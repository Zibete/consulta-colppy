import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
let handleMessage = null;
let calls = 0;
let loginAssists = 0;
let createdTabs = 0;
let tabUpdates = [];
let preflightReady = true;
let queryResponses = [];
let tab = { id: 77, active: true, discarded: false, url: 'https://login.colppy.com/contabilidad' };
let onUpdated, onActivated;
const listeners = { addListener: () => {} };
const chromeMock = {
  runtime: {
    onInstalled: listeners, onStartup: listeners,
    onMessage: { addListener(fn) { handleMessage = fn; } }
  },
  sidePanel: { setPanelBehavior: async () => {} },
  tabs: {
    onUpdated: { addListener(fn) { onUpdated = fn; } },
    onActivated: { addListener(fn) { onActivated = fn; } },
    query: async () => tab ? [tab] : [],
    async get(id) {
      if (!tab || tab.id !== id) throw new Error('Pestaña no encontrada');
      return tab;
    },
    async create(options) {
      createdTabs += 1;
      tab = { id: 77 + createdTabs, url: options.url, active: options.active, discarded: false };
      return tab;
    },
    async update(id, options) {
      assert.equal(tab?.id, id);
      tabUpdates.push({ ...options });
      tab = { ...tab, ...options };
      return tab;
    }
  },
  alarms: { onAlarm: listeners, create: async () => {}, clear: async () => {} },
  scripting: {
    async executeScript({ func, args }) {
      if (func.name === 'pagePreflight') return [{ result: { ready: preflightReady } }];
      if (func.name === 'pageAssistLogin') { loginAssists += 1; return [{ result: { monitoring: true } }]; }
      if (func.name === 'pageCancelLoginAssist') return [{ result: null }];
      calls += 1;
      const kind = queryResponses.shift() || 'ok';
      if (kind === 'session') return [{ result: { kind: 'session', message: 'Sesión vencida' } }];
      return [{ result: {
        kind: 'response', data: {
          result: { estado: 0 }, response: { success: true, data: {
            nombre: 'Empresa sintética', idCondicionIva: 1, pais: 'Argentina',
            domicilioFiscal: { localidad: 'Ciudad ficticia' }
          } }
        }
      } }];
    }
  },
  storage: {
    session: {
      async get(keys) {
        if (keys === null) return Object.fromEntries(mem.entries());
        if (typeof keys === 'string') return { [keys]: mem.get(keys) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => mem.has(k)).map((k) => [k, mem.get(k)]));
        const obj = {};
        for (const [key, defaultValue] of Object.entries(keys)) obj[key] = mem.has(key) ? mem.get(key) : defaultValue;
        return obj;
      },
      async set(values) { for (const [key, value] of Object.entries(values)) mem.set(key, value); },
      async remove(keys) { for (const key of keys) mem.delete(key); }
    }
  }
};
globalThis.chrome = chromeMock;
await import('../background.js');

function send(type, extra = {}) {
  return new Promise((resolve) => {
    const ret = handleMessage({ type, ...extra }, {}, resolve);
    assert.equal(ret, true);
  });
}
async function waitUntil(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('No se cumplió la condición');
}
function makeValid(prefix) {
  const w = [5,4,3,2,7,6,5,4,3,2];
  const rem = 11 - (w.reduce((a,v,i)=>a + v*Number(prefix[i]),0) % 11);
  return prefix + (rem === 11 ? 0 : rem === 10 ? 9 : rem);
}
async function reset() {
  await send('DISCARD');
  tab = { id: 77, active: true, discarded: false, url: 'https://login.colppy.com/contabilidad' };
  calls = 0;
  loginAssists = 0;
  tabUpdates = [];
  preflightReady = true;
  queryResponses = [];
}

test('B-01: procesa una vez CUIT duplicado y preserva tres filas', async () => {
  await reset();
  const cuit = makeValid('2012345678');
  const start = await send('START', { input: `${cuit},${cuit}|${cuit}` });
  assert.equal(start.ok, true);
  await waitUntil(async () => (await send('GET_STATUS')).data?.phase === 'complete');
  const status = (await send('GET_STATUS')).data;
  assert.equal(status.next, 1);
  assert.equal(status.uniqueCount, 1);
  assert.equal(status.inputCount, 3);
  assert.equal(calls, 1);
  const output = (await send('GET_ROWS', { start: 0, limit: 10 })).data;
  assert.equal(output.rows.length, 3);
  assert.deepEqual(output.rows.map((r) => r.CUIT), [cuit,cuit,cuit]);
  assert.deepEqual(output.rows.map((r) => r.Estado), ['OK','OK','OK']);
});

test('B-02: conserva checkpoint al pausar y reanudar', async () => {
  await reset();
  const a = makeValid('2012345678');
  const b = makeValid('3012345678');
  const start = await send('START', { input: `${a}|${b}` });
  assert.equal(start.ok, true);
  await waitUntil(async () => (await send('GET_STATUS')).data?.next === 1);
  const paused = await send('PAUSE');
  assert.equal(paused.data.phase, 'paused');
  const interim = (await send('GET_ROWS', { start: 0, limit: 10 })).data;
  assert.deepEqual(interim.rows.map((r) => r.Estado), ['OK','Pendiente']);
  const resumed = await send('RESUME');
  assert.equal(resumed.ok, true);
  await waitUntil(async () => (await send('GET_STATUS')).data?.phase === 'complete');
  const final = (await send('GET_ROWS', { start: 0, limit: 10 })).data;
  assert.deepEqual(final.rows.map((r) => r.Estado), ['OK','OK']);
  assert.equal(calls, 2);
});

test('B-03: sin pestaña abre login, conserva entrada y retoma sin interacción adicional', async () => {
  await reset();
  tab = null;
  preflightReady = false;
  const cuit = makeValid('2012345678');
  const before = createdTabs;
  const result = await send('START', { input: `${cuit}\n${cuit}` });
  assert.equal(result.data.phase, 'waiting_login');
  assert.equal(createdTabs, before + 1);
  assert.equal(tab.url, 'https://login.colppy.com/');
  assert.deepEqual((await send('GET_INPUT')).data.items, [cuit, cuit]);
  assert.equal(calls, 0);
  assert.ok(loginAssists > 0);
  preflightReady = true;
  onUpdated(tab.id, { status: 'complete' });
  await waitUntil(async () => (await send('GET_STATUS')).data?.phase === 'complete');
  assert.equal(calls, 1);
  assert.equal((await send('GET_ROWS', { start: 0, limit: 5 })).data.rows.length, 2);
});

test('B-04: sustituye resultados anteriores directamente tras un trabajo completo', async () => {
  await reset();
  const a = makeValid('2012345678');
  const b = makeValid('3012345678');
  await send('START', { input: a });
  await waitUntil(async () => (await send('GET_STATUS')).data?.phase === 'complete');
  const oldJobId = (await send('GET_STATUS')).data.id;
  const res = await send('START', { input: b });
  assert.equal(res.ok, true);
  await waitUntil(async () => (await send('GET_STATUS')).data?.phase === 'complete');
  const latest = (await send('GET_STATUS')).data;
  assert.notEqual(latest.id, oldJobId);
  assert.deepEqual((await send('GET_ROWS', { start: 0, limit: 5 })).data.rows.map(r => r.CUIT), [b]);
});

test('B-05: al caducar sesión preserva resultados previos y retoma desde el checkpoint', async () => {
  await reset();
  const a = makeValid('2012345678');
  const b = makeValid('3012345678');
  queryResponses = ['ok', 'session', 'ok'];
  await send('START', { input: `${a},${b}` });
  await waitUntil(async () => (await send('GET_STATUS')).data?.phase === 'waiting_login');
  const intermediate = (await send('GET_STATUS')).data;
  assert.equal(intermediate.next, 1);
  assert.equal(tab.url, 'https://login.colppy.com/');
  assert.equal(calls, 2);
  const rows = (await send('GET_ROWS', {start:0,limit:2})).data.rows;
  assert.deepEqual(rows.map(r => r.Estado), ['OK','Pendiente']);
  await send('CHECK_AUTH');
  assert.equal((await send('GET_STATUS')).data.phase, 'waiting_login');
  onUpdated(tab.id, { status: 'complete' });
  await waitUntil(async () => (await send('GET_STATUS')).data?.phase === 'complete');
  assert.equal(calls, 3);
  assert.equal((await send('GET_STATUS')).data.next, 2);
});

test('B-06: permite pausar una consulta en espera de login', async () => {
  await reset();
  preflightReady = false;
  const cuit = makeValid('2012345678');
  await send('START', { input: cuit });
  const paused = await send('PAUSE');
  assert.equal(paused.data.phase, 'paused');
  preflightReady = true;
  onActivated({tabId:tab.id});
  await new Promise(resolve => setTimeout(resolve,20));
  assert.equal((await send('GET_STATUS')).data.phase, 'paused');
  assert.equal(calls, 0);
});


test('B-07: nueva pestaña de Colppy queda inactiva (active false)', async () => {
  await reset();
  tab = null;
  preflightReady = false;
  const cuit = makeValid('2012345678');
  const started = await send('START', { input: cuit });
  assert.equal(started.ok, true);
  assert.equal(tab.active, false);
  assert.equal(tab.url, 'https://login.colppy.com/');
  assert.equal((await send('GET_STATUS')).data.phase, 'waiting_login');
});

test('B-08: pestaña existente se reutiliza sin modificar el foco', async () => {
  await reset();
  tab.active = false;
  preflightReady = false;
  const cuit = makeValid('2012345678');
  await send('START', { input: cuit });
  assert.equal(tab.id, 77);
  assert.equal(tab.active, false);
  assert.equal(tabUpdates.length, 0);
});

test('B-09: sesión vencida navega al login sin activar la pestaña', async () => {
  await reset();
  tab.active = false;
  const a = makeValid('2012345678');
  queryResponses = ['session'];
  await send('START', { input: a });
  await waitUntil(async () => (await send('GET_STATUS')).data?.phase === 'waiting_login');
  assert.equal(tab.active, false);
  assert.ok(tabUpdates.some(opts => opts.url === 'https://login.colppy.com/'));
  assert.ok(tabUpdates.every(opts => !('active' in opts)));
});
