#!/usr/bin/env node
/**
 * VERIFICATION D'IDENTITE D'UNE CIBLE — avant toute ecriture, en lecture seule.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * « Ne jamais ecrire sur une base dont l'identite n'est pas prouvee. » Une
 * chaine de connexion ressemble a une autre ; une branche Neon derivee de la
 * production et la production elle-meme ne se distinguent pas a l'oeil. Ce
 * script refuse par defaut : l'operateur doit NOMMER la cible attendue, et le
 * script compare ce qu'il constate a ce qui est declare.
 *
 * CE QU'IL PROUVE
 *   - l'hote reel de la connexion correspond a celui declare ;
 *   - la base est celle attendue ;
 *   - le role effectif, ses attributs (superutilisateur, BYPASSRLS) ;
 *   - le schema attendu est present (tables et fonctions DPP) ;
 *   - le registre `_prisma_migrations` : nombre termine, echecs, inachevees,
 *     dernieres appliquees, et ecart avec le depot ;
 *   - le profil actif `textile_readiness_mvp` et son nombre d'exigences ;
 *   - l'etat du parc en AGREGATS seulement (produits, dossiers, publies,
 *     revus, slugs) et les deux incoherences qui comptent :
 *         · slug pose mais produit non publiquement resoluble ;
 *         · produit publiquement resoluble sans revue valide.
 *
 * CE QU'IL NE PROUVE PAS
 *   - qu'il s'agit de la branche `br-…` annoncee : Neon n'expose pas
 *     l'identifiant de branche a SQL. L'hote est donc la seule preuve, et le
 *     script le dit au lieu de le laisser croire.
 *   - l'effet d'une migration a venir.
 *
 * USAGE
 *   DATABASE_URL=... \
 *   TF_ATTENDU_HOTE=ep-xxx.eu-central-1.aws.neon.tech \
 *   TF_ATTENDU_BASE=neondb \
 *   [TF_ATTENDU_MIGRATIONS=56] \
 *   [TF_EXIGER_MIGRATIONS=nom1,nom2,nom3] \
 *     node scripts/verifier_identite_branche.mjs
 *
 * `TF_EXIGER_MIGRATIONS` est la liste des migrations qui DOIVENT etre
 * appliquees et terminees. Sans elle, le script constate ; avec elle, il exige.
 * C'est ce qui distingue « l'etat est coherent » de « les trois migrations
 * attendues sont bien la ».
 *
 * CODES DE SORTIE
 *   0 identite prouvee et etat coherent ; 2 usage ; 3 cible refusee ;
 *   4 identite differente de la declaration ; 5 etat incoherent
 *   (schema manquant, migration en echec, registre en avance sur le depot).
 *
 * Aucune URL de connexion, aucun mot de passe, aucune donnee personnelle n'est
 * imprimee. Seul l'hote — sans identifiants — est affiche.
 */
import pg from 'pg';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'prisma/migrations');

const HOTE_PRODUCTION = process.env.TF_HOTE_PRODUCTION
  || 'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech';

const url = process.env.DATABASE_URL;
if (!url) { console.error('NON EXECUTE — DATABASE_URL obligatoire.'); process.exit(2); }

let hote;
try { hote = new URL(url).hostname; } catch { console.error('NON EXECUTE — DATABASE_URL illisible.'); process.exit(2); }

if (hote === HOTE_PRODUCTION || /^ep-polished-night/.test(hote)) {
  console.error(`REFUS — ${hote} est la base de PRODUCTION. Aucune verification d'identite ne s'y joue.`);
  process.exit(3);
}

const attenduHote = process.env.TF_ATTENDU_HOTE;
const attenduBase = process.env.TF_ATTENDU_BASE;
if (!attenduHote || !attenduBase) {
  console.error('REFUS — la cible doit etre nommee : TF_ATTENDU_HOTE et TF_ATTENDU_BASE sont obligatoires.');
  console.error(`         hote reel de la connexion : ${hote}`);
  console.error('         (le script refuse de deviner : une cible non nommee n\'est pas une cible prouvee)');
  process.exit(3);
}

if (attenduHote !== hote) {
  console.error('REFUS — l\'hote de DATABASE_URL ne correspond pas a la cible declaree.');
  console.error(`         declare : ${attenduHote}`);
  console.error(`         reel    : ${hote}`);
  process.exit(4);
}

const attenduMigrations = process.env.TF_ATTENDU_MIGRATIONS
  ? Number(process.env.TF_ATTENDU_MIGRATIONS) : null;
const exigees = (process.env.TF_EXIGER_MIGRATIONS || '')
  .split(',').map((n) => n.trim()).filter(Boolean);

const depot = readdirSync(MIGRATIONS)
  .filter((n) => /^\d/.test(n) && existsSync(join(MIGRATIONS, n, 'migration.sql')))
  .sort();

const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-identite' });
await client.connect();

const ligne = (titre) => console.log(`\n${titre}\n${'-'.repeat(titre.length)}`);
let incoherences = 0;
const dit = (ok, texte, detail = '') => {
  if (!ok) incoherences += 1;
  console.log(`  ${ok ? 'ok   ' : 'ECHEC'} ${texte}${detail ? ` — ${detail}` : ''}`);
};

ligne('Identite constatee');
const { rows: [id] } = await client.query(`
  SELECT current_database() AS base,
         current_user AS role_effectif,
         session_user AS role_session,
         version() AS version,
         inet_server_addr()::text AS adresse,
         inet_server_port() AS port,
         (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`);
console.log(`  hote (declaration) : ${hote}`);
console.log(`  base               : ${id.base}`);
console.log(`  role effectif      : ${id.role_effectif} (session : ${id.role_session})`);
console.log(`  superutilisateur   : ${id.superuser ? 'OUI' : 'non'}`);
console.log(`  BYPASSRLS          : ${id.bypassrls ? 'OUI' : 'non'}`);
console.log(`  serveur            : ${String(id.version).split(' ').slice(0, 2).join(' ')}`);
console.log(`  adresse/port       : ${id.adresse || 'non exposee (proxy)'}${id.port ? `:${id.port}` : ''}`);

dit(id.base === attenduBase, `la base est celle declaree (${attenduBase})`, id.base);

ligne('Schema attendu');
const TABLES = ['tracefab_products', 'dpp_records', 'dpp_lifecycle_events', 'audit_logs',
  'dpp_requirement_profiles', 'organization_memberships'];
for (const t of TABLES) {
  const { rows: [r] } = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${t}`]);
  dit(r.present, `table ${t}`);
}
const FONCTIONS = ['tracefab_compute_dpp_readiness', 'tracefab_product_is_public',
  'tracefab_mark_dpp_ready_to_publish', 'tracefab_set_dpp_publication',
  'tracefab_dpp_requirement_met'];
for (const f of FONCTIONS) {
  const { rows: [r] } = await client.query(
    'SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1', [f]);
  dit(r.n >= 1, `fonction ${f}`, r.n > 1 ? `${r.n} surcharges` : '');
}

ligne('Registre des migrations');
const { rows: [reg] } = await client.query(`
  SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS terminees,
         count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS en_echec,
         count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NOT NULL)::int AS annulees,
         count(*)::int AS total
  FROM public._prisma_migrations`);
const { rows: dernieres } = await client.query(`
  SELECT migration_name FROM public._prisma_migrations
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  ORDER BY migration_name DESC LIMIT 5`);
const { rows: appliquees } = await client.query(`
  SELECT migration_name FROM public._prisma_migrations
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
const nomsAppliques = new Set(appliquees.map((r) => r.migration_name));

console.log(`  terminees : ${reg.terminees} · en echec : ${reg.en_echec} · annulees : ${reg.annulees}`);
console.log('  5 dernieres :');
for (const d of dernieres) console.log(`    ${d.migration_name}`);
const enAttente = depot.filter((n) => !nomsAppliques.has(n));
const inconnues = [...nomsAppliques].filter((n) => !depot.includes(n));
console.log(`  en attente dans le depot : ${enAttente.length}`);
for (const n of enAttente) console.log(`    ${n}`);
if (inconnues.length) {
  console.log(`  appliquees mais absentes du depot : ${inconnues.length}`);
  for (const n of inconnues) console.log(`    ${n}`);
}

dit(reg.en_echec === 0, 'aucune migration en echec', String(reg.en_echec));
dit(inconnues.length === 0, 'aucune migration appliquee hors du depot', inconnues.join(', '));
if (attenduMigrations !== null) {
  dit(reg.terminees === attenduMigrations, `le registre compte ${attenduMigrations} migrations terminees`,
    String(reg.terminees));
}
dit(reg.terminees <= depot.length, 'le registre n\'est pas en avance sur le depot',
  `${reg.terminees} / ${depot.length} au depot`);

// Exigence nominative : chaque migration citee doit etre appliquee ET terminee.
if (exigees.length) {
  for (const nom of exigees) {
    const appliquee = nomsAppliques.has(nom);
    dit(appliquee, `migration exigee appliquee : ${nom}`,
      appliquee ? '' : (depot.includes(nom) ? 'presente au depot mais NON appliquee' : 'absente du depot'));
  }
} else {
  console.log('  (aucune migration exigee nominativement : TF_EXIGER_MIGRATIONS absent)');
}

ligne('Role applicatif, privileges et RLS');
// Le role applicatif est provisionne hors Prisma. S'il est absent de la cible,
// ce n'est pas un defaut du depot : la section est declaree non applicable au
// lieu d'etre comptee comme un echec. S'il est present, ses droits se mesurent.
const { rows: [roleApp] } = await client.query(
  "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'tracefab_app'");
if (!roleApp) {
  console.log('  tracefab_app absent de cette cible — section non applicable');
} else {
  console.log(`  tracefab_app : login ${roleApp.rolcanlogin ? 'oui' : 'non'}`
    + ` · superutilisateur ${roleApp.rolsuper ? 'OUI' : 'non'}`
    + ` · BYPASSRLS ${roleApp.rolbypassrls ? 'OUI' : 'non'}`);
  dit(!roleApp.rolsuper && !roleApp.rolbypassrls,
    'le role applicatif ne contourne ni les privileges ni la RLS');

  const TABLES_RLS = ['dpp_records', 'dpp_lifecycle_events', 'tracefab_products', 'dpp_requirement_profiles'];
  for (const t of TABLES_RLS) {
    const { rows: [r] } = await client.query(
      'SELECT relrowsecurity AS rls FROM pg_class WHERE oid = to_regclass($1)', [`public.${t}`]);
    dit(Boolean(r && r.rls), `RLS active sur ${t}`, r ? '' : 'table absente');
  }

  // Les migrations 20261017120000 et 20261023120000 ferment l'ecriture directe
  // du role applicatif sur les tables DPP : il ne doit garder que la lecture.
  for (const t of ['dpp_records', 'dpp_lifecycle_events']) {
    const { rows: [p2] } = await client.query(`
      SELECT has_table_privilege('tracefab_app', $1, 'SELECT') AS sel,
             has_table_privilege('tracefab_app', $1, 'INSERT') AS ins,
             has_table_privilege('tracefab_app', $1, 'UPDATE') AS upd,
             has_table_privilege('tracefab_app', $1, 'DELETE') AS del`,
      [`public.${t}`]);
    console.log(`  ${t} : SELECT ${p2.sel} · INSERT ${p2.ins} · UPDATE ${p2.upd} · DELETE ${p2.del}`);
    dit(p2.sel === true, `lecture accordee sur ${t}`);
    dit(p2.ins === false && p2.upd === false && p2.del === false,
      `aucune ecriture directe du role applicatif sur ${t}`);
  }

  // PUBLIC ne doit executer aucune fonction DPP (migrations 20261014110000,
  // 20261021120000) ; le role applicatif, si — c'est son metier.
  const { rows: droits } = await client.query(`
    SELECT p.proname,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public_peut,
           has_function_privilege('tracefab_app', p.oid, 'EXECUTE') AS app_peut
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY($1::text[])
     ORDER BY p.proname`, [['tracefab_compute_dpp_readiness', 'tracefab_mark_dpp_ready_to_publish',
      'tracefab_set_dpp_publication', 'tracefab_dpp_requirement_met', 'tracefab_product_is_public']]);
  for (const d of droits) {
    console.log(`  ${d.proname} : PUBLIC ${d.public_peut} · tracefab_app ${d.app_peut}`);
  }
  dit(droits.every((d) => d.public_peut === false), 'PUBLIC n\'execute aucune fonction DPP',
    droits.filter((d) => d.public_peut).map((d) => d.proname).join(', '));
}

ligne('Profil d\'exigences actif');
const { rows: profils } = await client.query(`
  SELECT profile_version, status,
         jsonb_array_length(definition -> 'requirements')::int AS nb
  FROM dpp_requirement_profiles
  WHERE profile_key = 'textile_readiness_mvp'
  ORDER BY profile_version`);
for (const p of profils) console.log(`  v${p.profile_version} · ${p.status} · ${p.nb} exigence(s)`);
const actif = profils.find((p) => p.status === 'active');
dit(Boolean(actif), 'un profil actif existe');
if (actif) console.log(`  -> version active : v${actif.profile_version}, ${actif.nb} exigence(s)`);

ligne('Parc (agregats seulement)');
const { rows: [parc] } = await client.query(`
  SELECT (SELECT count(*)::int FROM tracefab_products) AS produits,
         (SELECT count(*)::int FROM dpp_records) AS dossiers,
         (SELECT count(*)::int FROM dpp_records WHERE readiness_status = 'published') AS publies,
         (SELECT count(*)::int FROM dpp_records WHERE reviewed_at IS NOT NULL) AS revus,
         (SELECT count(*)::int FROM dpp_records WHERE reviewed_basis_fingerprint IS NOT NULL) AS revus_avec_empreinte,
         (SELECT count(*)::int FROM dpp_records WHERE review_invalidated_at IS NOT NULL) AS invalidations,
         (SELECT count(*)::int FROM tracefab_products WHERE public_slug IS NOT NULL) AS slugs`);
console.log(`  produits ${parc.produits} · dossiers ${parc.dossiers} · publies ${parc.publies} · revus ${parc.revus}`);
console.log(`  revus avec empreinte de revue ${parc.revus_avec_empreinte} · invalidations ${parc.invalidations} · slugs ${parc.slugs}`);

// Les deux incoherences qui ont motive la migration corrective. Elles se
// mesurent, elles ne se supposent pas.
const { rows: [inco] } = await client.query(`
  SELECT count(*) FILTER (WHERE p.public_slug IS NOT NULL AND NOT tracefab_product_is_public(p.id))::int AS slug_sans_public,
         count(*) FILTER (WHERE p.public_slug IS NULL AND tracefab_product_is_public(p.id))::int AS public_sans_slug,
         count(*) FILTER (WHERE d.readiness_status = 'published' AND d.reviewed_at IS NULL)::int AS publie_sans_revue
  FROM tracefab_products p
  LEFT JOIN dpp_records d ON d.product_id = p.id`);
dit(inco.slug_sans_public === 0, 'aucun produit avec slug mais non resoluble publiquement',
  String(inco.slug_sans_public));
dit(inco.public_sans_slug === 0, 'aucun produit resoluble publiquement sans slug',
  String(inco.public_sans_slug));
dit(inco.publie_sans_revue === 0, 'aucun dossier publie sans revue',
  String(inco.publie_sans_revue));

await client.end();

ligne('Conclusion');
if (incoherences > 0) {
  console.error(`  ${incoherences} incoherence(s) — NE PAS ECRIRE sur cette cible avant analyse.`);
  process.exit(5);
}
console.log('  identite conforme a la declaration, registre sain, parc coherent.');
console.log(`  migrations en attente : ${enAttente.length} — prochaine etape : npm run db:deploy`);
process.exit(0);
