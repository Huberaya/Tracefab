#!/usr/bin/env node
/**
 * Garde de non-regression pour l'identite DB du runtime.
 * Contrôle statique : le test Neon d'identité réelle reste la preuve d'exécution.
 */
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const prisma = read('../api/_lib/prisma.ts');
const readiness = read('../api/_routes/internal/p2-readiness.ts');
const probe = read('../api/_lib/readiness-probes.ts');

const checks = [
  [
    'Prisma runtime conserve un client singleton partagé par les routes et la sonde',
    /new PrismaClient\(\)/.test(prisma) && /export const prisma: PrismaClient/.test(prisma),
  ],
  [
    'la sonde lit current_user et session_user sur le client runtime',
    /current_user[\s\S]{0,300}session_user/.test(probe) && /prisma\.\$queryRaw/.test(probe),
  ],
  [
    'la sonde mesure BYPASSRLS et SUPERUSER',
    /rolbypassrls/.test(probe) && /rolsuper/.test(probe),
  ],
  [
    'la readiness diagnostique échoue si le rôle effectif n’est pas tracefab_app sans bypass',
    /databaseIdentityIsSafe\(databaseIdentity\)/.test(readiness) &&
      /function databaseIdentityIsSafe\(identity: DatabaseIdentity \| undefined\)/.test(probe) &&
      /identity\.currentUser === 'tracefab_app'/.test(probe) &&
      /identity\.sessionUser === 'tracefab_app'/.test(probe) &&
      /identity\.bypassesRls === false/.test(probe) &&
      /identity\.isSuperuser === false/.test(probe) &&
      /configured_ && identitySafe/.test(readiness),
  ],
];

let failures = 0;
for (const [label, passed] of checks) {
  console.log(`  ${passed ? 'ok' : 'ECHEC'} ${label}`);
  if (!passed) failures += 1;
}
console.log(`\nGarde runtime DB : ${checks.length - failures}/${checks.length}`);
process.exit(failures ? 1 : 0);
