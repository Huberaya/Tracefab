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
  return timed(async () => {
    if (!process.env.DATABASE_URL?.trim()) return { reachable: false, detail: 'DATABASE_URL absent' };
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
export type DatabaseIdentity = {
  measured: boolean;
  currentUser: string | null;
  sessionUser: string | null;
  database: string | null;
  bypassesRls: boolean | null;
  isSuperuser: boolean | null;
  /** Attributs de role lus dans pg_roles pour le role EFFECTIF. */
  canLogin: boolean | null;
  canCreateRole: boolean | null;
  canCreateDb: boolean | null;
  canReplicate: boolean | null;
  inheritsPrivileges: boolean | null;
  /** `row_security` du serveur tel que la connexion le voit : `on` attendu. */
  rowSecurityGuc: string | null;
  /** Appartenance a un role porteur de SUPERUSER ou BYPASSRLS. */
  privilegedMemberships: number | null;
  privilegedMembershipNames: string[];
  /** Propriete d'objet : un proprietaire echappe a la RLS sans FORCE. */
  ownsProductTable: boolean | null;
  rlsEnabledOnProducts: boolean | null;
  rlsForcedOnProducts: boolean | null;
  canSelectProducts: boolean | null;
  canWriteProducts: boolean | null;
  /**
   * Ecriture directe sur les tables qui ne doivent passer que par des
   * fonctions SECURITY DEFINER (`dpp_lifecycle_events`, append-only) ou qui
   * appartiennent au plan de controle des migrations (`_prisma_migrations`).
   * `true` = privilege excessif : ces tables sont REVOKE au bootstrap.
   */
  canWriteDppEvents: boolean | null;
  canWriteMigrationsLedger: boolean | null;
  canCreateInDatabase: boolean | null;
  canCreateInSchema: boolean | null;
  /**
   * La mesure qui tranche, et qui ne se lit pas dans une configuration :
   * nombre de lignes de `tracefab_products` visibles SANS aucun contexte arme.
   * Sous un role soumis a la RLS et sans contexte, la reponse est 0 — quelle
   * que soit la donnee. Une valeur non nulle prouve que les politiques ne sont
   * pas evaluees pour ce role.
   */
  rowsVisibleWithoutContext: number | null;
  detail: string;
};

type IdentityRow = {
  can_write_dpp_events: boolean | null;
  can_write_migrations_ledger: boolean | null;
  current_user: string;
  session_user: string;
  database: string;
  bypasses_rls: boolean | null;
  is_superuser: boolean | null;
  can_login: boolean | null;
  can_create_role: boolean | null;
  can_create_db: boolean | null;
  can_replicate: boolean | null;
  inherits_privileges: boolean | null;
  row_security_guc: string | null;
  privileged_memberships: number | null;
  privileged_membership_names: string | null;
  owns_product_table: boolean | null;
  rls_enabled_on_products: boolean | null;
  rls_forced_on_products: boolean | null;
  can_select_products: boolean | null;
  can_write_products: boolean | null;
  can_create_in_database: boolean | null;
  can_create_in_schema: boolean | null;
};

const IDENTITY_UNAVAILABLE: DatabaseIdentity = {
  measured: false,
  currentUser: null,
  sessionUser: null,
  database: null,
  bypassesRls: null,
  isSuperuser: null,
  canLogin: null,
  canCreateRole: null,
  canCreateDb: null,
  canReplicate: null,
  inheritsPrivileges: null,
  rowSecurityGuc: null,
  privilegedMemberships: null,
  privilegedMembershipNames: [],
  ownsProductTable: null,
  rlsEnabledOnProducts: null,
  rlsForcedOnProducts: null,
  canSelectProducts: null,
  canWriteProducts: null,
  canWriteDppEvents: null,
  canWriteMigrationsLedger: null,
  canCreateInDatabase: null,
  canCreateInSchema: null,
  rowsVisibleWithoutContext: null,
  detail: 'indisponible',
};

/**
 * Mesure decisive : ce que ce role VOIT sans aucun contexte arme.
 *
 * `LIMIT 1` derive : la question n'est pas « combien de lignes » mais « en
 * voit-il au moins une ». Un `count(*)` complet sur une table de production
 * serait un cout sans gain d'information.
 *
 * Absence de la table = mesure impossible, pas echec : on renvoie null.
 */
async function countRowsVisibleWithoutContext(): Promise<number | null> {
  try {
    const rows = await prisma.$queryRaw<{ visible: number }[]>`
      SELECT count(*)::int AS visible
        FROM (SELECT 1 FROM public.tracefab_products LIMIT 1) AS visible_rows
    `;
    return rows?.[0]?.visible ?? null;
  } catch {
    return null;
  }
}

export async function probeDatabaseIdentity(): Promise<DatabaseIdentity> {
  try {
    if (!process.env.DATABASE_URL?.trim()) {
      return { ...IDENTITY_UNAVAILABLE, detail: 'DATABASE_URL absent' };
    }
    /*
     * Requete d'attributs — STRICTEMENT en lecture.
     *
     * Chaque expression est gardee par `CASE WHEN to_regclass(...) IS NOT NULL` :
     * une base plus ancienne ou une table absente ne doit pas faire echouer la
     * mesure entiere et transformer une identite en « indisponible ».
     *
     * `session_user` n'est pas un doublon de `current_user` : si un `SET ROLE`
     * etait present (pooler, middleware, code applicatif), les deux divergeraient.
     * Le depot n'en contient aucun — c'est verifie statiquement — donc les deux
     * doivent etre egaux ; s'ils divergent, quelque chose agit entre la connexion
     * et la requete, et la mesure doit le dire plutot que de le masquer.
     */
    const rows = await prisma.$queryRaw<IdentityRow[]>`
  WITH attributs AS (
    SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin, r.rolcreaterole,
           r.rolcreatedb, r.rolreplication, r.rolinherit, r.oid
      FROM pg_roles r
     WHERE r.rolname = current_user
  ),
  membres AS (
    SELECT (count(*) FILTER (WHERE r.rolsuper OR r.rolbypassrls))::int AS nombre,
           coalesce(string_agg(r.rolname::text, ',' ORDER BY r.rolname)
                    FILTER (WHERE r.rolsuper OR r.rolbypassrls), '') AS noms
      FROM pg_roles r, attributs a
     WHERE r.oid <> a.oid
       -- Adhesion DIRECTE ou INDIRECTE. La surcharge (oid, oid, text) est la
       -- seule exacte ici : passer current_user (type name) ne resoudrait
       -- aucune fonction et ferait echouer la mesure entiere.
       AND pg_has_role(a.oid, r.oid, 'MEMBER')
  )
  SELECT current_user                                        AS current_user,
         session_user                                        AS session_user,
         current_database()                                  AS database,
         (SELECT rolsuper      FROM attributs)               AS is_superuser,
         (SELECT rolbypassrls  FROM attributs)               AS bypasses_rls,
         (SELECT rolcanlogin   FROM attributs)               AS can_login,
         (SELECT rolcreaterole FROM attributs)               AS can_create_role,
         (SELECT rolcreatedb   FROM attributs)               AS can_create_db,
         (SELECT rolreplication FROM attributs)              AS can_replicate,
         (SELECT rolinherit    FROM attributs)               AS inherits_privileges,
         current_setting('row_security', true)               AS row_security_guc,
         (SELECT nombre FROM membres)                        AS privileged_memberships,
         (SELECT noms   FROM membres)                        AS privileged_membership_names,
         CASE WHEN to_regclass('public.tracefab_products') IS NULL THEN NULL
              ELSE (SELECT c.relowner = a.oid
                      FROM pg_class c, attributs a
                     WHERE c.oid = to_regclass('public.tracefab_products'))
         END                                                 AS owns_product_table,
         CASE WHEN to_regclass('public.tracefab_products') IS NULL THEN NULL
              ELSE (SELECT c.relrowsecurity FROM pg_class c
                     WHERE c.oid = to_regclass('public.tracefab_products'))
         END                                                 AS rls_enabled_on_products,
         CASE WHEN to_regclass('public.tracefab_products') IS NULL THEN NULL
              ELSE (SELECT c.relforcerowsecurity FROM pg_class c
                     WHERE c.oid = to_regclass('public.tracefab_products'))
         END                                                 AS rls_forced_on_products,
         CASE WHEN to_regclass('public.tracefab_products') IS NULL THEN NULL
              ELSE has_table_privilege(current_user, 'public.tracefab_products', 'SELECT')
         END                                                 AS can_select_products,
         CASE WHEN to_regclass('public.tracefab_products') IS NULL THEN NULL
              ELSE (has_table_privilege(current_user, 'public.tracefab_products', 'INSERT')
                 OR has_table_privilege(current_user, 'public.tracefab_products', 'UPDATE')
                 OR has_table_privilege(current_user, 'public.tracefab_products', 'DELETE'))
         END                                                 AS can_write_products,
         CASE WHEN to_regclass('public.dpp_lifecycle_events') IS NULL THEN NULL
              ELSE (has_table_privilege(current_user, 'public.dpp_lifecycle_events', 'INSERT')
                 OR has_table_privilege(current_user, 'public.dpp_lifecycle_events', 'UPDATE')
                 OR has_table_privilege(current_user, 'public.dpp_lifecycle_events', 'DELETE'))
         END                                                 AS can_write_dpp_events,
         CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN NULL
              ELSE (has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT')
                 OR has_table_privilege(current_user, 'public._prisma_migrations', 'UPDATE')
                 OR has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE'))
         END                                                 AS can_write_migrations_ledger,
         has_database_privilege(current_user, current_database(), 'CREATE')  AS can_create_in_database,
         has_schema_privilege(current_user, 'public', 'CREATE')               AS can_create_in_schema
`;
    const row = rows?.[0];
    if (!row) return { ...IDENTITY_UNAVAILABLE, detail: 'requete honoree, aucune ligne' };
    const visible = await countRowsVisibleWithoutContext();
    const noms = String(row.privileged_membership_names || '')
      .split(',')
      .map((nom) => nom.trim())
      .filter(Boolean)
      // Un nom de role n'est pas un secret, mais la reponse est publique des
      // qu'elle sort de l'authentification : on borne ce qui est publie.
      .slice(0, 8);
    return {
      measured: true,
      currentUser: row.current_user,
      sessionUser: row.session_user,
      database: row.database,
      bypassesRls: row.bypasses_rls,
      isSuperuser: row.is_superuser,
      canLogin: row.can_login,
      canCreateRole: row.can_create_role,
      canCreateDb: row.can_create_db,
      canReplicate: row.can_replicate,
      inheritsPrivileges: row.inherits_privileges,
      rowSecurityGuc: row.row_security_guc,
      privilegedMemberships: row.privileged_memberships,
      privilegedMembershipNames: noms,
      ownsProductTable: row.owns_product_table,
      rlsEnabledOnProducts: row.rls_enabled_on_products,
      rlsForcedOnProducts: row.rls_forced_on_products,
      canSelectProducts: row.can_select_products,
      canWriteProducts: row.can_write_products,
      canWriteDppEvents: row.can_write_dpp_events,
      canWriteMigrationsLedger: row.can_write_migrations_ledger,
      canCreateInDatabase: row.can_create_in_database,
      canCreateInSchema: row.can_create_in_schema,
      rowsVisibleWithoutContext: visible,
      detail: 'identite lue sur la connexion applicative',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...IDENTITY_UNAVAILABLE, detail: redact(message).slice(0, 160) };
  }
}

/**
 * Ecarts au contrat de securite, nommes un par un.
 *
 * La liste est separee du verdict pour deux raisons : un echec doit dire QUOI,
 * et un rapport doit pouvoir distinguer « role permissif » de « identite non
 * mesuree ». Une violation n'est jamais devinee : chaque entree correspond a
 * une mesure de la reponse precedente.
 */
export function databaseIdentityViolations(identity: DatabaseIdentity | undefined): string[] {
  if (!identity?.measured) return [`identite_non_mesuree:${identity?.detail ?? 'inconnue'}`];
  const violations: string[] = [];
  if (identity.currentUser !== 'tracefab_app') {
    violations.push(`role_courant_${identity.currentUser ?? 'inconnu'}_different_de_tracefab_app`);
  }
  if (identity.sessionUser !== 'tracefab_app') {
    violations.push(`role_de_session_${identity.sessionUser ?? 'inconnu'}_different_de_tracefab_app`);
  }
  if (identity.bypassesRls !== false) violations.push('role_porte_bypassrls');
  if (identity.isSuperuser !== false) violations.push('role_superutilisateur');
  if (identity.canCreateDb !== false) violations.push('privilege_createdb');
  if (identity.canCreateRole !== false) violations.push('privilege_createrole');
  if (identity.canReplicate !== false) violations.push('privilege_replication');
  if ((identity.privilegedMemberships ?? 0) > 0) {
    violations.push(`membre_d_un_role_privilegie:${identity.privilegedMembershipNames.join('+') || 'non_nomme'}`);
  }
  if (identity.rowsVisibleWithoutContext !== 0) {
    violations.push('lignes_visibles_sans_contexte_arme');
  }
  if (identity.rowSecurityGuc !== null && identity.rowSecurityGuc !== 'on') {
    violations.push(`row_security_${identity.rowSecurityGuc}`);
  }
  if (identity.rlsEnabledOnProducts === false) violations.push('rls_desactivee_sur_tracefab_products');
  // Ecriture directe la ou le modele impose une fonction SECURITY DEFINER, ou
  // sur le registre des migrations : c'est un privilege excessif, meme si le
  // role parait conforme par ailleurs.
  if (identity.canWriteDppEvents === true) violations.push('ecriture_directe_sur_evenements_dpp_append_only');
  if (identity.canWriteMigrationsLedger === true) violations.push('ecriture_sur_le_registre_des_migrations_prisma');
  return violations;
}

/**
 * Contrat de securite de l'identite runtime. La comparaison vit dans ce module
 * pour que la route ne publie pas de champs d'identite par defaut.
 */
export function databaseIdentityIsSafe(identity: DatabaseIdentity | undefined): boolean {
  return Boolean(
    identity?.measured &&
    identity.currentUser === 'tracefab_app' &&
    identity.sessionUser === 'tracefab_app' &&
    identity.bypassesRls === false &&
    identity.isSuperuser === false &&
    databaseIdentityViolations(identity).length === 0,
  );
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
