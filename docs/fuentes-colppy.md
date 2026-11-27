# Fuentes y contratos observados — noviembre 2026

## Arquitectura

La extensión llama a las funcionalidades de Colppy dentro de su página autenticada (MAIN world, `requestBody`, `Ext.Ajax.request`, POST a `https://login.colppy.com/lib/frontera2/service.php`). No consulta a los organismos directamente. Solo devuelve campos seleccionados; la sesión queda en Colppy.

| Organismo asociado | Operación | Parámetros además de sesión | Respuesta observada |
|---|---|---|---|
| ARCA | Tercero / obtener_datos_tercero_de_afip | cuit, idEmpresa; sesión incluye userId | result.estado, response.success, response.data con nombre, domicilio fiscal, condición IVA, tipoPersona, mesCierre, idActividad/descActividad, impuestos[] y condicionIva.label |
| ARBA | Retencion / consultaPadronIIBB | cuit, fecha AAAA-MM-DD, idProvincia «2» | result.estado, response.success, data{retencion, percepcion} |
| AGIP | Retencion / consultaAlicuotaAgip | cuit | response.success, data[{retencion, percepcion}]; result puede estar ausente |

Las tres operaciones fueron probadas de forma individual durante la investigación anterior al desarrollo. No se ejecutaron consultas reales durante el desarrollo de v2.0. Los ejemplos de tests son ficticios. El DNI no se transfiere. Localidad y actividad pueden faltar; la respuesta no acredita CUIT activo ni inscripción actual en impuestos. El código de IVA sigue el mapeo original; la etiqueta de Colppy se conserva como dato auxiliar interno.

## Origen, fecha y vigencia

- **Observado:** la búsqueda ARCA coincide con el botón nativo de Colppy; los datos tienen campos compatibles con el servicio de constancia de inscripción, y se obtuvieron datos de un CUIT no registrado como tercero en la empresa. El mecanismo y la vigencia interna no son visibles.
- **Documentado:** Colppy describe el uso de padrones ARBA y AGIP; se publican por períodos mensuales. La fecha exacta de carga de Colppy, su política de actualización y su caché de backend no están verificadas. La documentación del plan condiciona el uso de las nuevas operaciones; la respuesta exitosa de un endpoint no concede autorización.
- **Observado:** una consulta histórica ARBA (fecha 2020) devolvió distintas alícuotas de una consulta de 2026 para el mismo CUIT. La fecha influye en el resultado; no demuestra cobertura histórica completa ni que el período devuelto coincida siempre con el solicitado. El cliente nativo usa la fecha actual, no la de un comprobante.
- **Indicio:** el cliente Vue contempla «Unable to open file!» en ARBA; sugiere lectura de archivos pero no prueba dónde están ni cómo se actualizan. AGIP no recibe fecha.
- **Observado:** `service.response_date` coincidió con HTTP Date, ajustado a UTC−3. No se encontraron campos de fecha de actualización o vigencia ni cabeceras HTTP de antigüedad de caché en las respuestas examinadas. Esto no descarta caché en el servidor. El programa registra su propia fecha de consulta, no una fecha de vigencia fiscal.
- **Límite de inferencia:** coincidencia con una fuente oficial o NetSuite, nombre de una función y baja latencia no prueban tiempo real ni independencia entre canales. Para confirmar mecanismo, periodicidad y fecha efectiva de carga se necesita evidencia del proveedor o metadata de origen que no se observó.

## Normalización y errores

Cada fuente conserva sus datos, estado y fecha de consulta. OK requiere datos de estructura válida. En ARBA/AGIP, si solo una alícuota es válida se conserva y el estado es Parcial. Cero explícito es válido. Una respuesta exitosa sin datos útiles no demuestra que el CUIT esté ausente del padrón. Sin datos identifica ausencia de respuesta útil; texto conocido de archivo no disponible, error HTTP, estructura no esperada y pendiente se distinguen. No se convierten errores en cero ni se aplica automáticamente ninguna regla tributaria. El estado de cada fuente se confirma de forma atómica con el checkpoint. Respuestas 429/503 y rechazo de sesión interrumpen la cola para evitar nuevas solicitudes. Los resultados confirmados no se repiten.

## Catálogo de impuestos

`tax-catalog.js` es un extracto versionado de los códigos verificados en el listado público de ARCA consultado el 27/11/2026. Incluye las equivalencias de control 11, 30 y 308 y códigos frecuentes de la investigación. No es una tabla exhaustiva; un código no incluido se conserva con «Código N (sin descripción)». La equivalencia de todos los códigos del padrón con el catálogo no fue verificada. Actualizar mediante revisión del listado oficial; no inferir estado ni vigencia. La consulta no necesita conectarse al catálogo en ejecución.

## Referencias

- [Colppy: crear o modificar proveedor](https://ayuda.colppy.com/es/articles/1263019-crear-o-modificar-un-proveedor)
- [Colppy: retención ARBA](https://ayuda.colppy.com/es/articles/1273216-calculo-de-retencion-de-impuesto-a-los-libb-provincia-de-buenos-aires-arba)
- [Colppy: percepción ARBA](https://ayuda.colppy.com/es/articles/1314123-calculo-de-percepcion-de-impuesto-a-los-libb-provincia-de-buenos-aires-arba)
- [Colppy: retención AGIP](https://ayuda.colppy.com/es/articles/9670254-calculo-automatico-de-retencion-de-agip)
- [ARCA: catálogo de servicios](https://www.arca.gob.ar/ws/documentacion/catalogo.asp)
- [ARCA: listado de impuestos](https://serviciosweb.afip.gob.ar/genericos/conceptosSubconceptosValidos/listadoImpuestos.asp)
- [ARCA: manual WSFECRED v2.0.3](https://servicioscf.afip.gob.ar/facturadecreditoelectronica/documentos/Manual_Desarrollador_WSFECRED_v2.0.3.pdf)

## Fuera de alcance

FCE (`benjamin/fceEmpresa`) identificado en código sin invocar; host y autorización distintos. Estado del CUIT, detalle de impuestos, CAE de terceros y otros padrones no identificados en las interfaces inspeccionadas. Sin integración directa ARCA, FCE, comparación automática NetSuite ni nuevos permisos. La documentación de API requiere acceso autorizado. Las formas de respuesta provincial vacía/de error se modelaron a partir de código cliente y pruebas ficticias; no se observaron todos esos casos reales.
