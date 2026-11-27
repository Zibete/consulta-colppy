import {
  parseCuits, isValidCuit, MAX_CUITS, INTERVAL_MS
} from './core.js';
import { selection, normalizeSource, aggregate, projectRow } from './sources.js';
import { pagePreflight, pageQueryCuit, pageAssistLogin, pageCancelLoginAssist } from './page-query.js';

const STATE_KEY = 'colppy:state';
const INPUT_KEY = 'colppy:input';
const RESULT_PREFIX = 'colppy:result:';
const WATCHDOG = 'colppy:watchdog';
const LOGIN_URL = 'https://login.colppy.com/';
let runningInWorker = false;
let checkingAuth = false;
let requestInProgress = false;
let checkpointLock = Promise.resolve();
function serialized(fn) {
  const next = checkpointLock.then(fn, fn);
  checkpointLock = next.catch(() => {});
  return next;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void resumeIfNeeded();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG) void resumeIfNeeded();
});
// La navegación, el login y el cambio de empresa pueden cargar Colppy sin cerrar el panel.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'complete' || change.url) void checkPendingLogin(tabId, change.status === 'complete');
});
chrome.tabs.onActivated.addListener(({ tabId }) => { void checkPendingLogin(tabId); });

async function getState() {
  return (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || null;
}
async function getInput() {
  return (await chrome.storage.session.get(INPUT_KEY))[INPUT_KEY] || null;
}
function resultKey(jobId, position) {
  return `${RESULT_PREFIX}${jobId}:${position}`;
}
async function setState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
}
async function clearJob() { return serialized(clearJobUnlocked); }
async function clearJobUnlocked() {
  const previous = await getState();
  if (previous?.phase === 'waiting_login' && previous.tabId != null) {
    await inject(previous.tabId, pageCancelLoginAssist).catch(() => {});
  }
  if (previous?.phase === 'running') {
    await setState({ ...previous, phase: 'paused', note: 'Proceso detenido por el usuario.' });
  }
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((key) => key === STATE_KEY || key === INPUT_KEY || key.startsWith(RESULT_PREFIX));
  if (keys.length) await chrome.storage.session.remove(keys);
  await chrome.alarms.clear(WATCHDOG);
}

async function locateColppyTab() {
  const tabs = await chrome.tabs.query({ url: 'https://login.colppy.com/*' });
  const candidates = tabs.filter((tab) => !tab.discarded && /^https:\/\/login\.colppy\.com\//u.test(tab.url || tab.pendingUrl || ''));
  candidates.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return candidates[0] || null;
}
// Reutiliza la pestaña existente sin cambiar el foco. Si no hay una, abre en segundo plano.
async function openOrReuseColppy() {
  const existing = await locateColppyTab();
  if (existing) return existing;
  return chrome.tabs.create({ url: LOGIN_URL, active: false });
}
async function verifyTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab && !tab.discarded && /^https:\/\/login\.colppy\.com\//u.test(tab.url || tab.pendingUrl || '');
  } catch { return false; }
}
async function inject(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func, args
  });
  return result[0]?.result;
}

/** Retoma el lote únicamente cuando Colppy tiene el contexto original de consultas listo. */
async function checkPendingLogin(changedTabId = null, navigationComplete = false) {
  if (checkingAuth) return getState();
  checkingAuth = true;
  try {
    const current = await getState();
    if (current?.phase !== 'waiting_login' || current.tabId == null) return current;
    if (changedTabId != null && changedTabId !== current.tabId) return current;
    if (current.awaitingNavigation) {
      if (!navigationComplete) {
        // Respaldo por si Chrome no entregó el evento final al worker suspendido.
        const tabAfterNavigation = await chrome.tabs.get(current.tabId).catch(() => null);
        const settled = tabAfterNavigation?.status === 'complete' &&
          /^https:\/\/login\.colppy\.com\//u.test(tabAfterNavigation.url || '') &&
          Date.now() - current.updatedAt > 3000;
        if (!settled) return current;
      }
      current.awaitingNavigation = false;
      await setState(current);
    }
    if (!(await verifyTab(current.tabId))) {
      const found = await locateColppyTab();
      if (!found) {
        const paused = { ...current, phase: 'paused', updatedAt: Date.now(),
          note: 'Se cerró la pestaña de Colppy. Presioná Reanudar para abrirla nuevamente.' };
        await setState(paused);
        await chrome.alarms.clear(WATCHDOG);
        return paused;
      }
      current.tabId = found.id;
      await setState(current);
    }
    const checked = await inject(current.tabId, pagePreflight).catch(() => null);
    return await serialized(async () => {
      const latest = await getState();
      if (latest?.id !== current.id || latest.phase !== 'waiting_login') return latest;
      if (checked?.ready) {
        const running = { ...latest, phase: 'running', tabId: current.tabId,
          updatedAt: Date.now(), note: 'Sesión disponible. Consultando CUIT.' };
        await setState(running);
        void runQueue();
        return running;
      }
      // El asistente opera dentro de Colppy. No recibe valores ni credenciales.
      await inject(current.tabId, pageAssistLogin).catch(() => {});
      return getState();
    });
  } finally {
    checkingAuth = false;
  }
}

async function startJob(message) {
  const active = await getState();
  if (['running', 'waiting_login', 'paused'].includes(active?.phase)) {
    throw new Error('Ya hay una consulta activa. Reanudala o descartala antes de iniciar otra.');
  }
  const items = parseCuits(message?.input || '');
  if (!items.length) throw new Error('Ingresá al menos un CUIT.');
  if (items.length > MAX_CUITS) throw new Error(`Máximo permitido: ${MAX_CUITS} CUIT por lote.`);
  const options = selection(message);
  const unique = [...new Set(items)];
  await clearJob();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const state = {
    id: jobId, tabId: null, phase: 'waiting_login', startedAt: now, updatedAt: now,
    inputCount: items.length, uniqueCount: unique.length, next: 0, sourceIndex: 0, completedQueries: 0, ...options,
    stats: { ok: 0, noData: 0, invalid: 0, errors: 0, fixedFields: 0 },
    consecutiveErrors: 0, authPrompts: 0,
    note: 'Abriendo Colppy. Si es necesario, iniciá sesión; la consulta continuará automáticamente.'
  };
  // Se escribe ANTES de abrir la pestaña: nunca se pierden los CUIT por un redirect.
  await chrome.storage.session.set({ [STATE_KEY]: state, [INPUT_KEY]: { items, unique } });
  try {
    const tab = await openOrReuseColppy();
    const latest = await getState();
    if (latest?.id !== state.id || latest.phase !== 'waiting_login') return latest;
    const awaiting = { ...latest, tabId: tab.id, updatedAt: Date.now() };
    await setState(awaiting);
    await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
    return await checkPendingLogin();
  } catch {
    const paused = { ...state, phase: 'paused', updatedAt: Date.now(),
      note: 'No se pudo abrir Colppy. Revisá los permisos del navegador y presioná Reanudar.' };
    await setState(paused);
    return paused;
  }
}

async function requestLogin(state) {
  await serialized(async () => {
    const current = await getState();
    if (!current || current.id !== state.id || current.phase !== 'running') return;
    if (current.pauseRequested || (current.authPrompts || 0) >= 1) {
      await setState({ ...current, phase: 'paused', pauseRequested: false, updatedAt: Date.now(),
        note: current.pauseRequested ? 'Pausado. La sesión deberá renovarse al reanudar.' : 'Colppy volvió a rechazar la sesión. Verificá el acceso y reanudá manualmente.' });
      await chrome.alarms.clear(WATCHDOG);
      return;
    }
    const waiting = { ...current, phase: 'waiting_login', authPrompts: 1, awaitingNavigation: true,
      updatedAt: Date.now(), note: 'La sesión venció. Iniciá sesión en Colppy para continuar sin repetir las consultas completadas.' };
    await setState(waiting);
    try {
      await chrome.tabs.update(current.tabId, { url: LOGIN_URL });
      await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
    } catch {
      await setState({ ...waiting, phase: 'paused', updatedAt: Date.now(),
        note: 'No se pudo abrir el inicio de sesión. Presioná Reanudar.' });
      await chrome.alarms.clear(WATCHDOG);
    }
  });
}

async function pauseWithNote(state, note) {
  await serialized(async () => {
    const current = await getState();
    if (!current || current.id !== state.id || current.phase !== 'running') return;
    await setState({ ...current, phase: 'paused', pauseRequested: false, updatedAt: Date.now(), note });
    await chrome.alarms.clear(WATCHDOG);
  });
}
function sessionRejected(response) {
  if (!response || response.kind === 'session') return true;
  const details = [response.data?.result?.mensaje, response.data?.response?.message, response.data?.response?.mensaje]
    .filter(Boolean).join(' ').toLocaleLowerCase('es-AR');
  return /(?:sesi[oó]n|autenticaci[oó]n)/u.test(details) && /(?:expir|venc|caduc|inv[aá]lid|autoriz|inici|cerrad)/u.test(details);
}
async function runQueue() {
  if (runningInWorker) return;
  runningInWorker = true;
  try {
    const input = await getInput();
    if (!input) return;
    while (true) {
      const state = await getState();
      if (!state || state.phase !== 'running') return;
      if (state.pauseRequested) {
        await pauseWithNote(state, 'Pausado. Podés copiar los resultados parciales o reanudar.');
        return;
      }
      if (state.next >= input.unique.length) {
        await serialized(async () => {
          const current = await getState();
          if (current?.id !== state.id || current.phase !== 'running') return;
          await setState({ ...current, phase: 'complete', updatedAt: Date.now(), note: 'Consulta finalizada.' });
          await chrome.alarms.clear(WATCHDOG);
        });
        return;
      }
      const index = state.next, sourceIndex = state.sourceIndex ?? 0;
      const cuit = input.unique[index], sources = state.sources ?? ['ARCA'], source = sources[sourceIndex];
      const key = resultKey(state.id, index);
      if (!(await verifyTab(state.tabId))) {
        await pauseWithNote(state, 'La pestaña de Colppy se cerró, se descargó o cambió de dirección. Presioná Reanudar.');
        return;
      }
      const ready = await getState();
      if (ready?.id !== state.id || ready.phase !== 'running' || ready.pauseRequested || ready.next !== index || (ready.sourceIndex ?? 0) !== sourceIndex) return;
      let result;
      const invalid = !isValidCuit(cuit);
      // Se mantiene hasta que el resultado y el cursor se confirmen juntos.
      requestInProgress = true;
      try {
        if (!invalid) {
          let response;
          try { response = await inject(state.tabId, pageQueryCuit, [cuit, source, state.arbaDate]); }
          catch { await pauseWithNote(state, 'No se pudo conectar con la pestaña Colppy. Revisá la sesión y reanudá.'); return; }
          if (sessionRejected(response)) {
            await requestLogin(state);
            return;
          }
          if (response.kind === 'http' && [429, 503].includes(response.status)) {
            await pauseWithNote(state, `Colppy respondió ${response.message}. Se pausó para evitar nuevas solicitudes.`);
            return;
          }
          result = normalizeSource(source, cuit, response);
        }
        const advanced = await serialized(async () => {
          const latest = await getState();
          if (!latest || latest.id !== state.id || latest.phase !== 'running' || latest.next !== index || (latest.sourceIndex ?? 0) !== sourceIndex) return null;
          const previous = (await chrome.storage.session.get(key))[key];
          const record = invalid ? { invalid: true } : { results: { ...previous?.results, [source]: result } };
          const done = invalid || sourceIndex + 1 === sources.length;
          const stats = { ...latest.stats };
          if (done) {
            const status = aggregate(record, sources);
            if (status === 'OK') stats.ok++;
            else if (status === 'Sin datos') stats.noData++;
            else if (status === 'CUIT inválido') stats.invalid++;
            else stats.errors++;
          }
          stats.fixedFields += result?.repaired ?? 0;
          const consecutiveErrors = result && !['OK', 'Sin datos'].includes(result.status) ? (latest.consecutiveErrors || 0) + 1 : 0;
          const paused = latest.pauseRequested || consecutiveErrors >= 5;
          const next = { ...latest, next: done ? index + 1 : index, sourceIndex: done ? 0 : sourceIndex + 1,
            completedQueries: (latest.completedQueries ?? 0) + (invalid ? 0 : 1), updatedAt: Date.now(), stats, consecutiveErrors,
            phase: paused ? 'paused' : 'running', pauseRequested: false,
            note: paused ? (consecutiveErrors >= 5 ? 'Cinco consultas seguidas fallaron. Se pausó para revisar Colppy.' : 'Pausado. Podés copiar los resultados parciales o reanudar.') : `Consultando ${done ? sources[0] : sources[sourceIndex + 1]}.` };
          // Checkpoint atómico por par: no se escribe el cursor sin confirmar el resultado.
          await chrome.storage.session.set({ [key]: record, [STATE_KEY]: next });
          if (paused) await chrome.alarms.clear(WATCHDOG);
          return next;
        });
        if (!advanced || advanced.phase !== 'running') return;
      } finally { requestInProgress = false; }
      if (!invalid && (index + 1 < input.unique.length || sourceIndex + 1 < sources.length)) {
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
      }
    }
  } catch {
    const state = await getState();
    if (state?.phase === 'running') {
      await pauseWithNote(state, 'No se pudo guardar el checkpoint o hubo un error interno. Conservá/exportá los resultados anteriores; si falta espacio, dividí el lote.');
    }
  } finally {
    requestInProgress = false;
    runningInWorker = false;
    void resumeIfNeeded();
  }
}

async function resumeIfNeeded() {
  const state = await getState();
  if (state?.phase === 'running') void runQueue();
  if (state?.phase === 'waiting_login') void checkPendingLogin();
}
async function pauseJob() {
  return serialized(async () => {
    const state = await getState();
    if (!['running', 'waiting_login'].includes(state?.phase)) return state;
    if (state.phase === 'running' && requestInProgress) {
      const requested = { ...state, pauseRequested: true, updatedAt: Date.now(), note: 'Pausando al finalizar la consulta en curso…' };
      await setState(requested);
      return requested;
    }
    if (state.phase === 'waiting_login' && state.tabId != null) {
      await inject(state.tabId, pageCancelLoginAssist).catch(() => {});
    }
    const next = { ...state, phase: 'paused', pauseRequested: false, updatedAt: Date.now(), note: 'Pausado. Podés copiar los resultados parciales o reanudar.' };
    await setState(next);
    await chrome.alarms.clear(WATCHDOG);
    return next;
  });
}
async function resumeJob() {
  const state = await getState();
  if (!state || state.phase !== 'paused') throw new Error('No hay una consulta pausada.');
  const waiting = { ...state, phase: 'waiting_login', pauseRequested: false, authPrompts: 0,
    updatedAt: Date.now(), note: 'Comprobando sesión de Colppy para continuar.' };
  await setState(waiting);
  try {
    const tab = await openOrReuseColppy();
    const latest = await getState();
    if (latest?.id !== waiting.id || latest.phase !== 'waiting_login') return latest;
    await setState({ ...latest, tabId: tab.id });
    await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
    return await checkPendingLogin();
  } catch {
    const paused = { ...waiting, phase: 'paused', updatedAt: Date.now(),
      note: 'No se pudo abrir Colppy. Volvé a intentar Reanudar.' };
    await setState(paused);
    await chrome.alarms.clear(WATCHDOG);
    return paused;
  }
}

/** Entrega únicamente un tramo: la UI no recibe 3500 resultados por mensaje. */
async function fetchRows(start, limit) {
  const state = await getState();
  const input = await getInput();
  if (!state || !input) return { rows: [], total: 0 };
  const from = Math.max(0, Math.min(input.items.length, Number(start) || 0));
  const length = Math.max(1, Math.min(250, Number(limit) || 200));
  const indexByCuit = new Map(input.unique.map((cuit, i) => [cuit, i]));
  const slice = input.items.slice(from, from + length);
  const keys = [...new Set(slice.map((cuit) => resultKey(state.id, indexByCuit.get(cuit))))];
  const found = await chrome.storage.session.get(keys);
  const rows = slice.map((cuit) => {
    const data = found[resultKey(state.id, indexByCuit.get(cuit))];
    return projectRow(cuit, data, state);
  });
  if ((await getState())?.id !== state.id) throw new Error('Cambió la consulta durante la lectura.');
  return { rows, total: input.items.length, jobId: state.id };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const fn = async () => {
    switch (message?.type) {
      case 'GET_STATUS': return getState();
      case 'GET_INPUT': return getInput();
      case 'CHECK_AUTH': return checkPendingLogin();
      case 'START': return startJob(message);
      case 'PAUSE': return pauseJob();
      case 'RESUME': return resumeJob();
      case 'DISCARD': await clearJob(); return null;
      case 'GET_ROWS': return fetchRows(message.start, message.limit);
      default: throw new Error('Acción no permitida.');
    }
  };
  fn().then((data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error?.message || 'Error desconocido.' }));
  return true;
});
