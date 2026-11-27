import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCuits, isValidCuit, repairMojibake, normalizeColppyResponse,
  COLUMNS, toTsv, toCsv, emptyRow
} from '../core.js';

function validCuit(prefix = '2012345678') {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, weight, i) => acc + Number(prefix[i]) * weight, 0);
  const n = 11 - (sum % 11);
  return prefix + (n === 11 ? 0 : n === 10 ? 9 : n);
}

test('P-01: separadores admitidos, orden y duplicados sin crecer verticalmente (parser)', () => {
  assert.deepEqual(parseCuits('20-12345678-6, 30-12345678-7; 20-12345678-6|27-12345678-3\t23-12345678-5\n20-12345678-6'), [
    '20123456786', '30123456787', '20123456786', '27123456783', '23123456785', '20123456786'
  ]);
});
test('P-02: validación de longitud y dígito verificador', () => {
  const valid = validCuit();
  assert.equal(isValidCuit(valid), true);
  assert.equal(isValidCuit(valid.slice(0, 10) + ((Number(valid[10]) + 1) % 10)), false);
  assert.equal(isValidCuit('2012345678'), false);
  assert.equal(isValidCuit('ABC12345678'), false);
});
test('P-03: conserva el esquema de 10 columnas', () => {
  assert.deepEqual(COLUMNS, [
    'CUIT', 'Estado', 'Razón social', 'Condición IVA', 'Dirección',
    'Localidad', 'CP', 'Provincia', 'País', 'Error'
  ]);
});
test('P-04: mapeo IVA y respuesta positiva preservan el contrato', () => {
  const result = normalizeColppyResponse('20123456780', {
    result: { estado: 0 },
    response: { success: true, data: {
      nombre: 'Empresa de prueba', idCondicionIva: 4, pais: 'Argentina',
      domicilioFiscal: { direccion: 'Calle ficticia', localidad: 'Ciudad', codPostal: '1000', provincia: 'Buenos Aires' }
    } }
  });
  assert.equal(result.row.Estado, 'OK');
  assert.equal(result.row['Condición IVA'], 'Monotributo');
  assert.equal(result.row.CP, '1000');
  assert.equal(result.row['Razón social'], 'Empresa de prueba');
});
test('P-05: mapea condición IVA desconocida sin inferir regla fiscal', () => {
  const {row} = normalizeColppyResponse('20123456780', {
    result: { estado: '0' }, response: { success: 1, data: { idCondicionIva: 99 } }
  });
  assert.equal(row['Condición IVA'], 'Condición desconocida: 99');
});
test('P-06: respuesta no satisfactoria conserva motivo y marca Sin datos', () => {
  const {row} = normalizeColppyResponse('20123456780', {
    result: { estado: 2, mensaje: 'No encontrado' }, response: { success: false }
  });
  assert.equal(row.Estado, 'Sin datos');
  assert.equal(row.Error, 'No encontrado');
});
test('P-07: repara mojibake Latin1/CP1252 localmente sin alterar texto correcto', () => {
  assert.equal(repairMojibake('PeÃ±a y CompaÃ±Ã­a'), 'Peña y Compañía');
  assert.equal(repairMojibake('GARCÃA MUÃ‘OZ'), 'GARCÍA MUÑOZ');
  assert.equal(repairMojibake('Société García y MÃ¡s'), 'Société García y Más');
  assert.equal(repairMojibake('Peña y García'), 'Peña y García');
  assert.equal(repairMojibake('Campo Ã no convertible'), 'Campo Ã no convertible');
  assert.equal(repairMojibake('Río de la Plata'), 'Río de la Plata');
});
test('P-08: reporte de campos corregidos por mojibake', () => {
  const normalized = normalizeColppyResponse('20123456780', {
    result: { estado: 0 }, response: { success: 'true', data: {
      nombre: 'PeÃ±a', domicilioFiscal: { localidad: 'CÃ³rdoba', direccion: 'Calle 1' }
    } }
  });
  assert.equal(normalized.row['Razón social'], 'Peña');
  assert.equal(normalized.row.Localidad, 'Córdoba');
  assert.equal(normalized.repaired, 2);
});
test('P-09: TSV conserva filas repetidas y no agrega encabezado', () => {
  const row = emptyRow('20123456780'); row.Estado = 'OK'; row['Razón social'] = 'Ficticia S.A.';
  const text = toTsv([row,row]);
  assert.equal(text.split('\r\n').length, 2);
  assert.equal(text.startsWith('20123456780\tOK\tFicticia S.A.'), true);
  assert.equal(text.includes('CUIT\tEstado'), false);
});
test('P-10: CSV UTF-8 BOM, punto y coma, encabezados y escape de fórmula', () => {
  const row = emptyRow('20123456780');
  row['Razón social'] = '=HIPERVINCULO("https://ejemplo.test")';
  row.Dirección = 'Calle; ficticia "1"';
  const csv = toCsv([row]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.equal(csv.split('\r\n').length, 2);
  assert.ok(csv.startsWith('\uFEFFCUIT;Estado;Razón social;'));
  assert.ok(csv.includes("'=HIPERVINCULO"));
  assert.ok(csv.includes('"Calle; ficticia ""1"""'));
});
test('P-11: 3500 entradas no deduplicadas en la salida del parser', () => {
  const value = validCuit();
  const input = Array.from({ length: 3500 }, () => value).join('|');
  assert.equal(parseCuits(input).length, 3500);
  assert.equal(new Set(parseCuits(input)).size, 1);
});

test('P-12: incluir encabezados en TSV es optativo y solo agrega la fila de títulos', () => {
  const row = emptyRow('20123456780');
  row.Estado = 'OK';
  row['Razón social'] = 'Empresa sintética';
  const without = toTsv([row]);
  const withHeaders = toTsv([row], true);
  assert.equal(withHeaders, `${COLUMNS.join('\t')}\r\n${without}`);
  assert.equal(withHeaders.split('\r\n').length, 2);
  assert.equal(without.split('\r\n').length, 1);
});

test('P-13: TSV con encabezados mantiene la protección frente a fórmulas', () => {
  const row = emptyRow('20123456780');
  row['Razón social'] = '=RIESGO(A1)';
  const output = toTsv([row], true);
  assert.ok(output.includes("\t'=RIESGO(A1)"));
  assert.equal(output.split('\r\n')[0], COLUMNS.join('\t'));
});
