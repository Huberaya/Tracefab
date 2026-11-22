#!/usr/bin/env node
/**
 * P10.7 — DÉMONSTRATION COMPLÈTE DU MODE STRICT, SUR CLUSTER JETABLE.
 *
 * CE QUE CE TEST EST, ET CE QU'IL N'EST PAS
 *
 * C'est la démonstration exigée par le chantier D de P10.7 : les huit
 * situations qui décident si le mode strict peut être activé, rejouées de bout
 * en bout SOUS LE RÔLE APPLICATIF, avec rotation de clé et parcours métier.
 * Ce n'est PAS une preuve de production : il n'y a ni Neon, ni pooler, ni
 * Vercel ici, et `strict` n'est activé que sur cette base jetable, puis rendu à
 * sa valeur initiale.
 *
 * Le mode strict est posé ICI, par le test, et seulement sur une cible locale
 * jetable : le script refuse toute cible non locale AVANT de se connecter.
 *
 *   D1 jeton valide                     -> identité rendue, données du locataire visibles
 *   D2 sans jeton, mode strict          -> aucune identité, aucune ligne visible
 *   D3 jeton invalide (MAC faux)        -> refusé
 *   D4 GUC forgé sans jeton             -> refusé (et non « repli »)
 *   D5 organisation incohérente         -> refusé
 *   D6 rotation, DEUX clés actives      -> les deux jetons acceptés (pas de coupure)
 *   D7 révocation de l'ancienne clé     -> l'ancien jeton refuse, le nouveau passe
 *   D8 parcours métier                  -> lecture RLS isolée + ingestion PLM/ERP
 *                                          refusée sans identité, acceptée avec
 *
 * Toutes les écritures sont annulées (`ROLLBACK`) : aucune ligne ne survit, et
 * les clés de test sont retirées dans le `finally`.
 *
 * Sortie : 0 conforme · 1 régression · 2 non exécuté · 3 refus de cible.
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
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}). Le mode strict ne s'active pas ici.`);
  process.exit(3);
}

let assertions = 0;
let echecs = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-p107-demo-admin' });
await admin.connect();
const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp), application_name: 'tracefab-p107-demo-runtime' });
await app.connect();

const locataires = (await admin.query(
  `SELECT o.id, m.user_id FROM organizations o
     JOIN organization_memberships m ON m.organization_id = o.id AND m.role = 'owner'
    ORDER BY o.created_at, o.id LIMIT 2`)).rows;
if (locataires.length < 2) {
  console.error('  NON EXECUTE — deux locataires requis ; jouer npm run db:seed-rls.');
  await admin.end(); await app.end();
  process.exit(2);
}
const [A, B] = locataires;

// Deux clés de test : l'ancienne et la nouvelle, versions hors plage d'exploitation.
const V_ANCIENNE = 99101;
const V_NOUVELLE = 99102;
const cleAncienne = randomBytes(32);
const cleNouvelle = randomBytes(32);
const VERSIONS = [V_ANCIENNE, V_NOUVELLE];
const strictAvant = (await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;

const signer = (corps, cle) => createHmac('sha256', cle).update(corps).digest('hex');
const jeton = ({ userId, orgId, exp, cle }) => {
  const corps = `v1|${userId}|${orgId}|tracefab_identity|${exp}`;
  return `${corps}.${signer(corps, cle)}`;
};
const MAINTENANT = Math.floor(Date.now() / 1000);

/** Une transaction applicative : pose les GUC, exécute, annule toujours. */
async function dansTransaction(gucs, corps) {
  await app.query('BEGIN');
  try {
    for (const [cle, valeur] of Object.entries(gucs)) {
      if (valeur !== undefined) await app.query('SELECT set_config($1,$2,true)', [cle, valeur]);
    }
    return await corps();
  } finally {
    await app.query('ROLLBACK').catch(() => {});
  }
}
const identite = () => app.query('SELECT public.tracefab_current_user_id() AS id').then((r) => r.rows[0].id);
const produitsVisibles = () => app.query('SELECT count(*)::int AS n FROM tracefab_products').then((r) => r.rows[0].n);
const ingerer = (orgId, reference) => app.query(
  `SELECT public.tracefab_ingest_plm_erp_payload($1::uuid,'generic_csv',$2::jsonb,NULL::uuid) AS s`,
  [orgId, JSON.stringify({ products: [{ reference, name: reference }] })],
).then(() => app.query('SELECT count(*)::int AS n FROM tracefab_products WHERE reference = $1', [reference])
  .then((r) => r.rows[0].n));

const poserCles = async (actives) => {
  await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = ANY($1)', [VERSIONS]);
  await admin.query(
    'INSERT INTO public.tracefab_identity_cles (version, secret, actif) VALUES ($1,$2,$3), ($4,$5,$6)',
    [V_ANCIENNE, cleAncienne, actives.includes(V_ANCIENNE), V_NOUVELLE, cleNouvelle, actives.includes(V_NOUVELLE)],
  );
};
const nettoyerCles = () => admin.query(
  'DELETE FROM public.tracefab_identity_cles WHERE version = ANY($1)', [VERSIONS]);
const poserStrict = (v) => admin.query(
  'UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [v]);

try {
  /* ====================================================================== *
   * PRÉPARATION : mode strict SUR LA BASE JETABLE, deux clés actives
   * ====================================================================== */
  console.log('  -- préparation (base jetable uniquement)');
  await poserCles([V_ANCIENNE, V_NOUVELLE]);
  await poserStrict(true);
  const strictMesure = (await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;
  ok(strictMesure === true, 'D0 le mode strict est actif SUR LA BASE JETABLE', `strict=${strictMesure}`);

  const jetonAncien = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 120, cle: cleAncienne });
  const jetonNouveau = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 120, cle: cleNouvelle });

  /* D1 — jeton valide */
  const d1 = await dansTransaction(
    { 'tracefab.identity': jetonNouveau, 'tracefab.active_organization_id': A.id },
    async () => ({ id: await identite(), lignes: await produitsVisibles() }),
  );
  ok(d1.id === A.user_id, 'D1 jeton valide : identité = celle du jeton signé', `${d1.id}`);
  ok(d1.lignes > 0, 'D1 jeton valide : le locataire voit SES données (aucune régression de service)', `${d1.lignes} produit(s)`);

  /* D2 — sans jeton, mode strict */
  const d2 = await dansTransaction(
    { 'tracefab.active_organization_id': A.id },
    async () => ({ id: await identite(), lignes: await produitsVisibles() }),
  );
  ok(d2.id === null, 'D2 mode strict SANS jeton : aucune identité', `${d2.id}`);
  ok(d2.lignes === 0, 'D2 mode strict SANS jeton : aucune ligne visible (la RLS n Est pas contournée)', `${d2.lignes}`);

  /* D3 — jeton invalide */
  const corps = `v1|${A.user_id}|${A.id}|tracefab_identity|${MAINTENANT + 120}`;
  const d3 = await dansTransaction(
    { 'tracefab.identity': `${corps}.${signer(corps, randomBytes(32))}`, 'tracefab.active_organization_id': A.id },
    () => identite(),
  );
  ok(d3 === null, 'D3 jeton au MAC invalide : refusé', `${d3}`);

  /* D4 — GUC forgé, sans jeton */
  const d4 = await dansTransaction(
    { 'tracefab.user_id': A.user_id, 'tracefab.active_organization_id': A.id },
    () => identite(),
  );
  ok(d4 === null, 'D4 GUC tracefab.user_id forgé, sans jeton : IGNORÉ (aucune identité)', `${d4}`);

  /* D5 — organisation incohérente */
  const d5 = await dansTransaction(
    { 'tracefab.identity': jetonNouveau, 'tracefab.active_organization_id': B.id },
    () => identite(),
  );
  ok(d5 === null, 'D5 jeton émis pour A dans une session B : refusé', `${d5}`);

  /* D6 — rotation, deux clés actives */
  const d6a = await dansTransaction(
    { 'tracefab.identity': jetonAncien, 'tracefab.active_organization_id': A.id }, () => identite());
  const d6b = await dansTransaction(
    { 'tracefab.identity': jetonNouveau, 'tracefab.active_organization_id': A.id }, () => identite());
  ok(d6a === A.user_id, 'D6 rotation : le jeton signé par l ANCIENNE clé reste accepté (pas de coupure)', `${d6a}`);
  ok(d6b === A.user_id, 'D6 rotation : le jeton signé par la NOUVELLE clé est accepté', `${d6b}`);

  /* D7 — révocation de l'ancienne clé */
  await admin.query('UPDATE public.tracefab_identity_cles SET actif = false WHERE version = $1', [V_ANCIENNE]);
  const d7a = await dansTransaction(
    { 'tracefab.identity': jetonAncien, 'tracefab.active_organization_id': A.id }, () => identite());
  const d7b = await dansTransaction(
    { 'tracefab.identity': jetonNouveau, 'tracefab.active_organization_id': A.id }, () => identite());
  ok(d7a === null, 'D7 après révocation : l ancienne clé ne vérifie plus rien', `${d7a}`);
  ok(d7b === A.user_id, 'D7 après révocation : le nouveau jeton continue de fonctionner', `${d7b}`);

  /* D8 — parcours métier : RLS isolée, puis ingestion PLM/ERP */
  const refA = `P107-A-${randomBytes(3).toString('hex')}`;
  const refB = `P107-B-${randomBytes(3).toString('hex')}`;

  const d8a = await dansTransaction(
    { 'tracefab.identity': jetonNouveau, 'tracefab.active_organization_id': A.id },
    async () => ({
      a: await app.query('SELECT count(*)::int AS n FROM tracefab_products WHERE brand_organization_id = $1', [A.id]).then((r) => r.rows[0].n),
      b: await app.query('SELECT count(*)::int AS n FROM tracefab_products WHERE brand_organization_id = $1', [B.id]).then((r) => r.rows[0].n),
    }),
  );
  ok(d8a.a > 0 && d8a.b === 0,
    'D8 lecture sous strict : le locataire A voit SES produits et AUCUN de B (RLS non régressée)',
    `A=${d8a.a} · B visible=${d8a.b}`);

  const d8b = await dansTransaction(
    { 'tracefab.active_organization_id': A.id },
    async () => { try { return { ecrit: await ingerer(A.id, refA) }; } catch (e) { return { refus: e.message.split('\n')[0].slice(0, 50) }; } },
  );
  ok(Boolean(d8b.refus) && !d8b.ecrit,
    'D8 ingestion PLM/ERP SANS identité, sous strict : refusée, aucune écriture', d8b.refus || 'ACCEPTÉE');

  const d8c = await dansTransaction(
    { 'tracefab.identity': jetonNouveau, 'tracefab.active_organization_id': A.id },
    async () => { try { return { ecrit: await ingerer(A.id, refA) }; } catch (e) { return { refus: e.message.split('\n')[0].slice(0, 50) }; } },
  );
  ok(d8c.ecrit === 1,
    'D8 ingestion PLM/ERP AVEC jeton valide : acceptée, 1 produit écrit chez A (aucune régression métier)',
    d8c.refus || `${d8c.ecrit} produit(s)`);

  const d8d = await dansTransaction(
    { 'tracefab.identity': jetonNouveau, 'tracefab.active_organization_id': B.id },
    async () => { try { return { ecrit: await ingerer(B.id, refB) }; } catch (e) { return { refus: e.message.split('\n')[0].slice(0, 50) }; } },
  );
  ok(Boolean(d8d.refus),
    'D8 jeton de A présenté dans la session B : l écriture chez B est refusée (jeton lié au contexte)',
    d8d.refus || 'ACCEPTÉE');
} finally {
  await nettoyerCles().catch(() => {});
  await poserStrict(strictAvant).catch(() => {});
  const apres = (await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;
  const residusProduits = (await admin.query(
    "SELECT count(*)::int AS n FROM tracefab_products WHERE reference LIKE 'P107-%'")).rows[0].n;
  const clesTest = (await admin.query(
    'SELECT count(*)::int AS n FROM public.tracefab_identity_cles WHERE version = ANY($1)', [VERSIONS])).rows[0].n;
  ok(apres === strictAvant, 'D9 le mode d identité est RENDU à sa valeur initiale', `strict=${apres}`);
  ok(clesTest === 0, 'D9 aucune clé de test ne subsiste', `${clesTest} restante(s)`);
  ok(residusProduits === 0, 'D9 aucune ligne métier ne subsiste (tout a été annulé)', `${residusProduits} ligne(s)`);
  await app.end();
  await admin.end();
}

console.log('');
if (echecs === 0) {
  console.log(`  Démonstration stricte P10.7 : ${assertions} assertions — cluster jetable, rien ne survit.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
