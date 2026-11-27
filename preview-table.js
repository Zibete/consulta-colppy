/** Vista virtualizada: no descarga todos los resultados ni crea miles de celdas en el DOM. */
import { COLUMNS, safeCell } from './core.js';

export const PREVIEW_ROW_HEIGHT = 34;
export const PREVIEW_HEADER_HEIGHT = 34;
export const PREVIEW_VISIBLE_ROWS = 5;
const OVERSCAN = 3;
const WIDTHS = [115, 115, 245, 180, 245, 165, 90, 180, 120, 260];

/** La tabla reserva espacio para todas las filas, pero recupera solo la ventana visible. */
export function previewWindow(scrollTop, total, viewportHeight = PREVIEW_HEADER_HEIGHT + PREVIEW_VISIBLE_ROWS * PREVIEW_ROW_HEIGHT) {
  const count = Math.max(0, Math.trunc(Number(total) || 0));
  const top = Math.max(0, Number(scrollTop) || 0);
  const height = Math.max(PREVIEW_ROW_HEIGHT, Number(viewportHeight) || 0);
  const firstVisible = Math.max(0, Math.floor(top / PREVIEW_ROW_HEIGHT));
  const start = Math.min(count, Math.max(0, firstVisible - OVERSCAN));
  const end = Math.min(count, Math.max(start, Math.ceil((top + height) / PREVIEW_ROW_HEIGHT) + OVERSCAN));
  return { start, end, topHeight: start * PREVIEW_ROW_HEIGHT, bottomHeight: (count - end) * PREVIEW_ROW_HEIGHT };
}

/** Todos los valores se agregan como textContent, nunca innerHTML. */
export function createPreviewTable({ disclosure, scroller, table, tbody, note, fetchRows, document: doc }) {
  const colgroup = doc.createElement('colgroup');
  for (const width of WIDTHS) {
    const col = doc.createElement('col');
    col.style.width = `${width}px`;
    colgroup.append(col);
  }
  const thead = doc.createElement('thead');
  const heading = doc.createElement('tr');
  for (const name of COLUMNS) {
    const th = doc.createElement('th');
    th.scope = 'col';
    th.textContent = name;
    heading.append(th);
  }
  thead.append(heading);
  table.prepend(colgroup, thead);

  let state = null;
  let generation = 0;
  let rendered = '';
  const available = (value) => Boolean(value && ['paused', 'complete'].includes(value.phase) && value.inputCount > 0 && value.next > 0);

  function spacer(height) {
    if (height <= 0) return null;
    const tr = doc.createElement('tr');
    tr.className = 'preview-spacer';
    tr.setAttribute('aria-hidden', 'true');
    const td = doc.createElement('td');
    td.colSpan = COLUMNS.length;
    td.style.height = `${height}px`;
    tr.append(td);
    return tr;
  }

  function paint(range, rows) {
    const children = [];
    const before = spacer(range.topHeight);
    if (before) children.push(before);
    for (let index = range.start; index < range.end; index++) {
      const row = rows?.[index - range.start];
      const tr = doc.createElement('tr');
      for (const field of COLUMNS) {
        const td = doc.createElement('td');
        if (row) {
          const value = safeCell(row[field]);
          td.textContent = value;
          td.title = value;
        } else {
          td.textContent = '…';
          td.className = 'preview-loading-cell';
        }
        tr.append(td);
      }
      children.push(tr);
    }
    const after = spacer(range.bottomHeight);
    if (after) children.push(after);
    tbody.replaceChildren(...children);
  }

  async function refresh(force = false) {
    if (!disclosure.open || !available(state)) return;
    const range = previewWindow(scroller.scrollTop, state.inputCount, scroller.clientHeight);
    const key = `${state.id}:${state.next}:${range.start}:${range.end}`;
    if (!force && key === rendered) return;
    rendered = key;
    const token = ++generation;
    const id = state.id;
    const nextAtRequest = state.next;
    paint(range, null);
    note.textContent = 'Cargando resultados…';
    try {
      const response = await fetchRows(range.start, range.end - range.start);
      if (token !== generation || !disclosure.open || state?.id !== id || !available(state)) return;
      // No representar filas de una consulta reemplazada mientras se recuperaban datos.
      if (state.next !== nextAtRequest) return;
      if (response.total !== state.inputCount || response.rows.length !== range.end - range.start) {
        throw new Error('La cantidad de filas cambió durante la lectura.');
      }
      paint(range, response.rows);
      note.textContent = `${state.inputCount.toLocaleString('es-AR')} filas · desplazate para consultar las demás columnas y registros.`;
    } catch (error) {
      if (token !== generation) return;
      rendered = '';
      note.textContent = `No se pudo cargar la tabla: ${error.message || String(error)}`;
    }
  }

  disclosure.addEventListener('toggle', () => {
    if (disclosure.open) {
      if (available(state)) void refresh(true);
    } else {
      generation++;
      rendered = '';
      tbody.replaceChildren();
      note.textContent = '';
    }
  });
  scroller.addEventListener('scroll', () => { if (disclosure.open) void refresh(); });

  return {
    update(next) {
      const prev = state;
      state = next;
      const canShow = available(next);
      disclosure.hidden = !canShow;
      if (!canShow || (prev?.id && next?.id !== prev.id)) {
        generation++;
        rendered = '';
        disclosure.open = false;
        tbody.replaceChildren();
        scroller.scrollTop = 0;
        scroller.scrollLeft = 0;
        note.textContent = '';
      } else if (disclosure.open && (prev?.next !== next?.next || prev?.phase !== next?.phase)) {
        void refresh(true);
      }
    }
  };
}
