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

export function pageQueryCuit(cuit, source = 'ARCA', arbaDate = null) {
  return new Promise((resolve) => {
    const g = globalThis;
    // El service worker solo aporta el CUIT; todo lo sensible permanece en el contexto Colppy.
    if (typeof cuit !== 'string' || !/^\d{11}$/.test(cuit)) {
      resolve({ kind: 'invalid', message: 'CUIT inválido' });
      return;
    }
    if (!['ARCA', 'ARBA', 'AGIP'].includes(source) || (source === 'ARBA' && (typeof arbaDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(arbaDate)))) {
      resolve({ kind: 'error', message: 'Consulta no autorizada o fecha inválida.' });
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
        params: source === 'ARCA' ? buildBody('Tercero', 'obtener_datos_tercero_de_afip', {
          sesion: { usuario: user, userId: sessionUserId, claveSesion: sessionPassword }, cuit, idEmpresa: company
        }) : buildBody('Retencion', source === 'ARBA' ? 'consultaPadronIIBB' : 'consultaAlicuotaAgip', {
          sesion: { usuario: user, claveSesion: sessionPassword }, cuit,
          ...(source === 'ARBA' ? { fecha: arbaDate, idProvincia: '2' } : {})
        }),
        success(response) {
          try {
            // No retornar JSON sin filtrar en caso de excepciones de autenticación.
            if (source === 'ARBA' && response.responseText.trim() === 'Unable to open file!') {
              resolve({ kind: 'padron' }); return;
            }
            const json = ext.decode(response.responseText);
            const scalar = value => {
              if (typeof value === 'string') {
                for (const secret of [sessionPassword, sessionUserId, user, company]) if (typeof secret === 'string' && secret.length >= 4 && value.includes(secret)) return undefined;
                if (value.length > 4096) throw new Error('Campo inesperadamente largo');
                return value;
              }
              return typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' ? value : undefined;
            };
            const obj = value => value && typeof value === 'object' && !Array.isArray(value);
            const d = json?.response?.data;
            if (source === 'AGIP' && Array.isArray(d) && d.length > 1) { resolve({ kind: 'error', message: 'Respuesta AGIP ambigua.' }); return; }
            if (source === 'ARCA' && Array.isArray(d?.impuestos) && d.impuestos.length > 1000) { resolve({ kind: 'error', message: 'Lista de impuestos inesperadamente extensa.' }); return; }
            const pickRates = value => obj(value) ? { retencion: scalar(value.retencion), percepcion: scalar(value.percepcion) } : scalar(value);
            const data = source === 'AGIP' ? (Array.isArray(d) ? d.map(pickRates) : pickRates(d)) : source === 'ARBA' ? pickRates(d) : obj(d) ? {
              nombre: scalar(d.nombre), idCondicionIva: scalar(d.idCondicionIva), pais: scalar(d.pais),
              tipoPersona: scalar(d.tipoPersona), mesCierre: scalar(d.mesCierre), idActividad: scalar(d.idActividad), descActividad: scalar(d.descActividad),
              impuestos: Array.isArray(d.impuestos) ? d.impuestos.filter(x => (typeof x === 'string' || typeof x === 'number') && /^\d+$/.test(String(x))) : undefined,
              condicionIva: { label: scalar(d.condicionIva?.label) },
              domicilioFiscal: { direccion: scalar(d.domicilioFiscal?.direccion), localidad: scalar(d.domicilioFiscal?.localidad), codPostal: scalar(d.domicilioFiscal?.codPostal), provincia: scalar(d.domicilioFiscal?.provincia) }
            } : null;
            // Solo campos permitidos; nunca retorna el cuerpo HTTP ni datos de sesión.
            const cleanMessage = value => {
              if (typeof value !== 'string') return undefined;
              for (const secret of [sessionPassword, sessionUserId, user, company]) if (typeof secret === 'string' && secret.length >= 4 && value.includes(secret)) return 'Colppy informó un error.';
              return value.slice(0, 512);
            };
            resolve({ kind: 'response', data: {
              result: obj(json?.result) ? { estado: scalar(json.result.estado), mensaje: cleanMessage(json.result.mensaje) } : undefined,
              response: {
                success: scalar(json?.response?.success),
                message: cleanMessage(json?.response?.message),
                mensaje: cleanMessage(json?.response?.mensaje),
                data
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
            resolve({ kind: 'http', status, message: status > 0 ? `HTTP ${status}` : 'Sin respuesta / timeout' });
          }
        }
      });
    } catch {
      resolve({ kind: 'error', message: 'Colppy no pudo iniciar la solicitud.' });
    }
  });
}
