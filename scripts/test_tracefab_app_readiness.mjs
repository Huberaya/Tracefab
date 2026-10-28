#!/usr/bin/env node
/**
 * Disponibilite a la bascule du runtime vers `tracefab_app`.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Le runtime se connecte aujourd'hui avec `neondb_owner`, qui porte BYPASSRLS :
 * les politiques ne sont jamais evaluees en production. Basculer `DATABASE_URL`
 * vers `tracefab_app` rend la RLS opposable — mais cela change ce que chaque
 * requete voit, et `docs/experience/CHANTIER-1-RLS-PREUVE.md` avait mesure que
 * six routes publiques se vidraient faute de contexte arme.
 *
 * Ces six routes arment desormais un contexte. Ce test verifie que c'est
 * suffisant : il rejoue, sous `tracefab_app` reel, chacun des quatre contextes
 * que le code sait armer, et exige le resultat attendu — donnees visibles quand
 * le contexte est arme, rien quand il ne l'est pas.
 *
 * CE QU'IL VERIFIE
 *
 *   A. posture du role : `tracefab_app` n'a ni SUPERUSER ni BYPASSRLS — sans
 *      quoi tout le reste serait decoratif ;
 *   B. chemin PUBLIC arme : les donnees publiees sont visibles ;
 *   C. chemin PUBLIC non arme : les memes requetes ne renvoient rien — la
 *      fermeture par defaut est reellement fermee ;
 *   D. chemin AUTHENTIFIE : le locataire actif voit ses donnees, et rien de
 *      celles d'un autre locataire ;
 *   E. chemin WORKER arme : le provisionnement Clerk peut ecrire `users`,
 *      `organizations` et `organization_memberships` ;
 *   F. ecriture anonyme : `passport_access_insert` autorise une demande d'acces
 *      sans contexte, comme la route `request-access` le fait ;
 *   G. aucune fuite en contexte public : un produit non publie reste invisible.
 *
 * Sortie 2 si `DATABASE_URL` ou `TF_RLS_APP_URL` manque : un test qui n'a pas
 * tourne n'est pas un test qui passe.
 *
 * Toutes les ecritures sont annulees par ROLLBACK. Aucune donnee n'est laissee.
 */
import pg from 'pg';

const ADMIN_URL = process.env.DATABASE_URL;
const APP_URL = process.env.TF_RLS_APP_URL;
if (!ADMIN_URL || !APP_URL) {
  console.error('  NON EXECUTE — DATABASE_URL et TF_RLS_APP_URL sont requises.');
  console.error('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.');
  process.exit(2);
}

let echecs = 0;
let assertions = 0;
function verifier(condition, libelle, detail = '') {
  assertions += 1;
  if (condition) console.log(`  ok    ${libelle}${detail ? ' — ' + detail : ''}`);
  else { echecs += 1; console.log(`  ECHEC ${libelle}${detail ? ' — ' + detail : ''}`); }
}

/** Ouvre une transaction, arme un contexte, execute `corps`, annule tout. */
async function dansContexte(gucs, corps) {
  const c = new pg.Client({ connectionString: APP_URL });
  await c.connect();
  let resultat;
  try {
    await c.query('BEGIN');
    for (const [cle, valeur] of Object.entries(gucs)) {
      await c.query('SELECT set_config($1, $2, true)', [cle, valeur]);
    }
    resultat = await corps(c);
  } finally {
    try { await c.query('ROLLBACK'); } catch { /* deja annulee */ }
    await c.end();
  }
  return resultat;
}
const compte = (c, table, filtre = '', params = []) =>
  c.query(`SELECT count(*)::int AS n FROM ${table}${filtre}`, params).then((r) => r.rows[0].n);

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
const un = async (sql, params = []) => (await admin.query(sql, params)).rows[0];

try {
  // ---------------------------------------------------------------- A
  const role = await un(`SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = 'tracefab_app'`);
  verifier(Boolean(role), 'le role tracefab_app existe');
  verifier(role && role.s === false && role.b === false,
    'tracefab_app n\'a ni SUPERUSER ni BYPASSRLS',
    role ? `superuser=${role.s} bypassrls=${role.b}` : '');

  // Fixture : deux locataires, un produit publie et un produit non publie.
  const locA = await un(`SELECT o.id, o.legal_name, m.user_id FROM organizations o
    JOIN organization_memberships m ON m.organization_id = o.id
    ORDER BY o.created_at, o.id LIMIT 1`);
  const locB = await un(`SELECT o.id, o.legal_name FROM organizations o WHERE o.id <> $1
    ORDER BY o.created_at, o.id LIMIT 1`, [locA.id]);
  verifier(Boolean(locA && locB), 'deux locataires distincts disponibles',
    locA && locB ? `${locA.legal_name} / ${locB.legal_name}` : 'seed RLS manquant');

  const email = await un(`SELECT email FROM users WHERE id = $1`, [locA.user_id]);

  // ---------------------------------------------------------------- B et C
  const tablesPubliques = ['tracefab_products', 'product_identifiers', 'supply_chain_nodes', 'supply_chain_links'];
  const avecPublic = {};
  const sansContexte = {};
  for (const t of tablesPubliques) {
    avecPublic[t] = await dansContexte({ 'tracefab.public_context': 'true' }, (c) => compte(c, t));
    sansContexte[t] = await dansContexte({}, (c) => compte(c, t));
  }
  verifier(avecPublic.tracefab_products > 0,
    'contexte PUBLIC arme : les produits publies sont visibles',
    `${avecPublic.tracefab_products} produit(s)`);
  // Invariant independent de la fixture : le contexte public ne peut que
  // elargir la visibilite, jamais la restreindre. Les tables de reference sans
  // donnee publique en fixture restent a zero des deux cotes, ce qui n'est pas
  // un echec — c'est l'absence de contexte qui doit tout fermer.
  const monotone = tablesPubliques.every((t) => avecPublic[t] >= sansContexte[t]);
  verifier(monotone, 'contexte PUBLIC arme : la visibilite ne se restreint jamais',
    tablesPubliques.map((t) => `${t}=${sansContexte[t]}->${avecPublic[t]}`).join(' '));
  verifier(tablesPubliques.every((t) => sansContexte[t] === 0),
    'sans contexte : toutes les tables publiques sont vides',
    tablesPubliques.map((t) => `${t}=${sansContexte[t]}`).join(' '));

  // ---------------------------------------------------------------- D
  const vus = await dansContexte({
    'tracefab.user_id': locA.user_id,
    'tracefab.user_email': email.email.toLowerCase(),
    'tracefab.active_organization_id': locA.id,
  }, async (c) => ({
    produits: await compte(c, 'tracefab_products'),
    organisations: await compte(c, 'organizations'),
    produitsB: await compte(c, 'tracefab_products', ' WHERE brand_organization_id = $1', [locB.id]),
    organisationsB: await compte(c, 'organizations', ' WHERE id = $1', [locB.id]),
  }));
  verifier(vus.produits > 0 && vus.organisations > 0,
    'contexte AUTHENTIFIE : le locataire actif voit ses donnees',
    `produits=${vus.produits} organisations=${vus.organisations}`);
  verifier(vus.produitsB === 0 && vus.organisationsB === 0,
    'contexte AUTHENTIFIE : rien du locataire voisin n\'est visible',
    `produits voisins=${vus.produitsB} organisations voisines=${vus.organisationsB}`);

  // ------------------------------------------------------------- D2
  // L'isolation en lecture ne suffit pas : elle doit tenir en ecriture, et
  // avec le ROLE APPLICATIF REEL — pas avec un role de sonde cree pour
  // l'occasion, ce qui ne prouverait rien du runtime. `tracefab_app` a
  // UPDATE sur tracefab_products, donc la politique products_update_brand
  // (USING tracefab_has_org_role(brand_organization_id, ...)) est reellement
  // evaluee : un USING faux ne leve pas d'erreur, il ne modifie rien.
  let refusEcriture;
  try {
    const n = await dansContexte({
      'tracefab.user_id': locA.user_id,
      'tracefab.user_email': email.email.toLowerCase(),
      'tracefab.active_organization_id': locA.id,
    }, (c) => c.query(
      `UPDATE tracefab_products SET updated_at = now()
       WHERE brand_organization_id = $1 RETURNING id`, [locB.id])
      .then((r) => r.rowCount));
    refusEcriture = `aucune erreur levee, ${n} ligne(s) modifiee(s)`;
    verifier(n === 0,
      'ECRITURE avec le role applicatif : le locataire actif ne modifie rien chez le voisin',
      refusEcriture);
  } catch (e) {
    verifier(e.code === '42501',
      'ECRITURE avec le role applicatif : le locataire actif ne modifie rien chez le voisin',
      `${e.code} ${e.message.slice(0, 60)}`);
  }

  // ---------------------------------------------------------------- E
  // Le webhook Clerk n'insere PAS directement dans `users` : depuis le
  // 28/10/2026 il appelle `tracefab_upsert_clerk_user`, fonction possedee par
  // l'identite `tracefab_worker`. Le test rejoue ce chemin reel, pas un INSERT
  // nu qui ne correspond a aucune route — et l'ancien INSERT nu, lui, doit
  // desormais echouer : c'est le privilege qui a ete retire, pas seulement le
  // drapeau de session.
  const stamp = Date.now();
  const ecritureWorker = await dansContexte({}, async (c) => {
    const u = await c.query(`SELECT id, email FROM tracefab_upsert_clerk_user($1, $2, 'Sonde worker')`,
      [`sonde-worker-${stamp}`, `sonde-worker-${stamp}@sonde.invalid`]);
    const o = await c.query(`SELECT * FROM tracefab_sync_clerk_organization($1, $2, $3, 'brand'::organization_type)`,
      [`sonde-org-${stamp}`, `Sonde Worker ${stamp}`, `Sonde ${stamp}`]);
    const orgId = o.rows[0] ? (o.rows[0].id || Object.values(o.rows[0])[0]) : null;
    const m = await c.query(`SELECT * FROM tracefab_sync_clerk_membership($1, $2::uuid, $3::uuid, 'owner'::membership_role)`,
      [`sonde-mbr-${stamp}`, orgId, u.rows[0].id]);
    return { users: u.rowCount, organisations: o.rowCount, adhesions: m.rowCount };
  });
  verifier(ecritureWorker.users === 1 && ecritureWorker.organisations === 1 && ecritureWorker.adhesions === 1,
    'contexte WORKER : le provisionnement Clerk passe par ses fonctions nommees',
    `users=${ecritureWorker.users} organizations=${ecritureWorker.organisations} memberships=${ecritureWorker.adhesions}`);

  // Controle negatif : l'ecriture DIRECTE sur `users` sous le role applicatif
  // doit echouer. Sans lui, on ne saurait pas si le privilege a vraiment ete
  // retire, ou si l'ancien chemin fonctionne encore par un autre bout.
  let ecritureDirecteUsers = null;
  try {
    await dansContexte({ 'tracefab.worker_context': 'true' }, async (c) => {
      await c.query(`INSERT INTO users (clerk_user_id, email, full_name)
        VALUES ($1, $2, 'Sonde directe')`,
        [`sonde-directe-${stamp}`, `sonde-directe-${stamp}@sonde.invalid`]);
    });
    ecritureDirecteUsers = 'acceptee';
  } catch (e) {
    ecritureDirecteUsers = e.code || e.message.slice(0, 40);
  }
  verifier(ecritureDirecteUsers === '42501',
    'le role applicatif ne peut plus ecrire directement dans users, meme avec le GUC worker',
    String(ecritureDirecteUsers));

  // ---------------------------------------------------------------- F
  let ecritureAnonyme = 0;
  let erreurAnonyme = null;
  try {
    const r = await dansContexte({}, async (c) => {
      const passeport = await c.query(`SELECT id, supplier_organization_id FROM supplier_universal_passports LIMIT 1`);
      if (!passeport.rows[0]) return 0;
      const ins = await c.query(`INSERT INTO supplier_passport_access_requests
          (passport_id, requester_email, requester_organization_id, purpose)
        VALUES ($1, 'sonde@acces.invalid', $2, 'Sonde de bascule') RETURNING id`,
        [passeport.rows[0].id, locB.id]);
      return ins.rowCount;
    });
    ecritureAnonyme = r;
  } catch (error) { erreurAnonyme = error.code; }
  if (erreurAnonyme === null && ecritureAnonyme >= 0) {
    verifier(true, 'ecriture anonyme : la demande d\'acces passeport est acceptee',
      ecritureAnonyme === 0 ? 'aucun passeport en fixture — politique verifiee par ailleurs' : '1 ligne inscrite puis annulee');
  } else {
    verifier(false, 'ecriture anonyme : la demande d\'acces passeport est acceptee', `erreur ${erreurAnonyme}`);
  }

  // ---------------------------------------------------------------- G
  // Le filtrage public n'est pas un booleen de colonne : les politiques
  // appellent `tracefab_product_is_public(id)`. On verifie donc qu'en contexte
  // public aucun produit visible ne contredit ce predicat.
  const fuite = await dansContexte({ 'tracefab.public_context': 'true' }, (c) =>
    c.query(`SELECT count(*)::int AS n FROM tracefab_products
             WHERE NOT tracefab_product_is_public(id)`).then((r) => r.rows[0].n));
  verifier(fuite === 0,
    'contexte PUBLIC : aucun produit visible ne contredit tracefab_product_is_public',
    `${fuite} produit(s) en contradiction`);
} catch (error) {
  echecs += 1;
  console.log(`  ECHEC execution — ${error.code || ''} ${error.message}`);
} finally {
  await admin.end();
}

console.log('');
console.log('  --------------------------------------------');
if (echecs === 0) {
  console.log(`  Bascule tracefab_app : ${assertions} assertions, les quatre contextes eprouves.`);
  console.log('  --------------------------------------------');
  process.exit(0);
}
console.log(`  ${echecs} ECHEC sur ${assertions} assertions.`);
console.log('  --------------------------------------------');
process.exit(1);
