#!/usr/bin/env node
/**
 * HMAC d'identité — les huit scénarios exigés, mesurés sur base jetable.
 *
 * CE QUE CE TEST PROUVE
 *
 *   1. identité légitime            -> acceptée, données du locataire visibles
 *   2. identité d'une autre org     -> l'identité est bien celle du jeton, et
 *                                      elle ne voit RIEN de l'autre organisation
 *   3. GUC forgé sans jeton (strict)-> refusé
 *   4. jeton falsifié               -> refusé
 *   5. jeton expiré                 -> refusé
 *   6. jeton rejoué autre contexte  -> refusé (organisation signée ≠ session)
 *   7. clé inaccessible au runtime  -> 42501, vérifié par exécution
 *   8. connexion physique réutilisée-> aucun contexte résiduel
 *
 * Et un contrôle négatif qui donne sa valeur à l'ensemble : si l'on force la
 * clé à une valeur connue de l'appelant, le jeton falsifié DOIT être accepté.
 * Sans ce contrôle, un « refusé » pourrait venir d'une simple erreur de forme
 * du jeton, pas de la vérification.
 *
 * Le test n'utilise ni secret d'exploitation ni production : il pose sa propre
 * clé dans une base jetable, et la retire à la fin.
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

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-hmac-admin' });
await admin.connect();

// ---------------------------------------------------------------------------
// Fixtures : deux locataires réels, et une clé de test.
// ---------------------------------------------------------------------------
const locataires = (await admin.query(
  `SELECT o.id, o.legal_name, m.user_id
     FROM organizations o
     JOIN organization_memberships m ON m.organization_id = o.id AND m.role = 'owner'
    ORDER BY o.created_at, o.id LIMIT 2`,
)).rows;
if (locataires.length < 2) {
  console.error('  NON EXECUTE — il faut deux locataires ; jouer npm run db:seed-rls d abord.');
  await admin.end();
  process.exit(2);
}
const [A, B] = locataires;

const secret = randomBytes(32);
const VERSION = 99001; // version de test, hors plage des versions d exploitation
await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = $1', [VERSION]);
await admin.query(
  `INSERT INTO public.tracefab_identity_cles (version, secret, actif) VALUES ($1, $2, false)`,
  [VERSION, secret],
);

const signer = (corps, cle = secret) => createHmac('sha256', cle).update(corps).digest('hex');
const jeton = ({ userId, orgId, exp, usage = 'tracefab_identity', cle = secret }) => {
  const corps = `v1|${userId}|${orgId}|${usage}|${exp}`;
  return `${corps}.${signer(corps, cle)}`;
};
const MAINTENANT = Math.floor(Date.now() / 1000);

/** Ouvre une transaction, arme les GUC, exécute `corps`, annule tout. */
const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp), application_name: 'tracefab-hmac-runtime' });
await app.connect();

async function dansTransaction({ identite, userId, orgId, userEmail }, corps) {
  await app.query('BEGIN');
  try {
    if (identite !== undefined) await app.query('SELECT set_config($1,$2,true)', ['tracefab.identity', identite]);
    if (userId !== undefined) await app.query('SELECT set_config($1,$2,true)', ['tracefab.user_id', userId]);
    if (orgId !== undefined) await app.query('SELECT set_config($1,$2,true)', ['tracefab.active_organization_id', orgId]);
    // P10.6 : l'adresse est un GUC non signe avant la migration 20261102120000.
    // Le poser explicitement est ce qui permet de mesurer la forge.
    if (userEmail !== undefined) await app.query('SELECT set_config($1,$2,true)', ['tracefab.user_email', userEmail]);
    return await corps();
  } finally {
    await app.query('ROLLBACK').catch(() => {});
  }
}
const identite = () => app.query('SELECT public.tracefab_current_user_id() AS id').then((r) => r.rows[0].id);
const produits = (orgId) => app.query(
  'SELECT count(*)::int AS n FROM tracefab_products WHERE brand_organization_id = $1', [orgId],
).then((r) => r.rows[0].n);

// La clé de test doit être ACTIVE pour que la vérification l'utilise.
await admin.query('UPDATE public.tracefab_identity_cles SET actif = (version = $1)', [VERSION]);

// ---------------------------------------------------------------------------
// 1. Identité légitime
// ---------------------------------------------------------------------------
const jetonA = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 60 });
const jetonB = jeton({ userId: B.user_id, orgId: B.id, exp: MAINTENANT + 60 });
const r1 = await dansTransaction({ identite: jetonA, orgId: A.id }, async () => ({
  id: await identite(), n: await produits(A.id),
}));
ok(r1.id === A.user_id, 'S1 jeton légitime : l identité rendue est celle du jeton', `${r1.id}`);
ok(r1.n > 0, 'S1 jeton légitime : le locataire voit ses produits', `${r1.n} produit(s)`);

// ---------------------------------------------------------------------------
// 2. Identité d'une autre organisation
// ---------------------------------------------------------------------------
// Le jeton est signé pour A mais vise l'organisation B : la vérification le
// refuse (organisation signée ≠ GUC). Même si l'on aligne le GUC sur la valeur
// signée, l'identité reste A — et A ne voit rien de B.
const jetonAorgB = jeton({ userId: A.user_id, orgId: B.id, exp: MAINTENANT + 60 });
const r2a = await dansTransaction({ identite: jetonAorgB, orgId: A.id }, () => identite());
ok(r2a === null, 'S2 jeton lié à B présenté dans un contexte A : refusé', `${r2a}`);

const r2b = await dansTransaction({ identite: jetonAorgB, orgId: B.id }, async () => ({
  id: await identite(), n: await produits(B.id),
}));
ok(r2b.id === A.user_id && r2b.n === 0,
  'S2 même avec le contexte aligné, A ne voit aucun produit de B',
  `identité=${r2b.id} produits de B vus=${r2b.n}`);

// ---------------------------------------------------------------------------
// 3. GUC forgé sans jeton, en mode strict
// ---------------------------------------------------------------------------
const strictAvant = (await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;
await admin.query('UPDATE public.tracefab_identity_politique SET strict = true, modifie_le = now() WHERE singleton');
try {
  const r3 = await dansTransaction({ userId: B.user_id, orgId: B.id }, () => identite());
  ok(r3 === null, 'S3 GUC forgé sans jeton en mode strict : refusé', `${r3}`);
  const n3 = await dansTransaction({ userId: B.user_id, orgId: B.id }, () => produits(B.id));
  ok(n3 === 0, 'S3 aucune ligne de B visible par usurpation du GUC', `${n3} ligne(s)`);
} finally {
  await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictAvant]);
}

// ---------------------------------------------------------------------------
// 3 bis. FAIL-CLOSED sur une ECRITURE (R-A1)
//
// Le scenario 3 prouve qu'une identite forgee ne rend pas d'identite. Il ne
// prouve pas qu'une OPERATION est refusee : une fonction qui ne consulte pas
// l'identite, ou une politique permissive, pourrait encore laisser passer une
// ecriture « sans identite », et l'absence de fuite ne serait alors qu'une
// absence de lecture.
//
// On mesure donc l'ecriture elle-meme : un INSERT direct, par le role
// applicatif, dans `product_materials` — table dont la politique d'insertion
// repose sur `tracefab_has_org_role(...)`, donc sur l'identite.
//
//   1. strict + aucune identite     -> REFUSEE (42501, RLS)
//   2. strict + GUC forge           -> REFUSEE (aucun repli sur le GUC)
//   3. permissif + aucune identite  -> REFUSEE
//   4. strict + jeton valide        -> ACCEPTEE (controle positif : sans lui,
//                                      les trois refus ne prouveraient rien de
//                                      la verification, seulement que la table
//                                      refuse tout le monde)
//
// Et une MESURE qui n'est pas une assertion : en mode permissif, le GUC forge
// reste accepte. C'est le residu M3, documente dans le rapport P10.5 § 7. Il
// est affiche pour que personne ne le confonde avec une protection acquise ;
// il n'est pas affirme « conforme », et il disparaitra le jour ou le mode
// strict sera arme (voir docs/security/2026-10-31-p105-hmac.md).
// ---------------------------------------------------------------------------
console.log('');
{
  // Le locataire VISÉ est B : le scénario M3 de P10.4 consistait à forger
  // l'identité d'un membre de B pour écrire chez B. C'est donc B qu'il faut
  // attaquer ici, pas A — mesuré le 02/11 : en forgeant un utilisateur qui
  // n'appartient PAS au locataire visé, la RLS refuse pour une autre raison
  // (non-membre), et le test passerait sans rien prouver de la vérification.
  const org = B.id;
  const matiere = (await admin.query(
    `INSERT INTO public.materials (owner_organization_id, material_type, name, composition)
     VALUES ($1, 'fibre', 'matiere ephemere p105 (hmac)', '{"test":true}'::jsonb)
     RETURNING id`, [org])).rows[0].id;
  const produit = (await admin.query(
    `SELECT id, version FROM public.tracefab_products
      WHERE brand_organization_id = $1 ORDER BY id LIMIT 1`, [org])).rows[0];

  /** Tente l'ecriture sous un contexte donne ; rend un code, jamais une exception. */
  const ecrire = (contexte) => dansTransaction(contexte, async () => {
    try {
      await app.query(
        `INSERT INTO public.product_materials
           (product_id, material_id, material_role, unit, product_version)
         VALUES ($1, $2, 'fibre', 'kg', $3)`,
        [produit.id, matiere, produit.version],
      );
      return 'ACCEPTEE';
    } catch (e) {
      return `${e.code || 'inconnu'}`;
    }
  });

  const strictInitial = strictAvant;
  try {
    await admin.query('UPDATE public.tracefab_identity_politique SET strict = true, modifie_le = now() WHERE singleton');

    const sansIdentite = await ecrire({ orgId: org });
    ok(sansIdentite === '42501',
      'S3 bis mode strict, aucune identité : l écriture est REFUSÉE par la RLS',
      sansIdentite);

    // LE scénario M3 : l'identité d'un membre RÉEL de B, forgée par GUC.
    const gucForge = await ecrire({ userId: B.user_id, orgId: org });
    ok(gucForge === '42501',
      'S3 bis mode strict, GUC forgé (membre réel du locataire visé) : écriture REFUSÉE',
      gucForge);

    const jetonValide = await ecrire({ identite: jetonB, orgId: org });
    ok(jetonValide === 'ACCEPTEE',
      'S3 bis contrôle positif : avec un jeton VALIDE la même écriture passe',
      jetonValide);

    await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictInitial]);

    const permissifSansIdentite = await ecrire({ orgId: org });
    ok(permissifSansIdentite === '42501',
      'S3 bis mode permissif sans jeton : refusé aussi — le permissif ne dispense pas d identité',
      permissifSansIdentite);

    const permissifGuc = await ecrire({ userId: B.user_id, orgId: org });
    console.log(`        MESURE (résidu M3, NON conforme) — mode permissif + GUC forgé : ${permissifGuc}`);
    ok(permissifGuc === 'ACCEPTEE',
      'S3 bis le résidu M3 est MESURÉ, pas supposé : le permissif accepte le GUC forgé',
      permissifGuc);
  } finally {
    await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictInitial]);
    await admin.query('DELETE FROM public.materials WHERE id = $1', [matiere]);
  }
  ok((await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict === strictInitial,
    'S3 bis la politique d identité est rendue à son état initial',
    String(strictInitial));
}

// ---------------------------------------------------------------------------
// 4. Jeton falsifié
// ---------------------------------------------------------------------------
const jetonFalsifie = jeton({ userId: B.user_id, orgId: B.id, exp: MAINTENANT + 60 });
const corpsFalsifie = jetonFalsifie.split('.')[0];
const macFalsifie = jetonFalsifie.split('.')[1];
const jetonAutreCorps = `${corpsFalsifie}.${signer(corpsFalsifie, randomBytes(32))}`;
const r4 = await dansTransaction({ identite: jetonAutreCorps, orgId: B.id }, () => identite());
ok(r4 === null, 'S4 jeton dont le MAC ne correspond pas : refusé', `${r4}`);

// Le corps modifié, MAC conservé (l'attaque la plus évidente).
const corpsModifie = `v1|${A.user_id}|${B.id}|tracefab_identity|${MAINTENANT + 60}`;
const r4b = await dansTransaction({ identite: `${corpsModifie}.${macFalsifie}`, orgId: B.id }, () => identite());
ok(r4b === null, 'S4 jeton au corps modifié, MAC conservé : refusé', `${r4b}`);

// ---------------------------------------------------------------------------
// 5. Jeton expiré
// ---------------------------------------------------------------------------
const jetonExpire = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT - 5 });
const r5 = await dansTransaction({ identite: jetonExpire, orgId: A.id }, () => identite());
ok(r5 === null, 'S5 jeton expiré : refusé', `${r5}`);

// ---------------------------------------------------------------------------
// 6. Jeton rejoué dans un autre contexte
// ---------------------------------------------------------------------------
const r6 = await dansTransaction({ identite: jetonA, orgId: B.id }, () => identite());
ok(r6 === null, 'S6 jeton de A rejoué avec un autre active_organization_id : refusé', `${r6}`);
const r6b = await dansTransaction({ identite: jetonA, orgId: '' }, () => identite());
ok(r6b === null, 'S6 jeton sans organisation en session : refusé', `${r6b}`);

// ---------------------------------------------------------------------------
// 7. La clé est inaccessible au runtime
// ---------------------------------------------------------------------------
let lectureCle = null;
try {
  await app.query('SELECT version, secret FROM public.tracefab_identity_cles LIMIT 1');
  lectureCle = 'ACCEPTEE';
} catch (e) {
  lectureCle = `${e.code || ''} ${e.message.split('\n')[0].slice(0, 50)}`;
}
ok(String(lectureCle).startsWith('42501'), 'S7 tracefab_app ne peut pas lire la clé', String(lectureCle));

// Aucune fonction accessible au runtime ne signe : on cherche une fonction
// exécutable par l'app qui rendrait un MAC (donc un oracle de signature).
// Le filtre porte sur les fonctions `tracefab_*` : `hmac()` de pgcrypto est
// exécutable par tout le monde et ne constitue PAS un oracle ici — il faut
// déjà détenir la clé pour s'en servir, et la clé n'est pas lisible.
const oracle = await admin.query(
  `SELECT p.proname
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'tracefab\\_%'
      AND (p.proname ILIKE '%sign%' OR p.proname ILIKE '%mac%' OR p.proname ILIKE '%hmac%')
      AND has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
      AND p.proname <> 'tracefab_identity_jeton_utilisateur'`,
);
ok(oracle.rows.length === 0, 'S7 aucune fonction de signature accessible au runtime',
  oracle.rows.map((r) => r.proname).join(', ') || 'aucune');

// ---------------------------------------------------------------------------
// 8. Connexion physique réutilisée : aucun contexte résiduel
// ---------------------------------------------------------------------------
const pid = () => app.query('SELECT pg_backend_pid() AS p').then((r) => r.rows[0].p);
const pids = new Set();
const tour1 = await dansTransaction({ identite: jetonA, orgId: A.id }, async () => {
  pids.add(await pid());
  return identite();
});
const tour2 = await dansTransaction({}, async () => {
  pids.add(await pid());
  return { id: await identite(), n: await app.query('SELECT count(*)::int AS n FROM tracefab_products').then((r) => r.rows[0].n) };
});
ok(tour1 === A.user_id && tour2.id === null && tour2.n === 0,
  'S8 sur la même connexion, l identité ne survit pas à la transaction',
  `tours=${pids.size} pid · après=${tour2.id} · lignes=${tour2.n}`);

// ---------------------------------------------------------------------------
// P10.6 — S9. L'ADRESSE EST-ELLE SIGNÉE ?
//
// P10.5 signait l'identifiant, pas l'adresse. Mesure de la revue P10.6 : en
// mode strict, jeton signé de A + `tracefab.user_email` forgé rendait l'adresse
// forgée. Trois surfaces en dépendent (acceptation d'invitation, auto-
// inscription fournisseur, politique `passport_access_select`). Depuis
// 20261102120000, l'adresse est LUE dans `users` sur l'identité signée.
//
// Le contrôle négatif compte autant que le refus : en mode permissif, l'adresse
// vient TOUJOURS du GUC. C'est la transition documentée, et elle est affichée
// pour que personne ne la confonde avec une protection acquise.
// ---------------------------------------------------------------------------
console.log('');
{
  const adresseReelle = (await admin.query('SELECT lower(email) e FROM public.users WHERE id = $1', [A.user_id])).rows[0].e;
  const FORGEE = 'pirate@exemple.test';
  const lireAdresse = (ctx) => dansTransaction(ctx, () => app.query('SELECT public.tracefab_current_user_email() AS e').then((r) => r.rows[0].e));

  await admin.query('UPDATE public.tracefab_identity_politique SET strict = true, modifie_le = now() WHERE singleton');
  try {
    const stricte = await lireAdresse({ identite: jetonA, orgId: A.id, userEmail: FORGEE });
    ok(stricte === adresseReelle,
      'S9 mode strict : l adresse vient de l IDENTITÉ SIGNÉE, pas du GUC forgé',
      `rendue=${stricte} · forgée=${FORGEE}`);

    const sansJeton = await lireAdresse({ orgId: A.id, userEmail: FORGEE });
    ok(sansJeton === null,
      'S9 mode strict, GUC d adresse forgé sans jeton : aucune adresse', `${sansJeton}`);
  } finally {
    await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictAvant]);
  }
  const permissive = await lireAdresse({ orgId: A.id, userEmail: FORGEE });
  console.log(`        MESURE (transition assumée) — mode permissif, adresse non signée : ${permissive}`);
  ok(permissive === FORGEE,
    'S9 mode permissif : comportement antérieur CONSERVÉ (transition), mesuré et non supposé',
    `${permissive}`);
}

// ---------------------------------------------------------------------------
// P10.6 — S10. AUCUNE AUTRE LECTURE DU GUC D'IDENTITÉ
//
// Contrôle STRUCTUREL, et c'est le seul possible pour les autres fonctions :
// l'assertion porte sur le catalogue, donc elle couvre toute fonction ajoutée
// plus tard, y compris par une migration qui ne passerait pas par ce fichier.
// ---------------------------------------------------------------------------
console.log('');
{
  const brut = await admin.query(
    `SELECT p.proname
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND p.proname <> 'tracefab_current_user_id'
        AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%current_setting(''tracefab.user_id''%'
      ORDER BY 1`);
  ok(brut.rows.length === 0,
    'S10 aucune fonction hors du point de passage ne lit le GUC tracefab.user_id',
    brut.rows.map((r) => r.proname).join(', ') || 'aucune');

  const politiques = await admin.query(
    `SELECT policyname, tablename FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%tracefab.user_email%'`);
  ok(politiques.rows.length === 0,
    'S10 aucune politique ne compare au GUC tracefab.user_email',
    politiques.rows.map((r) => `${r.tablename}.${r.policyname}`).join(', ') || 'aucune');
}

// ---------------------------------------------------------------------------
// P10.6 — S11. ROTATION DES CLÉS, SANS COUPURE
//
// Avant 20261102120000, la vérification ne retenait que la clé active de
// version la plus haute : toute rotation invalidait immédiatement les jetons
// en vol, ce qui décourage de tourner la clé. Deux clés ACTIVES doivent
// coexister : le jeton signé par l'ancienne reste accepté le temps que la
// nouvelle se déploie. Une clé DÉSACTIVÉE ne vaut plus rien.
// ---------------------------------------------------------------------------
console.log('');
{
  const V_ANCIENNE = 99012;
  const V_NOUVELLE = 99013;
  const ancienne = randomBytes(32);
  const nouvelle = randomBytes(32);
  // La clé de test P10.5 (`VERSION`) n'est PAS touchée : le contrôle négatif
  // qui suit la réutilise. Seules les deux clés de rotation sont créées puis
  // retirées ici.
  const nettoyer = async () => {
    await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = ANY($1)', [[V_ANCIENNE, V_NOUVELLE]]);
  };
  await nettoyer();
  try {
    await admin.query('UPDATE public.tracefab_identity_cles SET actif = (version = $1)', [VERSION]);
    await admin.query(
      `INSERT INTO public.tracefab_identity_cles (version, secret, actif) VALUES ($1,$2,true), ($3,$4,true)`,
      [V_ANCIENNE, ancienne, V_NOUVELLE, nouvelle]);

    const avecAncienne = await dansTransaction(
      { identite: jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 60, cle: ancienne }), orgId: A.id },
      () => identite());
    ok(avecAncienne === A.user_id,
      'S11 rotation : un jeton signé par l ANCIENNE clé reste accepté pendant le chevauchement',
      `${avecAncienne}`);

    const avecNouvelle = await dansTransaction(
      { identite: jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 60, cle: nouvelle }), orgId: A.id },
      () => identite());
    ok(avecNouvelle === A.user_id,
      'S11 rotation : un jeton signé par la NOUVELLE clé est accepté', `${avecNouvelle}`);

    await admin.query('UPDATE public.tracefab_identity_cles SET actif = false WHERE version = $1', [V_ANCIENNE]);
    const apresDesactivation = await dansTransaction(
      { identite: jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 60, cle: ancienne }), orgId: A.id },
      () => identite());
    ok(apresDesactivation === null,
      'S11 une clé DÉSACTIVÉE ne vérifie plus rien — la révocation est effective',
      `${apresDesactivation}`);
  } finally {
    await nettoyer();
    await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictAvant]);
  }
}

// ---------------------------------------------------------------------------
// Contrôle négatif : une clé connue de l'appelant rend la falsification valide.
// ---------------------------------------------------------------------------
const cleConnue = randomBytes(32);
await admin.query('UPDATE public.tracefab_identity_cles SET secret = $1 WHERE version = $2', [cleConnue, VERSION]);
const jetonForge = jeton({ userId: B.user_id, orgId: B.id, exp: MAINTENANT + 60, cle: cleConnue });
const rControle = await dansTransaction({ identite: jetonForge, orgId: B.id }, () => identite());
ok(rControle === B.user_id,
  'contrôle négatif : avec la clé, le même jeton est accepté — la vérification est bien la clé',
  `identité=${rControle}`);

// Restauration : la clé de test disparaît, la politique reprend sa valeur.
await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = $1', [VERSION]);
await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictAvant]);
const residus = await admin.query('SELECT count(*)::int AS n FROM public.tracefab_identity_cles');
console.log(`  info  clés restantes après le test : ${residus.rows[0].n}`);

await app.end();
await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  HMAC d'identité : ${assertions} assertions — huit scénarios P10.5 (S1-S8) et trois contrôles P10.6 (S9-S11).`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
