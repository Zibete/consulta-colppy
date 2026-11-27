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
let sourceCalls = [];
let pendingRequest = null;
let failCheckpoint = false;
let holdStateRead = false, resumeStateRead = null;
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
      const source = args[1] ?? 'ARCA';
      sourceCalls.push([source, args[0], args[2]]);
      const kind = queryResponses.shift() || 'ok';
      if (kind === 'session') return [{ result: { kind: 'session', message: 'Sesión vencida' } }];
      if (kind === 'hold') await new Promise(resolve => { pendingRequest = resolve; });
      if (kind === 'error') return [{result:{kind:'http',status:500,message:'HTTP 500'}}];
      if (source !== 'ARCA') { const rates = kind === 'partial' ? {percepcion:'0.80'} : {retencion:'0.00',percepcion:'0.80'}; return [{result:{kind:'response',data:{...(source==='ARBA'?{result:{estado:0}}:{}),response:{success:true,data:source==='ARBA'?rates:[rates]}}}}]; }
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
        if (typeof keys === 'string') {
          const captured = mem.get(keys);
          if (keys === 'colppy:state' && holdStateRead && captured?.phase === 'running') {
            holdStateRead = false; await new Promise(resolve => { resumeStateRead = resolve; });
          }
          return { [keys]: captured };
        }
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => mem.has(k)).map((k) => [k, mem.get(k)]));
        const obj = {};
        for (const [key, defaultValue] of Object.entries(keys)) obj[key] = mem.has(key) ? mem.get(key) : defaultValue;
        return obj;
      },
      async set(values) { if (failCheckpoint && Object.keys(values).some(k=>k.startsWith("colppy:result:"))) throw new Error("Quota exceeded"); for (const [key, value] of Object.entries(values)) mem.set(key, value); },
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
  sourceCalls = []; pendingRequest = null; failCheckpoint = false; holdStateRead = false; resumeStateRead = null;
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


test('B-10: fuentes seleccionadas, deduplicación, fecha congelada y error aislado', async () => {
  await reset(); const cuit=makeValid('2012345678');
  queryResponses=['ok','ok','error'];
  await send('START',{input:`${cuit}|${cuit}|123`,sources:['ARCA','ARBA','AGIP'],arbaDate:'2020-01-15'});
  await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='complete');
  const state=(await send('GET_STATUS')).data;
  assert.equal(state.next,2); assert.equal(state.stats.errors,1); assert.equal(state.stats.invalid,1);
  assert.deepEqual(sourceCalls.map(x=>x[0]),['ARCA','ARBA','AGIP']); assert.equal(sourceCalls[1][2],'2020-01-15');
  const {rows}=(await send('GET_ROWS',{start:0,limit:5})).data;
  assert.deepEqual(rows[0],rows[1]); assert.equal(rows[0].Estado,'Error'); assert.equal(rows[0]['ARBA Retención (%)'],'0,00');
  assert.equal(rows[0]['AGIP Estado'],'Error HTTP'); assert.equal(rows[2]['AGIP Estado'],'No consultado');
});
test('B-11: pausa durante solicitud guarda el par terminado y retoma solo lo pendiente', async () => {
  await reset(); const cuit=makeValid('2012345678'); queryResponses=['ok','hold','ok'];
  await send('START',{input:cuit,sources:['ARCA','ARBA','AGIP'],arbaDate:'2020-01-15'});
  await waitUntil(()=>pendingRequest!==null);
  const pause=await send('PAUSE'); assert.equal(pause.data.pauseRequested,true);
  pendingRequest(); await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='paused');
  const p=(await send('GET_STATUS')).data; assert.equal(p.next,0); assert.equal(p.sourceIndex,2); assert.equal(p.completedQueries,2);
  const {rows}=(await send('GET_ROWS',{start:0,limit:1})).data;
  assert.equal(rows[0]['ARBA Estado'],'OK'); assert.equal(rows[0]['AGIP Estado'],'Pendiente');
  await send('RESUME'); await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='complete');
  assert.deepEqual(sourceCalls.map(x=>x[0]),['ARCA','ARBA','AGIP']);
});
test('B-12: vencimiento de sesión entre organismos conserva ARCA y reintenta solo ARBA', async () => {
  await reset(); const cuit=makeValid('2012345678'); queryResponses=['ok','session','ok','ok'];
  await send('START',{input:cuit,sources:['ARCA','ARBA','AGIP'],arbaDate:'2020-01-15'});
  await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='waiting_login');
  const state=(await send('GET_STATUS')).data; assert.equal(state.sourceIndex,1);
  onUpdated(tab.id,{status:'complete'});
  await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='complete');
  assert.deepEqual(sourceCalls.map(x=>x[0]),['ARCA','ARBA','ARBA','AGIP']);
  assert.ok(sourceCalls.filter(x=>x[0]==='ARBA').every(x=>x[2]==='2020-01-15'));
});
test('B-13: falta de espacio no avanza cursor ni declara éxito', async () => {
  await reset(); const cuit=makeValid('2012345678'); failCheckpoint=true;
  await send('START',{input:cuit,sources:['ARCA']});
  await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='paused');
  const state=(await send('GET_STATUS')).data; assert.equal(state.next,0); assert.equal(state.completedQueries,0);
  const {rows}=(await send('GET_ROWS',{start:0,limit:1})).data; assert.equal(rows[0].Estado,'Pendiente');
  failCheckpoint=false; await send('RESUME'); await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='complete');
});

test('B-14: resultado parcial cuenta una vez por CUIT y coincide con las filas', async () => {
  await reset(); const cuit=makeValid('2012345678'); queryResponses=['ok','partial','ok'];
  await send('START',{input:`${cuit}|${cuit}`,sources:['ARCA','ARBA','AGIP'],arbaDate:'2020-01-15'});
  await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='complete');
  const state=(await send('GET_STATUS')).data;
  assert.equal(state.stats.partial,1); assert.equal(state.stats.ok,0); assert.equal(state.stats.errors,0);
  const {rows}=(await send('GET_ROWS',{start:0,limit:2})).data;
  assert.deepEqual(rows.map(r=>r.Estado),['Parcial','Parcial']);
  assert.equal(rows[0]['ARBA Percepción (%)'],'0,80'); assert.equal(calls,3);
});
test('B-15: pausa antes de reservar la solicitud no envía el par', async () => {
  await reset(); const cuit=makeValid('2012345678'); holdStateRead=true;
  await send('START',{input:cuit});
  await waitUntil(()=>resumeStateRead!==null);
  const paused=await send('PAUSE'); assert.equal(paused.data.phase,'paused');
  resumeStateRead(); await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(calls,0); await send('RESUME');
  await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='complete'); assert.equal(calls,1);
});

test('B-16: Error HTTP de ARCA sola conserva el estado histórico y cuenta un error por CUIT', async () => {
  await reset(); const cuit=makeValid('2012345678'); queryResponses=['error'];
  await send('START',{input:`${cuit}|${cuit}`});
  await waitUntil(async()=> (await send('GET_STATUS')).data?.phase==='complete');
  const state=(await send('GET_STATUS')).data;
  assert.equal(state.stats.errors,1); assert.equal(state.stats.ok,0);
  assert.equal(state.stats.partial,0); assert.equal(state.stats.noData,0);
  const {rows}=(await send('GET_ROWS',{start:0,limit:2})).data;
  assert.deepEqual(rows.map(r=>r.Estado),['Error HTTP','Error HTTP']);
  assert.deepEqual(rows.map(r=>r.Error),['HTTP 500','HTTP 500']); assert.equal(calls,1);
});
