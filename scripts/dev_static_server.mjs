#!/usr/bin/env node
/**
 * TRACEFAB — local static preview server.
 *
 * Mirrors the routing declared in vercel.json so the static shell
 * (landing, brand console, supplier portal, DPP, quality center…)
 * can be reviewed and visually regression-tested locally.
 *
 * It never touches the API runtime: /api/* answers 501 unless a
 * local fixture exists under scripts/fixtures/api/.
 *
 *   node scripts/dev_static_server.mjs [--port 3000]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg !== -1 ? Number(argv[portArg + 1]) : Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Les reecritures sont LUES depuis vercel.json, pas recopiees.
 *
 * Elles l'etaient a la main, et les deux listes ont diverge : une route
 * ajoutee a vercel.json restait invisible en local, ce qui fait mentir
 * l'apercu sur le comportement de production. Une seule source de verite.
 */
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const REWRITES = (VERCEL.routes || [])
  .filter((r) => r.src && r.dest && !r.dest.startsWith('/api/'))
  .map((r) => {
    const [destPath, destQuery] = String(r.dest).split('?');
    return {
      // vercel.json ancre implicitement le motif sur la totalite du chemin.
      pattern: new RegExp(`^${r.src.replace(/^\^/, '').replace(/\$$/, '')}$`),
      target: destPath.replace(/^\//, ''),
      query: destQuery || '',
    };
  });

function resolveFile(urlPath) {
  for (const { pattern, target } of REWRITES) {
    if (pattern.test(urlPath)) return path.join(ROOT, target);
  }
  const clean = urlPath.replace(/^\/+/, '').replace(/\.\./g, '');
  const direct = path.join(ROOT, clean);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const asHtml = `${direct}.html`;
  if (fs.existsSync(asHtml)) return asHtml;
  const asIndex = path.join(direct, 'index.html');
  if (fs.existsSync(asIndex)) return asIndex;
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (urlPath.startsWith('/api/')) {
    const fixture = path.join(__dirname, 'fixtures', 'api', `${urlPath.slice(5).replace(/\//g, '__')}.json`);
    if (fs.existsSync(fixture)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(fixture));
      return;
    }
    res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'api_not_available_in_static_preview', path: urlPath }));
    return;
  }

  const file = resolveFile(urlPath);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — not found');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TRACEFAB static preview  →  http://0.0.0.0:${PORT}`);
});
