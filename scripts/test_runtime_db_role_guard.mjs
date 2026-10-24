#!/usr/bin/env node
/**
 * Garde de non-regression pour l'identite DB du runtime.
 * Contrôle statique : le test Neon d'identité réelle reste la preuve d'exécution.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const prisma = read('../api/_lib/prisma.ts');
const readiness = read('../api/_routes/internal/p2-readiness.ts');
const probe = read('../api/_lib/readiness-probes.ts');
const sondePreview = read('../scripts/probe_preview_runtime_identity.mjs');

/**
 * Concatene le code d'un dossier. Sert a prouver une ABSENCE — ici, un
 * `SET ROLE` qui ferait diverger `current_user` de `session_user` et
 * invaliderait la lecture de l'identite. Une absence ne se prouve pas fichier
 * par fichier : elle se prouve sur l'arbre.
 */
function sequentiel(dossier, extensions) {
  const racine = new URL(`../${dossier}`, import.meta.url);
  const morceaux = [];
  const visiter = (url) => {
    for (const entree of readdirSync(url)) {
      const chemin = join(url.pathname, entree);
      const stats = statSync(chemin);
      if (stats.isDirectory()) visiter(new URL(`file://${chemin}`));
      else if (extensions.some((ext) => entree.endsWith(ext))) morceaux.push(readFileSync(chemin, 'utf8'));
    }
  };
  visiter(racine);
  return morceaux.join('\n');
}

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
  // MISSION C — l'identite ne se limite pas a deux booleens. Un role peut etre
  // « conforme en apparence » et contourner la RLS par adhesion heritee, par
  // propriete d'objet, ou parce que la RLS n'est pas activee sur la table.
  [
    'la sonde mesure l appartenance a un role privilegie (contournement herite)',
    /privilegedMemberships/.test(probe) && /pg_has_role\(a\.oid, r\.oid, 'MEMBER'\)/.test(probe),
  ],
  [
    'la sonde mesure les attributs de creation de base et de role, et la replication',
    /rolcreatedb/.test(probe) && /rolcreaterole/.test(probe) && /rolreplication/.test(probe),
  ],
  [
    'la sonde mesure la propriete de la table et l activation de la RLS',
    /ownsProductTable/.test(probe) && /relrowsecurity/.test(probe) && /relforcerowsecurity/.test(probe),
  ],
  [
    'la sonde mesure ce que le role VOIT sans contexte arme — la mesure decisive',
    /rowsVisibleWithoutContext/.test(probe) && /FROM \(SELECT 1 FROM public\.tracefab_products LIMIT 1\)/.test(probe),
  ],
  [
    'la sonde mesure les tables interdites a l ecriture directe (DPP append-only, registre Prisma)',
    /canWriteDppEvents/.test(probe) && /canWriteMigrationsLedger/.test(probe)
      && /ecriture_directe_sur_evenements_dpp_append_only/.test(probe)
      && /ecriture_sur_le_registre_des_migrations_prisma/.test(probe),
  ],
  [
    'le contrat refuse une ligne visible sans contexte, et une adhesion privilegiee',
    /lignes_visibles_sans_contexte_arme/.test(probe) && /membre_d_un_role_privilegie/.test(probe),
  ],
  [
    'les ecarts sont nommes un par un, et la route les publie sous authentification',
    /export function databaseIdentityViolations/.test(probe)
      && /databaseIdentityViolations\(databaseIdentity\)/.test(readiness)
      && /databaseIdentityViolations: identityViolations/.test(readiness),
  ],
  [
    'aucun SET ROLE dans le code applicatif : current_user est le role de connexion',
    !/SET\s+ROLE/i.test(sequentiel('api', ['.ts', '.js', '.mjs'])),
  ],
  [
    'la sonde Preview publie les attributs et distingue les causes par code de sortie',
    /attribut_bypassrls/.test(sondePreview) && /exit\(4\)/.test(sondePreview)
      && /exit\(5\)/.test(sondePreview) && /exit\(6\)/.test(sondePreview),
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
