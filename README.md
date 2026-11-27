# Consulta fiscal · Colppy — extensión Chrome MV3 v1.1.2

Extensión local que reutiliza **la sesión abierta en Colppy** para consultar CUIT mediante la operación de solo lectura `Tercero / obtener_datos_tercero_de_afip`.

## Instalar / actualizar (sujeto a autorización de IT)

1. Descomprimí el ZIP en una carpeta permanente del equipo (no cargar el ZIP directamente).
2. Abrí `chrome://extensions` y activá **Modo desarrollador** si el navegador corporativo lo permite.
3. Si tenías la v1.0 cargada desde otra carpeta, quitá esa extensión anterior **o sustituí los archivos de su carpeta original** y presioná **Actualizar**. No dejes dos copias instaladas.
4. Seleccioná **Cargar descomprimida** y elegí la carpeta `Consulta-Fiscal-Colppy` que contiene `manifest.json`, o actualizá la ya cargada.
5. Hacé clic en el ícono de la extensión, pegá los CUIT y pulsá **Consultar CUIT**. **No hace falta abrir Colppy antes**: se reutiliza una pestaña existente sin activar o se abre `https://login.colppy.com/` en segundo plano (`active: false`).
6. Si Colppy pide autenticación, completala en su propio sitio. Chrome puede autocompletar las credenciales guardadas. La extensión intenta un único clic automático solo cuando reconoce un formulario convencional, ambos campos ya están completos y no detecta CAPTCHA/segundo factor ni escritura manual. Si no es compatible, usá el botón Ingresar normalmente.
7. Cuando la sesión y la pantalla de consultas estén listas, el proceso continúa con los CUIT pendientes. Al finalizar, usá **Copiar Excel** (TSV, sin encabezados por defecto; checkbox opcional para incluirlos) o **Exportar CSV** (UTF-8 con BOM, `;`, siempre con encabezados).

## Visualización v1.1.2

- El paso **3. Resultados** incorpora **Visualizar resultados**, cerrado por defecto y disponible cuando la consulta está pausada o finalizada.
- Despliega los 10 encabezados originales fijos; muestra como máximo cinco filas de datos con scroll vertical y permite recorrer columnas con scroll horizontal.
- La tabla recupera solo el tramo visible desde los resultados temporales ya existentes (`GET_ROWS`), sin solicitudes nuevas a la API de Colppy. No altera datos, duplicados, orden ni archivos exportados.
- Cuando se inicia o descarta otra consulta, la tabla se vuelve a cerrar. Durante la ejecución activa permanece oculta; pausá o aguardá para verla.

## Comportamiento y límites

- Conserva las diez columnas y la cantidad/orden de filas de entrada, incluidos duplicados. Consulta solo una vez cada CUIT repetido.
- Valida 11 dígitos y el dígito verificador antes de invocar Colppy. Los inválidos salen con estado `CUIT inválido`.
- Consultas secuenciales con un intervalo base de **300 ms** y timeout de **20 segundos** cada una. Sin paralelismo ni reintentos automáticos que puedan sobrecargar el servicio.
- El estado y cada resultado único se guardan temporalmente en `chrome.storage.session` para sobrevivir a suspensiones del service worker y permitir pausa/reanudación mientras Chrome permanezca abierto. No sobreviven al cierre/reinicio completo del navegador.
- El panel puede cerrarse y reabrirse sin perder el progreso dentro de la misma sesión de Chrome.
- Si no hay pestaña Colppy, la abre sin quitar el foco de la pestaña actual y espera sesión sin perder los CUIT. Si caduca la sesión durante una tanda, abre el login e intenta retomar desde el checkpoint al autenticarse. Si hay un segundo rechazo o la pestaña se cierra, pausa y deja **Reanudar** disponible.
- **No está garantizado** que Colppy permita autocompletar contraseñas o consultas sostenidas con la pestaña fuera de foco; si requiere interacción, el usuario debe activar manualmente Colppy. Aunque el controlador vive fuera del sitio, cada solicitud usa el contexto original de Colppy y requiere prueba real de pérdida de foco.
- En pausa, la exportación parcial incluye todas las filas originales y marca `Pendiente` para las no consultadas; no las presenta como `OK`.
- La extensión no accede a otros dominios ni persiste claves, cookies o datos fiscales en `storage.local`. No obtiene las credenciales desde Google Password Manager; deja que Chrome las complete en el sitio.
- Los resultados contienen información fiscal y domicilios: usar solo en el entorno corporativo autorizado y custodiar archivos exportados.

## Seguridad

- No modifica registros. Únicamente realiza las consultas de lectura solicitadas por el operador.
- Las variables sensibles (`idUsuario`, `userId`, `password`, `idEmpresaUsuario`) se utilizan **dentro de la pestaña Colppy**, nunca se transfieren al service worker ni al panel; solo se devuelve una selección de campos del resultado. El auto-submit comprueba únicamente que los campos visibles estén completos en el DOM de Colppy y no lee ni devuelve su contenido.
- Permisos del manifest: `sidePanel`, `scripting`, `storage`, `alarms`, `clipboardWrite` y acceso restringido a `https://login.colppy.com/*`.
- No contiene dependencias, bibliotecas remotas, telemetría propia, credenciales ni endpoints adicionales.
- Requiere revisión/permiso de IT conforme al equipo y normativa interna antes de compartir/instalar en el dispositivo de Flor.

## Verificación offline

```bash
node --check core.js
node --check page-query.js
node --check background.js
node --check panel.js
node --test tests/*.test.js
```

## Validación real pendiente (necesaria antes de distribución)

- [ ] Abrir el panel en Colppy real autenticado y verificar preflight sin consultar.
- [ ] Con Chrome sin pestañas Colppy, pulsar Consultar: comprobar apertura en segundo plano, permanencia del foco en la pestaña original y conservación de los CUIT.
- [ ] Sin contraseña guardada: completar acceso manual y verificar reanudación; con credenciales guardadas: comprobar si el auto-submit detecta el HTML real y hace como máximo un clic. Probar también con CAPTCHA/MFA si el sitio los exige, sin automatizarlos.
- [ ] Cerrar el panel durante el login y reabrirlo: confirmar que los CUIT se restauran.
- [ ] Terminar consulta y repetir Consultar con otros CUIT: sin confirmación de reemplazo.
- [ ] Expandir Visualizar resultados con 1, 5 y más de 5 filas: comprobar encabezados, scroll vertical/horizontal, orden, duplicados y ausencia de nuevas llamadas a Colppy.
- [ ] Confirmar checkbox desmarcado por defecto: Copiar Excel sin encabezados; al marcarlo, agregar exactamente las 10 columnas; CSV sin cambios.
- [ ] Ejecutar una consulta de rutina autorizada y comprobar campos contra el script original.
- [ ] Confirmar mojibake, caracteres acentuados, mayúsculas y Excel en una respuesta anonimizada.
- [ ] Probar con 5–10 CUIT, luego 100, después 2.000–3.500 gradualmente y con el consentimiento del equipo responsable de Colppy.
- [ ] Cambiar de pestaña y minimizar Chrome durante una tanda pequeña: comprobar continuidad/pausa/reanudación sin filas perdidas.
- [ ] Verificar que recargar Colppy o cerrar la pestaña no declara consultas inconclusas como correctas.
- [ ] Confirmar que Flor puede instalarla y usar su propia sesión en su equipo autorizado.

**Estado de entrega v1.1.2:** implementación y pruebas offline completadas. Apertura/reanudación y auto-submit requieren validación manual en el Colppy real. No se probó con contraseñas ni con clientes reales.
