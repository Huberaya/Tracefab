#!/usr/bin/env node
/**
 * Isolation RLS prouvée sur des LIGNES EXISTANTES.
 *
 * Pourquoi ce contrôle existe séparément.
 *
 * `has_table_privilege`, `FORCE ROW LEVEL SECURITY` et un `DELETE ... WHERE
 * false` ne prouvent rien de l'isolation : le premier ne dit que le droit
 * d'essayer, le deuxième ne dit pas qu'une politique filtre, et le troisième
 * n'examine aucune ligne — avec `WHERE false` la clause USING n'est jamais
 * évaluée. Ce contrôle crée donc deux organisations réelles, y insère des
 * lignes réelles, puis tente de les lire, les modifier et les supprimer depuis
 * l'autre organisation.
 *
 * Chaque assertion est accompagnée d'un contrôle positif : si l'opération
 * légitime correspondante échoue aussi, le test le dit au lieu de conclure à
 * une isolation qui ne viendrait que d'une base vide.
 *
 * Ordre de provisioning : le rôle applicatif est créé AVANT les migrations,
 * comme le font la CI (`db:prepare-ci-role` puis `db:deploy:throwaway`) et
 * Production. C'est l'ordre qui déclenche le bloc $preserve_runtime_acl$ de la
 * migration 20261014130000, donc le seul ordre représentatif.
 *
 * Sorties : 0 conforme · 1 défaut · 2 prérequis manquant · 3 cible refusée.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { TABLES_ECRITURE_DIRECTE } from './lib/tracefab_app_role.mjs';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SORTIE_DEFAUT = 1;
const SORTIE_PREREQUIS = 2;

const APP_ROLE = 'tracefab_app';
const BASE_EPHEMERE = 'tracefab_isolation_lignes';
const MOT_DE_PASSE = process.env.TF_APP_PASSWORD || 'epreuve_locale_jetable';

let vertes = 0;
let rouges = 0;
const echecs = [];

function verifier(etiquette, ok, detail) {
  if (ok) {
    vertes += 1;
    console.log(`    ok    ${etiquette}`);
  } else {
    rouges += 1;
    echecs.push(etiquette);
    console.log(`    ECHEC ${etiquette}${detail ? ` — observé : ${detail}` : ''}`);
  }
}

/* --- Prérequis ------------------------------------------------------------ */

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: "isolation RLS sur lignes réelles, deux organisations",
  exitOnFailure: true,
});

const urlAdmin = process.env.DATABASE_URL;
const hote = (urlAdmin.match(/@([^/:]+)/) || [])[1] ?? 'illisible';
const urlMaintenance = urlAdmin.replace(/\/[^/?]+(\?|$)/, '/postgres$1');

const uuid = (graine) => {
  const h = crypto.createHash('sha1').update(`tracefab-isol-${graine}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const admin = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${BASE_EPHEMERE}`);
await admin.query(`CREATE DATABASE ${BASE_EPHEMERE}`);
await admin.end();

const url = urlAdmin.replace(/\/[^/?]+(\?|$)/, `/${BASE_EPHEMERE}$1`);
const urlApp = url.replace(/:\/\/[^@]*@/, `://${APP_ROLE}:${encodeURIComponent(MOT_DE_PASSE)}@`);

console.log(`\n  base éphémère sur ${hote} — ${BASE_EPHEMERE}`);

const boot = () =>
  execFileSync('node', [path.join(RACINE, 'scripts', 'bootstrap_app_role.mjs')], {
    env: { ...process.env, DATABASE_URL: url, TF_APP_PASSWORD: MOT_DE_PASSE },
    stdio: 'ignore',
  });

const mig = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
await mig.connect();
await mig.query(
  `CREATE TABLE IF NOT EXISTS _prisma_migrations (
     id text PRIMARY KEY, checksum text NOT NULL, finished_at timestamptz,
     migration_name text NOT NULL, logs text, rolled_back_at timestamptz,
     started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`,
);

// Le rôle AVANT les migrations : ordre réel de la CI et de Production.
boot();

const dossiers = fs
  .readdirSync(path.join(RACINE, 'prisma', 'migrations'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let appliquees = 0;
for (const d of dossiers) {
  const sql = fs.readFileSync(path.join(RACINE, 'prisma', 'migrations', d, 'migration.sql'), 'utf8');
  if (!sql.trim() || sql.trim() === '-- This is an empty migration.') continue;
  try {
    await mig.query(sql);
    appliquees += 1;
  } catch (e) {
    console.log(`    MIGRATION EN ECHEC ${d} — ${e.code} ${String(e.message).split('\n')[0]}`);
  }
}
console.log(`  migrations appliquées : ${appliquees}/${dossiers.length}`);
await mig.query(
  `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name)
   SELECT gen_random_uuid()::text, 'x', now(), unnest($1::text[]) ON CONFLICT DO NOTHING`,
  [dossiers],
);
await mig.end();

/* --- Contrôle négatif optionnel -------------------------------------------
 *
 * Un test d'isolation qui ne peut pas échouer ne prouve rien. Avec
 * ISOLATION_CONTROLE_NEGATIF=desactive_rls_documents, la RLS est retirée de la
 * table `documents` après les migrations : les assertions A, B et C DOIVENT
 * alors passer au rouge. Si elles restent vertes, c'est qu'elles ne mesuraient
 * pas la RLS.
 */
if (process.env.ISOLATION_CONTROLE_NEGATIF === 'desactive_rls_documents') {
  const neg = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await neg.connect();
  await neg.query(`ALTER TABLE documents DISABLE ROW LEVEL SECURITY`);
  await neg.end();
  console.log('  CONTRÔLE NÉGATIF ACTIF : RLS désactivée sur documents — A, B et C doivent échouer');
}

/* --- Fixture : deux organisations, des lignes réelles --------------------- */

const fix = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
await fix.connect();

const A = { org: uuid('org-a'), user: uuid('user-a'), sup: uuid('sup-a') };
const B = { org: uuid('org-b'), user: uuid('user-b'), sup: uuid('sup-b') };

for (const [cle, t] of [['a', A], ['b', B]]) {
  await fix.query(`INSERT INTO organizations (id, type, legal_name) VALUES ($1,'brand',$2)`, [t.org, `Maison ${cle.toUpperCase()}`]);
  await fix.query(`INSERT INTO users (id, clerk_user_id, email, full_name) VALUES ($1,$2,$3,$4)`, [t.user, `clerk_isol_${cle}`, `${cle}@isolation.test`, `Responsable ${cle.toUpperCase()}`]);
  await fix.query(`INSERT INTO organization_memberships (id, organization_id, user_id, role) VALUES ($1,$2,$3,'owner')`, [uuid(`mem-${cle}`), t.org, t.user]);
  await fix.query(`INSERT INTO suppliers (id, organization_id) VALUES ($1,$2)`, [t.sup, t.org]);
}

// Un document réel par organisation. Le déclencheur
// tracefab_validate_document_location impose le bucket privé, un chemin préfixé
// par l'organisation et le statut « uploaded » : on respecte l'invariant.
const docA = uuid('doc-a');
const docB = uuid('doc-b');
for (const [cle, t, doc] of [['a', A, docA], ['b', B, docB]]) {
  await fix.query(
    `INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, visibility, status)
     VALUES ($1,$2,'tracefab-private',$3,$4,'application/pdf',1024,'private','uploaded')`,
    [doc, t.org, `${t.org}/preuve-${cle}.pdf`, `preuve-${cle}.pdf`],
  );
}

// Un produit publié par B : sert au test de lecture publique.
const prodBPublie = uuid('prodb-publie');
const prodBBrouillon = uuid('prodb-brouillon');
await fix.query(
  `INSERT INTO tracefab_products (id, brand_organization_id, reference, name, status, public_slug)
   VALUES ($1,$2,'B-001','Article publié B','active','b-001')`, [prodBPublie, B.org]);
await fix.query(
  `INSERT INTO dpp_records (id, product_id, product_version, requirement_profile_key,
     requirement_profile_version, readiness_status, reviewed_at, reviewed_by)
   VALUES ($1,$2,1,'espr-textile','1','published',now(),$3)`, [uuid('dpp-b'), prodBPublie, B.user]);
await fix.query(
  `INSERT INTO tracefab_products (id, brand_organization_id, reference, name, status)
   VALUES ($1,$2,'B-002','Brouillon B','draft')`, [prodBBrouillon, B.org]);

await fix.end();
console.log('  fixture : 2 organisations, 2 utilisateurs, 2 documents, 2 produits (1 publié, 1 brouillon)');

/* --- Connexion applicative ------------------------------------------------ */

const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp) });
await app.connect();

const identite = await app.query('SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS b');
verifier("la connexion est le rôle applicatif", identite.rows[0].u === APP_ROLE, identite.rows[0].u);
verifier("le rôle ne contourne pas la RLS", identite.rows[0].b === false, `rolbypassrls=${identite.rows[0].b}`);

/** Pose l'identité d'un utilisateur pour la durée de la transaction. */
async function enTantQue(userId, fn) {
  await app.query('BEGIN');
  try {
    if (userId) {
      await app.query(`SELECT set_config('tracefab.user_id', $1, true)`, [userId]);
    }
    return await fn();
  } finally {
    await app.query('ROLLBACK');
  }
}

/** Renvoie { ok, code, rows } sans lever.
 *
 * Une erreur SQL annule la transaction courante jusqu'au ROLLBACK.
 * Chaque tentative est donc isolée par un savepoint : en particulier,
 * un DELETE refusé par les privilèges minimaux ne doit pas faire échouer
 * artificiellement le contrôle positif UPDATE qui suit dans la même
 * transaction. */
async function tente(sql, params = []) {
  await app.query('SAVEPOINT tentative_operation');
  try {
    const r = await app.query(sql, params);
    await app.query('RELEASE SAVEPOINT tentative_operation');
    return { ok: true, rows: r.rows, count: r.rowCount };
  } catch (e) {
    await app.query('ROLLBACK TO SAVEPOINT tentative_operation');
    await app.query('RELEASE SAVEPOINT tentative_operation');
    return { ok: false, code: e.code, message: String(e.message).split('\n')[0] };
  }
}

/* --- A. Lecture inter-tenant ---------------------------------------------- */

console.log('\n  A. lecture inter-tenant, sur lignes existantes');

await enTantQue(A.user, async () => {
  const propres = await app.query(`SELECT id FROM documents WHERE id = $1`, [docA]);
  verifier('contrôle positif : A lit son propre document', propres.rowCount === 1, `${propres.rowCount} ligne`);

  const autres = await app.query(`SELECT id FROM documents WHERE id = $1`, [docB]);
  verifier('A ne lit PAS le document de B', autres.rowCount === 0, `${autres.rowCount} ligne visible`);

  const toutB = await app.query(`SELECT id FROM documents WHERE owner_organization_id = $1`, [B.org]);
  verifier('A ne lit aucun document de l organisation B', toutB.rowCount === 0, `${toutB.rowCount} lignes`);
});

/* --- B. Modification d'une ligne d'un autre tenant ------------------------- */

console.log('\n  B. modification inter-tenant');

// `documents` fait partie des quatre tables où le rôle applicatif a vraiment le
// droit d'écrire. C'est donc ici que la RLS — et non le privilège — doit agir.
await enTantQue(A.user, async () => {
  // La colonne modifiée est `original_filename`. Deux versions précédentes
  // écrivaient status puis byte_size, et restaient vertes même RLS désactivée :
  // le déclencheur de la migration initiale lève
  // managed_document_fields_are_not_client_writable sur status, byte_size,
  // sha256, uploaded_by, available_at, deleted_at et deleted_by. Le contrôle
  // négatif l'a révélé. `original_filename` n'est dans aucune de ces listes,
  // donc le refus observé vient bien de la RLS et non d'un déclencheur.
  const r = await tente(`UPDATE documents SET original_filename = 'infiltration.pdf' WHERE id = $1`, [docB]);
  verifier(
    "A ne peut pas modifier le document de B",
    !r.ok || r.count === 0,
    r.ok ? `${r.count} ligne modifiée` : `${r.code} ${r.message}`,
  );
});

const apresUpdate = await (async () => {
  const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await c.connect();
  const r = await c.query(`SELECT original_filename FROM documents WHERE id = $1`, [docB]);
  await c.end();
  return r.rows[0]?.original_filename;
})();
verifier("le document de B est intact après la tentative", apresUpdate === 'preuve-b.pdf', `original_filename=${apresUpdate}`);

/* --- C. Suppression d'une ligne d'un autre tenant -------------------------- */

console.log('\n  C. suppression inter-tenant');

await enTantQue(A.user, async () => {
  const r = await tente(`DELETE FROM documents WHERE id = $1`, [docB]);
  verifier(
    "A ne peut pas supprimer le document de B",
    !r.ok || r.count === 0,
    r.ok ? `${r.count} ligne supprimée` : `${r.code} ${r.message}`,
  );
  // Contrôle positif sur la même table : le privilège d'écrire existe bien,
  // donc le refus ci-dessus vient de la RLS et pas d'une absence de droit.
  const r2 = await tente(`UPDATE documents SET original_filename = 'renommé-par-a.pdf' WHERE id = $1`, [docA]);
  verifier("contrôle positif : A peut toucher son propre document", r2.ok && r2.count === 1, r2.ok ? `${r2.count} ligne` : `${r2.code} ${r2.message}`);
});

const docBExiste = await (async () => {
  const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await c.connect();
  const r = await c.query(`SELECT count(*)::int n FROM documents WHERE id = $1`, [docB]);
  await c.end();
  return r.rows[0].n;
})();
verifier("le document de B existe toujours", docBExiste === 1, `${docBExiste} ligne`);

/* --- D. Insertion avec une identité falsifiée ------------------------------ */

console.log('\n  D. insertion avec identité ou organisation falsifiée');

await enTantQue(A.user, async () => {
  // A tente d'écrire un document en se déclarant propriétaire l'organisation B.
  const r = await tente(
    `INSERT INTO documents (id, owner_organization_id, storage_bucket, storage_path,
       original_filename, content_type, byte_size, visibility, status)
     VALUES ($1,$2,'tracefab-private',$3,'infiltration.pdf','application/pdf',10,'private','uploaded')`,
    [uuid('doc-infil'), B.org, `${B.org}/infiltration.pdf`],
  );
  verifier(
    "insertion d'un document au nom de B refusée à A",
    !r.ok,
    r.ok ? 'INSERT accepté' : `${r.code} ${r.message}`,
  );
});

/* --- E. Accès sans contexte d'identité ------------------------------------- */

console.log('\n  E. accès sans contexte d identité');

await app.query('BEGIN');
const sansContexte = await app.query(`SELECT count(*)::int n FROM documents`);
verifier('sans identité, aucun document privé n est visible', sansContexte.rows[0].n === 0, `${sansContexte.rows[0].n} lignes`);
await app.query('ROLLBACK');

/* --- F. Tentative de contournement par fonction SECURITY DEFINER ----------- */

console.log('\n  F. fonctions SECURITY DEFINER');

const sd = await app.query(`
  SELECT p.proname, p.proconfig::text AS cfg, pg_get_userbyid(p.proowner) AS proprio
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
  ORDER BY 1`);
const sansChemin = sd.rows.filter((r) => !r.cfg || !/search_path/i.test(r.cfg));
verifier(
  `toute fonction SECURITY DEFINER fixe son search_path (${sd.rows.length} fonctions)`,
  sansChemin.length === 0,
  sansChemin.length ? `sans search_path : ${sansChemin.slice(0, 6).map((r) => r.proname).join(', ')}` : '',
);

// Le contexte « worker » ne doit pas ouvrir l'écriture inter-tenant : il arme
// les politiques de l'outbox de notifications, pas celles des documents.
await enTantQue(A.user, async () => {
  await app.query(`SELECT set_config('tracefab.worker_context', 'true', true)`);
  // La colonne modifiée est `original_filename`. Deux versions précédentes
  // écrivaient status puis byte_size, et restaient vertes même RLS désactivée :
  // le déclencheur de la migration initiale lève
  // managed_document_fields_are_not_client_writable sur status, byte_size,
  // sha256, uploaded_by, available_at, deleted_at et deleted_by. Le contrôle
  // négatif l'a révélé. `original_filename` n'est dans aucune de ces listes,
  // donc le refus observé vient bien de la RLS et non d'un déclencheur.
  const r = await tente(`UPDATE documents SET original_filename = 'infiltration.pdf' WHERE id = $1`, [docB]);
  verifier(
    "le contexte worker ne permet pas de modifier le document de B",
    !r.ok || r.count === 0,
    r.ok ? `${r.count} ligne modifiée` : `${r.code} ${r.message}`,
  );
});

/* --- G. Parcours publics légitimes ----------------------------------------- */

console.log('\n  G. parcours publics — ce qui DOIT rester accessible');

await app.query('BEGIN');
await app.query(`SELECT set_config('tracefab.public_context', 'true', true)`);
const publie = await tente(`SELECT id FROM tracefab_products WHERE id = $1`, [prodBPublie]);
verifier('un produit publié reste lisible en contexte public', publie.ok && publie.count === 1, publie.ok ? `${publie.count} ligne` : `${publie.code} ${publie.message}`);
const brouillon = await tente(`SELECT id FROM tracefab_products WHERE id = $1`, [prodBBrouillon]);
verifier('un brouillon ne l est pas', brouillon.ok && brouillon.count === 0, brouillon.ok ? `${brouillon.count} ligne` : `${brouillon.code} ${brouillon.message}`);
await app.query('ROLLBACK');

/* --- H. Écriture directe limitée aux tables approuvées ---------------------- */

console.log('\n  H. surface d écriture directe');

const dml = await app.query(`
  SELECT c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  WHERE n.nspname='public' AND c.relkind IN ('r','p')
    AND a.grantee = 'tracefab_app'::regrole
    AND a.privilege_type IN ('INSERT','UPDATE','DELETE')
  GROUP BY 1 ORDER BY 1`);
// Importée, PAS recopiée. Cette liste était dupliquée ici en dur, ce qui la
// rendait aveugle à sa propre fausseté : elle répétait les 4 tables du
// provisioning au lieu de les contester. Source unique désormais, et sa
// justesse est vérifiée par scripts/test_tables_ecriture_directe.mjs, qui
// re-dérive la liste depuis api/.
const attendues = [...TABLES_ECRITURE_DIRECTE].sort();
verifier(
  `l'écriture directe est limitée aux ${attendues.length} tables approuvées`,
  JSON.stringify(dml.rows.map((r) => r.relname)) === JSON.stringify(attendues),
  dml.rows.map((r) => r.relname).join(', '),
);
verifier(
  'la surface d écriture directe reste minoritaire',
  attendues.length < 30,
  `${attendues.length} tables en écriture directe`,
);

const pubDml = await app.query(`
  SELECT count(*)::int n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
    AND a.grantee = 0 AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')`);
verifier('aucun DML n est accordé à PUBLIC', pubDml.rows[0].n === 0, `${pubDml.rows[0].n} entrées`);

await app.end();

/* --- Verdict --------------------------------------------------------------- */

// Un client pg ne se reconnecte pas après end() : la destruction passe par un
// client neuf, sinon le verdict est masqué par une erreur de réutilisation.
const nettoyeur = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await nettoyeur.connect();
await nettoyeur.query(`DROP DATABASE IF EXISTS ${BASE_EPHEMERE}`);
await nettoyeur.end();
console.log('  base éphémère détruite');

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' ; ')}`);
  process.exit(SORTIE_DEFAUT);
}
console.log('  ok — isolation vérifiée sur des lignes existantes.');
process.exit(0);
