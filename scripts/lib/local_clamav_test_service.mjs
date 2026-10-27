/**
 * Fixture CI uniquement : pont HTTP local vers le vrai binaire clamscan.
 * Une base de signatures ephemere ne contenant QUE l'echantillon EICAR est
 * volontairement insuffisante pour proteger de vrais fichiers. Ce module ne
 * doit jamais etre lance dans un deploiement ni presente comme un scanner de
 * Preview ; il teste seulement l'integration du protocole avec un vrai moteur.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eicarTestBytes } from './preview_harness_safety.mjs';

export async function startLocalClamavTestService() {
  if (process.env.NODE_ENV !== 'test' || process.env.VERCEL || process.env.VERCEL_ENV === 'production'
      || process.env.TF_PREVIEW_STORAGE_LOCAL_TEST !== '1' || process.env.TF_PREVIEW_TEST_REAL_CLAMAV !== '1') {
    throw new Error('clamav_local_test_only');
  }
  const directory = await mkdtemp(join(tmpdir(), 'tracefab-clamav-fixture-'));
  const token = randomBytes(32).toString('hex');
  let scans = 0;
  let server;
  try {
    // Le fichier n'est ni commite ni affiche. Signature de test UNIQUEMENT.
    await writeFile(join(directory, 'eicar-only.ndb'),
      `Tracefab.Test.EICAR:0:*:${eicarTestBytes().toString('hex')}\n`, { mode: 0o600 });
    async function scan(bytes) {
      return new Promise((resolve, reject) => {
        const child = spawn('clamscan', [`--database=${directory}`, '--no-summary', '-'],
          { stdio: ['pipe', 'ignore', 'ignore'] });
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.stdin.on('error', () => {});
        child.on('error', () => { clearTimeout(timer); reject(new Error('clamav_binary_unavailable')); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(true);
          else if (code === 1) resolve(false);
          else reject(new Error('clamav_scan_failed'));
        });
        child.stdin.end(bytes);
      });
    }
    // Verifie que le moteur et sa signature detectent vraiment EICAR avant
    // toute utilisation : un binaire absent ou un scan en erreur echoue ferme.
    if (!(await scan(Buffer.from('TraceFab clean local fixture', 'ascii'))) || await scan(eicarTestBytes())) {
      throw new Error('clamav_fixture_selfcheck_failed');
    }
    server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/scan' || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403).end(); return;
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new Error('fixture_too_large');
          chunks.push(chunk);
        }
        if (!size) throw new Error('fixture_empty');
        const clean = await scan(Buffer.concat(chunks));
        scans += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ clean, mimeType: req.headers['content-type'] || 'application/octet-stream' }));
      } catch {
        res.writeHead(503).end();
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return {
      url: `http://127.0.0.1:${server.address().port}/scan`, token,
      stats: () => ({ scans }),
      async stop() {
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
