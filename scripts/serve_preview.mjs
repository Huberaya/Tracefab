import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();

/*
 * Les routes sont lues depuis vercel.json, pas recopiées à la main.
 *
 * Une liste codée en dur dérive : `/i18n-core.js` en était absent, donc aucune des
 * surfaces i18n ne pouvait charger son runtime en preview — exactement la classe de
 * défaut du Chantier 29, mais côté aperçu local. En dérivant du fichier qui décide
 * en production, l'aperçu ne peut plus s'en écarter.
 */
const ROUTES = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).routes
  .filter((r) => r.dest && !r.dest.includes('$1'))
  .map((r) => ({ re: new RegExp(`^${r.src}$`), dest: r.dest.split('?')[0] }));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);

  // Mirror vercel.json so the preview matches production routing.
  const mapped = ROUTES.find((r) => r.re.test(pathname));
  if (mapped) pathname = mapped.dest;

  const filePath = path.join(ROOT, pathname);

  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (stats && stats.isDirectory()) {
        const indexHtml = path.join(filePath, 'index.html');
        if (fs.existsSync(indexHtml)) {
          const ext = '.html';
          res.setHeader('Content-Type', MIME_TYPES[ext]);
          fs.createReadStream(indexHtml).pipe(res);
          return;
        }
      }
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Preview server listening on 0.0.0.0:${PORT}`);
});
