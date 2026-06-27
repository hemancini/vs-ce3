// API JSON de autenticación de vodscene. La consume el componente VodsceneAuth.
//
//   GET                                   → valida la cuenta activa + lista de cuentas.
//   POST { action: 'login', email, password, label? } → valida credenciales y las guarda.
//   POST { action: 'validate' }           → revalida la cuenta activa.
//   POST { action: 'list' }               → lista de cuentas (sin contraseñas).
//   POST { action: 'select', id }         → marca una cuenta como activa.
//   POST { action: 'remove', id }         → elimina una cuenta.
//
// Los errores se devuelven con 200 + { ok:false/valid:false, ... } para que el
// cliente los muestre sin tratarlos como fallos de red.
import type { APIRoute } from "astro";
import {
  loadAccounts,
  sanitizeAccounts,
  upsertAccount,
  setActiveAccount,
  removeAccount,
  loadActiveCredentials,
  validateCredentials,
} from "@/lib/vodscene/accounts";
import { invalidateFirebaseToken } from "@/lib/vodscene/firebase-auth";
import { loadMode, saveMode, libraryInfo } from "@/lib/vodscene/library";

export const prerender = false;

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

const getApiKey = (env: any): string =>
  env?.FIREBASE_API_KEY ?? import.meta.env.FIREBASE_API_KEY;

export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as App.Locals).runtime?.env;
  try {
    const store = await loadAccounts(env);
    const accounts = sanitizeAccounts(store);
    const creds = await loadActiveCredentials(env);
    const mode = await loadMode(env);
    const library = await libraryInfo(env);
    if (!creds) {
      return json({ valid: false, reason: "No hay cuentas guardadas", accounts, activeId: store.activeId, mode, library });
    }
    const res = await validateCredentials({ apiKey: getApiKey(env), ...creds });
    return json({ ...res, accounts, activeId: store.activeId, mode, library });
  } catch (e: any) {
    return json({ valid: false, reason: e?.message });
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  const env = (locals as App.Locals).runtime?.env;

  let payload: any = {};
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }

  const action = payload.action || "";

  try {
    if (action === "validate") {
      const creds = await loadActiveCredentials(env);
      if (!creds) return json({ valid: false, reason: "No hay cuenta activa" });
      const res = await validateCredentials({ apiKey: getApiKey(env), ...creds });
      return json(res);
    }

    if (action === "login") {
      const { email, password, label } = payload;
      if (!email || !password) {
        return json({ ok: false, error: "Email y contraseña son requeridos." }, 400);
      }
      // Validar antes de guardar para no persistir credenciales inservibles.
      const check = await validateCredentials({ apiKey: getApiKey(env), email, password });
      if (!check.valid) {
        return json({ ok: false, valid: false, error: check.reason, reason: check.reason });
      }
      const { id, store } = await upsertAccount(
        { label: label || check.name || email, email, password },
        env,
      );
      // La cuenta activa cambió: descarta cualquier token cacheado del email.
      invalidateFirebaseToken();
      return json({
        ok: true,
        valid: true,
        reason: check.reason,
        name: check.name,
        activeId: id,
        accounts: sanitizeAccounts(store),
      });
    }

    if (action === "list") {
      const store = await loadAccounts(env);
      return json({ ok: true, accounts: sanitizeAccounts(store), activeId: store.activeId });
    }

    if (action === "mode") {
      const mode = await saveMode(payload.mode, env);
      const library = await libraryInfo(env);
      return json({ ok: true, mode, library });
    }

    if (action === "select") {
      if (!payload.id) return json({ ok: false, error: "Falta el id de la cuenta." }, 400);
      const store = await setActiveAccount(payload.id, env);
      invalidateFirebaseToken();
      const creds = await loadActiveCredentials(env);
      const res = creds
        ? await validateCredentials({ apiKey: getApiKey(env), ...creds })
        : { valid: false, reason: "Sin credenciales" };
      return json({
        ok: true,
        valid: res.valid,
        reason: res.reason,
        activeId: store.activeId,
        accounts: sanitizeAccounts(store),
      });
    }

    if (action === "remove") {
      if (!payload.id) return json({ ok: false, error: "Falta el id de la cuenta." }, 400);
      const store = await removeAccount(payload.id, env);
      invalidateFirebaseToken();
      return json({ ok: true, activeId: store.activeId, accounts: sanitizeAccounts(store) });
    }

    return json({ ok: false, error: "Acción desconocida" }, 400);
  } catch (e: any) {
    return json({ ok: false, valid: false, error: e?.message, reason: e?.message });
  }
};
