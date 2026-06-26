// Gestión multicuenta de sesiones de Pornhub.
//
// Dos claves en KV (VS_C3_KV):
//   · ph:accounts → store multicuenta { accounts:[{id,label,cookies,username,createdAt}], activeId }
//   · ph:cookies  → cookies de la cuenta ACTIVA en formato legacy [{name,value,domain}],
//                   que es lo que leen el scraper y las páginas (así no necesitan cambios).
//
// GET  /api/ph/accounts
//   → { accounts:[{id,label,count,username,active}], activeId }
//
// POST /api/ph/accounts   body: { action, ... }
//   action 'add'      { label?, cookies, username? } → crea/actualiza por label y la activa
//   action 'activate' { id }                          → cambia la cuenta activa
//   action 'rename'   { id, label }                   → renombra
//   action 'delete'   { id }                          → elimina (si era activa, pasa a la 1ª)

import { readPhKV, writePhKV, PH_KV_COOKIES, PH_KV_ACCOUNTS } from '../../../lib/ph/cookies.js';

export const prerender = false;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' },
  });

function getEnv(context) {
  return context.locals?.runtime?.env ?? null;
}

const genId = () => `phacc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function normalizeCookies(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((c) => c && c.name)
    .map((c) => ({ name: String(c.name), value: c.value ?? '', domain: c.domain ?? '' }));
}

// Sanea un store crudo: ids/labels string, cookies normalizadas, activeId válido.
function normalizeStore(store) {
  const accounts = (Array.isArray(store?.accounts) ? store.accounts : [])
    .filter((a) => a && a.id)
    .map((a) => ({
      id: String(a.id),
      label: String(a.label || a.id),
      username: a.username ? String(a.username) : '',
      cookies: normalizeCookies(a.cookies),
      createdAt: a.createdAt || Date.now(),
    }));
  let activeId = store?.activeId || null;
  if (activeId && !accounts.some((a) => a.id === activeId)) activeId = null;
  if (!activeId && accounts.length) activeId = accounts[0].id;
  return { accounts, activeId };
}

/** Vista pública: oculta las cookies, expone solo metadatos. */
function sanitize(store) {
  return {
    accounts: store.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      username: a.username || '',
      count: (a.cookies || []).length,
      active: a.id === store.activeId,
    })),
    activeId: store.activeId,
  };
}

// Lee el store multicuenta (descifrado). Si aún no existe, migra el formato
// legacy (ph:cookies) a una única cuenta «Principal» para no perder la sesión.
async function loadStore(env) {
  const kv = env.VS_C3_KV;
  try {
    const raw = await readPhKV(kv, PH_KV_ACCOUNTS, env);
    if (raw) {
      const store = normalizeStore(raw);
      if (store.accounts.length) return store;
    }
  } catch {}
  try {
    const legacy = normalizeCookies(await readPhKV(kv, PH_KV_COOKIES, env));
    if (legacy.length) {
      const id = genId();
      return { accounts: [{ id, label: 'Principal', username: '', cookies: legacy, createdAt: Date.now() }], activeId: id };
    }
  } catch {}
  return { accounts: [], activeId: null };
}

// Persiste el store y refleja la cuenta activa en ph:cookies (formato legacy).
// Ambas claves quedan cifradas en KV.
async function saveStore(env, store) {
  const kv = env.VS_C3_KV;
  const norm = normalizeStore(store);
  await writePhKV(kv, PH_KV_ACCOUNTS, norm, env);
  const active = norm.accounts.find((a) => a.id === norm.activeId);
  await writePhKV(kv, PH_KV_COOKIES, active ? active.cookies : [], env);
  return norm;
}

export const GET = async (context) => {
  const env = getEnv(context);
  if (!env?.VS_C3_KV) return json({ error: 'KV no configurado' }, 503);
  try {
    const store = await loadStore(env);
    return json(sanitize(store));
  } catch (e) {
    return json({ error: 'Error al leer KV: ' + e.message }, 500);
  }
};

export const POST = async (context) => {
  const env = getEnv(context);
  if (!env?.VS_C3_KV) return json({ error: 'KV no configurado' }, 503);

  let body;
  try { body = await context.request.json(); } catch { return json({ error: 'Body JSON inválido' }, 400); }

  const action = body?.action;
  try {
    const store = await loadStore(env);

    if (action === 'add') {
      const cookies = normalizeCookies(body.cookies);
      if (!cookies.length) return json({ error: 'Sin cookies para guardar' }, 400);
      const lbl = String(body.label || '').trim();
      const username = body.username ? String(body.username) : '';
      let acc = lbl ? store.accounts.find((a) => a.label.toLowerCase() === lbl.toLowerCase()) : null;
      if (acc) {
        acc.cookies = cookies;
        if (username) acc.username = username;
      } else {
        acc = { id: genId(), label: lbl || username || `Cuenta ${store.accounts.length + 1}`, username, cookies, createdAt: Date.now() };
        store.accounts.push(acc);
      }
      store.activeId = acc.id;
      const saved = await saveStore(env, store);
      return json({ ok: true, id: acc.id, ...sanitize(saved) });
    }

    if (action === 'activate') {
      const id = String(body.id || '');
      if (!store.accounts.some((a) => a.id === id)) return json({ error: 'Cuenta no encontrada' }, 404);
      store.activeId = id;
      const saved = await saveStore(env, store);
      return json({ ok: true, ...sanitize(saved) });
    }

    if (action === 'rename') {
      const id = String(body.id || '');
      const lbl = String(body.label || '').trim();
      if (!lbl) return json({ error: 'Nombre requerido' }, 400);
      const acc = store.accounts.find((a) => a.id === id);
      if (!acc) return json({ error: 'Cuenta no encontrada' }, 404);
      acc.label = lbl;
      const saved = await saveStore(env, store);
      return json({ ok: true, ...sanitize(saved) });
    }

    if (action === 'delete') {
      const id = String(body.id || '');
      store.accounts = store.accounts.filter((a) => a.id !== id);
      if (store.activeId === id) store.activeId = store.accounts[0]?.id || null;
      const saved = await saveStore(env, store);
      return json({ ok: true, ...sanitize(saved) });
    }

    return json({ error: 'Acción desconocida' }, 400);
  } catch (e) {
    return json({ error: 'Error: ' + e.message }, 500);
  }
};
