// Extracto verificado del catálogo público de ARCA (2026-11-27).
// https://serviciosweb.afip.gob.ar/genericos/conceptosSubconceptosValidos/listadoImpuestos.asp
// No implica inscripción activa. Códigos sin correspondencia se conservan.
export const TAX_CATALOG = Object.freeze({
  10: 'Ganancias sociedades', 11: 'Ganancias personas físicas', 14: 'Precios de transferencia',
  20: 'Monotributo', 21: 'Monotributo autónomo', 22: 'Monotributo seguridad social',
  24: 'Monotributo obra social', 30: 'IVA', 103: 'Regímenes de información',
  149: 'Créditos y débitos en cuenta corriente', 180: 'Bienes personales',
  181: 'Combustibles líquidos Ley 23966 - naftas', 210: 'Ganancias régimen especial RG 830',
  211: 'Bienes personales - acciones o participaciones', 216: 'SIRE - IVA',
  217: 'SICORE - Ganancias', 218: 'Ganancias - beneficiarios del exterior',
  219: 'SICORE - Bienes personales', 228: 'Fondo hídrico de infraestructura',
  229: 'Recargo sobre el gas natural', 240: 'Nafta - fondo hídrico de infraestructura',
  301: 'Empleador - aportes seguridad social', 302: 'Aportes obras sociales',
  308: 'Aportes seguridad social autónomos', 312: 'Riesgos del trabajo',
  351: 'Contribuciones seguridad social', 352: 'Contribuciones obra social',
  353: 'Retenciones contribuciones seguridad social', 377: 'Combustibles líquidos Ley 23966/24699 art. 2 A',
  395: 'Combustibles líquidos Ley 23966/24699 art. 2 B', 398: 'Impuesto sobre gasoil',
  729: 'IVA aduana', 767: 'SICORE - retenciones y percepciones',
  787: 'Retenciones art. 79 Ganancias inc. A, B y C', 789: 'Créditos y débitos en cuentas bancarias',
  945: 'Aportes trabajadores casas particulares', 946: 'Contribuciones trabajadores casas particulares',
  947: 'Obra social trabajadores casas particulares', 1018: 'CO2 - naftas',
  1019: 'CO2 - solventes, aguarrás, gasolinas', 1020: 'CO2 - gasoil, diesel oil y kerosene',
  1021: 'Dióxido de carbono - fuel oil', 1022: 'CO2 - coque petróleo y carbón mineral'
});
export function describeTax(code) {
  return Object.hasOwn(TAX_CATALOG, code) ? TAX_CATALOG[code] : `Código ${code} (sin descripción)`;
}
