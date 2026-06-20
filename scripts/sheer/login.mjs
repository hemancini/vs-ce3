import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const rootDir = process.cwd();
dotenv.config({ path: path.resolve(rootDir, '.env') });

const loginUrl = process.env.LOGIN_URL || 'https://www.sheer.com/TheGrey';
const cookiesPath = path.resolve(rootDir, 'config/cookies.json');

// Normalize sameSite values so Playwright accepts them (same logic as scrape.js)
const normalizeCookies = (cookies) =>
  cookies.map((cookie) => {
    const cleaned = { ...cookie };
    if (cleaned.sameSite) {
      const normalized =
        cleaned.sameSite.charAt(0).toUpperCase() + cleaned.sameSite.slice(1).toLowerCase();
      if (['Strict', 'Lax', 'None'].includes(normalized)) {
        cleaned.sameSite = normalized;
      } else {
        delete cleaned.sameSite;
      }
    }
    return cleaned;
  });

const main = async () => {
  console.log('Launching browser (headed, con DevTools)...');

  // headless: false  -> ventana visible
  // devtools: true   -> abre las DevTools automáticamente
  const browser = await chromium.launch({
    headless: false,
    devtools: true,
    args: ['--auto-open-devtools-for-tabs', '--start-maximized'],
  });

  const context = await browser.newContext({
    viewport: null, // usa el tamaño real de la ventana
  });

  // Reutiliza la sesión existente si hay cookies guardadas
  if (fs.existsSync(cookiesPath)) {
    try {
      const cookies = normalizeCookies(JSON.parse(fs.readFileSync(cookiesPath, 'utf8')));
      await context.addCookies(cookies);
      console.log(`Cookies cargadas desde ${cookiesPath} (${cookies.length})`);
    } catch (err) {
      console.warn(`No se pudieron cargar cookies.json: ${err.message}`);
    }
  } else {
    console.log('No hay cookies.json todavía. Inicia sesión manualmente en la ventana.');
  }

  const page = await context.newPage();
  console.log(`Navegando a: ${loginUrl}`);
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    // Un código HTTP de error (4xx/5xx) o un fallo de red no debe matar el script:
    // dejamos la ventana abierta para iniciar sesión manualmente.
    console.warn(`No se pudo cargar ${loginUrl} automáticamente: ${err.message}`);
    console.warn('Navega manualmente en la ventana del navegador si es necesario.');
  }
  console.log('\nEl navegador permanecerá abierto. Inicia sesión manualmente si es necesario.');
  console.log('Pulsa Ctrl+C en esta terminal para guardar las cookies y cerrar.\n');

  // Guarda las cookies actuales en cookies.json
  const saveCookies = async () => {
    try {
      const current = await context.cookies();
      fs.writeFileSync(cookiesPath, JSON.stringify(current, null, 2), 'utf8');
      console.log(`\nCookies guardadas en ${cookiesPath} (${current.length})`);
    } catch (err) {
      console.error(`Error guardando cookies: ${err.message}`);
    }
  };

  // Ctrl+C -> guarda cookies y cierra limpiamente
  let closing = false;
  process.on('SIGINT', async () => {
    if (closing) return;
    closing = true;
    await saveCookies();
    await browser.close().catch(() => {});
    process.exit(0);
  });

  // Si el usuario cierra la ventana del navegador, también guardamos y salimos
  browser.on('disconnected', async () => {
    if (closing) return;
    closing = true;
    await saveCookies().catch(() => {});
    process.exit(0);
  });

  // Mantiene el proceso (y el navegador) vivo indefinidamente
  await new Promise(() => {});
};

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
