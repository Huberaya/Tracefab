#!/usr/bin/env node
/**
 * Ingestion PLM/ERP sous le rôle applicatif, avec et sans jeton d'identité.
 *
 * CE QUE CE TEST MESURE
 *
 * P10.4 avait mesuré, sur base jetable, quatre situations sous `tracefab_app` :
 *
 *   M1 identité légitime de A sur A          -> succès
 *   M2 identité de A sur l'organisation B    -> refus brand_product_role_required
 *   M3 identité FORGÉE du propriétaire de B  -> SUCCÈS  ← le résidu R-A1
 *   M4 aucune identité                       -> refus authentication_required
 *
 * Ce test rejoue exactement les quatre, puis rejoue M3 en mode STRICT avec un
 * jeton falsifié : c'est là que le HMAC doit faire basculer le résultat.
 *
 *   M3 jeton valide, identité du propriétaire de B -> succès (comportement
 *      normal : c'est bien l'identité de B qui appelle) ;
 *   M3' MAC falsifié                                -> refusé ;
 *   M3'' GUC forgé, aucun jeton, mode strict        -> refusé ;
 *   M3''' jeton expiré                              -> refusé.
 *
 * Toutes les transactions sont annulées : aucune ligne ne subsiste.
 *
 * Sortie : 0 conforme · 1 régression · 2 non exécuté · 3 refus.
 */
import process from 'node:process';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const urlAdmin = (process.env.DATABASE_URL || '').trim();
const urlApp = (process.env.TF_RLS_APP_URL || '').trim();
if (!urlAdmin || !urlApp) {
  console.error('  NON EXECUTE — DATABASE_URL et TF_RLS_APP_URL sont requises.');
  process.exit(2);
}
const hote = (() => { try { return new URL(urlAdmin).hostname; } catch { return ''; } })();
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote)) {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}).`);
  process.exit(3);
}

let echecs = 0;
let assertions = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-p105-ingest-admin' });
await admin.connect();

const locataires = (await admin.query(
  `SELECT o.id, o.legal_name, m.user_id
     FROM organizations o
     JOIN organization_memberships m ON m.organization_id = o.id AND m.role = 'owner'
    ORDER BY o.created_at, o.id LIMIT 2`,
)).rows;
if (locataires.length < 2) {
  console.error('  NON EXECUTE — deux locataires sont requis ; jouer npm run db:seed-rls.');
  await admin.end();
  process.exit(2);
}
const [A, B] = locataires;
console.log(`  locataires : A=${A.legal_name} · B=${B.legal_name}`);

// Clé de test, posée puis retirée.
const secret = randomBytes(32);
const VERSION = 99011;
await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = $1', [VERSION]);
await admin.query('INSERT INTO public.tracefab_identity_cles (version, secret, actif) VALUES ($1, $2, true)', [VERSION, secret]);

const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp), application_name: 'tracefab-p105-ingest-runtime' });
await app.connect();

const signer = (corps, cle = secret) => createHmac('sha256', cle).update(corps).digest('hex');
const jeton = (userId, orgId, exp) => {
  const corps = `v1|${userId}|${orgId}|tracefab_identity|${exp}`;
  return `${corps}.${signer(corps)}`;
};
const MAINTENANT = Math.floor(Date.now() / 1000);

/** Rejoue un appel d'ingestion, puis annule tout. */
async function appeler({ gucs = {}, reference, updateFirstNode = false }) {
  await app.query('BEGIN');
  try {
    for (const [cle, valeur] of Object.entries(gucs)) {
      await app.query('SELECT set_config($1,$2,true)', [cle, valeur]);
    }
    let resultat = null;
    let erreur = null;
    let lignes = 0;
    let nodeUpdateOk = null;
    try {
      resultat = (await app.query(
        `SELECT public.tracefab_ingest_plm_erp_payload($1::uuid,'generic_csv',$2::jsonb,NULL::uuid) AS s`,
        [gucs['tracefab.active_organization_id'] ?? null,
          JSON.stringify({
            products: [{
              reference,
              name: reference,
              materials: [{ materialName: 'P105 test cotton', materialType: 'fiber', percentage: 100, composition: { cotton: 100 } }],
              productionSteps: [
                { label: 'P105 spinning', processCode: 'spinning', country: 'FR' },
                { label: 'P105 knitting', processCode: 'knitting', country: 'PT' },
              ],
            }],
          })],
      )).rows[0].s;
      lignes = (await app.query(
        `SELECT count(*)::int AS n FROM tracefab_products WHERE reference = $1`, [reference],
      )).rows[0].n;
      if (updateFirstNode && !erreur) {
        const productId = (await app.query(
          'SELECT id FROM tracefab_products WHERE reference = $1', [reference],
        )).rows[0]?.id;
        if (!productId) throw new Error('product_missing_after_ingest');
        const graph = (await app.query(
          'SELECT public.tracefab_get_product_traceability($1::uuid) AS graph', [productId],
        )).rows[0]?.graph;
        const node = graph?.nodes?.find((item) => item.node_type === 'process');
        if (!node?.id) throw new Error('process_node_missing_after_ingest');
        await app.query(
          `SELECT public.tracefab_update_supply_chain_node(
             $1::uuid, $2::uuid, $3, $4::jsonb, NULL::uuid, CURRENT_DATE
           )`,
          [productId, node.id, `${reference} updated`, JSON.stringify({ p105EnumCast: true })],
        );
        nodeUpdateOk = true;
      }
    } catch (e) {
      erreur = `${e.code || ''} ${e.message.split('\n')[0].slice(0, 60)}`;
    }
    return { resultat, erreur, lignes, nodeUpdateOk };
  } finally {
    await app.query('ROLLBACK').catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// M1 — identité légitime de A sur A
// ---------------------------------------------------------------------------
const m1 = await appeler({ gucs: { 'tracefab.user_id': A.user_id, 'tracefab.active_organization_id': A.id }, reference: 'P105-M1', updateFirstNode: true });
ok(!m1.erreur && m1.lignes === 1 && m1.nodeUpdateOk === true,
  'M1 identité légitime de A sur A : ingestion et mise à jour d’un nœud réussies',
  m1.erreur || `${m1.lignes} produit(s), update=${m1.nodeUpdateOk}`);

// ---------------------------------------------------------------------------
// M2 — identité de A sur l'organisation B
// ---------------------------------------------------------------------------
const m2 = await appeler({ gucs: { 'tracefab.user_id': A.user_id, 'tracefab.active_organization_id': B.id }, reference: 'P105-M2' });
ok(/brand_product_role_required/.test(String(m2.erreur)), 'M2 identité de A sur B : refusé', m2.erreur || 'ACCEPTÉ');

// ---------------------------------------------------------------------------
// M3 — identité FORGÉE du propriétaire de B (sans jeton, mode permissif)
// ---------------------------------------------------------------------------
const strictAvant = (await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;
const m3 = await appeler({ gucs: { 'tracefab.user_id': B.user_id, 'tracefab.active_organization_id': B.id }, reference: 'P105-M3' });
ok(!m3.erreur && m3.lignes === 1,
  'M3 GUC forgé en mode permissif : ACCEPTÉ (résidu R-A1 assumé tant que le mode strict n est pas activé)',
  m3.erreur || `${m3.lignes} ligne(s)`);

// ---------------------------------------------------------------------------
// M3' à M3''' — en mode strict, le jeton devient obligatoire
// ---------------------------------------------------------------------------
await admin.query('UPDATE public.tracefab_identity_politique SET strict = true, modifie_le = now() WHERE singleton');
try {
  const m3p = await appeler({ gucs: { 'tracefab.user_id': B.user_id, 'tracefab.active_organization_id': B.id }, reference: 'P105-M3P' });
  ok(Boolean(m3p.erreur) && m3p.lignes === 0,
    'M3\' mode STRICT, GUC forgé sans jeton : refusé, aucune écriture', m3p.erreur || `${m3p.lignes} ligne(s)`);

  const jetonValide = jeton(B.user_id, B.id, MAINTENANT + 60);
  const m3v = await appeler({
    gucs: { 'tracefab.identity': jetonValide, 'tracefab.user_id': B.user_id, 'tracefab.active_organization_id': B.id },
    reference: 'P105-M3V',
  });
  ok(!m3v.erreur && m3v.lignes === 1, 'M3\'\' jeton VALIDE du propriétaire de B : succès (chemin normal)', m3v.erreur || `${m3v.lignes} ligne(s)`);

  const corps = `v1|${B.user_id}|${B.id}|tracefab_identity|${MAINTENANT + 60}`;
  const jetonFalsifie = `${corps}.${signer(corps, randomBytes(32))}`;
  const m3f = await appeler({
    gucs: { 'tracefab.identity': jetonFalsifie, 'tracefab.user_id': B.user_id, 'tracefab.active_organization_id': B.id },
    reference: 'P105-M3F',
  });
  ok(Boolean(m3f.erreur) && m3f.lignes === 0, 'M3\'\'\' jeton FALSIFIÉ : refusé, aucune écriture', m3f.erreur || `${m3f.lignes} ligne(s)`);

  const jetonExpire = jeton(B.user_id, B.id, MAINTENANT - 10);
  const m3e = await appeler({
    gucs: { 'tracefab.identity': jetonExpire, 'tracefab.user_id': B.user_id, 'tracefab.active_organization_id': B.id },
    reference: 'P105-M3E',
  });
  ok(Boolean(m3e.erreur) && m3e.lignes === 0, 'jeton EXPIRÉ : refusé, aucune écriture', m3e.erreur || `${m3e.lignes} ligne(s)`);

  const jetonAutreOrg = jeton(B.user_id, A.id, MAINTENANT + 60);
  const m3o = await appeler({
    gucs: { 'tracefab.identity': jetonAutreOrg, 'tracefab.user_id': B.user_id, 'tracefab.active_organization_id': B.id },
    reference: 'P105-M3O',
  });
  ok(Boolean(m3o.erreur) && m3o.lignes === 0, 'jeton émis pour une AUTRE organisation : refusé', m3o.erreur || `${m3o.lignes} ligne(s)`);
} finally {
  await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictAvant]);
}

// ---------------------------------------------------------------------------
// M4 — aucune identité
// ---------------------------------------------------------------------------
const m4 = await appeler({ gucs: { 'tracefab.active_organization_id': A.id }, reference: 'P105-M4' });
ok(/authentication_required/.test(String(m4.erreur)), 'M4 aucune identité : refusé', m4.erreur || 'ACCEPTÉ');

// ---------------------------------------------------------------------------
// Aucun résidu
// ---------------------------------------------------------------------------
await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = $1', [VERSION]);
const residus = (await admin.query(
  `SELECT count(*)::int AS n FROM tracefab_products WHERE reference LIKE 'P105-M%'`,
)).rows[0].n;
ok(residus === 0, 'aucune ligne résiduelle après les transactions annulées', `${residus} ligne(s)`);

await app.end();
await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  Ingestion sous tracefab_app : ${assertions} assertions.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
