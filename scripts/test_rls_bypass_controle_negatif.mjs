#!/usr/bin/env node
/**
 * Contrôle négatif de l'isolation RLS.
 *
 * À quoi cela sert
 *   Une suite qui vérifie « le locataire A ne voit rien de B » ne prouve rien si
 *   la requête renverrait 0 dans tous les cas — fixture vide, table absente,
 *   faute dans le nom de colonne. Ce contrôle établit le contraste : le MÊME
 *   contexte acteur, la MÊME requête, exécutés par un rôle identique en tout
 *   point mais doté de BYPASSRLS, doivent aboutir. Si le rôle privilégié réussit
 *   là où le rôle applicatif échoue, alors l'échec du rôle applicatif vient bien
 *   de la RLS et non d'un artefact du test.
 *
 * Mesure obtenue sur PostgreSQL 18.4
 *   tracefab_app            : 0 produit voisin lu, 0 ligne modifiée
 *   rôle identique + BYPASS : 2 produits voisins lus, 2 lignes modifiées
 *
 * Précautions
 *   Le rôle de sonde est créé puis détruit, dans un `finally` : un échec
 *   d'assertion ne le laisse pas derrière lui. `DROP OWNED` précède `DROP ROLE`,
 *   car les privilèges accordés rendent la suppression directe impossible
 *   (2BP01). Toutes les écritures sont annulées par ROLLBACK.
 *
 *   Ce contrôle crée un rôle BYPASSRLS : il exige un superutilisateur et ne doit
 *   jamais être exécuté contre une base partagée ou de production.
 */
import pg from 'pg';
import { nomRoleEphemere } from './lib/ephemeral-role.mjs';

const URL_ADMIN = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

if (!URL_ADMIN || !URL_APP) {
  console.error('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  process.exit(2);
}
if (/neon\.tech/.test(URL_ADMIN) || /neon\.tech/.test(URL_APP)) {
  console.error('  REFUSE — ce controle cree un role BYPASSRLS. Il ne doit jamais');
  console.error('  etre execute contre une base Neon, seulement contre un harnais local.');
  process.exit(2);
}

// Nom UNIQUE par execution : `DROP ROLE IF EXISTS sonde_bypass_probe` visait un
// role de CLUSTER preexistant possible, avant tout controle. Un role porte des
// appartenances et la propriete d'objets : le supprimer « au cas ou » n'est pas
// un nettoyage. Voir scripts/lib/ephemeral-role.mjs.
const SONDE = nomRoleEphemere('tf_bypass_probe');
const MDP = 'sonde_locale_jetable';

let reussites = 0;
let echecs = 0;
const verifier = (condition, nom, detail = '') => {
  if (condition) {
    reussites += 1;
    console.log(`  ok    ${nom}${detail ? ` — ${detail}` : ''}`);
  } else {
    echecs += 1;
    console.log(`  ECHEC ${nom}${detail ? ` — ${detail}` : ''}`);
  }
};

const admin = new pg.Client({ connectionString: URL_ADMIN });
await admin.connect();

/** Mesure, dans une transaction annulée, ce qu'un rôle voit et peut modifier. */
async function mesurer(url, etiquette) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  await c.query(
    `SELECT set_config('tracefab.user_id', $1, true),
            set_config('tracefab.user_email', $2, true),
            set_config('tracefab.active_organization_id', $3, true)`,
    [locA.user_id, emailA, locA.id],
  );
  let lus = -1;
  let modifiees = -1;
  let erreur = null;
  try {
    lus = (await c.query('SELECT count(*)::int AS n FROM tracefab_products WHERE brand_organization_id = $1', [locB.id])).rows[0].n;
    modifiees = (await c.query('UPDATE tracefab_products SET updated_at = now() WHERE brand_organization_id = $1 RETURNING id', [locB.id])).rowCount;
  } catch (e) {
    erreur = `${e.code} ${e.message.slice(0, 60)}`;
  }
  await c.query('ROLLBACK');
  await c.end();
  return { etiquette, lus, modifiees, erreur };
}

const loc = await admin.query(
  `SELECT o.id, (SELECT m.user_id FROM organization_memberships m
                  WHERE m.organization_id = o.id LIMIT 1) AS user_id
   FROM organizations o ORDER BY o.created_at LIMIT 2`,
);
if (loc.rowCount < 2) {
  console.error('  NON EXECUTE — il faut deux locataires distincts en fixture.');
  await admin.end();
  process.exit(2);
}
const [locA, locB] = loc.rows;
const emailA = (await admin.query('SELECT email FROM users WHERE id = $1', [locA.user_id])).rows[0].email.toLowerCase();

console.log('');
console.log('  Contrôle négatif — l isolement vient-il bien de la RLS ?');
console.log('');

// Le rôle applicatif réel, celui de TF_RLS_APP_URL : pas un substitut.
const app = new pg.Client({ connectionString: URL_APP });
await app.connect();
const moi = (await app.query('SELECT current_user AS u')).rows[0].u;
const prop = (await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [moi])).rows[0];
await app.end();
verifier(prop && !prop.rolsuper && !prop.rolbypassrls,
  `le role applicatif ${moi} n'a ni SUPERUSER ni BYPASSRLS`,
  `superuser=${prop?.rolsuper} bypassrls=${prop?.rolbypassrls}`);

const sansBypass = await mesurer(URL_APP, moi);
verifier(sansBypass.lus === 0 && sansBypass.modifiees === 0,
  `${moi} : rien du locataire voisin n'est lu ni modifie`,
  sansBypass.erreur || `lus=${sansBypass.lus} modifiees=${sansBypass.modifiees}`);

// Le contraste : même contexte, même requêtes, un rôle doté de BYPASSRLS.
let avecBypass = null;
try {
  await admin.query(
    `CREATE ROLE ${SONDE} LOGIN PASSWORD ${admin.escapeLiteral(MDP)} NOSUPERUSER BYPASSRLS NOCREATEROLE NOCREATEDB`,
  );
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${SONDE}`);
  await admin.query(`GRANT SELECT, UPDATE ON tracefab_products TO ${SONDE}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${SONDE}`);

  const p = (await admin.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [SONDE])).rows[0];
  verifier(!p.rolsuper && p.rolbypassrls,
    'le role de sonde porte BYPASSRLS et rien d autre de decisif',
    `superuser=${p.rolsuper} bypassrls=${p.rolbypassrls}`);

  avecBypass = await mesurer(
    URL_ADMIN.replace(/\/\/[^:]+:[^@]*@/, `//${SONDE}:${MDP}@`),
    SONDE,
  );
} finally {
  // Nettoyage inconditionnel : DROP OWNED d'abord, sinon 2BP01.
  await admin.query(`DROP OWNED BY ${SONDE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${SONDE}`).catch(() => {});
}

verifier(avecBypass !== null && avecBypass.lus > 0 && avecBypass.modifiees > 0,
  'le role dote de BYPASSRLS, lui, lit et modifie les donnees du voisin',
  avecBypass ? `lus=${avecBypass.lus} modifiees=${avecBypass.modifiees}` : 'sonde non executee');

verifier(
  avecBypass !== null && sansBypass.lus === 0 && avecBypass.lus > sansBypass.lus,
  'le contraste est etabli : l isolement vient de la RLS, pas d un artefact du test',
  `${moi}=${sansBypass.lus} contre ${SONDE}=${avecBypass?.lus}`,
);

const reste = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = $1", [SONDE]);
verifier(reste.rowCount === 0, 'le role de sonde est detruit', `restant=${reste.rowCount}`);

await admin.end();

console.log('');
console.log('  --------------------------------------------');
if (echecs > 0) {
  console.log(`  ${echecs} ECHEC sur ${reussites + echecs} assertions.`);
  console.log('  --------------------------------------------');
  process.exit(1);
}
console.log(`  Contrôle négatif concluant : ${reussites} assertions.`);
console.log('  --------------------------------------------');
process.exit(0);
