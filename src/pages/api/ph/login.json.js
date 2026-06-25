// POST /api/ph/login.json
//   body JSON: { email, password }
//   → inicia sesión en es.pornhub.com y devuelve las cookies de sesión
//     resultantes en formato [{ name, value, domain }] para poder guardarlas en KV.
//   Respuesta: { ok: true, cookies: [...], username?, count } o { ok: false, error }
//
// Cómo funciona: el endpoint `/front/authenticate` de PH exige un `token`
// anti-CSRF (con marca de tiempo) y un campo `redirect`, ambos viven en la página
// de login y caducan. Por eso:
//   1. Descargamos /login para extraer token + redirect y las cookies iniciales.
//   2. Hacemos el POST de autenticación con ese token y el cookie-jar.
//   3. Verificamos contra la home que la sesión quedó iniciada y devolvemos el jar.

export const prerender = false;

const BASE_URL = 'https://es.pornhub.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  'sec-ch-ua': '"Chromium";v="120", "Not?A_Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
  'user-agent': UA,
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', 'cache-control': 'no-store' },
  });

// Aplica un array de cabeceras Set-Cookie sobre un jar (Map name->value).
function mergeSetCookies(jar, setCookies) {
  for (const sc of setCookies) {
    const first = sc.split(';')[0];
    const eq = first.indexOf('=');
    if (eq === -1) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;
    // Cookie borrada por el servidor.
    if (value === '' || /expires=Thu,?\s*01[- ]Jan[- ]1970/i.test(sc)) {
      jar.delete(name);
      continue;
    }
    jar.set(name, value);
  }
}

const jarToHeader = (jar) =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

export const POST = async ({ request }) => {
  let body;
  try { body = await request.json(); } catch {}
  const email = (body?.email || '').trim();
  const password = body?.password || '';
  if (!email || !password) {
    return json({ ok: false, error: 'Email y contraseña requeridos' }, 400);
  }

  // Jar inicial con cookies de age-gate para que PH no sirva el stub.
  const jar = new Map([
    ['platform', 'pc'],
    ['accessAgeDisclaimerPH', '1'],
    ['accessAgeDisclaimerUK', '1'],
    ['cookieConsent', '3'],
  ]);

  // 1. Página de login → token CSRF + redirect + cookies iniciales.
  let token, redirect;
  try {
    const res = await fetch(`${BASE_URL}/login`, {
      headers: { ...BROWSER_HEADERS, cookie: jarToHeader(jar) },
      redirect: 'follow',
    });
    mergeSetCookies(jar, res.headers.getSetCookie?.() ?? []);
    const html = await res.text();
    token =
      (html.match(/name="token"\s+value="([^"]+)"/) ||
        html.match(/"token"\s*:\s*"([^"]+)"/) ||
        html.match(/\btoken\s*=\s*"([A-Za-z0-9._-]+)"/) || [])[1];
    redirect =
      (html.match(/name="redirect"\s+value="([^"]*)"/) ||
        html.match(/"redirect"\s*:\s*"([^"]*)"/) || [])[1] || '';
  } catch (e) {
    return json({ ok: false, error: 'No se pudo cargar la página de login: ' + e.message }, 502);
  }

  if (!token) {
    return json({ ok: false, error: 'No se pudo extraer el token CSRF del login (¿PH cambió el formulario?)' }, 502);
  }

  // 2. POST de autenticación.
  const form = new URLSearchParams({
    redirect,
    user_id: '',
    intended_action: '',
    token,
    from: 'pc_login_modal_:browse',
    email,
    password,
  });

  let authData;
  try {
    const res = await fetch(`${BASE_URL}/front/authenticate`, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
        origin: BASE_URL,
        referer: `${BASE_URL}/login`,
        'x-requested-with': 'XMLHttpRequest',
        cookie: jarToHeader(jar),
      },
      body: form.toString(),
      redirect: 'manual',
    });
    mergeSetCookies(jar, res.headers.getSetCookie?.() ?? []);
    authData = await res.json().catch(() => ({}));
  } catch (e) {
    return json({ ok: false, error: 'Error al autenticar: ' + e.message }, 502);
  }

  // PH suele devolver { success: 1 } o errores en message/errors. Si vino un error
  // explícito de credenciales, cortamos antes de verificar.
  const explicitError =
    authData?.error ||
    (typeof authData?.message === 'string' && /contraseñ|password|incorrect|inválid|invalid|error/i.test(authData.message)
      ? authData.message
      : null) ||
    (Array.isArray(authData?.errors) && authData.errors.length
      ? authData.errors.map((e) => (typeof e === 'string' ? e : e?.message)).filter(Boolean).join(', ')
      : null);

  const authOk =
    authData?.success === 1 || authData?.success === '1' || authData?.success === true ||
    authData?.authenticated === true || authData?.status === 'success';

  if (explicitError && !authOk) {
    return json({ ok: false, error: 'Login fallido: ' + explicitError }, 401);
  }

  // 3. Verificación: cargamos la home con el jar resultante y comprobamos sesión.
  let valid = authOk;
  let username = authData?.username || null;
  try {
    const res = await fetch(`${BASE_URL}/`, {
      headers: { ...BROWSER_HEADERS, cookie: jarToHeader(jar) },
      redirect: 'follow',
    });
    mergeSetCookies(jar, res.headers.getSetCookie?.() ?? []);
    const html = await res.text();
    valid =
      /isLoggedIn\s*[=:]\s*[1"']/.test(html) ||
      html.includes('"isLogged":1') ||
      html.includes('"isLoggedIn":1') ||
      html.includes('class="userLoggedIn"') ||
      valid;
    if (!username) {
      for (const re of [/"username"\s*:\s*"([^"]+)"/, /class="[^"]*username[^"]*"[^>]*>\s*([^<\s][^<]{0,40})/]) {
        const m = html.match(re);
        if (m?.[1]) { username = m[1].trim(); break; }
      }
    }
  } catch {
    // Si falla la verificación nos quedamos con la señal del authenticate.
  }

  if (!valid) {
    return json(
      { ok: false, error: 'Login fallido: credenciales inválidas o verificación adicional requerida (captcha/2FA)' },
      401,
    );
  }

  const cookies = [...jar.entries()].map(([name, value]) => ({
    name,
    value,
    domain: '.pornhub.com',
  }));

  return json({ ok: true, count: cookies.length, username, cookies });
};
