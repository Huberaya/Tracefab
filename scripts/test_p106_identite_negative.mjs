#!/usr/bin/env node
/**
 * P10.6 — CONTRÔLE NÉGATIF PERMANENT DE L'IDENTITÉ SIGNÉE.
 *
 * CE QUE CE TEST GARDE, ET POURQUOI IL EXISTE SÉPARÉMENT DE `test:p105:hmac`
 *
 * `test:p105:hmac` décrit le chemin nominal des huit scénarios P10.5. Ce test-ci
 * ne décrit QUE des refus, et il les décrit pour que le jour où quelqu'un
 * « simplifiera » `tracefab_current_user_id()` en repassant par le GUC, la CI
 * tombe au lieu de continuer à afficher du vert. Chaque assertion doit rester
 * vraie après n'importe quelle migration future.
 *
 * Ce qui est prouvé ici, par EXÉCUTION sur base jetable :
 *
 *   N1  mode strict + GUC `tracefab.user_id` forgé, sans jeton  -> aucune identité
 *   N2  jeton valide de A + GUC forgé de B                       -> identité = A
 *   N3  jeton à MAC invalide, en mode PERMISSIF                  -> aucune identité
 *       (le point qui compte le plus : un jeton présent n'est JAMAIS remplacé
 *        par le GUC, même pendant la période de transition)
 *   N4  jeton malformé (sans séparateur, 4 champs, non-UTF8, 10 ko) -> refus
 *   N5  jeton d'une autre organisation que la session             -> refus
 *   N6  jeton expiré, et jeton expirant à la seconde même         -> refus
 *   N7  usage signé inattendu (`tracefab_impersonation`)          -> refus
 *   N8  aucune clé ACTIVE (rotation terminée)                     -> refus, même
 *       avec un jeton correctement signé : l'absence de clé ne rouvre pas le GUC
 *   N9  rotation : ancienne clé active acceptée, clé désactivée refusée,
 *       clé présente mais inactive ignorée
 *   N10 adresse en mode strict : l'adresse vient de `users` sur l'identité
 *       signée, jamais du GUC `tracefab.user_email` forgé
 *   N11 adresse en mode strict sans jeton                          -> aucune adresse
 *   N12 STRUCTUREL : aucune fonction hors point de passage ne lit les GUC
 *       `tracefab.user_id` ni `tracefab.user_email`
 *   N13 STRUCTUREL : aucune politique RLS ne compare au GUC d'adresse
 *   N14 la clé reste illisible par `tracefab_app` (42501)
 *   N15 la politique d'identité et les clés sont rendues à leur état initial
 *
 * Aucun secret d'exploitation : le test pose ses propres clés (versions 9902x,
 * hors plage d'exploitation) dans la base jetable et les retire à la fin.
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

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-p106-admin' });
await admin.connect();
const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp), application_name: 'tracefab-p106-runtime' });
await app.connect();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const locataires = (await admin.query(
  `SELECT o.id, m.user_id, lower(u.email) AS email
     FROM organizations o
     JOIN organization_memberships m ON m.organization_id = o.id AND m.role = 'owner'
     JOIN users u ON u.id = m.user_id
    ORDER BY o.created_at, o.id LIMIT 2`,
)).rows;
if (locataires.length < 2) {
  console.error('  NON EXECUTE — il faut deux locataires avec propriétaire ; jouer npm run db:seed-rls d abord.');
  await admin.end(); await app.end();
  process.exit(2);
}
const [A, B] = locataires;

const V_BASE = 99021;   // clé nominale du test
const V_ANCIENNE = 99022;
const V_NOUVELLE = 99023;
const V_INACTIVE = 99024;
const VERSIONS = [V_BASE, V_ANCIENNE, V_NOUVELLE, V_INACTIVE];

const cleBase = randomBytes(32);
const cleAncienne = randomBytes(32);
const cleNouvelle = randomBytes(32);
const cleInactive = randomBytes(32);

const strictAvant = (await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;

const nettoyerCles = () => admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = ANY($1)', [VERSIONS]);
await nettoyerCles();
await admin.query(
  `INSERT INTO public.tracefab_identity_cles (version, secret, actif)
   VALUES ($1,$2,true), ($3,$4,false), ($5,$6,false), ($7,$8,false)`,
  [V_BASE, cleBase, V_ANCIENNE, cleAncienne, V_NOUVELLE, cleNouvelle, V_INACTIVE, cleInactive],
);

const signer = (corps, cle) => createHmac('sha256', cle).update(corps).digest('hex');
const jeton = ({ userId, orgId, exp, usage = 'tracefab_identity', cle = cleBase }) => {
  const corps = `v1|${userId}|${orgId}|${usage}|${exp}`;
  return `${corps}.${signer(corps, cle)}`;
};
const MAINTENANT = Math.floor(Date.now() / 1000);

async function dansTransaction({ identite, userId, orgId, userEmail } = {}, corps) {
  await app.query('BEGIN');
  try {
    for (const [guc, valeur] of [
      ['tracefab.identity', identite],
      ['tracefab.user_id', userId],
      ['tracefab.active_organization_id', orgId],
      ['tracefab.user_email', userEmail],
    ]) {
      if (valeur !== undefined) await app.query('SELECT set_config($1,$2,true)', [guc, valeur]);
    }
    return await corps();
  } finally {
    await app.query('ROLLBACK').catch(() => {});
  }
}
const identite = () => app.query('SELECT public.tracefab_current_user_id() AS id').then((r) => r.rows[0].id);
const adresse = () => app.query('SELECT public.tracefab_current_user_email() AS e').then((r) => r.rows[0].e);
const poserStrict = (v) => admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [v]);

const jetonA = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 120 });

try {
  // -------------------------------------------------------------------------
  // N1 — le GUC forgé n'est pas une identité en mode strict
  // -------------------------------------------------------------------------
  await poserStrict(true);
  {
    const n1 = await dansTransaction({ userId: B.user_id, orgId: B.id }, identite);
    ok(n1 === null, 'N1 strict : GUC user_id forgé sans jeton — aucune identité', `${n1}`);
    const n1b = await dansTransaction({ userId: B.user_id, userEmail: 'pirate@exemple.test' }, adresse);
    ok(n1b === null, 'N1 strict : GUC user_email forgé sans jeton — aucune adresse', `${n1b}`);
  }

  // -------------------------------------------------------------------------
  // N2 — un jeton valide n'est pas « recouvert » par un GUC forgé
  // -------------------------------------------------------------------------
  {
    const n2 = await dansTransaction({ identite: jetonA, userId: B.user_id, orgId: A.id }, identite);
    ok(n2 === A.user_id, 'N2 jeton de A + GUC user_id de B — identité = A', `${n2}`);
  }

  // -------------------------------------------------------------------------
  // N3 — jeton PRÉSENT mais invalide : jamais de repli sur le GUC, même en
  //      mode permissif. C'est la garantie de transition.
  // -------------------------------------------------------------------------
  await poserStrict(false);
  {
    const corps = `v1|${B.user_id}|${B.id}|tracefab_identity|${MAINTENANT + 120}`;
    const macFaux = signer(corps, randomBytes(32));
    const n3 = await dansTransaction(
      { identite: `${corps}.${macFaux}`, userId: B.user_id, orgId: B.id },
      identite,
    );
    ok(n3 === null, 'N3 permissif : MAC invalide + GUC valide de B — aucune identité (pas de repli)', `${n3}`);

    const corpsA = `v1|${A.user_id}|${B.id}|tracefab_identity|${MAINTENANT + 120}`;
    const n3b = await dansTransaction(
      { identite: `${corpsA}.${signer(`v1|${A.user_id}|${A.id}|tracefab_identity|${MAINTENANT + 120}`, cleBase)}`, orgId: B.id },
      identite,
    );
    ok(n3b === null, 'N3 permissif : corps modifié, MAC d un autre corps — refusé', `${n3b}`);

    const n3c = await dansTransaction({ userId: B.user_id, orgId: B.id }, identite);
    ok(n3c === B.user_id, 'N3 contrôle positif de transition : SANS jeton, le permissif garde le GUC', `${n3c}`);
  }
  await poserStrict(true);

  // -------------------------------------------------------------------------
  // N4 — formes malformées : refus, jamais d'exception remontée à l'appelant
  // -------------------------------------------------------------------------
  {
    const formes = {
      'sans séparateur': 'v1abc',
      'quatre champs': `v1|${A.user_id}|${A.id}|${MAINTENANT + 120}.${signer('x', cleBase)}`,
      'MAC vide': `v1|${A.user_id}|${A.id}|tracefab_identity|${MAINTENANT + 120}.`,
      'MAC tronqué': `v1|${A.user_id}|${A.id}|tracefab_identity|${MAINTENANT + 120}.${signer(`v1|${A.user_id}|${A.id}|tracefab_identity|${MAINTENANT + 120}`, cleBase).slice(0, 20)}`,
      'identifiant non UUID': `v1|pas-un-uuid|${A.id}|tracefab_identity|${MAINTENANT + 120}.${signer(`v1|pas-un-uuid|${A.id}|tracefab_identity|${MAINTENANT + 120}`, cleBase)}`,
      'jeton énorme': `v1|${'a'.repeat(10000)}`,
      'version inconnue': `v2|${A.user_id}|${A.id}|tracefab_identity|${MAINTENANT + 120}.${signer(`v2|${A.user_id}|${A.id}|tracefab_identity|${MAINTENANT + 120}`, cleBase)}`,
    };
    for (const [nom, valeur] of Object.entries(formes)) {
      let rendu = 'EXCEPTION';
      try {
        rendu = await dansTransaction({ identite: valeur, orgId: A.id }, identite);
      } catch (e) {
        rendu = `EXCEPTION ${e.code || ''} ${e.message.split('\n')[0].slice(0, 40)}`;
      }
      ok(rendu === null, `N4 jeton malformé (${nom}) — refus sans exception`, `${rendu}`);
    }
  }

  // -------------------------------------------------------------------------
  // N5 — organisation : celle du jeton doit être celle de la session
  // -------------------------------------------------------------------------
  {
    const n5 = await dansTransaction({ identite: jetonA, orgId: B.id }, identite);
    ok(n5 === null, 'N5 jeton de l organisation A joué dans la session B — refusé', `${n5}`);
    const n5b = await dansTransaction({ identite: jetonA }, identite);
    ok(n5b === null, 'N5 jeton sans organisation en session — refusé', `${n5b}`);
  }

  // -------------------------------------------------------------------------
  // N6 — expiration : horloge de la base
  // -------------------------------------------------------------------------
  {
    const n6 = await dansTransaction(
      { identite: jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT - 1 }), orgId: A.id }, identite);
    ok(n6 === null, 'N6 jeton expiré (1 s) — refusé', `${n6}`);
    const n6b = await dansTransaction(
      { identite: jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 3 }), orgId: A.id }, identite);
    ok(n6b === A.user_id, 'N6 contrôle positif : jeton encore valide — accepté', `${n6b}`);
  }

  // -------------------------------------------------------------------------
  // N7 — l'usage fait partie du corps signé : il ne peut pas être détourné
  // -------------------------------------------------------------------------
  {
    for (const usage of ['tracefab_impersonation', 'tracefab_identity ', 'TRACEFAB_IDENTITY']) {
      const n7 = await dansTransaction(
        { identite: jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 120, usage }), orgId: A.id },
        identite);
      ok(n7 === null, `N7 usage signé « ${usage} » — refusé`, `${n7}`);
    }
  }

  // -------------------------------------------------------------------------
  // N8 — AUCUNE clé active : le refus est total, la porte du GUC reste fermée
  // -------------------------------------------------------------------------
  {
    await admin.query('UPDATE public.tracefab_identity_cles SET actif = false WHERE version = ANY($1)', [VERSIONS]);
    const n8 = await dansTransaction({ identite: jetonA, userId: B.user_id, orgId: A.id }, identite);
    ok(n8 === null, 'N8 aucune clé active : jeton correctement signé + GUC forgé — aucune identité', `${n8}`);
    const n8b = await dansTransaction({ identite: jetonA, orgId: A.id }, adresse);
    ok(n8b === null, 'N8 aucune clé active : aucune adresse non plus', `${n8b}`);
    await admin.query('UPDATE public.tracefab_identity_cles SET actif = true WHERE version = $1', [V_BASE]);
    const n8c = await dansTransaction({ identite: jetonA, orgId: A.id }, identite);
    ok(n8c === A.user_id, 'N8 contrôle positif : clé réactivée, le même jeton est de nouveau accepté', `${n8c}`);
  }

  // -------------------------------------------------------------------------
  // N9 — rotation sans coupure, revocation effective
  // -------------------------------------------------------------------------
  {
    const jetonAncien = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 120, cle: cleAncienne });
    const jetonNouveau = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 120, cle: cleNouvelle });
    const jetonInactif = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 120, cle: cleInactive });

    await admin.query('UPDATE public.tracefab_identity_cles SET actif = false WHERE version = ANY($1)', [VERSIONS]);
    await admin.query('UPDATE public.tracefab_identity_cles SET actif = true WHERE version = ANY($1)', [[V_BASE, V_ANCIENNE, V_NOUVELLE]]);

    const r1 = await dansTransaction({ identite: jetonAncien, orgId: A.id }, identite);
    ok(r1 === A.user_id, 'N9 rotation : l ANCIENNE clé active est encore acceptée (jetons en vol)', `${r1}`);
    const r2 = await dansTransaction({ identite: jetonNouveau, orgId: A.id }, identite);
    ok(r2 === A.user_id, 'N9 rotation : la NOUVELLE clé active est acceptée', `${r2}`);
    const r3 = await dansTransaction({ identite: jetonInactif, orgId: A.id }, identite);
    ok(r3 === null, 'N9 une clé PRÉSENTE mais inactive ne vérifie rien', `${r3}`);

    await admin.query('UPDATE public.tracefab_identity_cles SET actif = false WHERE version = $1', [V_ANCIENNE]);
    const r4 = await dansTransaction({ identite: jetonAncien, orgId: A.id }, identite);
    ok(r4 === null, 'N9 après désactivation : l ancienne clé ne vérifie plus (révocation effective)', `${r4}`);
  }

  // -------------------------------------------------------------------------
  // N10/N11 — l'adresse n'est pas une déclaration en mode strict
  // -------------------------------------------------------------------------
  {
    const FORGEE = 'pirate@exemple.test';
    const n10 = await dansTransaction({ identite: jetonA, orgId: A.id, userEmail: FORGEE }, adresse);
    ok(n10 === A.email, 'N10 strict : adresse issue de users sur l identité signée, GUC ignoré', `rendue=${n10}`);
    const n11 = await dansTransaction({ orgId: A.id, userEmail: FORGEE }, adresse);
    ok(n11 === null, 'N11 strict : GUC d adresse seul — aucune adresse', `${n11}`);
  }

  // -------------------------------------------------------------------------
  // N12/N13 — contrôles STRUCTURELS : ils couvrent toute fonction ou politique
  // ajoutée plus tard, y compris par une migration qui ignorerait ce fichier.
  // -------------------------------------------------------------------------
  {
    // Le catalogue conserve les COMMENTAIRES du corps : une fonction qui parle
    // de `tracefab.user_id` dans un commentaire n'en est pas une qui le lit
    // (mesuré le 02/11 : `tracefab_ingest_plm_erp_payload` remontait à tort).
    // Le filtre porte donc sur l'APPEL `current_setting('tracefab.user_…')`,
    // commentaires retirés. Les deux points de passage légitimes sont exclus :
    // `tracefab_current_user_id()` et `tracefab_current_user_email()`, qui
    // portent à eux seuls la transition permissive documentée.
    const definitions = await admin.query(
      `SELECT p.proname, pg_catalog.pg_get_functiondef(p.oid) AS def
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND p.proname NOT IN ('tracefab_current_user_id', 'tracefab_current_user_email')
        ORDER BY 1`);
    const lecturesGuc = definitions.rows.filter((r) => {
      const sansCommentaires = r.def
        .split('\n')
        .map((l) => l.replace(/--.*$/, ''))
        .join('\n');
      return /current_setting\s*\(\s*'tracefab\.user_(id|email)'/i.test(sansCommentaires);
    });
    ok(lecturesGuc.length === 0,
      'N12 aucune fonction hors du point de passage ne lit un GUC d identité',
      lecturesGuc.map((r) => r.proname).join(', ') || 'aucune');

    const politiquesGuc = await admin.query(
      `SELECT policyname, tablename FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%tracefab.user_%'
        ORDER BY 2,1`);
    ok(politiquesGuc.rows.length === 0,
      'N13 aucune politique RLS ne compare à un GUC d identité',
      politiquesGuc.rows.map((r) => `${r.tablename}.${r.policyname}`).join(', ') || 'aucune');

    // Les trois fonctions SECURITY DEFINER reprises par 20261102120000 doivent
    // passer par le point de passage signé, et seulement par lui.
    const trois = [
      'tracefab_register_transaction_certificate',
      'tracefab_allocate_tc_quantity',
      'tracefab_reconcile_mass_balance',
    ];
    const parPointDePassage = await admin.query(
      `SELECT p.proname,
              pg_catalog.pg_get_functiondef(p.oid) LIKE '%public.tracefab_current_user_id()%' AS signee
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)`, [trois]);
    const nonConformes = parPointDePassage.rows.filter((r) => !r.signee).map((r) => r.proname);
    ok(parPointDePassage.rows.length === trois.length && nonConformes.length === 0,
      'N12 bis les trois fonctions d attestation lisent l identité signée',
      nonConformes.join(', ') || `${parPointDePassage.rows.length}/${trois.length}`);

    // Le point de passage lui-même : SECURITY INVOKER (il ne doit pas élargir
    // les droits) et search_path verrouillé.
    const porte = (await admin.query(
      `SELECT p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') AS conf, r.rolname AS proprietaire
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE p.oid = 'public.tracefab_current_user_id()'::regprocedure`)).rows[0];
    ok(porte && porte.prosecdef === false, 'N12 ter le point de passage n est pas SECURITY DEFINER', porte ? `prosecdef=${porte.prosecdef}` : 'absent');
    ok(porte && /search_path=pg_catalog, ?public/.test(porte.conf), 'N12 ter le point de passage verrouille son search_path', porte ? porte.conf : 'absent');
  }

  // -------------------------------------------------------------------------
  // N14 — la clé reste hors de portée du runtime
  // -------------------------------------------------------------------------
  {
    let rendu = 'ACCEPTEE';
    try {
      await app.query('SELECT version, secret FROM public.tracefab_identity_cles LIMIT 1');
    } catch (e) {
      rendu = `${e.code || ''}`;
    }
    ok(rendu === '42501', 'N14 tracefab_app ne peut pas lire la clé (42501)', rendu);
  }
} finally {
  // -------------------------------------------------------------------------
  // N15 — l'état est rendu tel qu'il était
  // -------------------------------------------------------------------------
  await nettoyerCles();
  await poserStrict(strictAvant);
  const apres = (await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;
  const residus = (await admin.query('SELECT count(*)::int AS n FROM public.tracefab_identity_cles WHERE version = ANY($1)', [VERSIONS])).rows[0].n;
  ok(apres === strictAvant, 'N15 politique d identité rendue à son état initial', String(apres));
  ok(residus === 0, 'N15 aucune clé de test ne subsiste', `restantes=${residus}`);
  await app.end();
  await admin.end();
}

console.log('');
if (echecs === 0) {
  console.log(`  P10.6 identite negative : ${assertions} assertions — aucun refus affaibli.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
