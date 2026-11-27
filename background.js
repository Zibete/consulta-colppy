import {
  parseCuits, isValidCuit, MAX_CUITS, INTERVAL_MS,
  emptyRow, normalizeColppyResponse
} from './core.js';
import { pagePreflight, pageQueryCuit, pageAssistLogin, pageCancelLoginAssist } from './page-query.js';

const STATE_KEY = 'colppy:state';
const INPUT_KEY = 'colppy:input';
const RESULT_PREFIX = 'colppy:result:';
const WATCHDOG = 'colppy:watchdog';
const LOGIN_URL = 'https://login.colppy.com/';
let runningInWorker = false;
let checkingAuth = false;

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
async function clearJob() {
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
  } finally {
    checkingAuth = false;
  }
}

async function startJob(message) {
  const active = await getState();
  if (['running', 'waiting_login'].includes(active?.phase)) {
    throw new Error('Ya hay una consulta en curso o esperando autenticación.');
  }
  const items = parseCuits(message?.input || '');
  if (!items.length) throw new Error('Ingresá al menos un CUIT.');
  if (items.length > MAX_CUITS) throw new Error(`Máximo permitido: ${MAX_CUITS} CUIT por lote.`);
  const unique = [...new Set(items)];
  await clearJob();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const state = {
    id: jobId, tabId: null, phase: 'waiting_login', startedAt: now, updatedAt: now,
    inputCount: items.length, uniqueCount: unique.length, next: 0,
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
  const current = await getState();
  if (!current || current.id !== state.id || current.phase !== 'running') return;
  if ((current.authPrompts || 0) >= 1) {
    await pauseWithNote(current, 'Colppy volvió a rechazar la sesión. Verificá el acceso y reanudá manualmente.');
    return;
  }
  const waiting = { ...current, phase: 'waiting_login', authPrompts: 1, awaitingNavigation: true,
    updatedAt: Date.now(), note: 'La sesión venció. Se abrirá Colppy para iniciar sesión y continuar sin repetir los CUIT completados.' };
  await setState(waiting);
  try {
    // Navegar a login solo después de un error de sesión real; no por un preflight ambiguo.
    // Un login por sesión vencida tampoco roba el foco.
    await chrome.tabs.update(current.tabId, { url: LOGIN_URL });
    await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  } catch {
    await setState({ ...waiting, phase: 'paused', updatedAt: Date.now(),
      note: 'No se pudo abrir el inicio de sesión. Presioná Reanudar.' });
    await chrome.alarms.clear(WATCHDOG);
  }
}

function rowFromError(cuit, kind, message) {
  const row = emptyRow(cuit);
  row.Estado = kind;
  row.Error = message;
  return row;
}

async function pauseWithNote(state, note) {
  const current = await getState();
  if (!current || current.id !== state.id || current.phase !== 'running') return;
  await setState({ ...current, phase: 'paused', updatedAt: Date.now(), note });
  await chrome.alarms.clear(WATCHDOG);
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
      if (state.next >= input.unique.length) {
        await setState({ ...state, phase: 'complete', updatedAt: Date.now(), note: 'Consulta finalizada.' });
        await chrome.alarms.clear(WATCHDOG);
        return;
      }
      if (!(await verifyTab(state.tabId))) {
        await pauseWithNote(state, 'La pestaña de Colppy se cerró, se descargó o cambió de dirección. Presioná Reanudar.');
        return;
      }
      const index = state.next;
      const cuit = input.unique[index];
      let row;
      let fixedFields = 0;
      if (!isValidCuit(cuit)) {
        row = rowFromError(cuit, 'CUIT inválido', 'Debe tener 11 dígitos y dígito verificador válido.');
      } else {
        let response;
        try {
          response = await inject(state.tabId, pageQueryCuit, [cuit]);
        } catch {
          await pauseWithNote(state, 'No se pudo conectar con la pestaña Colppy. Revisá la sesión y reanudá.');
          return;
        }
        if (!response || response.kind === 'session') {
          await requestLogin(state);
          return;
        }
        if (response.kind === 'http' && [429, 503].includes(response.status)) {
          await pauseWithNote(state, `Colppy respondió ${response.message}. Se pausó para evitar nuevas solicitudes.`);
          return;
        }
        if (response.kind === 'response') {
          const details = [response.data?.result?.mensaje, response.data?.response?.message,
            response.data?.response?.mensaje].filter(Boolean).join(' ').toLocaleLowerCase('es-AR');
          if (/(?:sesi[oó]n|autenticaci[oó]n)/u.test(details) &&
              /(?:expir|venc|caduc|inv[aá]lid|autoriz|inici|cerrad)/u.test(details)) {
            await requestLogin(state);
            return;
          }
          const normalized = normalizeColppyResponse(cuit, response.data);
          row = normalized.row;
          fixedFields = normalized.repaired;
        } else if (response.kind === 'http') {
          row = rowFromError(cuit, 'Error HTTP', response.message);
        } else {
          row = rowFromError(cuit, 'Error', response?.message || 'Respuesta no reconocida de Colppy.');
        }
      }
      // Una pausa o descarte durante la petición nunca se sobreescribe al retornar.
      const latest = await getState();
      if (!latest || latest.id !== state.id || latest.phase !== 'running' || latest.next !== index) return;
      const stats = { ...latest.stats };
      if (row.Estado === 'OK') stats.ok += 1;
      else if (row.Estado === 'Sin datos') stats.noData += 1;
      else if (row.Estado === 'CUIT inválido') stats.invalid += 1;
      else stats.errors += 1;
      stats.fixedFields += fixedFields;
      const consecutiveErrors = ['Error HTTP', 'Error'].includes(row.Estado) ?
        (latest.consecutiveErrors || 0) + 1 : 0;
      const advanced = { ...latest, next: index + 1, updatedAt: Date.now(), stats, consecutiveErrors };
      // Checkpoint atómico: resultado + cursor; evita perder filas ya procesadas.
      await chrome.storage.session.set({
        [resultKey(state.id, index)]: row,
        [STATE_KEY]: advanced
      });
      if (consecutiveErrors >= 5) {
        await pauseWithNote(advanced, 'Cinco consultas seguidas fallaron. Se pausó para revisar Colppy antes de continuar.');
        return;
      }
      if (index + 1 < input.unique.length) {
        await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
      }
    }
  } catch {
    const state = await getState();
    if (state?.phase === 'running') {
      await pauseWithNote(state, 'Error interno de procesamiento. Los resultados anteriores permanecen disponibles.');
    }
  } finally {
    runningInWorker = false;
    // Si el login se completó mientras terminaba una petición anterior, reintenta la cola.
    void resumeIfNeeded();
  }
}

async function resumeIfNeeded() {
  const state = await getState();
  if (state?.phase === 'running') void runQueue();
  if (state?.phase === 'waiting_login') void checkPendingLogin();
}
async function pauseJob() {
  const state = await getState();
  if (!['running', 'waiting_login'].includes(state?.phase)) return state;
  if (state.phase === 'waiting_login' && state.tabId != null) {
    await inject(state.tabId, pageCancelLoginAssist).catch(() => {});
  }
  const next = { ...state, phase: 'paused', updatedAt: Date.now(), note: 'Pausado. Podés copiar los resultados parciales o reanudar.' };
  await setState(next);
  await chrome.alarms.clear(WATCHDOG);
  return next;
}
async function resumeJob() {
  const state = await getState();
  if (!state || state.phase !== 'paused') throw new Error('No hay una consulta pausada.');
  const waiting = { ...state, phase: 'waiting_login', authPrompts: 0,
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
    return data || rowFromError(cuit, 'Pendiente', 'No procesado todavía.');
  });
  return { rows, total: input.items.length };
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
