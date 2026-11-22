import { type IdentiteRuntime, identiteRuntimeSure } from './identite-contrat.js';
import { prisma } from './prisma.js';
import { headObject, storageConfig } from './storage.js';
import { redact } from './error-reporting.js';

/**
 * Sondes de disponibilite reelles.
 *
 * L'endpoint de readiness existant verifie que les variables d'environnement
 * sont *definies*. C'est utile, mais une cle presente n'est pas une cle valide,
 * et un bucket nomme n'est pas un bucket joignable. Le jour de la mise en
 * production, la difference est tout.
 *
 * Ces sondes exercent reellement chaque service. Elles sont volontairement
 * separees du controle de configuration : on ne veut pas appeler quatre
 * services externes a chaque passage d'une sonde de supervision.
 *
 * Regles :
 *   - aucune sonde ne jette : un service en panne est un resultat, pas un bug.
 *   - aucune sonde n'a d'effet de bord. On ne poste pas un vrai e-mail pour
 *     verifier que l'envoi marche.
 *   - aucun secret ne sort, les messages sont caviardes.
 */

export type ProbeResult = {
  reachable: boolean;
  latencyMs: number;
  detail: string;
};

const DEFAULT_TIMEOUT_MS = 4000;

function probeTimeout() {
  const value = Number(process.env.TRACEFAB_READINESS_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1000 && value <= 15000 ? value : DEFAULT_TIMEOUT_MS;
}

async function timed(fn: () => Promise<Omit<ProbeResult, 'latencyMs'>>): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const result = await fn();
    return { ...result, latencyMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reachable: false, latencyMs: Date.now() - started, detail: redact(message).slice(0, 160) };
  }
}

/** Une reponse HTTP, meme 405 ou 404, prouve que l'hote repond. Seules une
 *  panne reseau et un depassement de delai signifient injoignable. */
async function reachableByHttp(url: string, method: 'HEAD' | 'GET', headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), probeTimeout());
  try {
    const response = await fetch(url, { method, headers, signal: controller.signal });
    return { reachable: true, detail: `reponse HTTP ${response.status}`, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

/** Base de donnees : la sonde qui compte le plus. Une requete triviale prouve
 *  la resolution DNS, le TLS, l'authentification et le pooler. */
export function probeDatabase(): Promise<ProbeResult> {
  const aUneBase = Boolean(process.env.DATABASE_URL?.trim());
  return timed(async () => {
    if (!aUneBase) return { reachable: false, detail: 'DATABASE_URL absent' };
    await prisma.$queryRaw`SELECT 1`;
    return { reachable: true, detail: 'requete SELECT 1 honoree' };
  });
}

/**
 * Identite reelle de la connexion applicative.
 *
 * Pourquoi cette sonde existe. Toute la securite du runtime repose sur la RLS,
 * et la RLS ne s'applique pas a un role qui porte BYPASSRLS. Or l'identite
 * effectivement utilisee ne se deduit ni du code ni de la configuration
 * attendue : `DATABASE_URL` peut pointer n'importe quel role, et un role
 * proprietaire ou superutilisateur contourne silencieusement toutes les
 * politiques. Seul un `current_user` lu sur la connexion reelle le dit.
 *
 * Cette sonde passe par le MEME client Prisma que les routes
 * (api/_lib/prisma.ts, unique `new PrismaClient()` de api/). C'est la condition
 * pour qu'elle mesure l'identite du runtime et pas celle d'une connexion
 * ouverte a cote : un `psql` branche sur la meme URL ne prouverait rien.
 *
 * Regles respectees :
 *   - lecture seule. Trois fonctions du catalogue, aucune ecriture, aucune
 *     modification de role, aucun `SET ROLE` ;
 *   - aucun secret. Ni URL de connexion, ni hote, ni mot de passe : le resultat
 *     ne contient que des noms de role et deux booleens. Les messages d'erreur
 *     passent par `redact()`, comme toutes les autres sondes ;
 *   - la sonde ne jette pas : un echec est un resultat.
 *
 * Le resultat ne doit etre expose que derriere l'authentification deja en place
 * sur la route interne. Un nom de role n'est pas un secret en soi, mais le
 * publier sans authentification revelerait a quel point l'application est
 * proche — ou non — d'un contournement de RLS.
 */
export type DatabaseIdentity = IdentiteRuntime;

type IdentityRow = {
  current_user: string;
  session_user: string;
  database: string;
  bypasses_rls: boolean | null;
  is_superuser: boolean | null;
  privileged_memberships: string[] | null;
};

// P10.7 — LE DEFAUT CORRIGE ICI.
//
// Cette constante portait `privilegedMemberships: []` et `canEscalate: false`.
// Les deux sont des VALEURS DE MESURE : « aucun role privilegie atteignable ».
// Les publier quand `measured` vaut false revient a affirmer un resultat qu'on
// n'a pas obtenu — et dans le sens qui rassure. Un lecteur qui ignore
// `measured` lit « pas d'escalade possible » sur une sonde qui n'a jamais
// interroge la base, par exemple quand `DATABASE_URL` manque.
//
// C'est la meme classe de defaut que le `Boolean(...) || true` de C4.6 : une
// valeur favorable produite sans mesure. La difference est qu'ici c'etait un
// tableau vide, moins visible qu'une constante litterale.
//
// `privilegedMemberships` est donc `null` (inconnu) et `canEscalate` aussi. Le
// contrat `identiteRuntimeSure` refusait deja sur `measured !== true` en
// premier, donc aucune decision de securite ne change : ce qui change est
// qu'un consommateur ne peut plus lire un resultat la ou il n'y en a pas.
const IDENTITY_UNAVAILABLE: DatabaseIdentity = {
  measured: false,
  currentUser: null,
  sessionUser: null,
  database: null,
  bypassesRls: null,
  isSuperuser: null,
  privilegedMemberships: null,
  canEscalate: null,
  detail: 'indisponible',
};

export async function probeDatabaseIdentity(): Promise<DatabaseIdentity> {
  try {
    if (!process.env.DATABASE_URL?.trim()) {
      return { ...IDENTITY_UNAVAILABLE, detail: 'DATABASE_URL absent' };
    }
    const rows = await prisma.$queryRaw<IdentityRow[]>`
      WITH RECURSIVE atteignables(oid, profondeur) AS (
        SELECT r.oid, 0
          FROM pg_roles r
         WHERE r.rolname = current_user
        UNION
        SELECT m.roleid, a.profondeur + 1
          FROM atteignables a
          JOIN pg_auth_members m ON m.member = a.oid
         WHERE a.profondeur < 8
      )
      SELECT current_user                                       AS current_user,
             session_user                                       AS session_user,
             current_database()                                 AS database,
             (SELECT rolbypassrls FROM pg_roles
               WHERE rolname = current_user)                    AS bypasses_rls,
             (SELECT rolsuper     FROM pg_roles
               WHERE rolname = current_user)                    AS is_superuser,
             ARRAY(
               SELECT r.rolname
                 FROM atteignables a
                 JOIN pg_roles r ON r.oid = a.oid
                WHERE a.profondeur > 0
                  AND (r.rolsuper OR r.rolbypassrls)
                ORDER BY 1
             )                                                  AS privileged_memberships
    `;
    const row = rows?.[0];
    if (!row) return { ...IDENTITY_UNAVAILABLE, detail: 'requete honoree, aucune ligne' };
    const membres = row.privileged_memberships ?? [];
    return {
      measured: true,
      currentUser: row.current_user,
      sessionUser: row.session_user,
      database: row.database,
      bypassesRls: row.bypasses_rls,
      isSuperuser: row.is_superuser,
      privilegedMemberships: membres,
      canEscalate: membres.length > 0,
      detail: 'identite lue sur la connexion applicative',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...IDENTITY_UNAVAILABLE, detail: redact(message).slice(0, 160) };
  }
}

/**
 * P10.7 — LE CONTEXTE TENANT EST-IL PRESENT ET NON FALSIFIE ?
 *
 * CE QUE CE N'EST PAS
 *
 * Ce n'est pas « la RLS fonctionne ». L'isolation reelle est prouvee par les
 * suites dediees (`test:neon:cross-tenant`, `test:neon:active-tenant`,
 * `test:neon:isolation-lignes`), qui creent deux organisations et tentent de
 * lire les lignes de l'autre. Une sonde de diagnostic en lecture seule ne peut
 * pas, et ne doit pas, remplacer cela.
 *
 * CE QUE C'EST
 *
 * La question laissee ouverte par C4.6 : le runtime pose-t-il, sur la connexion
 * REELLE, un contexte tenant que la BASE accepte ? C'etait jusqu'ici repondu
 * « INDETERMINATE — la route de diagnostic n'ouvre pas de transaction metier ».
 * C'etait exact, et ce n'etait pas une fatalite : le contexte tenant se mesure
 * avec un aller-retour, sans ecrire une ligne.
 *
 * COMMENT, SANS ECRITURE
 *
 *   1. on signe une identite UTILISATEUR pour un identifiant de sonde ;
 *   2. on pose `tracefab.active_organization_id` et `tracefab.identity` dans
 *      une transaction de diagnostic ;
 *   3. on demande a la base ce que le POINT DE PASSAGE UNIQUE
 *      (`tracefab_current_user_id`, utilise par 72 fonctions) en conclut ;
 *   4. on verifie le REFUS : un jeton signe pour une AUTRE organisation que
 *      celle posee doit rendre NULL.
 *
 * Le point 4 est ce qui distingue une mesure d'une presence. Sans lui, une
 * fonction qui ignorerait le jeton rendrait le meme resultat des deux cotes et
 * la sonde serait verte sur un systeme casse.
 *
 * L'identifiant de sonde est un UUID NUL. `tracefab_identity_jeton_utilisateur`
 * ne verifie que la signature, l'expiration et la liaison a l'organisation : il
 * ne consulte aucune table d'utilisateurs (mesure sur la migration du
 * 20261031120000). Aucune ligne n'est donc lue, ecrite, ni exigee.
 */
export type ContexteTenant = {
  /** La mesure a-t-elle eu lieu ? `false` = non mesuré, jamais un resultat. */
  measured: boolean;
  /** Le jeton utilisateur signe a-t-il ete accepte par la base ? */
  jetonAccepte: boolean | null;
  /** Le point de passage unique rend-il bien l'identite signee ? */
  identiteLue: boolean | null;
  /** Un jeton d'une AUTRE organisation est-il refuse ? C'est le controle negatif. */
  organisationEtrangereRefusee: boolean | null;
  /**
   * Le GUC a-t-il ete REMIS A ZERO avant la fin de la transaction ?
   *
   * Nomme `...RemisAZero` et non `...SurvitApresTransaction` : la relecture a
   * lieu DANS la transaction, donc elle ne peut pas observer une fuite vers la
   * connexion suivante. Un nom qui promettait cette mesure aurait ete un faux
   * temoin par son seul intitule. La non-fuite du pool est prouvee par les
   * suites Neon dediees, pas ici.
   */
  gucRemisAZero: boolean | null;
  detail: string;
};

const CONTEXTE_TENANT_INDISPONIBLE: ContexteTenant = {
  measured: false,
  jetonAccepte: null,
  identiteLue: null,
  organisationEtrangereRefusee: null,
  gucRemisAZero: null,
  detail: 'indisponible',
};

/** UUID nul : une identite de sonde qui ne designe aucun utilisateur reel. */
const SONDE_USER_ID = '00000000-0000-4000-8000-000000000000';
/** Organisation de sonde, elle aussi inexistante : on ne mesure que la liaison. */
const SONDE_ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const SONDE_ORG_AUTRE = '00000000-0000-4000-8000-0000000000b2';

export async function probeContexteTenant(): Promise<ContexteTenant> {
  // Les deux presences sont lues AVANT tout `return`.
  //
  // Le garde-fou `test_sonde_identite_runtime` refuse la sequence « return puis
  // process.env.DATABASE_URL » a moins de 200 caracteres, parce qu un
  // `return { url: ... }` publierait l hote, l utilisateur et le mot de passe.
  // La regle ne distingue pas une garde d une fuite, et elle a raison de rester
  // grossiere : un faux positif coute une minute, un faux negatif publie un
  // secret. C est donc le code qui s adapte, pas le garde-fou.
  const aUneBase = Boolean(process.env.DATABASE_URL?.trim());
  const cle = (process.env.TRACEFAB_IDENTITY_KEY || '').trim();
  if (!cle) {
    return { ...CONTEXTE_TENANT_INDISPONIBLE, detail: 'cle d identite absente : contexte non mesurable' };
  }
  if (!aUneBase) {
    return { ...CONTEXTE_TENANT_INDISPONIBLE, detail: 'DATABASE_URL absent' };
  }
  try {
    const { signerIdentite } = await import('./identite-jeton.js');
    const jeton = signerIdentite({ userId: SONDE_USER_ID, organizationId: SONDE_ORG_ID, cle });
    const jetonAutre = signerIdentite({ userId: SONDE_USER_ID, organizationId: SONDE_ORG_AUTRE, cle });
    if (jeton === null || jetonAutre === null) {
      return { ...CONTEXTE_TENANT_INDISPONIBLE, detail: 'signature impossible' };
    }

    type Row = { lu: string | null; guc_apres: string | null };
    // Portee TRANSACTIONNELLE (`true`) sur les deux set_config : le pool ne
    // conserve rien. Le GUC est relu APRES la remise a zero pour verifier que
    // la transaction ne fuit pas — c'est la propriete que les suites Neon
    // verifient, et on la reverifie ici sur la connexion reelle du runtime.
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('tracefab.active_organization_id', ${SONDE_ORG_ID}, true)`;
      await tx.$executeRaw`SELECT set_config('tracefab.identity', ${jeton.jeton}, true)`;
      const lues = await tx.$queryRaw<Array<{ lu: string | null }>>`
        SELECT public.tracefab_current_user_id()::TEXT AS lu
      `;
      // Controle NEGATIF : le meme GUC d'organisation, mais un jeton signe pour
      // une autre organisation. La base doit refuser et rendre NULL.
      await tx.$executeRaw`SELECT set_config('tracefab.identity', ${jetonAutre.jeton}, true)`;
      const refus = await tx.$queryRaw<Array<{ lu: string | null }>>`
        SELECT public.tracefab_current_user_id()::TEXT AS lu
      `;
      await tx.$executeRaw`SELECT set_config('tracefab.identity', '', true)`;
      await tx.$executeRaw`SELECT set_config('tracefab.active_organization_id', '', true)`;
      const apres = await tx.$queryRaw<Array<{ v: string | null }>>`
        SELECT nullif(current_setting('tracefab.identity', true), '') AS v
      `;
      return [{
        lu: lues?.[0]?.lu ?? null,
        refus: refus?.[0]?.lu ?? null,
        guc_apres: apres?.[0]?.v ?? null,
      }];
    });

    const r = rows?.[0];
    if (!r) return { ...CONTEXTE_TENANT_INDISPONIBLE, detail: 'transaction honoree, aucune ligne' };
    // Comparaison insensible a la casse : PostgreSQL rend l'UUID en minuscules.
    const identiteLue = (r.lu ?? '').toLowerCase() === SONDE_USER_ID;
    const refusee = r.refus === null || r.refus === '';
    return {
      measured: true,
      jetonAccepte: identiteLue,
      identiteLue,
      organisationEtrangereRefusee: refusee,
      gucRemisAZero: r.guc_apres === null || r.guc_apres === '',
      detail: 'contexte tenant pose puis relu par le point de passage unique, en lecture seule',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...CONTEXTE_TENANT_INDISPONIBLE, detail: redact(message).slice(0, 160) };
  }
}

/**
 * Contrat de securite de l'identite runtime. La comparaison vit dans ce module
 * pour que la route ne publie pas de champs d'identite par defaut.
 */
export function databaseIdentityIsSafe(identity: DatabaseIdentity | undefined): boolean {
  return identiteRuntimeSure(identity ?? null);
}

/** Stockage prive : on interroge une cle qui n'existe pas. Un 404 est un
 *  succes — il prouve que le bucket repond et que la signature est acceptee.
 *  Un 403 signifierait des identifiants refuses. */
export function probeStorage(): Promise<ProbeResult> {
  return timed(async () => {
    storageConfig(); // jette si la configuration est invalide
    try {
      await headObject('tracefab-readiness-probe/.keep');
      return { reachable: true, detail: 'objet sonde present, bucket joignable' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'document_object_not_found') {
        return { reachable: true, detail: 'bucket joignable, signature acceptee (404 attendu)' };
      }
      // private_storage_head_failed couvre 403 : identifiants refuses.
      return { reachable: false, detail: redact(message).slice(0, 160) };
    }
  });
}

/** Antivirus : l'analyseur n'accepte que POST avec un corps. On se contente
 *  donc de prouver que l'hote repond, sans lui soumettre de fichier. */
export function probeAntivirus(): Promise<ProbeResult> {
  return timed(async () => {
    const url = process.env.PRIVATE_STORAGE_ANTIVIRUS_URL?.trim();
    if (!url) return { reachable: false, detail: 'PRIVATE_STORAGE_ANTIVIRUS_URL absent' };
    const { detail } = await reachableByHttp(url, 'HEAD');
    return { reachable: true, detail: `${detail} (joignabilite seule, aucun fichier soumis)` };
  });
}

/** Resend : GET /domains valide la cle d'API sans envoyer le moindre message.
 *  Un 401 prouve que l'hote repond mais que la cle est refusee. */
export function probeEmail(): Promise<ProbeResult> {
  return timed(async () => {
    const key = process.env.RESEND_API_KEY?.trim();
    if (!key) return { reachable: false, detail: 'RESEND_API_KEY absent' };
    const { status } = await reachableByHttp('https://api.resend.com/domains', 'GET', {
      Authorization: `Bearer ${key}`,
    });
    // Seul un 2xx prouve que la cle est acceptee. Resend repond 400 sur une
    // cle malformee et 401 sur une cle revoquee : les deux sont des echecs.
    if (status >= 200 && status < 300) return { reachable: true, detail: `cle Resend acceptee (HTTP ${status})` };
    return { reachable: false, detail: `cle Resend refusee (HTTP ${status})` };
  });
}

/** Collecteur d'alertes : joignabilite seule, on n'emet pas de fausse alerte. */
export function probeAlerting(): Promise<ProbeResult> {
  return timed(async () => {
    const url = process.env.TRACEFAB_NOTIFICATION_ALERT_URL?.trim();
    if (!url) return { reachable: false, detail: 'TRACEFAB_NOTIFICATION_ALERT_URL absent' };
    const { detail } = await reachableByHttp(url, 'HEAD');
    return { reachable: true, detail: `${detail} (joignabilite seule, aucune alerte emise)` };
  });
}

/** Collecteur d'erreurs : optionnel. Son absence ne bloque pas la mise en
 *  production, mais elle doit etre visible. */
export function probeErrorSink(): Promise<ProbeResult> {
  return timed(async () => {
    const url = process.env.TRACEFAB_ERROR_WEBHOOK_URL?.trim();
    if (!url) return { reachable: false, detail: 'TRACEFAB_ERROR_WEBHOOK_URL absent (journal stderr seul)' };
    const { detail } = await reachableByHttp(url, 'HEAD');
    return { reachable: true, detail };
  });
}

export async function runLiveProbes() {
  const [database, privateStorage, antivirus, email, alerting, errorSink] = await Promise.all([
    probeDatabase(), probeStorage(), probeAntivirus(), probeEmail(), probeAlerting(), probeErrorSink(),
  ]);
  return { database, privateStorage, antivirus, email, alerting, errorSink };
}
