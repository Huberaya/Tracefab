#!/usr/bin/env node
// Chantier 2C.34 — verification de la dependance reseau de Prisma.
//
// `prisma generate` (CLI 6.19.3) a besoin d'acceder a binaries.prisma.sh
// pour verifier/telecharger le schema-engine. Ce script verifie uniquement
// cette disponibilite, sans tenter de generer le client.
import { request } from 'node:https';

const host = 'binaries.prisma.sh';
const path = '/all_commits/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x/schema-engine.gz.sha256';

const req = request({ host, port: 443, path, method: 'HEAD', timeout: 8000 }, (res) => {
  const ok = Boolean(res.statusCode && res.statusCode < 500);
  console.log(`host=${host} status=${res.statusCode} reachable=${ok}`);
  res.resume();
  process.exit(ok ? 0 : 1);
});
req.on('error', (err) => {
  console.log(`host=${host} reachable=false error=${err.code || err.message}`);
  process.exit(1);
});
req.on('timeout', () => { req.destroy(); console.log(`host=${host} reachable=false (timeout)`); process.exit(1); });
req.end();
