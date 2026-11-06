import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { emailDeliveryConfigured } from '../../_lib/email.js';
import { notificationAlertConfigured } from '../../_lib/notification-observability.js';
import { storageConfig } from '../../_lib/storage.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { workerAuthorized, workerSecretConfigured } from '../../_lib/worker-auth.js';
import { databaseIdentityIsSafe, probeDatabaseIdentity, runLiveProbes } from '../../_lib/readiness-probes.js';
import { etatCleIdentite } from '../../_lib/identite-jeton.js';
import { prisma } from '../../_lib/prisma.js';
import { etatCleSysteme, signerIdentiteSysteme } from '../../_lib/identite-systeme.js';

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
  if (!workerSecretConfigured()) return json(res, 503, { error: 'worker_not_configured' });
  if (!workerAuthorized(req)) return json(res, 401, { error: 'worker_unauthorized' });

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
  const configured_ = Object.values(services).every((service) => service.configured);

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
  // En mode diagnostic, la readiness est rouge tant que l'identité effective
  // ne prouve pas le rôle applicatif sans privilèges de contournement RLS.
  const identitySafe = !wantIdentity || databaseIdentityIsSafe(databaseIdentity);

  if (!live) {
    return json(res, configured_ && identitySafe ? 200 : 503, {
      schema: 'tracefab-p2-readiness-v1',
      ready: configured_ && identitySafe,
      configurationOnly: true,
      services,
      identityTokens: jetonsIdentite,
      identitySysteme: jetonsSysteme,
      ...(databaseIdentity ? { databaseIdentity } : {}),
    });
  }

  const probes = await runLiveProbes();
  // Le collecteur d'erreurs est souhaitable, pas bloquant : son absence degrade
  // l'exploitation, elle n'empeche pas de servir.
  const blocking = [probes.database, probes.privateStorage, probes.antivirus, probes.email, probes.alerting];
  const ready = configured_ && blocking.every((probe) => probe.reachable) && identitySafe;
  return json(res, ready ? 200 : 503, {
    schema: 'tracefab-p2-readiness-v1',
    ready,
    configurationOnly: false,
    services,
    probes,
    identityTokens: jetonsIdentite,
    identitySysteme: jetonsSysteme,
    ...(databaseIdentity ? { databaseIdentity } : {}),
  });
}
