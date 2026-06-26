// API JSON de autenticación de Sheer. La consume el componente SheerAuth.
//
//   GET                      → valida la cuenta activa + lista de cuentas guardadas.
//   POST { action: 'validate', cookies? } → valida cookies pegadas o, si no, las activas.
//   POST { action: 'save', cookies, label? } → guarda cookies como cuenta nueva/activa.
//   POST { action: 'login', email, password } → login con credenciales (cuenta = email).
//   POST { action: 'list' }            → lista de cuentas (sin exponer las cookies).
//   POST { action: 'select', id }      → marca una cuenta como activa.
//   POST { action: 'remove', id }      → elimina una cuenta.
//
// Todos los errores se devuelven con 200 + { ok:false/valid:false, ... } para que
// el cliente los muestre sin tratarlos como fallos de red.
import {
  parseCookiesInput,
  cookiesToHeader,
  validateSession,
  loginSheer,
  loadCookies,
  loadAccounts,
  upsertAccount,
  setActiveAccount,
  removeAccount,
  renameAccount,
  sanitizeAccounts,
} from '../../../lib/sheer/auth.js';
import { loadMode, saveMode, loadLibrary } from '../../../lib/sheer/scraper.js';

// Resumen ligero de la biblioteca guardada (sin exponer los videos): sirve para
// que el menú muestre si hay datos disponibles para el modo «guardado».
const libraryInfo = async (env) => {
  const lib = await loadLibrary(env);
  if (!lib) return { hasLibrary: false, totalCreators: 0, totalVideos: 0, generatedAt: null };
  return {
    hasLibrary: (lib.creators || []).length > 0,
    totalCreators: lib.totalCreators ?? (lib.creators || []).length,
    totalVideos: lib.totalVideos ?? 0,
    generatedAt: lib.generatedAt ?? null,
  };
};

export const prerender = false;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// Etiquetas "provisionales" que conviene sustituir por el nombre real en cuanto
// lo conozcamos: el "Cuenta N" autogenerado o un email usado como nombre.
const isDefaultLabel = (label) =>
  !label || /^cuenta\s*\d+$/i.test(label) || /@/.test(label);

export const GET = async (context) => {
  const env = context.locals?.runtime?.env;
  try {
    const store = await loadAccounts(env);
    const accounts = sanitizeAccounts(store);
    const cookies = await loadCookies(env);
    const mode = await loadMode(env);
    const library = await libraryInfo(env);
    if (!cookies.length) {
      return json({ valid: false, count: 0, reason: 'No hay cookies guardadas', accounts, activeId: store.activeId, mode, library });
    }
    const res = await validateSession({ cookieHeader: cookiesToHeader(cookies), env });
    // Backfill: si la cuenta activa aún tiene un nombre provisional y ahora
    // conocemos el real, la renombramos.
    const active = store.accounts.find((a) => a.id === store.activeId);
    if (res.valid && res.name && active && isDefaultLabel(active.label)) {
      const renamed = await renameAccount(active.id, res.name, env);
      return json({ ...res, count: cookies.length, accounts: sanitizeAccounts(renamed), activeId: store.activeId, mode, library });
    }
    return json({ ...res, count: cookies.length, accounts, activeId: store.activeId, mode, library });
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
      // Nombre: el que el usuario indique o, si no, el nombre real del usuario.
      const label = payload.label || check.name || '';
      const { id, store } = await upsertAccount({ label, cookies }, env);
      return json({
        ok: true,
        count: cookies.length,
        valid: check.valid,
        reason: check.reason,
        activeId: id,
        accounts: sanitizeAccounts(store),
      });
    }

    if (action === 'login') {
      const { email, password } = payload;
      const { cookies, name } = await loginSheer({ email, password, env });
      // Preferir el nombre real del usuario; caer al email si no se obtuvo.
      const { id, store } = await upsertAccount({ label: name || email, cookies }, env);
      return json({
        ok: true,
        count: cookies.length,
        valid: true,
        reason: 'Sesión activa',
        activeId: id,
        accounts: sanitizeAccounts(store),
      });
    }

    if (action === 'list') {
      const store = await loadAccounts(env);
      return json({ ok: true, accounts: sanitizeAccounts(store), activeId: store.activeId });
    }

    if (action === 'mode') {
      const mode = await saveMode(payload.mode, env);
      const library = await libraryInfo(env);
      return json({ ok: true, mode, library });
    }

    if (action === 'select') {
      if (!payload.id) return json({ ok: false, error: 'Falta el id de la cuenta.' }, 400);
      let store = await setActiveAccount(payload.id, env);
      const res = await validateSession({ cookieHeader: cookiesToHeader(await loadCookies(env)), env });
      // Backfill del nombre real si la cuenta tenía un nombre provisional.
      const active = store.accounts.find((a) => a.id === store.activeId);
      if (res.valid && res.name && active && isDefaultLabel(active.label)) {
        store = (await renameAccount(active.id, res.name, env)) || store;
      }
      return json({
        ok: true,
        valid: res.valid,
        reason: res.reason,
        activeId: store.activeId,
        accounts: sanitizeAccounts(store),
      });
    }

    if (action === 'remove') {
      if (!payload.id) return json({ ok: false, error: 'Falta el id de la cuenta.' }, 400);
      const store = await removeAccount(payload.id, env);
      return json({ ok: true, activeId: store.activeId, accounts: sanitizeAccounts(store) });
    }

    return json({ ok: false, error: 'Acción desconocida' }, 400);
  } catch (e) {
    return json({ ok: false, valid: false, error: e.message, reason: e.message });
  }
};
