#!/usr/bin/env node
/* ==========================================================================
   Barriere `quality.no_open_issues` — la porte ne doit pas s'ouvrir par
   ABSENCE d'evaluation.

   Ce que ce test protege
   ----------------------
   Jusqu'a la migration `20261021170000`, la barriere se reduisait a

       NOT EXISTS (SELECT 1 FROM data_quality_issues ...)

   Un produit jamais evalue n'a aucune ligne d'anomalie : il franchissait donc
   la barriere sans qu'aucun controle ait eu lieu. Un dossier DPP pouvait
   afficher un « vert » qualite que personne n'avait calcule.

   La migration `20261027100000` exige, en plus, une evaluation persistee
   (`data_quality_scores`). Ce test lit la DERNIERE definition de
   `tracefab_dpp_requirement_met` et verifie que :

     1. la branche `quality.no_open_issues` exige une evaluation ;
     2. les treize exigences du profil sont toujours couvertes ;
     3. les privileges restent retires (aucun oracle d'existence produit) ;
     4. la migration ne touche a rien d'autre (pas de DDL de table/policy) ;
     5. le sens du changement est documente en tete de fichier.

   Limite assumee : un test statique ne joue pas le SQL. Il empêche une
   REGRESSION de la definition ; il ne prouve pas son comportement en base.
   Cette preuve-la exige une base migree (`npm run test:neon:*`).
   ========================================================================== */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MIGRATIONS = join(ROOT, 'prisma/migrations');

let failures = 0;
const fail = (message) => { console.error(`  ECHEC ${message}`); failures++; };
const ok = (message) => console.log(`  ok    ${message}`);

const FUNCTION = 'tracefab_dpp_requirement_met';

// Toutes les migrations, dans l'ordre lexicographique (= ordre d'application).
const dirs = readdirSync(MIGRATIONS)
  .filter((name) => statSync(join(MIGRATIONS, name)).isDirectory())
  .sort();

const definitions = dirs
  .map((dir) => {
    const file = join(MIGRATIONS, dir, 'migration.sql');
    let sql;
    try { sql = readFileSync(file, 'utf8'); } catch { return null; }
    const marker = sql.indexOf(`CREATE OR REPLACE FUNCTION ${FUNCTION}(`);
    if (marker < 0) return null;
    return { dir, file, sql, start: marker };
  })
  .filter(Boolean);

if (!definitions.length) {
  fail(`aucune definition de ${FUNCTION} trouvee dans prisma/migrations`);
  process.exit(1);
}

const last = definitions[definitions.length - 1];
ok(`${definitions.length} definition(s) de ${FUNCTION} — la derniere est ${last.dir}`);

if (!last.dir.startsWith('20261027100000')) {
  fail(`la derniere definition devrait venir de 20261027100000_dpp_quality_gate_requires_assessment, pas de ${last.dir}`);
}

const body = last.sql.slice(last.start);

/* -- 1. la branche qualite exige une evaluation --------------------------- */
const branchMatch = body.match(/WHEN\s+'quality\.no_open_issues'\s+THEN([\s\S]*?)(?=WHEN\s+'|ELSE\s+v_met)/);
if (!branchMatch) {
  fail("branche 'quality.no_open_issues' introuvable dans la derniere definition");
} else {
  const branch = branchMatch[1];
  if (!/EXISTS\s*\(\s*SELECT 1 FROM data_quality_scores/.test(branch)) {
    fail('la barriere ne verifie pas qu\'une evaluation qualite existe (data_quality_scores)');
  } else {
    ok('la barriere exige une evaluation qualite persistee');
  }
  if (!/NOT EXISTS\s*\(\s*SELECT 1 FROM data_quality_issues/.test(branch)) {
    fail('la barriere ne verifie plus l\'absence d\'anomalie ouverte');
  } else {
    ok('la barriere exige toujours l\'absence d\'anomalie ouverte');
  }
  // La conjonction doit etre explicite : un `OR` rouvrirait la porte.
  if (/\bOR\b/.test(branch.replace(/'[^']*'/g, "''"))) {
    fail('la condition contient un OR : l\'absence d\'anomalie suffirait de nouveau');
  }
}

/* -- 2. les treize exigences sont couvertes ------------------------------- */
const REQUIRED = [
  'product.reference', 'product.name', 'product.description', 'product.category',
  'product.country_of_manufacture', 'product.required_attributes',
  'composition.complete', 'materials.origin_documented', 'traceability.graph',
  'traceability.documented', 'quality.no_open_issues', 'evidence.product_data',
  'product.not_draft',
];
const missing = REQUIRED.filter((key) => !body.includes(`'${key}'`));
if (missing.length) fail(`exigences absentes de la fonction : ${missing.join(', ')}`);
else ok('les 13 exigences du profil sont toujours traitees');

/* -- 3. privileges retires ------------------------------------------------ */
for (const role of ['PUBLIC', 'tracefab_app']) {
  if (!new RegExp(`REVOKE EXECUTE ON FUNCTION ${FUNCTION}\\(TEXT, UUID\\) FROM ${role};`).test(last.sql)) {
    fail(`REVOKE manquant pour ${role} : la fonction redeviendrait un oracle d'existence produit`);
  }
}
if (!failures) ok('les privileges sont retires (PUBLIC et tracefab_app)');

/* -- 4. aucune autre modification de schema ------------------------------- */
const forbidden = [/\bALTER\s+TABLE\b/i, /\bCREATE\s+TABLE\b/i, /\bCREATE\s+(OR\s+REPLACE\s+)?POLICY\b/i,
  /\bDROP\s+(TABLE|POLICY|COLUMN)\b/i, /\bALTER\s+POLICY\b/i, /\bGRANT\b/i];
for (const pattern of forbidden) {
  if (pattern.test(last.sql)) fail(`la migration contient une instruction interdite ici : ${pattern}`);
}
if (!forbidden.some((pattern) => pattern.test(last.sql))) {
  ok('aucun changement de table, colonne, policy ni GRANT');
}

/* -- 5. intention documentee ---------------------------------------------- */
if (!/absence d('|\\s)?evaluation|jamais evalue/i.test(last.sql.slice(0, 2000))) {
  fail('la migration ne documente pas le faux positif qu\'elle corrige');
} else {
  ok('la migration documente le faux positif corrige');
}

console.log('');
if (failures) {
  console.error(`Barriere qualite : ${failures} probleme(s).`);
  process.exit(1);
}
console.log("Barriere qualite : OK — `quality.no_open_issues` ne peut plus etre satisfaite par l'absence d'evaluation.");
