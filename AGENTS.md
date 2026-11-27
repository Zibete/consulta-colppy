# Contrato de desarrollo — Consulta Colppy

- La fuente de verdad de negocio es el script original `busquedaArcaColppy.js`, salvo decisiones expresas de mejora (validación DV, deduplicación de consultas sin alterar filas, mojibake, panel y control de ejecución).
- Lectura solamente: lista cerrada de operaciones permitidas: `Tercero / obtener_datos_tercero_de_afip`, `Retencion / consultaPadronIIBB` (ARBA, idProvincia 2), `Retencion / consultaAlicuotaAgip` (AGIP). Las nuevas consultas requieren autorización de uso y del plan contratado antes de ejecutarlas en producción. No crear, modificar ni eliminar registros en Colppy/ARCA.
- Minimizar permisos: únicamente `https://login.colppy.com/*`, sidePanel, scripting, storage de sesión, alarms y clipboardWrite. No incorporar otros hosts, APIs o integraciones sin revisión.
- La sesión (usuario, claveSesion, cookie, tokens, idEmpresa) se utiliza únicamente dentro del contexto original Colppy. Nunca llevar credenciales al panel, almacenamiento, red externa o logs.
- Datos de consulta y resultados se almacenan solo en `chrome.storage.session`, temporal hasta cierre de navegador; no almacenar en disco salvo exportación explícita del usuario.
- Todo corte de ejecución debe conservar checkpoints, no ocultar filas ni declarar resultados sin consultas completadas. La pausa es cooperativa al finalizar la solicitud en curso.
- Conservar las diez columnas originales en ARCA estándar y el orden/duplicados de las entradas; agregar columnas solo según selección de fuentes y opción de información adicional. TSV sin encabezados por defecto; checkbox opcional para incluirlos al copiar. CSV UTF-8 BOM con encabezados para descargar.
- Reparar mojibake solo en patrones inequívocos; conservar la cadena intacta si no puede repararse. No usar sustituciones genéricas.
- Git en rama de trabajo y PR revisable; sin dependencias de terceros. Tests offline con datos ficticios; documentar explícitamente qué no ha sido verificado en Colppy real.
- No solicitar ni incorporar datos reales de clientes ni credenciales en tests, ejemplos, documentación o diagnósticos públicos.

## Flujo de autenticación v1.1
- Al presionar Consultar, reutilizar una pestaña Colppy o abrir `https://login.colppy.com/` y esperar a que el preflight quede listo antes de consultar. Conservar CUIT y checkpoints en `storage.session`.
- No solicitar, guardar ni transmitir claves. El asistente MAIN world solo verifica que los campos estén completos y hace **un único** clic en un submit inequívoco, si no hay interacción manual, CAPTCHA ni MFA. Nunca devuelve valores. No intenta eludir controles de seguridad.
- El auto-submit es una mejora condicionada al HTML real de Colppy: sin formulario estándar, el usuario debe iniciar sesión manualmente.
- Pausar o descartar mientras espera login cancela el asistente del documento vigente. Tras iniciar sesión, retomar únicamente desde el siguiente par CUIT + fuente no confirmado.

## Navegación en segundo plano v1.1.1
- Abrir Colppy con `chrome.tabs.create({ active: false })`. Reutilizar pestañas existentes sin activarlas, y los redirects de sesión vencida nunca deben forzar foco.
- El usuario puede necesitar activar manualmente Colppy para autocompletar credenciales o completar MFA; no simular foco ni burlar controles.


## Tabla de resultados v1.1.2
- Cambio de presentación exclusivamente: desplegable en paso 3, inicialmente cerrado, sin consultas adicionales al servidor Colppy.
- Mostrar los encabezados seleccionados (diez columnas en ARCA estándar) con encabezados fijos, scroll horizontal y vertical limitado a cinco filas visibles.
- Consultar solo las filas visibles mediante `GET_ROWS`, con virtualización para no construir 10.000 filas/celdas en el DOM.
- Activar solo en pausa o al terminar; conservar la indicación explícita de `Pendiente` en exportaciones parciales.
- Aislar lecturas asíncronas por ID de consulta, sin reutilizar datos de otra ejecución; usar `textContent` para datos externos.
- Conservar TSV sin encabezados por defecto, CSV con encabezados y compatibilidad de ARCA estándar. No ampliar permisos.

## Contrato v2.0
- ARCA seleccionado por defecto; ARBA y AGIP opcionales. Fecha ARBA congelada al iniciar, por defecto fecha actual de Argentina; no enviar fechas futuras.
- Checkpoint atómico por CUIT + organismo. Pausa cooperativa; si una solicitud termina mientras se pausa, preservar su resultado. Nunca repetir un resultado confirmado al reanudar.
- Conservar alícuota cero; no confundir ausencia de datos, padrón no disponible, error y pendiente. No inferir vigencia ni inscripción activa.
- Filtrar campos en MAIN world; excluir DNI, respuestas completas y credenciales. No incorporar FCE ni hosts nuevos.
- Fecha de consulta no equivale a fecha de actualización del dato. No prometer tiempo real; documentar la procedencia y sus límites fuera de la UI.
- QA offline con datos ficticios; validación real independiente y autorización de uso antes de distribuir.
