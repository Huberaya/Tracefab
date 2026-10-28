#!/usr/bin/env node
/**
 * Test bloquant du registre des fonctions ouvertes au runtime.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La migration 20261021120000_limit_app_function_execute a limite les fonctions
 * executables par `tracefab_app` a une liste ecrite dans son propre code. Ce
 * controle etait bon mais FIGE : la migration verifie que chaque nom de sa liste
 * existe deja, donc une migration posterieure ne pouvait rien ajouter sans
 * modifier un fichier deja applique — ce qui change son empreinte et exige
 * d'ecrire dans _prisma_migrations. Consequence mesuree le 28/10/2026 : la
 * chaine n'autorisait AUCUN ajout de fonction appelee depuis `api/`.
 *
 * La reponse n'est pas d'assouplir le controle, mais de le deplacer dans un
 * registre en base (migration 20261028120000) ou une migration posterieure
 * ajoute des noms par INSERT. Ce test verifie que le deplacement n'a rien perdu.
 *
 * LES SIX CONDITIONS D'ECHEC
 *
 *   1. une fonction autorisee n'existe pas (nom fantome, surcharge, proprietaire
 *      inattendu) ;
 *   2. le module TypeScript et la base divergent ;
 *   3. une fonction non autorisee est ajoutee (EXECUTE hors registre) ;
 *   4. le perimetre herite est perdu (moins de 84 noms d'origine) ;
 *   5. l'historique a ete modifie : la migration 20261021120000 a change de
 *      contenu, alors qu'elle est deja appliquee partout ;
 *   6. une migration posterieure accorde EXECUTE directement a `tracefab_app`
 *      au lieu de passer par le registre.
 *
 * Les conditions 5 et 1 (partie statique) ne demandent aucune base : elles
 * tournent partout. Les conditions 1 a 4 ont aussi une phase base, qui ne
 * s'execute que si DATABASE_URL est fourni.
 *
 * Sortie 0 = conforme, 1 = regression, 2 = NON EXECUTE (environnement).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_FUNCTION_NAMES } from './lib/tracefab_runtime_functions.mjs';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(RACINE, 'prisma', 'migrations');

// Migration qui porte le perimetre historique, et son empreinte au moment ou ce
// test a ete ecrit. La modifier est interdit : elle est deja appliquee partout,
// et un changement de contenu desynchronise le checksum de toutes les bases.
const MIGRATION_HISTORIQUE = '20261021120000_limit_app_function_execute';
const EMPREINTE_HISTORIQUE = 'e9f00fb17be91ece1925d159e8b128146fdb9eddb0f7d986202e7cc2ae299b6c';
const MIGRATION_REGISTRE = '20261028120000_runtime_function_registry';
const NB_HERITES = 84;

const refus = [];
const ok = (condition, libelle, detail) => {
  if (condition) {
    console.log(`  ok        ${libelle}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ECHEC     ${libelle}${detail ? ` — ${detail}` : ''}`);
    refus.push(libelle);
  }
};

const lire = (chemin) => readFileSync(chemin, 'utf8');
const nomsEntreApostrophes = (bloc) => [...bloc.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);

// --- A. Historique intact ---------------------------------------------------
console.log('A. La migration historique n a pas bouge');
const cheminHistorique = path.join(MIGRATIONS, MIGRATION_HISTORIQUE, 'migration.sql');
ok(existsSync(cheminHistorique), `la migration ${MIGRATION_HISTORIQUE} est presente`);
const sourceHistorique = lire(cheminHistorique);
const empreinte = createHash('sha256').update(sourceHistorique).digest('hex');
ok(
  empreinte === EMPREINTE_HISTORIQUE,
  'son contenu est identique a la version revue',
  empreinte === EMPREINTE_HISTORIQUE ? empreinte.slice(0, 16) : `attendu ${EMPREINTE_HISTORIQUE.slice(0, 16)}, lu ${empreinte.slice(0, 16)}`,
);

const blocHistorique = sourceHistorique.match(/runtime_names text\[\] := ARRAY\[([\s\S]*?)\]::text\[\];/);
ok(!!blocHistorique, 'le tableau runtime_names est lisible');
const nomsHistoriques = blocHistorique ? nomsEntreApostrophes(blocHistorique[1]) : [];
ok(
  nomsHistoriques.length === NB_HERITES,
  `le perimetre herite compte ${NB_HERITES} noms`,
  String(nomsHistoriques.length),
);
ok(
  new Set(nomsHistoriques).size === nomsHistoriques.length,
  'aucun nom herite en double',
);

// --- B. Le registre reprend le perimetre herite -----------------------------
console.log('\nB. Le registre reprend le perimetre herite');
const cheminRegistre = path.join(MIGRATIONS, MIGRATION_REGISTRE, 'migration.sql');
ok(existsSync(cheminRegistre), `la migration ${MIGRATION_REGISTRE} est presente`);
const sourceRegistre = lire(cheminRegistre);
const blocSeed = sourceRegistre.match(/INSERT INTO public\.tracefab_runtime_function_registry[^;]*;([\s\S]*?)/);
const nomsSeed = new Set(
  [...sourceRegistre.matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*'20261021120000_limit_app_function_execute'\s*\)/g)]
    .map((m) => m[1]),
);
ok(!!blocSeed, 'le seed du registre est present');
ok(nomsSeed.size === NB_HERITES, `le seed reprend ${NB_HERITES} noms`, String(nomsSeed.size));
const perdus = nomsHistoriques.filter((n) => !nomsSeed.has(n));
const ajoutes = [...nomsSeed].filter((n) => !nomsHistoriques.includes(n));
ok(perdus.length === 0, 'aucun nom herite perdu', perdus.join(', ') || 'aucun');
ok(ajoutes.length === 0, 'aucun nom herite invente', ajoutes.join(', ') || 'aucun');

// --- C. Les ajouts ulterieurs passent tous par le registre -----------------
console.log('\nC. Les migrations posterieures declarent au registre');
const dossiers = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const posterieurs = dossiers.filter((d) => d > MIGRATION_REGISTRE);
const ajouts = new Map();
const grantsDirects = [];
for (const dossier of posterieurs) {
  const fichier = path.join(MIGRATIONS, dossier, 'migration.sql');
  if (!existsSync(fichier)) continue;
  const sql = lire(fichier)
    .replace(/--[^\n]*/g, '');
  for (const m of sql.matchAll(
    /INSERT INTO public\.tracefab_runtime_function_registry[\s\S]*?;/g,
  )) {
    for (const row of m[0].matchAll(/\(\s*'([a-z0-9_]+)'\s*,/g)) ajouts.set(row[1], dossier);
  }
  // Un GRANT EXECUTE direct court-circuiterait le registre : on refuse.
  for (const m of sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([a-z0-9_.]+)[^;]*TO\s+tracefab_app/gi)) {
    grantsDirects.push(`${dossier}:${m[1]}`);
  }
}
ok(
  grantsDirects.length === 0,
  'aucune migration posterieure n accorde EXECUTE directement a tracefab_app',
  grantsDirects.join(', ') || 'aucun',
);
console.log(`  info      ${ajouts.size} nom(s) ajoute(s) apres le registre`);

// --- D. Module et registre concordent --------------------------------------
console.log('\nD. Le module TypeScript et le registre concordent');
const registreAttendu = [...new Set([...nomsSeed, ...ajouts.keys()])].sort();
const module_ = [...RUNTIME_FUNCTION_NAMES].sort();
const seulementModule = module_.filter((n) => !registreAttendu.includes(n));
const seulementRegistre = registreAttendu.filter((n) => !module_.includes(n));
ok(
  seulementModule.length === 0,
  'toute fonction appelee par le runtime est declaree au registre',
  seulementModule.join(', ') || 'aucun ecart',
);
ok(
  seulementRegistre.length === 0,
  'toute fonction du registre est connue du module',
  seulementRegistre.join(', ') || 'aucun ecart',
);
ok(
  module_.length === registreAttendu.length,
  'module et registre ont le meme nombre d entrées',
  `module=${module_.length} registre=${registreAttendu.length}`,
);

// --- E. Phase base : existence, unicite, absence d EXECUTE hors registre ---
const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\nE. Phase base — NON EXECUTE (DATABASE_URL absent)');
} else {
  console.log('\nE. Phase base : le registre est reellement applique');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    // 1. Une fonction autorisee doit exister, une seule fois, chez un
    //    proprietaire de confiance.
    const invalides = await client.query(`
      select r.name,
             count(p.oid) filter (where n.nspname = 'public') as trouvees,
             coalesce(bool_or(pg_get_userbyid(p.proowner) not in (current_user, 'tracefab_worker'))
                      filter (where n.nspname = 'public'), false) as proprietaire_suspect
        from public.tracefab_runtime_function_registry r
        left join pg_proc p on p.proname = r.name and p.prokind = 'f'
        left join pg_namespace n on n.oid = p.pronamespace
       group by r.name
      having count(p.oid) filter (where n.nspname = 'public') <> 1
          or coalesce(bool_or(pg_get_userbyid(p.proowner) not in (current_user, 'tracefab_worker'))
                      filter (where n.nspname = 'public'), false)
       order by r.name`);
    ok(
      invalides.rowCount === 0,
      'chaque nom autorise designe exactement une fonction existante',
      invalides.rows.map((r) => r.name).join(', ') || 'aucune anomalie',
    );

    // 2. Module et base concordent.
    const enBase = (await client.query('select name from public.tracefab_runtime_function_registry order by name'))
      .rows.map((r) => r.name);
    const manquantsEnBase = module_.filter((n) => !enBase.includes(n));
    const enTropEnBase = enBase.filter((n) => !module_.includes(n));
    ok(
      manquantsEnBase.length === 0,
      'la base declare toutes les fonctions du module',
      manquantsEnBase.join(', ') || 'aucun ecart',
    );
    ok(
      enTropEnBase.length === 0,
      'la base ne declare rien que le module ignore',
      enTropEnBase.join(', ') || 'aucun ecart',
    );

    // 3. Aucune fonction non autorisee n est executable par le runtime.
    const horsRegistre = await client.query(`
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
         and p.proname not in (select name from public.tracefab_runtime_function_registry)
       order by 1`);
    ok(
      horsRegistre.rowCount === 0,
      'aucune fonction executable par le runtime hors registre',
      horsRegistre.rows.map((r) => r.proname).join(', ') || 'aucune',
    );

    // 4. Aucune fonction du registre n est ouverte a PUBLIC.
    const publiques = await client.query(`
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where n.nspname = 'public'
         and p.prokind = 'f'
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
         and p.proname in (select name from public.tracefab_runtime_function_registry)
       order by 1`);
    ok(
      publiques.rowCount === 0,
      'aucune fonction autorisee n est executable par PUBLIC',
      publiques.rows.map((r) => r.proname).join(', ') || 'aucune',
    );

    // 5. La fonction d'application n est pas utilisable par le runtime : sinon
    //    il pourrait s'ouvrir lui-meme n'importe quelle fonction.
    const reouverture = await client.query(
      "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'tracefab_apply_runtime_function_grants' and has_function_privilege('tracefab_app', p.oid, 'EXECUTE')",
    );
    ok(
      reouverture.rows[0].n === 0,
      'le runtime ne peut pas re-executer la fonction de redistribution des droits',
      String(reouverture.rows[0].n),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

console.log('\nVerdict');
console.log('-------');
if (refus.length === 0) {
  console.log('  ok — registre coherent, perimetre herite preserve, aucun elargissement.');
  process.exit(0);
}
console.log(`  ECHEC — ${refus.length} propriete(s) non tenue(s) :`);
for (const r of refus) console.log(`    - ${r}`);
process.exit(1);
