import test from 'node:test';
import assert from 'node:assert/strict';

// DOM mínimo para verificar el contrato del panel sin Chrome ni datos reales.
class Node {
  constructor() {
    Object.assign(this, { value:'', checked:false, hidden:false, disabled:false, textContent:'', style:{}, children:[], listeners:{}, open:false });
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] ?? []) fn(); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('P-01: preferencias al reabrir, contadores y esquema del último lote independientes del próximo', async () => {
  const old = { chrome:globalThis.chrome, document:globalThis.document, setInterval:globalThis.setInterval };
  const stored = {};
  const state = {id:'ficticio',phase:'complete',inputCount:23,uniqueCount:20,next:20,completedQueries:60,sources:['ARCA','ARBA','AGIP'],arbaDate:'2020-01-15',stats:{ok:15,partial:4,noData:0,invalid:0,errors:1,fixedFields:0}};
  const makeDocument = () => {
    const nodes = new Map();
    const getElementById = id => { if (!nodes.has(id)) nodes.set(id,new Node()); return nodes.get(id); };
    getElementById('source-arca').checked=true;
    return {getElementById,createElement:()=>new Node()};
  };
  globalThis.setInterval = ()=>0;
  globalThis.chrome = { runtime:{sendMessage:async m=>({ok:true,data:m.type==='GET_STATUS'?state:{items:['20123456780']}})},storage:{onChanged:{addListener(){}},session:{get:async k=>({[k]:stored[k]}),set:async v=>Object.assign(stored,v)}}};
  try {
    globalThis.document=makeDocument();
    await import('../panel.js?test=initial'); await tick();
    let $=globalThis.document.getElementById;
    assert.equal($('count-partial').textContent,4);
    assert.match($('columns-hint').textContent,/Último lote · 19 columnas/);
    $('source-arba').checked=false; $('source-arba').fire('change');
    assert.match($('source-legend').textContent,/próximo lote/);
    assert.match($('columns-hint').textContent,/19 columnas/);
    $('extended').checked=true;$('extended').fire('change');
    $('include-headers').checked=true;$('include-headers').fire('change');
    await tick();assert.match($('columns-hint').textContent,/25 columnas/);
    assert.deepEqual(stored['colppy:preferences'],{extended:true,headers:true});
    globalThis.document=makeDocument();
    await import('../panel.js?test=reopen');await tick();
    $=globalThis.document.getElementById;
    assert.equal($('extended').checked,true);assert.equal($('include-headers').checked,true);
    assert.match($('columns-hint').textContent,/Último lote · 25 columnas/);
    assert.equal($('results-preview').open,false);
    $('cuit-input').value='123';$('cuit-input').fire('input');assert.equal($('input-warning').textContent,'1 inválido');
  } finally { Object.assign(globalThis,old); }
});
