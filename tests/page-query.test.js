import test from 'node:test';
import assert from 'node:assert/strict';
import { pageQueryCuit, pagePreflight } from '../page-query.js';

function installMock(ajax) {
  const old = Object.fromEntries(['Ext','requestBody','urlapi','idUsuario','userId','password','idEmpresaUsuario']
    .map((key) => [key, globalThis[key]]));
  globalThis.Ext = { Ajax: { request: ajax }, decode: JSON.parse, util: { Cookies: { get: () => 'TEST_USER' } } };
  globalThis.requestBody = (service, operation, data) => ({ service, operation, data });
  globalThis.urlapi = 'https://login.colppy.com/lib/frontera2/service.php';
  globalThis.idUsuario = 'TEST_USER';
  globalThis.userId = 'TEST_UID';
  globalThis.password = 'TEST_SESSION_ONLY';
  globalThis.idEmpresaUsuario = 'TEST_COMPANY';
  return () => {
    for (const [key, val] of Object.entries(old)) {
      if (val === undefined) delete globalThis[key];
      else globalThis[key] = val;
    }
  };
}
test('Q-01: preflight devuelve indicadores, no valores de sesión', () => {
  const restore = installMock(() => {});
  try {
    const checked = pagePreflight();
    assert.equal(checked.ready, true);
    assert.equal(JSON.stringify(checked).includes('TEST_'), false);
  } finally { restore(); }
});
test('Q-02: inyecta petición histórica a Colppy y devuelve solo campos autorizados', async () => {
  let request = null;
  const restore = installMock((options) => {
    request = options;
    options.success({ responseText: JSON.stringify({
      result: { estado: 0 },
      response: { success: true, data: {
        nombre: 'Empresa prueba', idCondicionIva: 1,
        domicilioFiscal: { localidad: 'CABA' }, campoInternoSecreto: 'NO_EXFILTRAR'
      }, secreto: 'NO_EXFILTRAR' }
    }) });
  });
  try {
    const result = await pageQueryCuit('20123456780');
    assert.equal(request.params.service, 'Tercero');
    assert.equal(request.params.operation, 'obtener_datos_tercero_de_afip');
    assert.equal(request.params.data.cuit, '20123456780');
    assert.equal(request.timeout, 20000);
    assert.equal(result.kind, 'response');
    assert.equal(result.data.response.data.nombre, 'Empresa prueba');
    assert.equal(JSON.stringify(result).includes('NO_EXFILTRAR'), false);
    assert.equal(JSON.stringify(result).includes('TEST_SESSION_ONLY'), false);
  } finally { restore(); }
});
test('Q-03: HTTP 401 pausa como sesión no autorizada', async () => {
  const restore = installMock((options) => options.failure({ status: 401 }));
  try { assert.equal((await pageQueryCuit('20123456780')).kind, 'session'); }
  finally { restore(); }
});
test('Q-04: error HTTP no devuelve cuerpo de respuesta arbitrario', async () => {
  const restore = installMock((options) => options.failure({ status: 500, responseText: 'SECRET' }));
  try {
    const output = await pageQueryCuit('20123456780');
    assert.equal(output.kind, 'http');
    assert.equal(JSON.stringify(output).includes('SECRET'), false);
  } finally { restore(); }
});
test('Q-05: JSON inválido se identifica sin filtrar datos', async () => {
  const restore = installMock((options) => options.success({ responseText: '<html>privado</html>' }));
  try { assert.equal((await pageQueryCuit('20123456780')).kind, 'error'); }
  finally { restore(); }
});
test('Q-06: sin sesión nunca llama al endpoint', async () => {
  const old = globalThis.Ext;
  delete globalThis.Ext;
  try { assert.equal((await pageQueryCuit('20123456780')).kind, 'session'); }
  finally { if (old !== undefined) globalThis.Ext = old; }
});
test('Q-07: no consulta CUIT sintácticamente inválido', async () => {
  const restore = installMock(() => { throw new Error('No debería ejecutarse'); });
  try { assert.equal((await pageQueryCuit('ABC')).kind, 'invalid'); }
  finally { restore(); }
});

// Pruebas aisladas del login: no se crean, leen ni envían credenciales reales.
import { pageAssistLogin, pageCancelLoginAssist } from '../page-query.js';
function fakeLogin({ usernameValue = 'prueba@example.test', passwordValue = 'FICTICIA', challenge = false, buttonType = 'submit', extraPassword = false } = {}) {
  const old = { location: globalThis.location, document: globalThis.document };
  let clicked = 0;
  const handlers = new Map();
  const rects = () => [{}];
  const user = { value: usernameValue, disabled: false, getClientRects: rects };
  const button = { type: buttonType, disabled: false, getClientRects: rects, click: () => { clicked++; } };
  const form = {
    querySelector: () => challenge ? {} : null,
    querySelectorAll: (selector) => selector.startsWith('input[type="email"]') ? [user] : [button]
  };
  const password = { value: passwordValue, disabled: false, getClientRects: rects, closest: () => form };
  globalThis.location = { origin: 'https://login.colppy.com' };
  globalThis.document = {
    addEventListener: (event, handler) => handlers.set(event, handler),
    querySelectorAll: () => extraPassword ? [password, password] : [password]
  };
  return {
    user, password, handlers, get clicks() { return clicked; },
    restore() {
      pageCancelLoginAssist();
      if (old.location === undefined) delete globalThis.location;
      else globalThis.location = old.location;
      if (old.document === undefined) delete globalThis.document;
      else globalThis.document = old.document;
    }
  };
}

test('Q-08: credenciales autocompletadas permiten UN solo submit; no se exfiltran', () => {
  const fake = fakeLogin();
  try {
    const result = pageAssistLogin();
    assert.deepEqual(result, { monitoring: true });
    assert.equal(fake.clicks, 1);
    pageAssistLogin();
    assert.equal(fake.clicks, 1);
    assert.equal(JSON.stringify(result).includes('FICTICIA'), false);
    assert.equal(JSON.stringify(result).includes('prueba@example.test'), false);
  } finally { fake.restore(); }
});

test('Q-09: no enviar formularios con contraseña vacía, MFA/captcha o múltiples contraseñas', () => {
  for (const options of [{passwordValue:''},{challenge:true},{extraPassword:true}]) {
    const fake = fakeLogin(options);
    try { pageAssistLogin(); assert.equal(fake.clicks, 0); }
    finally { fake.restore(); }
  }
});

test('Q-10: si la persona tipea, no autoenvía el formulario', async () => {
  const fake = fakeLogin({ usernameValue: '', passwordValue: '' });
  try {
    pageAssistLogin();
    fake.handlers.get('keydown')({ isTrusted: true, key: 'a', target: { matches: () => true } });
    fake.user.value = 'prueba@example.test';
    fake.password.value = 'MANUAL';
    await new Promise((resolve) => setTimeout(resolve, 660));
    assert.equal(fake.clicks, 0);
  } finally { fake.restore(); }
});

test('Q-11: no automatiza login fuera del origen autorizado', () => {
  const fake = fakeLogin();
  try {
    globalThis.location.origin = 'https://otro-dominio.example';
    assert.deepEqual(pageAssistLogin(), { monitoring: false });
    assert.equal(fake.clicks, 0);
  } finally { fake.restore(); }
});
