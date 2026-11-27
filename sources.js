import { COLUMNS, emptyRow, normalizeColppyResponse, repairMojibake } from './core.js';
import { describeTax } from './tax-catalog.js';

export const SOURCES = Object.freeze(['ARCA', 'ARBA', 'AGIP']);
export const EXTRA_COLUMNS = Object.freeze(['Tipo de persona', 'Mes de cierre', 'Código de actividad', 'Actividad económica', 'Códigos de impuestos', 'Descripción de impuestos']);
const ARBA_COLUMNS = ['ARBA Retención (%)', 'ARBA Percepción (%)', 'ARBA Estado', 'ARBA Fecha solicitada', 'ARBA Fecha consulta'];
const AGIP_COLUMNS = ['AGIP Retención (%)', 'AGIP Percepción (%)', 'AGIP Estado', 'AGIP Fecha consulta'];
export function argentinaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({type, value}) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
export function validDate(value, today = argentinaDate()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value && value <= today;
}
export function selection(message = {}) {
  const requested = message.sources ?? ['ARCA'];
  if (!Array.isArray(requested) || !requested.length || requested.some(s => !SOURCES.includes(s))) throw new Error('Seleccioná al menos una consulta válida.');
  const sources = SOURCES.filter(s => requested.includes(s));
  const arbaDate = sources.includes('ARBA') ? (message.arbaDate ?? argentinaDate()) : null;
  if (arbaDate !== null && !validDate(arbaDate)) throw new Error('Seleccioná una fecha ARBA válida, no posterior a hoy.');
  return { sources, arbaDate };
}
export function columnsFor(sources = ['ARCA'], extended = false) {
  return [...(sources.includes('ARCA') ? COLUMNS : ['CUIT', 'Estado', 'Error']),
    ...(sources.includes('ARCA') && extended ? EXTRA_COLUMNS : []),
    ...(sources.includes('ARBA') ? ARBA_COLUMNS : []), ...(sources.includes('AGIP') ? AGIP_COLUMNS : [])];
}
const good = x => [true, 1, 'true'].includes(x);
const bad = x => [false, 0, 'false'].includes(x);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const scalar = x => typeof x === 'string' || typeof x === 'number' ? repairMojibake(String(x)) : '';
const rate = x => typeof x === 'string' && /^\d+(?:[.,]\d+)?$/.test(x.trim()) ? x : typeof x === 'number' && Number.isFinite(x) && x >= 0 ? String(x) : null;
export function normalizeSource(source, cuit, answer, date = new Date().toISOString()) {
  const finish = (status, error = '', data = {}) => ({ status, error, date, data });
  if (answer?.kind === 'padron') return finish('Padrón no disponible', 'Colppy no pudo abrir el padrón.');
  if (answer?.kind === 'http') return finish('Error HTTP', answer.message || 'Error HTTP');
  if (answer?.kind !== 'response') return finish('Error', answer?.message || 'Respuesta no reconocida de Colppy.');
  const json = answer.data, result = json?.result, response = json?.response;
  const message = scalar(response?.message || response?.mensaje || result?.mensaje);
  if (!obj(response) || (!good(response.success) && !bad(response.success))) return finish('Error', 'Estructura inesperada de Colppy.');
  if (source === 'ARCA') {
    // Preservar el contrato histórico de respuesta negativa, pero no declarar OK ante data ausente.
    if (!obj(result) || result.estado == null) return finish('Error', 'Estructura inesperada de Colppy.');
    if (bad(response.success)) return finish('Sin datos', message || 'Colppy no informó el motivo');
    if (String(result.estado) !== '0' || !obj(response.data) || ![response.data.nombre, response.data.idCondicionIva, response.data.tipoPersona, response.data.mesCierre].some(x => typeof x === 'string' && x.trim() || typeof x === 'number' && Number.isFinite(x))) return finish('Error', message || 'Respuesta fiscal incompleta.');
    const { row, repaired } = normalizeColppyResponse(cuit, json);
    const d = response.data;
    return {...finish('OK', '', { row, extra: { tipoPersona: scalar(d.tipoPersona), mesCierre: scalar(d.mesCierre), idActividad: scalar(d.idActividad), descActividad: scalar(d.descActividad), impuestos: Array.isArray(d.impuestos) ? d.impuestos.filter(x => /^\d+$/.test(String(x))).map(String) : [], ivaLabel: scalar(d.condicionIva?.label) } }), repaired};
  }
  // AGIP puede omitir result. ARBA exige el estado observado.
  if ((source === 'ARBA' && (!obj(result) || result.estado == null)) || (result?.estado != null && String(result.estado) !== '0')) return finish('Error', message || 'Colppy informó un error.');
  if (bad(response.success)) return finish('Sin datos', message || 'Colppy no devolvió datos.');
  const payload = response.data;
  if (payload == null || payload === false || (Array.isArray(payload) && !payload.length) || (obj(payload) && !Object.values(payload).some(x => x != null))) return finish('Sin datos', message || 'Colppy no devolvió datos.');
  const d = source === 'AGIP' && Array.isArray(payload) && payload.length === 1 ? payload[0] : source === 'ARBA' ? payload : null;
  if (!obj(d)) return finish('Error', 'Estructura de alícuotas inesperada.');
  const retencion = rate(d.retencion), percepcion = rate(d.percepcion);
  if (retencion === null || percepcion === null) return finish('Error', 'Respuesta de alícuotas incompleta o inválida.');
  return finish('OK', '', { retencion, percepcion });
}
export function aggregate(record, sources) {
  if (record?.invalid) return 'CUIT inválido';
  const statuses = sources.map(s => record?.results?.[s]?.status ?? 'Pendiente');
  if (statuses.includes('Pendiente')) return 'Pendiente';
  if (statuses.some(x => !['OK','Sin datos'].includes(x))) return 'Error';
  if (statuses.includes('Sin datos')) return 'Sin datos';
  return 'OK';
}
export function projectRow(cuit, record, options) {
  const sources = options.sources ?? ['ARCA'];
  const results = record?.results ?? {};
  const arca = results.ARCA;
  const row = arca?.data?.row ? {...arca.data.row} : emptyRow(cuit);
  row.Estado = record?.invalid ? 'CUIT inválido' : sources.includes('ARCA') ? (arca?.status ?? 'Pendiente') : aggregate(record, sources);
  const errors = sources.flatMap(s => results[s]?.error ? [sources.length === 1 ? results[s].error : `${s}: ${results[s].error}`] : []);
  if (record?.invalid) row.Error = 'Debe tener 11 dígitos y dígito verificador válido.';
  else row.Error = errors.join(' | ') || (row.Estado === 'Pendiente' ? 'No procesado todavía.' : '');
  const extra = arca?.data?.extra ?? {};
  const taxes = extra.impuestos ?? [];
  Object.assign(row, {'Tipo de persona': extra.tipoPersona, 'Mes de cierre': extra.mesCierre, 'Código de actividad': extra.idActividad, 'Actividad económica': extra.descActividad, 'Códigos de impuestos': taxes.join(', '), 'Descripción de impuestos': taxes.map(describeTax).join(' | ')});
  for (const s of ['ARBA','AGIP']) {
    if (!sources.includes(s)) continue;
    const r = results[s];
    row[`${s} Retención (%)`] = r?.data?.retencion ?? '';
    row[`${s} Percepción (%)`] = r?.data?.percepcion ?? '';
    row[`${s} Estado`] = record?.invalid ? 'No consultado' : r?.status ?? 'Pendiente';
    row[`${s} Fecha consulta`] = r?.date ?? '';
    if (s === 'ARBA') row['ARBA Fecha solicitada'] = options.arbaDate;
  }
  return row;
}
