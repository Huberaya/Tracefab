import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { emailDeliveryConfigured } from '../../_lib/email.js';
import { notificationAlertConfigured } from '../../_lib/notification-observability.js';
import { storageConfig } from '../../_lib/storage.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { runtimeProbeAuthorized, workerAuthorized, workerSecretConfigured } from '../../_lib/worker-auth.js';
import { databaseIdentityIsSafe, probeDatabaseIdentity, runLiveProbes } from '../../_lib/readiness-probes.js';
import { ecartIdentiteRuntime } from '../../_lib/identite-contrat.js';
import { etatCleIdentite } from '../../_lib/identite-jeton.js';
import { prisma } from '../../_lib/prisma.js';
import { withTracefabWorkerContext } from '../../_lib/contexte-systeme.js';
import { etatCleSysteme, signerIdentiteSysteme } from '../../_lib/identite-systeme.js';

type OutboxHealthRow = {
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  ready: number;
  staleProcessing: number;
  exhausted: number;
  oldestReadyAt: Date | null;
};

function configured(name: string) {
  return Boolean(process.env[name]?.trim());
}

function privateStorageReadiness() {
  const required = ['PRIVATE_STORAGE_ENDPOINT', 'PRIVATE_STORAGE_BUCKET', 'PRIVATE_STORAGE_REGION', 'PRIVATE_STORAGE_ACCESS_KEY_ID', 'PRIVATE_STORAGE_SECRET_ACCESS_KEY', 'PRIVATE_STORAGE_ANTIVIRUS_URL', 'PRIVATE_STORAGE_ANTIVIRUS_TOKEN'];
  const missing = required.filter((name) => !configured(name));
  let configValid = false;
  if (missing.length === 0) {
    try {
      storageConfig();
      configValid = true;
    } catch {
      configValid = false;
    }
  }
  return { configured: missing.length === 0 && configValid, missing, probe: 'configuration_only' };
}


export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const workerConfigured = workerSecretConfigured();
  const workerAccess = workerConfigured && workerAuthorized(req);
  // Le jeton de sonde n'autorise que la lecture de l'identite DB en Preview
  // sur la branche P11. Il ne peut pas declencher les sondes live externes.
  const runtimeIdentityProbe = req.query?.identity === '1'
    && req.query?.probe !== 'live'
    && runtimeProbeAuthorized(req);
  if (!workerConfigured && !runtimeIdentityProbe) return json(res, 503, { error: 'worker_not_configured' });
  if (!workerAccess && !runtimeIdentityProbe) return json(res, 401, { error: 'worker_unauthorized' });

  // ?probe=live exerce reellement chaque service au lieu de constater que ses
  // variables existent. Volontairement opt-in : on ne veut pas appeler cinq
  // services externes a chaque passage d'une sonde de supervision.
  const live = req.query?.probe === 'live';

  const privateStorage = privateStorageReadiness();
  const email = {
    configured: emailDeliveryConfigured(),
    missing: ['RESEND_API_KEY', 'EMAIL_FROM', 'TRACEFAB_APP_URL'].filter((name) => !configured(name)),
    probe: 'configuration_only',
  };
  const alerting = {
    configured: notificationAlertConfigured() && configured('TRACEFAB_NOTIFICATION_ALERT_TOKEN'),
    missing: ['TRACEFAB_NOTIFICATION_ALERT_URL', 'TRACEFAB_NOTIFICATION_ALERT_TOKEN'].filter((name) => !configured(name)),
    probe: 'configuration_only',
  };
  const services = { privateStorage, email, alerting };
  // Alerting is explicitly optional in docs/operations/production-hardening.md.
  // It remains visible in the report, but cannot hold core readiness red.
  const configured_ = privateStorage.configured && email.configured;

  // Identite reelle de la connexion applicative — opt-in.
  //
  // Deja derriere workerSecretConfigured() puis workerAuthorized(), donc jamais
  // expose sans authentification. Opt-in pour deux raisons : la sonde interroge
  // la base, et un nom de role n'a pas a figurer dans chaque passage de sonde de
  // supervision.
  //
  // C'est le seul moyen de mesurer l'identite reellement utilisee par le
  // runtime : la requete passe par le meme client Prisma que les routes. Un
  // psql branche sur la meme URL mesurerait une autre connexion et ne
  // prouverait rien. Tant que cette sonde n'a pas ete executee sur le runtime
  // reel, l'identite de Production reste non mesuree.
  // P10.5 — l'application sait-elle SIGNER l'identite qu'elle pose en base ?
  //
  // C'est un booleen, jamais la cle : un operateur peut donc verifier sur le
  // deploiement reel que `TRACEFAB_IDENTITY_KEY` est posee, sans lire de
  // secret. L'absence n'est PAS bloquante : le mode permissif est l'etat de
  // transition documente (docs/security/2026-10-31-p105-hmac.md § 4). Le mode
  // qui fait foi est celui de la BASE (`tracefab_identity_politique.strict`).
  // P10.6 : trois etats distincts, pas deux. Une cle PRESENTE mais malformee
  // n'est pas « non configuree » : c'est une erreur d'exploitation qui, avant
  // ce correctif, degradait silencieusement la signature vers l'identite non
  // signee. L'operateur doit pouvoir la voir sans lire le secret.
  // `etatCleIdentite` ne rend jamais la valeur.
  const etatSignature = etatCleIdentite();
  const jetonsIdentite = {
    configured: etatSignature === 'valide',
    mode: etatSignature === 'valide' ? 'signe'
      : etatSignature === 'invalide' ? 'cle_invalide'
        : 'non_configure',
  };

  const wantIdentity = req.query?.identity === '1';

  // P10.7 — l'application sait-elle signer une identite SYSTEME, et la base
  // sait-elle la VERIFIER ?
  //
  // Ce n'est pas la meme question que `identityTokens` : le jeton utilisateur et
  // le jeton systeme partagent la cle mais pas l'usage, et le mode strict de
  // l'un n'est pas celui de l'autre. Un operateur doit pouvoir constater les
  // deux avant d'activer quoi que ce soit.
  //
  // `verifiee_par_la_base` n'est pas un constat de configuration : c'est un
  // ALLER-RETOUR reel — on signe un jeton, on le fait verifier par la base, et
  // on rapporte le booleen. Une application qui signe et une base qui refuse
  // (cle differente, mode strict, table vide) est exactement le mode de panne
  // que cette sonde doit rendre visible AVANT la bascule.
  const etatSysteme = etatCleSysteme();
  let verificationBase: boolean | null = null;
  let verificationDetail = 'non_sondee';
  if (etatSysteme === 'valide' && wantIdentity) {
    const signe = signerIdentiteSysteme({ cle: process.env.TRACEFAB_IDENTITY_KEY });
    if (signe === null) {
      verificationDetail = 'signature_impossible';
    } else {
      try {
        const rows = await prisma.$queryRaw<Array<{ v: boolean | null }>>`
          SELECT public.tracefab_identite_systeme_jeton_valide(${signe.jeton}) AS v
        `;
        verificationBase = rows?.[0]?.v === true;
        verificationDetail = verificationBase ? 'aller_retour_reussi' : 'base_a_refuse';
      } catch (error) {
        // Une erreur n'est PAS un « non » : c'est une incapacite de mesurer, et
        // la distinguer evite de lire un feu vert la ou rien n'a ete verifie.
        verificationBase = null;
        verificationDetail = error instanceof Error && /42501|permission denied/.test(error.message)
          ? 'verification_non_accordee_au_runtime'
          : 'verification_en_erreur';
      }
    }
  }
  // P10.7 — L'ETAT DE LA BASE, MEME QUAND LA CLE RUNTIME MANQUE.
  //
  // Mesure du 2026-11-17 : `mode = non_configure` parce que
  // `TRACEFAB_IDENTITY_KEY` est absente de Preview. L'operateur lit alors
  // « non configure » et ne sait pas si la BASE, elle, est prete. Il doit
  // regenerer une cle sans savoir si une version active existe deja — et sans
  // ce fait, il ne peut pas decider entre « provisionner » et « reutiliser ».
  //
  // On interroge donc le CATALOGUE, pas la table des cles : `pg_class` pour
  // l'existence, `pg_policy`/`pg_class` pour la RLS. Aucune ligne de
  // `tracefab_identity_cles` n'est lue, aucun secret n'est approche. Un role
  // sans privilege sur la table peut lire ces catalogues.
  //
  // Ce bloc ne s'execute que sur demande explicite (`?identity=1`) et derriere
  // l'authentification de sonde deja exigee ci-dessus.
  let baseIdentite: { table_presente: boolean; rls_forcee: boolean; mode_strict: boolean | null } | null = null;
  if (wantIdentity && etatSysteme !== 'valide') {
    // DEUX REQUETES SEPAREES, ET POURQUOI.
    //
    // La premiere version combinait les trois champs dans un seul SELECT avec
    // `CASE WHEN to_regclass('...politique') IS NOT NULL THEN (SELECT ...)`.
    // Mesure du run 44262660569 : `baseIdentite: null`, alors que le GRANT
    // SELECT et la politique de lecture existent bien. Un `CASE` n'empeche pas
    // PostgreSQL de planifier — donc de resoudre — la sous-requete de la branche
    // non prise : sur une base sans cette table, la requete entiere echouait.
    //
    // On separe donc : d'abord le catalogue (toujours lisible, aucun privilege
    // requis), puis la politique SEULEMENT si sa table existe. Une incapacite de
    // mesurer n'est pas un « non » : chaque etape degrade vers `null`.
    try {
      // DEUX TEMOINS INDEPENDANTS POUR L'EXISTENCE, ET POURQUOI.
      //
      // `to_regclass` resout le nom en passant par le catalogue des schemas :
      // sans USAGE sur `public`, il ne rend pas NULL mais leve 42501. Il est
      // donc fiable pour dire « absente » quand il rend NULL — mesure PGlite :
      // une table PRIVEE (aucun GRANT, mais USAGE sur le schema) reste vue.
      //
      // `pg_class` ne consulte aucun privilege d'usage : c'est le temoin
      // independant. Les deux doivent concorder. Une divergence signale une
      // base qui n'est pas celle qu'on croit, pas une table absente.
      const cat = await prisma.$queryRaw<Array<{
        vue_to_regclass: boolean; vue_pg_class: boolean; rls_forcee: boolean; politique_presente: boolean;
      }>>`
        SELECT
          to_regclass('public.tracefab_identity_cles') IS NOT NULL AS vue_to_regclass,
          EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = 'tracefab_identity_cles') AS vue_pg_class,
          COALESCE((SELECT c.relrowsecurity AND c.relforcerowsecurity
                      FROM pg_catalog.pg_class c
                      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relname = 'tracefab_identity_cles'), false) AS rls_forcee,
          EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = 'tracefab_identity_politique') AS politique_presente
      `;
      const ligne = cat?.[0];
      let modeStrict: boolean | null = null;
      if (ligne?.politique_presente) {
        try {
          const pol = await prisma.$queryRaw<Array<{ strict: boolean | null }>>`
            SELECT p.strict FROM public.tracefab_identity_politique p WHERE p.singleton
          `;
          modeStrict = pol?.[0]?.strict ?? null;
        } catch {
          modeStrict = null;
        }
      }
      if (ligne) {
        baseIdentite = {
          table_presente: ligne.vue_to_regclass,
          table_vue_par_pg_class: ligne.vue_pg_class,
          rls_forcee: ligne.rls_forcee,
          mode_strict: modeStrict,
        };
      }
    } catch {
      baseIdentite = null;
    }
  }

  const jetonsSysteme = {
    // Meme cle que `identityTokens` : deux variables distinctes pour la meme
    // valeur seraient deux occasions de les faire diverger.
    configured: etatSysteme === 'valide',
    mode: etatSysteme === 'valide' ? 'signe' : etatSysteme === 'invalide' ? 'cle_invalide' : 'non_configure',
    usage: 'tracefab_system',
    // `null` = non mesuree (et non « fausse ») : le champ n'est renseigne que
    // sur demande (`?identity=1`), pour ne pas interroger la base a chaque
    // passage d'une sonde de supervision.
    verifiee_par_la_base: verificationBase,
    verification: verificationDetail,
  };

  const databaseIdentity = wantIdentity ? await probeDatabaseIdentity() : undefined;

  // P10.7 — verification reelle de l'outbox sous contexte systeme signe.
  // Lecture seule : aucun element n'est reclame, modifie, ni envoye.
  let notificationOutbox: { verified: boolean; detail: string; health?: OutboxHealthRow } | undefined;
  if (req.query?.outbox === '1' && wantIdentity) {
    try {
      const rows = await withTracefabWorkerContext((tx) => tx.$queryRaw<OutboxHealthRow[]>`
        SELECT * FROM tracefab_notification_outbox_health()
      `);
      notificationOutbox = {
        verified: true,
        detail: 'aller_retour_reussi',
        health: rows[0] ?? {
          pending: 0, processing: 0, sent: 0, failed: 0, ready: 0,
          staleProcessing: 0, exhausted: 0, oldestReadyAt: null,
        },
      };
    } catch (error) {
      notificationOutbox = {
        verified: false,
        detail: error instanceof Error && /42501|authentication_required/.test(error.message)
          ? 'identite_systeme_refusee'
          : 'sonde_en_erreur',
      };
    }
  }
  // En mode diagnostic, la readiness est rouge tant que l'identité effective
  // ne prouve pas le rôle applicatif sans privilèges de contournement RLS.
  const identitySafe = !wantIdentity || databaseIdentityIsSafe(databaseIdentity);

  // POURQUOI UN MOTIF, ET POURQUOI MAINTENANT
  //
  // Mesure du run 44074983675 (SHA c0f8d6f) : la sonde authentifiee rendait 503.
  // Le corps tronque ne permettait pas de savoir si le refus venait de la
  // CONFIGURATION (`configured_`) ou de l'IDENTITE (`identitySafe`). Deux
  // causes, deux corrections opposees : on ne peut pas les confondre.
  //
  // `ecartIdentiteRuntime` ne rend que des ecarts lisibles — noms de roles,
  // drapeaux booleens — jamais une cle, un mot de passe ni une URL. Il n'est
  // expose que derriere l'authentification de sonde deja exigee ci-dessus, et
  // seulement quand l'identite est ROUGE : un feu vert n'a pas a se justifier.
  const identiteEcarts = wantIdentity && !identitySafe ? ecartIdentiteRuntime(databaseIdentity) : undefined;

  if (!live) {
    return json(res, configured_ && identitySafe ? 200 : 503, {
      schema: 'tracefab-p2-readiness-v1',
      ready: configured_ && identitySafe,
      configurationOnly: true,
      configurationSuffisante: configured_,
      identiteSaine: identitySafe,
      ...(identiteEcarts ? { identiteEcarts } : {}),
      services,
      identityTokens: jetonsIdentite,
      identitySysteme: jetonsSysteme,
      ...(baseIdentite ? { baseIdentite } : {}),
      ...(databaseIdentity ? { databaseIdentity } : {}),
      ...(notificationOutbox ? { notificationOutbox } : {}),
    });
  }

  const probes = await runLiveProbes();
  // Le collecteur d'erreurs est souhaitable, pas bloquant : son absence degrade
  // l'exploitation, elle n'empeche pas de servir.
  // Alerting is optional: a missing or unreachable collector degrades
  // observability but must not block document, identity, or email workflows.
  const blocking = [probes.database, probes.privateStorage, probes.antivirus, probes.email];
  const ready = configured_ && blocking.every((probe) => probe.reachable) && identitySafe;
  return json(res, ready ? 200 : 503, {
    schema: 'tracefab-p2-readiness-v1',
    ready,
    configurationOnly: false,
    services,
    probes,
    identityTokens: jetonsIdentite,
    identitySysteme: jetonsSysteme,
    ...(baseIdentite ? { baseIdentite } : {}),
    ...(databaseIdentity ? { databaseIdentity } : {}),
    ...(notificationOutbox ? { notificationOutbox } : {}),
  });
}
