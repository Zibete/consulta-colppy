# Consulta Colppy · Finance Toolkit

Extensión Chrome MV3 para consultar CUIT, datos fiscales y alícuotas de IIBB mediante la sesión de Colppy. Solo lectura; no modifica registros.

## Instalación / actualización

1. Descomprimí el ZIP en una carpeta permanente. Para actualizar, sustituí los archivos de la carpeta cargada (no instales dos copias).
2. En `chrome://extensions`, activá **Modo desarrollador** si tu política corporativa lo permite; seleccioná **Cargar descomprimida** y la carpeta que contiene `manifest.json`, o recargá la extensión existente.
3. Abrí **Consulta Colppy**, pegá los CUIT, seleccioná las consultas y pulsá **Consultar CUIT**. Colppy se reutiliza o abre en segundo plano. Si necesita autenticación, completala en su propia pestaña; el proceso continúa al estar lista la sesión.

La instalación, distribución y uso de las operaciones debe estar autorizado por la organización y el proveedor. En particular, verificar el plan y autorización para ARBA/AGIP antes de usarlas: Colppy documenta el cálculo automático de alícuotas como una prestación de su plan Enterprise.

## Uso

**1. Ingresar CUIT:** admite coma, punto y coma, tabulador, `|`, espacios y saltos. ARCA está seleccionado por defecto; ARBA y AGIP son opcionales e independientes. Al elegir ARBA, seleccioná la fecha (hoy por defecto, Argentina); queda fija durante la ejecución. El histórico depende del padrón disponible.

**2. Procesamiento:** una solicitud por CUIT único y organismo seleccionado, secuencial y con intervalo de 300 ms. Los CUIT inválidos no generan solicitudes. Los contadores corresponden a CUIT únicos: correcto si todas sus fuentes concluyen OK, error si alguna falla, sin datos si todas están sin datos, parcial si hay datos útiles pero incompletos sin fallo total. Los CUIT no terminados siguen pendientes. La pausa concluye la solicitud en curso y conserva el checkpoint. Reanudar continúa desde el siguiente par CUIT + fuente; descartar elimina la consulta temporal. No se repiten resultados confirmados.

**3. Resultados:** visualización desplegable con encabezados fijos, scroll horizontal y máximo cinco filas visibles; solo recupera el tramo visible del almacenamiento temporal. Podés incluir los campos adicionales de ARCA sin repetir consultas. Copiar Excel genera TSV sin encabezados por defecto; Exportar CSV siempre incluye encabezados (UTF-8 BOM, `;`). Ambas preservan orden y duplicados, y señalan los resultados pendientes en una exportación parcial. Las preferencias de exportación se conservan durante la sesión de Chrome; al finalizar, los selectores de entrada corresponden al próximo lote, y la salida al último lote.

## Formato de salida

ARCA estándar conserva exactamente las diez columnas de v1.1.2: CUIT, Estado, Razón social, Condición IVA, Dirección, Localidad, CP, Provincia, País, Error.

ARCA adicional agrega tipo de persona, mes de cierre, código y descripción de actividad, códigos y descripción de impuestos. Se conserva el código aunque no figure en el extracto del catálogo oficial. No se exporta DNI. ARBA agrega retención, percepción, estado, fecha solicitada y fecha de consulta; AGIP agrega retención, percepción, estado y fecha de consulta. Sin ARCA, las columnas base son CUIT, Estado y Error. Estado resume todas las fuentes seleccionadas con las mismas reglas de los contadores por CUIT único. Si solo se consulta ARCA, se mantiene el estado histórico Error HTTP, contabilizado en Errores. Los estados provinciales se muestran en sus propias columnas. Se conserva cada alícuota válida aunque la otra falte; cero es válido. Se exportan porcentajes con coma decimal, al menos dos decimales y sin redondear precisión adicional. Las fechas se muestran como DD/MM/AAAA (solicitada) y DD/MM/AAAA HH:mm:ss (consulta, Argentina), conservando ISO internamente. No representan la fecha de actualización del padrón.

## Seguridad y límites

- Único host: `https://login.colppy.com/*`. Permisos sin cambios. Lista cerrada de tres operaciones de lectura, sin otros hosts ni credenciales adicionales.
- Las credenciales y la autenticación quedan en el sitio; no se almacenan ni se exportan. No se copian cuerpos HTTP completos. El asistente de login solo hace un clic en formulario inequívoco ya completado, nunca rellena campos ni evita CAPTCHA/MFA. El usuario puede tener que activar la pestaña para completar el acceso.
- Datos en `chrome.storage.session` hasta cerrar Chrome, o exportación explícita. Límite de entrada: 10.000 CUIT. La cuota de sesión depende del volumen de respuestas; si se agota, se pausa sin avanzar el checkpoint. Exportá lo obtenido y dividí el lote. No se promete capacidad ilimitada ni se añaden permisos de almacenamiento.
- Colppy es el proveedor de datos de las tres consultas; la vigencia exacta y la implementación de su backend no se exponen. Ver [fuentes y límites](docs/fuentes-colppy.md). NetSuite puede ser otro canal de contraste; no hay comparador automático.

## Desarrollo y QA

```bash
npm run check
npm test
```

Sin dependencias externas. Tests offline con datos ficticios. Para QA de la aplicación real, usar una sesión y CUIT autorizados, verificar cada modalidad, exportación, fecha ARBA, ceros y errores, pausa/reanudación, cierre de panel y sesión. No registrar credenciales ni respuestas completas. No escalar a lotes masivos sin autorización. Ver [QA independiente](docs/qa.md).
