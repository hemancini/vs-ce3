// API JSON de autenticación de Arsmate. La consume el componente ArsAuth.
//
//   GET                                       → valida la sesión activa (KV o env).
//   POST { action: 'validate', cookie? }      → valida la cookie pegada o la activa.
//   POST { action: 'save', cookie, label? }   → guarda una cookie pegada como sesión.
//   POST { action: 'login', email, password } → login con credenciales.
//   POST { action: 'logout' }                 → olvida la sesión guardada.
//
// Todos los errores se devuelven con 200 + { ok:false/valid:false, … } para que
// el cliente los muestre sin tratarlos como fallos de red.
import type { APIRoute } from 'astro';
import {
  parseArsCookie,
  validateArsSession,
  loginArs,
  loadArsSession,
  saveArsSession,
  clearArsSession,
  type ArsSession,
} from '@/lib/ars/auth';
import { setArsSession, clearArsSessionMemory } from '@/lib/ars/session';

export const prerender = false;

// Cookie de primera parte (por navegador) con la sesión activa. Debe coincidir con
// la que lee el middleware (ARS_SESSION_COOKIE en src/lib/ars/session.ts).
const SESSION_COOKIE = 'ars_session';
const COOKIE_OPTS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  maxAge: 60 * 60 * 24 * 30, // 30 días
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const accountView = (session: ArsSession | null, locals: any) => {
  if (session) {
    return { label: session.name || 'Sesión Arsmate', userId: session.userId, source: session.source || 'manual' };
  }
  // Hay una sesión activa (cookie de navegador / KV) pero sin metadatos guardados.
  return locals?.arsmateCookie ? { label: 'Sesión Arsmate', source: 'session' } : null;
};

export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as any).runtime?.env;
  try {
    const stored = await loadArsSession(env);
    // Preferimos la cookie que el middleware ya resolvió (memoria primero, luego
    // KV): tras un login, la lectura directa de KV puede venir desactualizada
    // (consistencia eventual). `stored` solo aporta metadatos de la cuenta.
    const cookie = (locals as any).arsmateCookie || stored?.cookie;
    if (!cookie) return json({ valid: false, reason: 'Sin sesión', account: null });
    const res = await validateArsSession(cookie);
    return json({ ...res, account: accountView(stored, locals) });
  } catch (e: any) {
    return json({ valid: false, reason: e?.message || 'Error' });
  }
};

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const env = (locals as any).runtime?.env;

  let payload: any = {};
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'JSON inválido' }, 400);
  }

  const action = payload.action || '';

  try {
    if (action === 'validate') {
      const cookie = payload.cookie
        ? parseArsCookie(payload.cookie)
        : (locals as any).arsmateCookie || (await loadArsSession(env))?.cookie;
      if (!cookie) return json({ valid: false, reason: 'No hay cookie para validar' });
      return json(await validateArsSession(cookie));
    }

    if (action === 'save') {
      const cookie = parseArsCookie(payload.cookie);
      if (!cookie) return json({ ok: false, error: 'No se reconoció la cookie en el texto.' }, 400);
      const check = await validateArsSession(cookie);
      const session: ArsSession = { cookie, name: String(payload.label || '').trim(), source: 'manual' };
      await saveArsSession(session, env);
      setArsSession(session);
      // Cookie de navegador: hace que la sesión funcione de inmediato (dev y prod).
      cookies.set(SESSION_COOKIE, session.cookie, COOKIE_OPTS);
      return json({
        ok: true,
        valid: check.valid,
        reason: check.reason,
        account: accountView(session, locals),
      });
    }

    if (action === 'login') {
      const session = await loginArs({ email: payload.email, password: payload.password });
      await saveArsSession(session, env);
      setArsSession(session);
      cookies.set(SESSION_COOKIE, session.cookie, COOKIE_OPTS);
      return json({
        ok: true,
        valid: true,
        reason: 'Sesión activa',
        account: accountView(session, locals),
      });
    }

    if (action === 'logout') {
      await clearArsSession(env);
      clearArsSessionMemory();
      cookies.delete(SESSION_COOKIE, { path: '/' });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida' }, 400);
  } catch (e: any) {
    return json({ ok: false, valid: false, error: e?.message, reason: e?.message });
  }
};
