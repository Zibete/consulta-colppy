/** Reglas puras: sin red, sin estado ni dependencias de Chrome. */
export const COLUMNS = Object.freeze([
  'CUIT', 'Estado', 'Razón social', 'Condición IVA', 'Dirección',
  'Localidad', 'CP', 'Provincia', 'País', 'Error'
]);
export const VAT_CONDITIONS = Object.freeze({
  '1': 'Responsable Inscripto',
  '2': 'Exento',
  '3': 'Consumidor Final',
  '4': 'Monotributo',
  '5': 'Del Exterior'
});
export const MAX_CUITS = 10000;
export const INTERVAL_MS = 300;

/** Soporta comas, punto y coma, |, tabuladores, saltos y espacios; conserva orden y duplicados. */
export function parseCuits(text) {
  return String(text ?? '')
    .split(/[\s,;|]+/u)
    .map((token) => token.replace(/\D/gu, ''))
    .filter(Boolean);
}

export function isValidCuit(cuit) {
  if (!/^\d{11}$/.test(cuit)) return false;
  const multipliers = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = multipliers.reduce((acc, multiplier, index) => acc + Number(cuit[index]) * multiplier, 0);
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? 0 : remainder === 10 ? 9 : remainder;
  return Number(cuit[10]) === expected;
}

/** CP1252 inverso para caracteres de control UTF-8 interpretados como Windows-1252. */
const cp1252 = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C],
  [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93],
  [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B],
  [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F]
]);
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeCandidate(fragment) {
  const bytes = [];
  for (const ch of fragment) {
    const code = ch.codePointAt(0);
    const byte = code <= 255 ? code : cp1252.get(code);
    if (byte === undefined) return fragment;
    bytes.push(byte);
  }
  try { return utf8.decode(Uint8Array.from(bytes)); } catch { return fragment; }
}

/** Reparación conservadora de patrones demostrables de UTF-8 interpretado como Latin-1/CP1252. */
export function repairMojibake(value) {
  if (typeof value !== 'string' || !/[ÃÂâ]/u.test(value)) return value;
  // Repara secuencias locales sin corromper texto adyacente que ya era Unicode correcto.
  return value.replace(/(?:Ã[\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2018-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]|Â[\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2018-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]|â[\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2018-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]{2})/gu,
    (segment) => decodeCandidate(segment));
}

export function emptyRow(cuit) {
  return {
    CUIT: cuit, Estado: '', 'Razón social': '', 'Condición IVA': '',
    'Dirección': '', Localidad: '', CP: '', Provincia: '', País: '', Error: ''
  };
}

export function normalizeColppyResponse(cuit, json) {
  const row = emptyRow(cuit);
  const valid = json && json.result && String(json.result.estado) === '0' &&
    json.response && [true, 1, 'true'].includes(json.response.success);
  if (!valid) {
    row.Estado = 'Sin datos';
    row.Error = json?.response?.message || json?.response?.mensaje ||
      json?.result?.mensaje || 'Colppy no informó el motivo';
  } else {
    const data = json.response.data || {};
    const address = data.domicilioFiscal || {};
    const iva = data.idCondicionIva == null ? '' : String(data.idCondicionIva);
    row.Estado = 'OK';
    row['Razón social'] = data.nombre || '';
    row['Condición IVA'] = VAT_CONDITIONS[iva] || (iva ? `Condición desconocida: ${iva}` : '');
    row['Dirección'] = address.direccion || '';
    row.Localidad = address.localidad || '';
    row.CP = address.codPostal || '';
    row.Provincia = address.provincia || '';
    row.País = data.pais || '';
  }
  let repaired = 0;
  for (const key of COLUMNS) {
    const original = String(row[key] ?? '');
    const fixed = repairMojibake(original);
    if (original !== fixed) repaired += 1;
    row[key] = fixed;
  }
  return { row, repaired };
}

export function safeCell(value) {
  const text = String(value ?? '').replace(/[\t\r\n]+/gu, ' ').trim();
  // Impide que Excel evalúe cadenas devueltas por sistemas externos como fórmulas.
  return /^[\x00-\x20]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

export function toTsv(rows, includeHeaders = false) {
  const data = rows.map((row) => COLUMNS.map((c) => safeCell(row[c])).join('\t'));
  return (includeHeaders ? [COLUMNS.join('\t'), ...data] : data).join('\r\n');
}

function csvCell(value) {
  const text = safeCell(value);
  return /[;"\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}
export function toCsv(rows) {
  return '\uFEFF' + [COLUMNS.join(';'), ...rows.map((row) => COLUMNS.map((c) => csvCell(row[c])).join(';'))].join('\r\n');
}
