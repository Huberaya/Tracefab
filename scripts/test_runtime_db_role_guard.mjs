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
    'Prisma runtime privilégie TF_RLS_APP_URL sur DATABASE_URL',
    /process\.env\.TF_RLS_APP_URL\?\.trim\(\)\s*\|\|\s*process\.env\.DATABASE_URL\?\.trim\(\)/.test(prisma),
  ],
  [
    'Prisma applique explicitement l’URL choisie au datasource db',
    /new PrismaClient\(\{\s*datasources:\s*\{\s*db:\s*\{\s*url:\s*runtimeUrl\s*\}\s*\}\s*\}\)/s.test(prisma),
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
    /databaseIdentity\.currentUser === 'tracefab_app'/.test(readiness) &&
      /databaseIdentity\.sessionUser === 'tracefab_app'/.test(readiness) &&
      /databaseIdentity\.bypassesRls === false/.test(readiness) &&
      /databaseIdentity\.isSuperuser === false/.test(readiness) &&
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
