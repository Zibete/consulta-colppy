import { parseCuits, isValidCuit, MAX_CUITS, toTsv, toCsv } from './core.js';
import { createPreviewTable } from './preview-table.js';

const $ = (id) => document.getElementById(id);
const elements = {
  input: $('cuit-input'), inputCount: $('input-count'), inputWarning: $('input-warning'),
  start: $('start'), pause: $('pause'), resume: $('resume'), discard: $('discard'),
  copy: $('copy'), headers: $('include-headers'), csv: $('csv'), status: $('job-status'), progressLabel: $('job-progress'),
  progress: $('progress'), ok: $('count-ok'), empty: $('count-empty'),
  invalid: $('count-invalid'), errors: $('count-errors'),
  note: $('job-note'), outputNote: $('output-note')
};
let job = null;
let busy = false;
const preview = createPreviewTable({
  disclosure: $('results-preview'), scroller: $('preview-scroll'),
  table: $('preview-table'), tbody: $('preview-body'), note: $('preview-note'),
  fetchRows: (start, limit) => command('GET_ROWS', { start, limit }), document
});

async function command(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || 'No se recibió respuesta de la extensión.');
  return response.data;
}
function message(error) {
  elements.note.textContent = error instanceof Error ? error.message : String(error);
}
function refreshInputCount() {
  const tokens = parseCuits(elements.input.value);
  const invalid = tokens.filter((cuit) => !isValidCuit(cuit)).length;
  const unique = new Set(tokens).size;
  elements.inputCount.textContent = `${tokens.length.toLocaleString('es-AR')} CUIT · ${unique.toLocaleString('es-AR')} únicos`;
  elements.inputWarning.textContent = tokens.length > MAX_CUITS ? 'Supera el máximo' :
    invalid ? `${invalid} inválidos` : '';
  elements.start.disabled = busy || ['running', 'waiting_login'].includes(job?.phase) || !tokens.length || tokens.length > MAX_CUITS;
}
function render(next) {
  job = next;
  preview.update(next);
  const phase = next?.phase || 'idle';
  const names = { idle: 'Sin iniciar', waiting_login: 'Abriendo Colppy', running: 'Consultando', paused: 'Pausado', complete: 'Finalizado' };
  elements.status.textContent = names[phase] || 'Sin iniciar';
  elements.status.className = `status-pill ${phase}`;
  elements.progressLabel.textContent = next ?
    `${next.next.toLocaleString('es-AR')} / ${next.uniqueCount.toLocaleString('es-AR')} únicos` : '0 / 0 únicos';
  elements.progress.value = next?.uniqueCount ? (next.next * 100 / next.uniqueCount) : 0;
  elements.ok.textContent = next?.stats?.ok ?? 0;
  elements.empty.textContent = next?.stats?.noData ?? 0;
  elements.invalid.textContent = next?.stats?.invalid ?? 0;
  elements.errors.textContent = next?.stats?.errors ?? 0;
  elements.note.textContent = next?.note || 'Pegá los CUIT y presioná Consultar.';
  const outputReady = !!next && (phase === 'paused' || phase === 'complete') && next.next > 0;
  elements.pause.disabled = busy || !['running', 'waiting_login'].includes(phase);
  elements.resume.disabled = busy || phase !== 'paused';
  elements.discard.disabled = busy || phase === 'idle';
  elements.copy.disabled = busy || !outputReady;
  elements.csv.disabled = busy || !outputReady;
  elements.input.disabled = ['running', 'paused', 'waiting_login'].includes(phase);
  elements.outputNote.textContent = !next ? 'Cuando haya resultados, podrás exportarlos incluso si pausás el proceso.' :
    phase === 'waiting_login' ? 'Los CUIT se conservarán mientras iniciás sesión en Colppy.' :
    phase === 'running' ? 'Pausá para exportar un resultado parcial o esperá al final.' :
    phase === 'paused' ? 'La exportación parcial incluye las filas pendientes identificadas como tales.' :
    `${next.inputCount.toLocaleString('es-AR')} filas de salida · ${next.stats.fixedFields} campos reparados por codificación.`;
  refreshInputCount();
}
async function withBusy(action) {
  if (busy) return;
  busy = true;
  render(job);
  let feedback;
  let failure;
  try { feedback = await action(); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    busy = false;
    render(await command('GET_STATUS').catch(() => job));
    if (failure) message(failure);
    else if (feedback) elements.outputNote.textContent = feedback;
  }
}

/** Progreso disponible aunque se suspenda/reinicie el worker. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes['colppy:state'] && !busy) {
    render(changes['colppy:state'].newValue || null);
  }
});

elements.input.addEventListener('input', refreshInputCount);
elements.start.addEventListener('click', () => withBusy(async () => {
  render(await command('START', { input: elements.input.value }));
}));
elements.pause.addEventListener('click', () => withBusy(async () => {
  render(await command('PAUSE'));
}));
elements.resume.addEventListener('click', () => withBusy(async () => {
  render(await command('RESUME'));
}));
elements.discard.addEventListener('click', () => withBusy(async () => {
  if (!confirm('¿Descartar la consulta y todos sus resultados temporales?')) return;
  await command('DISCARD');
  render(null);
}));

async function collectRows() {
  const state = await command('GET_STATUS');
  if (!state || !['paused', 'complete'].includes(state.phase)) {
    throw new Error('Pausá o terminá la consulta antes de exportar.');
  }
  const rows = [];
  for (let start = 0; start < state.inputCount; start += 200) {
    const batch = await command('GET_ROWS', { start, limit: 200 });
    rows.push(...batch.rows);
  }
  // Evita exportar si el lote fue sustituido durante la lectura.
  const current = await command('GET_STATUS');
  if (current?.id !== state.id) throw new Error('Cambió la consulta durante la exportación.');
  return rows;
}
elements.copy.addEventListener('click', () => withBusy(async () => {
  const rows = await collectRows();
  const includeHeaders = elements.headers.checked;
  await navigator.clipboard.writeText(toTsv(rows, includeHeaders));
  return `Copiadas ${rows.length.toLocaleString('es-AR')} filas (${includeHeaders ? 'con' : 'sin'} encabezados). Pegá en Excel.`;
}));
elements.csv.addEventListener('click', () => withBusy(async () => {
  const rows = await collectRows();
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `consulta-fiscal-colppy-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return `Generado CSV con ${rows.length.toLocaleString('es-AR')} filas y encabezados.`;
}));

// Rehidrata el texto al volver a abrir el panel mientras el trabajo está en sesión.
async function restorePanel() {
  const state = await command('GET_STATUS');
  render(state);
  if (state && !elements.input.value) {
    const saved = await command('GET_INPUT');
    if (saved?.items && !elements.input.value) {
      elements.input.value = saved.items.join('\n');
      refreshInputCount();
    }
  }
}
// Al esperar login, sondear con bajo costo solo mientras el panel esté abierto.
// Las transiciones de pestaña y la alarma del worker siguen funcionando sin el panel.
let authPollBusy = false;
setInterval(async () => {
  if (job?.phase !== 'waiting_login' || busy || authPollBusy) return;
  authPollBusy = true;
  try { render(await command('CHECK_AUTH')); } catch { /* Estado persistido; reintenta. */ }
  finally { authPollBusy = false; }
}, 2000);
render(null);
restorePanel().catch(message);
