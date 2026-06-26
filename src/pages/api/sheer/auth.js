// API JSON de autenticación de Sheer. La consume el componente SheerAuth.
//
//   GET                      → valida la sesión actualmente guardada (cookies en KV/archivo).
//   POST { action: 'validate', cookies? } → valida cookies pegadas o, si no, las guardadas.
//   POST { action: 'save', cookies }      → guarda cookies pegadas (las valida primero).
//   POST { action: 'login', email, password } → login con credenciales, guarda las cookies.
//
// Todos los errores se devuelven con 200 + { ok:false/valid:false, ... } para que
// el cliente los muestre sin tratarlos como fallos de red.
import {
  parseCookiesInput,
  cookiesToHeader,
  validateSession,
  loginSheer,
  saveCookies,
  loadCookies,
} from '../../../lib/sheer/auth.js';

export const prerender = false;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export const GET = async (context) => {
  const env = context.locals?.runtime?.env;
  try {
    const cookies = await loadCookies(env);
    if (!cookies.length) return json({ valid: false, count: 0, reason: 'No hay cookies guardadas' });
    const res = await validateSession({ cookieHeader: cookiesToHeader(cookies), env });
    return json({ ...res, count: cookies.length });
  } catch (e) {
    return json({ valid: false, reason: e.message });
  }
};

export const POST = async (context) => {
  const env = context.locals?.runtime?.env;

  let payload = {};
  try {
    payload = await context.request.json();
  } catch {
    return json({ ok: false, error: 'JSON inválido' }, 400);
  }

  const action = payload.action || '';

  try {
    if (action === 'validate') {
      const cookieHeader = payload.cookies
        ? cookiesToHeader(parseCookiesInput(payload.cookies))
        : cookiesToHeader(await loadCookies(env));
      if (!cookieHeader) return json({ valid: false, reason: 'No hay cookies para validar' });
      const res = await validateSession({ cookieHeader, env });
      return json(res);
    }

    if (action === 'save') {
      const cookies = parseCookiesInput(payload.cookies);
      if (!cookies.length) {
        return json({ ok: false, error: 'No se reconocieron cookies en el texto.' }, 400);
      }
      const check = await validateSession({ cookieHeader: cookiesToHeader(cookies), env });
      const saved = await saveCookies(cookies, env);
      return json({ ok: true, count: cookies.length, valid: check.valid, reason: check.reason, saved });
    }

    if (action === 'login') {
      const { email, password } = payload;
      const { cookies } = await loginSheer({ email, password, env });
      const saved = await saveCookies(cookies, env);
      return json({ ok: true, count: cookies.length, valid: true, reason: 'Sesión activa', saved });
    }

    return json({ ok: false, error: 'Acción desconocida' }, 400);
  } catch (e) {
    return json({ ok: false, valid: false, error: e.message, reason: e.message });
  }
};
