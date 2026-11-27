import test from 'node:test';
import assert from 'node:assert/strict';
import { argentinaDate, validDate, selection, columnsFor, normalizeSource, aggregate, projectRow, formatRate, formatQueryDate } from '../sources.js';
import { COLUMNS, toTsv, toCsv } from '../core.js';
import { describeTax } from '../tax-catalog.js';
const cuit = '20123456780';
const at = '2026-01-15T12:00:00.000Z';
const answer = (data, result = { estado: 0 }, success = true) => ({kind:'response',data:{result,response:{success,data}}});
test('S-01: selección cerrada y fecha Argentina, sin fechas futuras ni imposibles', () => {
  assert.deepEqual(selection({}), {sources:['ARCA'],arbaDate:null});
  assert.deepEqual(selection({sources:['AGIP','ARBA','ARBA'],arbaDate:'2020-01-15'}), {sources:['ARBA','AGIP'],arbaDate:'2020-01-15'});
  assert.throws(()=>selection({sources:[]}));
  assert.throws(()=>selection({sources:['FCE']}));
  assert.throws(()=>selection({sources:['ARBA'],arbaDate:'2026-02-30'}));
  assert.equal(argentinaDate(new Date('2026-03-01T01:00:00Z')), '2026-02-28');
  assert.equal(validDate('2026-03-01','2026-02-28'),false);
});
test('S-02: exportación estándar y combinaciones de columnas', () => {
  assert.deepEqual(columnsFor(), COLUMNS);
  assert.equal(columnsFor(['ARCA'],true).length,16);
  assert.equal(columnsFor(['ARCA','ARBA']).length,15);
  assert.equal(columnsFor(['ARCA','AGIP']).length,14);
  assert.equal(columnsFor(['ARCA','ARBA','AGIP'],true).length,25);
  assert.deepEqual(columnsFor(['AGIP']).slice(0,3),['CUIT','Estado','Error']);
});
test('S-03: ARBA y AGIP aceptan cero, contratos distintos y fecha', () => {
  const a = normalizeSource('ARBA',cuit,answer({retencion:'0.00',percepcion:'0.80'}),at);
  const g = normalizeSource('AGIP',cuit,{kind:'response',data:{response:{success:true,data:[{retencion:'0',percepcion:'0.01'}]}}},at);
  assert.deepEqual(a,{status:'OK',error:'',date:at,data:{retencion:'0.00',percepcion:'0.80'}});
  assert.equal(g.status,'OK'); assert.equal(g.data.retencion,'0');
});
test('S-04: errores, ausencia y padrón no disponible son distintos', () => {
  assert.equal(normalizeSource('AGIP',cuit,answer([])).status,'Sin datos');
  assert.equal(normalizeSource('ARBA',cuit,answer(null)).status,'Sin datos');
  assert.equal(normalizeSource('ARBA',cuit,answer({}, {estado:0},false)).status,'Sin datos');
  assert.equal(normalizeSource('ARBA',cuit,{kind:'padron'}).status,'Padrón no disponible');
  assert.equal(normalizeSource('ARBA',cuit,{kind:'http',message:'HTTP 500'}).status,'Error HTTP');
  assert.equal(normalizeSource('ARBA',cuit,answer({retencion:'0',percepcion:'0'},{estado:1})).status,'Error');
  assert.equal(normalizeSource('AGIP',cuit,answer([{retencion:'0'}])).status,'Parcial');
  assert.equal(normalizeSource('ARCA',cuit,answer({})).status,'Error');
  assert.equal(normalizeSource('ARCA',cuit,answer(null)).status,'Error');
});
test('S-05: impuestos desconocidos, extensión opcional, fecha y resultados parciales', () => {
  const a = normalizeSource('ARCA',cuit,answer({nombre:'Empresa ficticia',tipoPersona:'JURIDICA',impuestos:[30,999999],numeroDocumento:'NO MOSTRAR'}),at);
  const b = normalizeSource('ARBA',cuit,answer({retencion:'0.00',percepcion:'0.80'}),at);
  const record={results:{ARCA:a,ARBA:b}};
  const options={sources:['ARCA','ARBA','AGIP'],arbaDate:'2020-01-15'};
  const row=projectRow(cuit,record,options);
  assert.equal(aggregate(record,options.sources),'Pendiente');
  assert.equal(row['ARCA Estado'],undefined);
  assert.equal(row.Estado,'Pendiente'); assert.equal(row['AGIP Estado'],'Pendiente');
  assert.equal(row['ARBA Fecha solicitada'],'15/01/2020'); assert.equal(row['ARBA Fecha consulta'],'15/01/2026 09:00:00');
  assert.equal(row['Códigos de impuestos'],'30, 999999'); assert.match(row['Descripción de impuestos'],/IVA.*999999/);
  assert.equal(JSON.stringify(row).includes('NO MOSTRAR'),false);
  assert.equal(describeTax(11),'Ganancias personas físicas');
  assert.match(describeTax(308),/autónomos/);
  assert.equal(toTsv([row]).split('\t').length,10);
  assert.equal(toTsv([row],true,columnsFor(options.sources,true)).split('\r\n')[0].split('\t').length,25);
  assert.equal(toCsv([row],columnsFor(options.sources,true)).charCodeAt(0),0xfeff);
});
test('S-06: resultado mixto no pierde datos confirmados y marca error por fuente', () => {
  const a=normalizeSource('ARBA',cuit,answer({retencion:'0',percepcion:'0.2'}),at);
  const g=normalizeSource('AGIP',cuit,{kind:'http',message:'HTTP 500'},at);
  const record={results:{ARBA:a,AGIP:g}}, opts={sources:['ARBA','AGIP'],arbaDate:'2020-01-15'};
  const row=projectRow(cuit,record,opts);
  assert.equal(aggregate(record,opts.sources),'Error'); assert.equal(row.Estado,'Error');
  assert.equal(row['ARBA Retención (%)'],'0,00'); assert.equal(row['AGIP Retención (%)'],'');
  assert.equal(row['AGIP Estado'],'Error HTTP'); assert.match(row.Error,/AGIP/);
  const invalid=projectRow(cuit,{invalid:true},opts);assert.equal(invalid['ARBA Estado'],'No consultado');
});


test('S-07: 10000 filas ficticias con tres fuentes y exportación sin pérdida', () => {
  const options = { sources:['ARCA','ARBA','AGIP'], arbaDate:'2020-01-15' };
  const a = normalizeSource('ARCA',cuit,answer({nombre:'Empresa sintética',tipoPersona:'JURIDICA',idCondicionIva:1,mesCierre:12,idActividad:123456,descActividad:'Actividad ficticia',impuestos:Array.from({length:24},(_,i)=>1000+i),domicilioFiscal:{direccion:'Calle ficticia 123',localidad:'Ciudad ficticia',codPostal:'1000',provincia:'CABA'},pais:'Argentina'}),at);
  const b = normalizeSource('ARBA',cuit,answer({retencion:'0',percepcion:'0.80'}),at);
  const g = normalizeSource('AGIP',cuit,answer([{retencion:'0.10',percepcion:'0'}]),at);
  const record={results:{ARCA:a,ARBA:b,AGIP:g}};
  const rows=Array.from({length:10000},(_,i)=>projectRow(String(i).padStart(11,'0'),record,options));
  const cols=columnsFor(options.sources,true);
  const csv=toCsv(rows,cols);assert.equal(csv.split('\r\n').length,10001);
  assert.equal(toTsv(rows,true,cols).split('\r\n').length,10001);
  const estimatedBytes = (Buffer.byteLength(JSON.stringify(record))+64)*10000+300000;
  assert.ok(estimatedBytes<10*1024*1024, `Fixture excede la cuota estimada: ${estimatedBytes}`);
});

test('S-08: conserva cada alícuota válida, incluso cero, ante otra ausente o inválida', () => {
  const a=normalizeSource('ARBA',cuit,answer({percepcion:' 0.80 '}),at);
  const g=normalizeSource('AGIP',cuit,answer([{retencion:0,percepcion:'invalid'}]),at);
  assert.equal(a.status,'Parcial'); assert.match(a.error,/Retención: sin dato/);
  assert.equal(a.data.percepcion,'0.80');
  assert.equal(g.status,'Parcial'); assert.match(g.error,/Percepción: valor inválido/);
  assert.equal(g.data.retencion,'0');
  const row=projectRow(cuit,{results:{ARBA:a,AGIP:g}},{sources:['ARBA','AGIP'],arbaDate:'2020-01-15'});
  assert.equal(row.Estado,'Parcial'); assert.equal(row['ARBA Retención (%)'],'');
  assert.equal(row['ARBA Percepción (%)'],'0,80'); assert.equal(row['AGIP Retención (%)'],'0,00');
  assert.equal(row['AGIP Percepción (%)'],'');
  assert.equal(normalizeSource('ARBA',cuit,answer({retencion:' ',percepcion:null})).status,'Sin datos');
  assert.equal(normalizeSource('ARBA',cuit,answer({retencion:'X',percepcion:'Y'})).status,'Error');
});
test('S-09: ausencia con mensaje de éxito no implica CUIT fuera de padrón', () => {
  for(const data of [null, [], {retencion:null,percepcion:null}]) {
    const r=answer(data); r.data.response.message='Operacion realizada con exito';
    const g=normalizeSource('AGIP',cuit,r,at);
    assert.equal(g.status,'Sin datos'); assert.doesNotMatch(g.error,/exito|no encontrado/i); assert.match(g.error,/no devolvió/);
  }
  const r=answer(null,{estado:0},false); r.data.response.message='El CUIT no se encuentra en el Padron';
  assert.equal(normalizeSource('ARBA',cuit,r).error,r.data.response.message);
});
test('S-10: fechas argentinas cruzan medianoche UTC y tasas respetan precisión', () => {
  assert.equal(formatQueryDate('2026-11-28T01:01:02.345Z'),'27/11/2026 22:01:02');
  assert.equal(formatQueryDate('2026-11-28T03:00:00Z'),'28/11/2026 00:00:00');
  assert.equal(formatQueryDate('invalid'),'');
  for(const [input,expected] of [[' 2 ','2,00'],['0.00','0,00'],['1,5','1,50'],['0.1250','0,125'],[null,''],['-1','']]) assert.equal(formatRate(input),expected);
});
test('S-11: Estado general es el mismo agregado que usan los contadores', () => {
  const opts={sources:['ARCA','ARBA','AGIP'],arbaDate:'2020-01-15'};
  const result=status=>({status,data:{},error:''});
  for(const [statuses,expected] of [[['OK','OK','OK'],'OK'],[['OK','Sin datos','OK'],'Parcial'],[['Sin datos','Sin datos','Sin datos'],'Sin datos'],[['OK','Error','OK'],'Error'],[['OK','Parcial','OK'],'Parcial'],[['OK','Error',null],'Pendiente']]) {
    const record={results:Object.fromEntries(opts.sources.flatMap((s,i)=>statuses[i] ? [[s,result(statuses[i])]] : []))};
    assert.equal(aggregate(record,opts.sources),expected); assert.equal(projectRow(cuit,record,opts).Estado,expected);
  }
});

test('S-12: ARCA sola conserva Error HTTP en tabla y exportaciones estándar y ampliada', () => {
  const arca = normalizeSource('ARCA',cuit,{kind:'http',status:500,message:'HTTP 500'},at);
  const record = {results:{ARCA:arca}}, opts = {sources:['ARCA']};
  const row = projectRow(cuit,record,opts);
  assert.equal(aggregate(record,opts.sources),'Error HTTP');
  assert.equal(row.Estado,'Error HTTP'); assert.equal(row.Error,'HTTP 500');
  for (const extended of [false,true]) {
    const cols = columnsFor(opts.sources,extended);
    assert.equal(toTsv([row],false,cols).split('\t')[1],'Error HTTP');
    assert.match(toCsv([row],cols),/Error HTTP/);
  }
  const arba = normalizeSource('ARBA',cuit,answer({retencion:'0',percepcion:'0.80'}),at);
  const mixed = {results:{ARCA:arca,ARBA:arba}}, mixedOpts = {sources:['ARCA','ARBA'],arbaDate:'2020-01-15'};
  assert.equal(aggregate(mixed,mixedOpts.sources),'Error');
  assert.equal(projectRow(cuit,mixed,mixedOpts).Estado,'Error');
});
