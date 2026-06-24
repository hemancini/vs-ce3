// Endpoint SSE: ejecuta scripts/ph/scrape.mjs como proceso hijo y transmite su
// salida (stdout/stderr) línea a línea en tiempo real al navegador.
//
// Se consume desde /ph/scraper con EventSource. Eventos emitidos:
//   event: log   data: { line, stream: 'out'|'err' }
//   event: done  data: { code }
//
// Solo funciona en `astro dev` (Node): usa child_process y el filesystem.

export const prerender = false;

// Estado a nivel de módulo: en `astro dev` el módulo persiste entre peticiones,
// así evitamos dos scrapers simultáneos escribiendo el mismo videos.json.
let running = false;

export const GET = async ({ url, request }) => {
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');

  const p = url.searchParams;
  const maxPages = parseInt(p.get('maxPages') || '0', 10);
  const concurrency = parseInt(p.get('concurrency') || '2', 10);
  const skipStreams = p.get('skipStreams') === '1';
  const source = p.get('source') || 'all'; // model | favorites | all

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      if (running) {
        send('log', { line: '⚠️  Ya hay un scraping en curso. Espera a que termine.', stream: 'err' });
        send('done', { code: -1 });
        controller.close();
        return;
      }
      running = true;

      const scriptPath = path.resolve(process.cwd(), 'scripts/ph/scrape.mjs');
      const args = [scriptPath];
      if (maxPages > 0) args.push('--max-pages', String(maxPages));
      if (concurrency > 0) args.push('--concurrency', String(concurrency));
      if (skipStreams) args.push('--skip-streams');
      if (source) args.push('--source', source);

      send('log', { line: `▶️  node ${args.map((a) => a.replace(process.cwd() + '/', '')).join(' ')}`, stream: 'out' });

      const child = spawn(process.execPath, args, { cwd: process.cwd() });

      // Parte líneas de un buffer y las reenvía como eventos SSE.
      const makeLineHandler = (streamName) => {
        let buf = '';
        return {
          push(chunk) {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, idx);
              buf = buf.slice(idx + 1);
              send('log', { line, stream: streamName });
            }
          },
          flush() {
            if (buf) send('log', { line: buf, stream: streamName });
            buf = '';
          },
        };
      };

      const out = makeLineHandler('out');
      const err = makeLineHandler('err');
      child.stdout.on('data', (c) => out.push(c));
      child.stderr.on('data', (c) => err.push(c));

      const finish = (code) => {
        out.flush();
        err.flush();
        running = false;
        try {
          send('done', { code });
          controller.close();
        } catch {
          /* ya cerrado */
        }
      };

      child.on('close', (code) => finish(code ?? 0));
      child.on('error', (e) => {
        send('log', { line: '❌  No se pudo iniciar el proceso: ' + e.message, stream: 'err' });
        finish(-1);
      });

      // Si el cliente cierra la pestaña / cancela, matamos el proceso.
      request.signal.addEventListener('abort', () => {
        if (!child.killed) child.kill('SIGTERM');
        running = false;
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
};
