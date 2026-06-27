// src/lib/vodscene/accounts.ts
//
// Multicuenta de vodscene. Cada cuenta guarda las credenciales de Firebase
// (email + contraseña) cifradas en KV (VS_C3_KV, clave `vodscene:accounts`).
// La cuenta ACTIVA es la que usa el endpoint de Firestore para autenticarse, en
// lugar de las vars en duro VODSCENE_EMAIL / VODSCENE_PASSWORD.
//
// El cifrado reutiliza el helper AES-256-GCM de Sheer (SHEER_KV_SECRET). La
// lectura tolera datos en texto plano (passthrough) por compatibilidad.

import { encryptJSON, decryptJSON } from "../sheer/crypto.js";

const KV_ACCOUNTS = "vodscene:accounts";

export interface VodsceneAccount {
  id: string;
  label: string;
  email: string;
  password: string;
  createdAt: number;
}

export interface AccountStore {
  accounts: VodsceneAccount[];
  activeId: string | null;
}

/** Vista pública de una cuenta: sin contraseña. */
export interface PublicAccount {
  id: string;
  label: string;
  email: string;
  active: boolean;
}

const envVar = (env: any, key: string): string | undefined =>
  env?.[key] ?? (typeof process !== "undefined" ? process.env?.[key] : undefined);

// Reutilizamos el secreto de Sheer; opcionalmente VODSCENE_KV_SECRET lo sobrescribe.
const resolveSecret = (env: any): string | undefined =>
  envVar(env, "VODSCENE_KV_SECRET") ?? envVar(env, "SHEER_KV_SECRET");

const genId = (): string =>
  `vacc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Sanea un store crudo: ids/labels/email string, activeId válido.
function normalizeStore(store: any): AccountStore {
  const accounts: VodsceneAccount[] = (Array.isArray(store?.accounts) ? store.accounts : [])
    .filter((a: any) => a && a.id && a.email)
    .map((a: any) => ({
      id: String(a.id),
      label: String(a.label || a.email || a.id),
      email: String(a.email),
      password: String(a.password ?? ""),
      createdAt: a.createdAt || Date.now(),
    }));
  let activeId: string | null = store?.activeId || null;
  if (activeId && !accounts.some((a) => a.id === activeId)) activeId = null;
  if (!activeId && accounts.length) activeId = accounts[0].id;
  return { accounts, activeId };
}

/** Vista pública del store: oculta las contraseñas. */
export function sanitizeAccounts(store: AccountStore): PublicAccount[] {
  return (store?.accounts || []).map((a) => ({
    id: a.id,
    label: a.label,
    email: a.email,
    active: a.id === store.activeId,
  }));
}

/** Lee el store multicuenta de KV. Devuelve un store vacío si no existe. */
export async function loadAccounts(env: any): Promise<AccountStore> {
  try {
    const raw = await env?.VS_C3_KV?.get(KV_ACCOUNTS);
    if (raw) {
      const store = normalizeStore(await decryptJSON(raw, resolveSecret(env)));
      return store;
    }
  } catch {
    // KV ilegible o secreto inválido: caemos a store vacío.
  }
  return { accounts: [], activeId: null };
}

/** Persiste el store multicuenta en KV (minificado + cifrado). */
export async function saveAccounts(store: AccountStore, env: any): Promise<AccountStore> {
  const norm = normalizeStore(store);
  if (env?.VS_C3_KV) {
    const payload = await encryptJSON(norm, resolveSecret(env));
    await env.VS_C3_KV.put(KV_ACCOUNTS, payload);
  }
  return norm;
}

/**
 * Añade una cuenta nueva (o actualiza la contraseña de una existente con el
 * mismo email) y la marca como activa. Devuelve { id, store }.
 */
export async function upsertAccount(
  { label, email, password }: { label?: string; email: string; password: string },
  env: any,
): Promise<{ id: string; store: AccountStore }> {
  const mail = String(email || "").trim();
  if (!mail) throw new Error("El email es requerido.");
  const store = await loadAccounts(env);
  let acc = store.accounts.find((a) => a.email.toLowerCase() === mail.toLowerCase());
  const lbl = String(label || "").trim();
  if (acc) {
    acc.password = String(password ?? "");
    if (lbl) acc.label = lbl;
  } else {
    acc = {
      id: genId(),
      label: lbl || mail,
      email: mail,
      password: String(password ?? ""),
      createdAt: Date.now(),
    };
    store.accounts.push(acc);
  }
  store.activeId = acc.id;
  const saved = await saveAccounts(store, env);
  return { id: acc.id, store: saved };
}

/** Cambia la cuenta activa por id. Lanza si no existe. */
export async function setActiveAccount(id: string, env: any): Promise<AccountStore> {
  const store = await loadAccounts(env);
  if (!store.accounts.some((a) => a.id === id)) throw new Error("Cuenta no encontrada");
  store.activeId = id;
  return saveAccounts(store, env);
}

/** Renombra una cuenta por id. No-op si no existe o el nombre está vacío. */
export async function renameAccount(id: string, label: string, env: any): Promise<AccountStore> {
  const lbl = String(label || "").trim();
  const store = await loadAccounts(env);
  if (!lbl) return store;
  const acc = store.accounts.find((a) => a.id === id);
  if (!acc || acc.label === lbl) return store;
  acc.label = lbl;
  return saveAccounts(store, env);
}

/** Elimina una cuenta; si era la activa, pasa a la primera disponible. */
export async function removeAccount(id: string, env: any): Promise<AccountStore> {
  const store = await loadAccounts(env);
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.activeId === id) store.activeId = store.accounts[0]?.id || null;
  return saveAccounts(store, env);
}

/** Credenciales de la cuenta activa, o null si no hay ninguna configurada. */
export async function loadActiveCredentials(
  env: any,
): Promise<{ email: string; password: string } | null> {
  const { accounts, activeId } = await loadAccounts(env);
  const active = accounts.find((a) => a.id === activeId);
  return active ? { email: active.email, password: active.password } : null;
}

/**
 * Resuelve las credenciales a usar: la cuenta activa en KV o, como respaldo,
 * las vars VODSCENE_EMAIL / VODSCENE_PASSWORD (secrets) si existieran.
 */
export async function resolveCredentials(
  env: any,
): Promise<{ email: string; password: string; source: "account" | "env" } | null> {
  const active = await loadActiveCredentials(env);
  if (active && active.email && active.password) return { ...active, source: "account" };
  const email = envVar(env, "VODSCENE_EMAIL");
  const password = envVar(env, "VODSCENE_PASSWORD");
  if (email && password) return { email, password, source: "env" };
  return null;
}

/**
 * Valida credenciales contra Firebase (signInWithPassword). No cachea: hace un
 * sign-in directo y devuelve el nombre/email para mostrar en la UI.
 */
export async function validateCredentials({
  apiKey,
  email,
  password,
}: {
  apiKey: string;
  email: string;
  password: string;
}): Promise<{ valid: boolean; reason: string; name?: string; email?: string }> {
  if (!email || !password) return { valid: false, reason: "Faltan email o contraseña" };
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Referer: "https://vodscene.com/",
          Origin: "https://vodscene.com",
        },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = data?.error?.message || `HTTP ${res.status}`;
      const friendly =
        code === "INVALID_PASSWORD" || code === "INVALID_LOGIN_CREDENTIALS"
          ? "Email o contraseña incorrectos"
          : code === "EMAIL_NOT_FOUND"
            ? "No existe una cuenta con ese email"
            : code === "USER_DISABLED"
              ? "La cuenta está deshabilitada"
              : String(code);
      return { valid: false, reason: friendly };
    }
    return {
      valid: true,
      reason: "Sesión válida",
      name: data?.displayName ? String(data.displayName) : "",
      email: data?.email ? String(data.email) : email,
    };
  } catch (e: any) {
    return { valid: false, reason: e?.message || "Error de red" };
  }
}
