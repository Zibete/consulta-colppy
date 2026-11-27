import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewWindow, createPreviewTable, PREVIEW_ROW_HEIGHT, PREVIEW_VISIBLE_ROWS } from '../preview-table.js';
import { COLUMNS } from '../core.js';

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.style = {};
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.open = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.clientHeight = 204;
    this.textContent = '';
    this.title = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn(); }
}
const doc = { createElement: (name) => new FakeNode(name) };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(fetchRows = async (start, limit) => ({ rows: Array.from({ length: limit }, (_, i) => ({ CUIT: `${start + i}`, Estado: 'OK' })), total: 10 })) {
  const disclosure = new FakeNode('details');
  const scroller = new FakeNode('div');
  const table = new FakeNode('table');
  const tbody = new FakeNode('tbody');
  const note = new FakeNode('p');
  const calls = [];
  const preview = createPreviewTable({ disclosure, scroller, table, tbody, note,
    fetchRows: async (start, limit) => { calls.push({ start, limit }); return fetchRows(start, limit); }, document: doc });
  return { disclosure, scroller, table, tbody, note, preview, calls };
}
const status = (id = 'job-1', total = 10, next = 10, phase = 'complete') => ({ id, inputCount: total, next, phase });
const dataRows = (start, limit) => Array.from({ length: limit }, (_, i) => ({ CUIT: String(start + i), Estado: 'OK', 'Razón social': 'Organización ficticia' }));

// Asegura que la ventana escala con el área visible y no con toda la base.
test('V-01: ventana de cinco filas más overscan, aun para 10000 filas', () => {
  const range = previewWindow(0, 10000, 204);
  assert.equal(range.start, 0);
  assert.ok(range.end <= 10);
  assert.equal(range.bottomHeight, (10000 - range.end) * PREVIEW_ROW_HEIGHT);
  assert.equal(PREVIEW_VISIBLE_ROWS, 5);
});
test('V-02: al llegar al final, la ventana no excede las filas existentes', () => {
  assert.deepEqual(previewWindow(0, 1, 204), { start: 0, end: 1, topHeight: 0, bottomHeight: 0 });
  const range = previewWindow(999999, 10000, 204);
  assert.ok(range.start <= 10000);
  assert.equal(range.end, 10000);
  assert.equal(range.bottomHeight, 0);
});
test('V-03: los encabezados corresponden exactamente a las 10 columnas', () => {
  const { table } = fixture();
  const thead = table.children.find((x) => x.tagName === 'thead');
  assert.deepEqual(thead.children[0].children.map((x) => x.textContent), COLUMNS);
  assert.equal(table.children[0].children.length, 10);
});
test('V-04: cerrada por defecto, y sin solicitudes de filas si no se abre', async () => {
  const f = fixture();
  f.preview.update(status());
  assert.equal(f.disclosure.open, false);
  assert.equal(f.disclosure.hidden, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.tbody.children.length, 0);
});
test('V-05: al expandir, trae solamente tramo visible y usa valores como texto', async () => {
  const f = fixture(async (start, limit) => ({ rows: Array.from({length:limit}, (_, i) => ({ CUIT: `${start+i}`, 'Razón social': '<img src=x onerror=alert(1)>', Estado: 'OK' })), total: 10000 }));
  f.preview.update(status('job-1', 10000));
  f.disclosure.open = true;
  f.disclosure.fire('toggle');
  await tick();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].limit <= 10);
  const realRows = f.tbody.children.filter(x => x.className !== 'preview-spacer');
  assert.ok(realRows.length <= 10);
  assert.equal(realRows[0].children[2].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(realRows[0].children.length, 10);
});
test('V-06: scroll navega a filas posteriores sin descargar el conjunto completo', async () => {
  const f = fixture(async (start, limit) => ({ rows: dataRows(start, limit), total: 1000 }));
  f.preview.update(status('j', 1000));
  f.disclosure.open = true;
  f.disclosure.fire('toggle');
  await tick();
  f.scroller.scrollTop = 400 * PREVIEW_ROW_HEIGHT;
  f.scroller.fire('scroll');
  await tick();
  assert.ok(f.calls.length >= 2);
  assert.ok(f.calls.at(-1).start >= 395);
  const cells = f.tbody.children.filter(x=>x.className !== 'preview-spacer');
  assert.equal(cells[0].children[0].textContent, String(f.calls.at(-1).start));
});
test('V-07: cambiar de consulta cierra tabla y descarta una respuesta en vuelo', async () => {
  let resolvePending;
  const f = fixture((start, limit) => new Promise((resolve) => { resolvePending = () => resolve({ rows: dataRows(start, limit), total: 10 }); }));
  f.preview.update(status('old'));
  f.disclosure.open = true;
  f.disclosure.fire('toggle');
  f.preview.update(status('new'));
  assert.equal(f.disclosure.open, false);
  assert.equal(f.scroller.scrollTop, 0);
  resolvePending();
  await tick();
  assert.equal(f.tbody.children.length, 0);
});
test('V-08: durante ejecución o sin filas terminadas, no se habilita la vista', () => {
  const f = fixture();
  f.preview.update(status('j', 10, 1, 'running'));
  assert.equal(f.disclosure.hidden, true);
  f.preview.update(status('j', 10, 0, 'paused'));
  assert.equal(f.disclosure.hidden, true);
  f.preview.update(status('j', 10, 1, 'paused'));
  assert.equal(f.disclosure.hidden, false);
});
test('V-09: estructura, sticky header, scroll doble, límite cinco filas y sin afectar exportación', () => {
  const root = new URL('..', import.meta.url);
  const html = readFileSync(new URL('panel.html', root), 'utf8');
  const css = readFileSync(new URL('panel.css', root), 'utf8');
  const js = readFileSync(new URL('panel.js', root), 'utf8');
  assert.match(html, /<details id="results-preview"[^>]*hidden>/);
  assert.match(html, /<tbody id="preview-body"><\/tbody>/);
  assert.match(css, /\.preview-scroll\s*\{[^}]*max-height:204px;[^}]*overflow:auto;/);
  assert.match(css, /\.preview-scroll th\s*\{[^}]*position:sticky;top:0;/);
  assert.match(js, /const includeHeaders = elements\.headers\.checked;/);
  assert.match(js, /toTsv\(rows, includeHeaders, outputColumns\(\)\)/);
  assert.match(js, /toCsv\(rows, outputColumns\(\)\)/);
});
test('V-10: colapsar no conserva filas visibles ni realiza consultas adicionales', async () => {
  const f = fixture(async (start, limit) => ({ rows: dataRows(start, limit), total: 10 }));
  f.preview.update(status());
  f.disclosure.open = true;
  f.disclosure.fire('toggle');
  await tick();
  const initial = f.calls.length;
  f.disclosure.open = false;
  f.disclosure.fire('toggle');
  assert.equal(f.tbody.children.length, 0);
  f.scroller.fire('scroll');
  await tick();
  assert.equal(f.calls.length, initial);
});


test('V-11: la tabla cambia encabezados y celdas según columnas seleccionadas sin pedir datos fiscales', async () => {
  const f=fixture(); const columns=['CUIT','AGIP Retención (%)','AGIP Estado'];
  f.preview.update(status(),columns); f.disclosure.open=true;f.disclosure.fire('toggle');await tick();
  const head=f.table.children.find(x=>x.tagName==='thead');assert.deepEqual(head.children[0].children.map(x=>x.textContent),columns);
  assert.equal(f.tbody.children.filter(x=>x.className!=='preview-spacer')[0].children.length,3);
  f.preview.update(status(),COLUMNS);await tick();assert.equal(head.children[0].children.length,10);
});
