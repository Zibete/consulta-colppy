/**
 * Asistente acotado de acceso: corre exclusivamente en MAIN world, dentro de Colppy.
 * Nunca devuelve, copia, registra ni almacena el contenido de campos de credenciales.
 * Solo una pulsación automática por documento y únicamente tras el clic Consultar.
 * No rellena formularios, evita segundo factor/CAPTCHA y deja el acceso manual intacto.
 */
export function pageAssistLogin() {
  const g = globalThis;
  if (g.location?.origin !== 'https://login.colppy.com' || !g.document) {
    return { monitoring: false };
  }
  const marker = '__consultaFiscalColppyAutoLoginV11';
  if (g[marker]) return { monitoring: true };
  const state = { submitted: false, manualEntry: false };
  g[marker] = state;

  const visible = (element) => !!element && !element.disabled &&
    typeof element.getClientRects === 'function' && element.getClientRects().length > 0;
  // La escritura manual desactiva el auto-submit; el usuario puede continuar normalmente.
  g.document.addEventListener('keydown', (event) => {
    if (event.isTrusted && event.target?.matches?.('input') && event.key.length === 1) {
      state.manualEntry = true;
    }
  }, true);

  function attemptSubmit() {
    if (state.submitted || state.manualEntry) return;
    const passwords = [...g.document.querySelectorAll('input[type="password"]')].filter(visible);
    if (passwords.length !== 1) return;
    const form = passwords[0].closest('form');
    if (!form) return;
    // No actuar ante login ambiguo, MFA, challenge, CAPTCHA o cambio de contraseña.
    if (form.querySelector('[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[name*="confirm" i], input[name*="captcha" i], [class*="captcha" i], [id*="captcha" i], iframe')) return;
    const users = [...form.querySelectorAll('input[type="email"], input[type="text"], input[autocomplete="username"]')]
      .filter(visible);
    if (users.length !== 1) return;
    const buttons = [...form.querySelectorAll('button, input[type="submit"]')]
      .filter((el) => visible(el) && el.type === 'submit');
    if (buttons.length !== 1) return;
    // Solo comprobación de presencia: nunca extraer la contraseña ni exponer sus valores.
    if (!users[0].value?.trim() || !passwords[0].value) return;
    state.submitted = true;
    clearInterval(interval);
    clearTimeout(expiration);
    buttons[0].click();
  }

  // Autofill puede ocurrir después de DOMContentLoaded y no emitir eventos input.
  const interval = g.setInterval(attemptSubmit, 600);
  const expiration = g.setTimeout(() => g.clearInterval(interval), 30000);
  state.stop = () => { state.manualEntry = true; g.clearInterval(interval); g.clearTimeout(expiration); };
  attemptSubmit();
  return { monitoring: true };
}

export function pageCancelLoginAssist() {
  if (globalThis.location?.origin !== 'https://login.colppy.com') return;
  const state = globalThis.__consultaFiscalColppyAutoLoginV11;
  if (state?.stop) state.stop();
  delete globalThis.__consultaFiscalColppyAutoLoginV11;
}

/**
 * Este módulo define funciones autosuficientes que Chrome ejecuta en MAIN world.
 * NO se trasladan variables de sesión, cookies, requestBody ni credenciales a la extensión.
 */
export function pagePreflight() {
  const g = globalThis;
  const ext = typeof Ext !== 'undefined' ? Ext : g.Ext;
  const buildBody = typeof requestBody !== 'undefined' ? requestBody : g.requestBody;
  const api = typeof urlapi !== 'undefined' ? urlapi : g.urlapi;
  const user = typeof idUsuario !== 'undefined' ? idUsuario : g.idUsuario;
  const sessionPassword = typeof password !== 'undefined' ? password : g.password;
  const company = typeof idEmpresaUsuario !== 'undefined' ? idEmpresaUsuario : g.idEmpresaUsuario;
  let urlAllowed = false;
  try {
    const endpoint = new URL(api, g.location?.href || 'https://login.colppy.com/');
    urlAllowed = endpoint.protocol === 'https:' && endpoint.hostname === 'login.colppy.com' &&
      endpoint.pathname === '/lib/frontera2/service.php';
  } catch { /* Endpoint inválido: no permite consultas. */ }
  const hasExt = !!ext?.Ajax?.request;
  return {
    ready: hasExt && typeof buildBody === 'function' && urlAllowed &&
      user != null && sessionPassword != null && company != null,
    hasExt,
    hasRequestBody: typeof buildBody === 'function',
    // Solo booleanos: nunca devolver los valores de sesión.
    urlConfigured: urlAllowed
  };
}

export function pageQueryCuit(cuit) {
  return new Promise((resolve) => {
    const g = globalThis;
    // El service worker solo aporta el CUIT; todo lo sensible permanece en el contexto Colppy.
    if (typeof cuit !== 'string' || !/^\d{11}$/.test(cuit)) {
      resolve({ kind: 'invalid', message: 'CUIT inválido' });
      return;
    }
    const ext = typeof Ext !== 'undefined' ? Ext : g.Ext;
    const buildBody = typeof requestBody !== 'undefined' ? requestBody : g.requestBody;
    const api = typeof urlapi !== 'undefined' ? urlapi : g.urlapi;
    const user = typeof idUsuario !== 'undefined' ? idUsuario : g.idUsuario;
    const sessionPassword = typeof password !== 'undefined' ? password : g.password;
    const company = typeof idEmpresaUsuario !== 'undefined' ? idEmpresaUsuario : g.idEmpresaUsuario;
    if (!ext?.Ajax?.request || typeof buildBody !== 'function' ||
        user == null || sessionPassword == null || company == null) {
      resolve({ kind: 'session', message: 'Colppy no está listo o la sesión debe renovarse.' });
      return;
    }
    let endpoint;
    try { endpoint = new URL(api, g.location?.href || 'https://login.colppy.com/'); }
    catch { resolve({ kind: 'session', message: 'Endpoint Colppy no válido.' }); return; }
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'login.colppy.com' ||
        endpoint.pathname !== '/lib/frontera2/service.php') {
      resolve({ kind: 'session', message: 'Endpoint no autorizado. Consulta bloqueada.' });
      return;
    }
    try {
      const sessionUserId = typeof userId !== 'undefined' ? userId :
        ext?.util?.Cookies?.get('userIdCookie');
      ext.Ajax.request({
        url: endpoint.href,
        method: 'POST',
        timeout: 20000,
        params: buildBody('Tercero', 'obtener_datos_tercero_de_afip', {
          sesion: { usuario: user, userId: sessionUserId, claveSesion: sessionPassword },
          cuit, idEmpresa: company
        }),
        success(response) {
          try {
            // No retornar JSON sin filtrar en caso de excepciones de autenticación.
            const json = ext.decode(response.responseText);
            resolve({ kind: 'response', data: {
              result: { estado: json?.result?.estado, mensaje: json?.result?.mensaje },
              response: {
                success: json?.response?.success,
                message: json?.response?.message,
                mensaje: json?.response?.mensaje,
                data: {
                  nombre: json?.response?.data?.nombre,
                  idCondicionIva: json?.response?.data?.idCondicionIva,
                  pais: json?.response?.data?.pais,
                  domicilioFiscal: {
                    direccion: json?.response?.data?.domicilioFiscal?.direccion,
                    localidad: json?.response?.data?.domicilioFiscal?.localidad,
                    codPostal: json?.response?.data?.domicilioFiscal?.codPostal,
                    provincia: json?.response?.data?.domicilioFiscal?.provincia
                  }
                }
              }
            } });
          } catch {
            resolve({ kind: 'error', message: 'Respuesta JSON inválida de Colppy.' });
          }
        },
        failure(response) {
          const status = Number(response?.status) || 0;
          if (status === 401 || status === 403) {
            resolve({ kind: 'session', message: 'Colppy rechazó la sesión; iniciá sesión nuevamente.' });
          } else {
            resolve({ kind: 'http', status, message: status ? `HTTP ${status}` : 'Sin respuesta / timeout' });
          }
        }
      });
    } catch {
      resolve({ kind: 'error', message: 'Colppy no pudo iniciar la solicitud.' });
    }
  });
}
