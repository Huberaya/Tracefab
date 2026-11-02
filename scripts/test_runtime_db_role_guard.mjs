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
// P10.7 : le contrat d'identite vit dans un module SANS Prisma, pour etre
// testable hors ligne. La garde le lit donc la ou il est, et elle exige EN PLUS
// la regle d'escalade : un role qui peut endosser un role privilegie n'est pas
// sur, meme si ses propres attributs sont irreprochables.
const contrat = read('../api/_lib/identite-contrat.ts');

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
      /export function databaseIdentityIsSafe\(identity: DatabaseIdentity \| undefined\): boolean \{\s*return identiteRuntimeSure/.test(probe) &&
      /identite\.currentUser !== ROLE_RUNTIME_ATTENDU/.test(contrat) &&
      /identite\.sessionUser !== ROLE_RUNTIME_ATTENDU/.test(contrat) &&
      /identite\.bypassesRls !== false/.test(contrat) &&
      /identite\.isSuperuser !== false/.test(contrat) &&
      /configured_ && identitySafe/.test(readiness),
  ],
  [
    'P10.7 — le contrat refuse aussi une appartenance privilégiée ATTEIGNABLE (escalade)',
    /identite\.canEscalate !== false/.test(contrat) &&
      /privilegedMemberships/.test(contrat) &&
      /privileged_memberships/.test(probe) &&
      /WITH RECURSIVE|pg_auth_members/.test(probe),
  ],
];

let failures = 0;
for (const [label, passed] of checks) {
  console.log(`  ${passed ? 'ok' : 'ECHEC'} ${label}`);
  if (!passed) failures += 1;
}
console.log(`\nGarde runtime DB : ${checks.length - failures}/${checks.length}`);
process.exit(failures ? 1 : 0);
