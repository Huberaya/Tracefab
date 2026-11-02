/**
 * Les trois rôles PostgreSQL de TraceFab, et les outils pour les inspecter.
 *
 * POURQUOI CE MODULE
 *
 * Jusqu'à P10.4, le dépôt parlait de deux rôles — `tracefab_app` et
 * `tracefab_worker` — et laissait le rôle qui exécute les migrations
 * implicite : « le propriétaire de la base », c'est-à-dire, en pratique,
 * `neondb_owner`, qui porte aussi `BYPASSRLS` et sert de rôle de runtime.
 * Trois responsabilités distinctes étaient donc portées par un seul compte :
 *
 *   1. servir les requêtes applicatives ;
 *   2. posséder les objets et exécuter les migrations ;
 *   3. administrer les rôles.
 *
 * Les mesures de P10.4 ont montré ce que cela coûte : une appartenance
 * accordée « pour faire passer une migration » donne au runtime le droit de
 * prendre le rôle propriétaire, donc de lire les deux organisations.
 *
 * LA SÉPARATION RETENUE
 *
 *   tracefab_app        runtime. LOGIN, aucun privilège d'administration,
 *                       aucun objet possédé, AUCUNE appartenance.
 *   tracefab_migrator   propriétaire des objets, exécutant des migrations.
 *                       LOGIN, CREATEROLE (la chaîne crée `tracefab_worker`),
 *                       NOBYPASSRLS, NOSUPERUSER. Ce n'est jamais le runtime.
 *   tracefab_worker     identité système, NOLOGIN. Possède les six fonctions
 *                       de provisionnement Clerk et la clef HMAC (P10.5).
 *                       Aucun rôle membre : on ne peut pas la prendre.
 *
 * CE QUE CE MODULE NE FAIT PAS
 *   - il n'écrit rien : toutes ses fonctions sont des lectures de catalogue ;
 *   - il n'affiche jamais une chaîne de connexion, un mot de passe ou un secret ;
 *   - il ne décide pas si un rôle est « bon » : il rend l'état mesuré, et les
 *     appelants comparent à ATTRIBUTS_ATTENDUS.
 */

export const ROLE_APP = 'tracefab_app';
export const ROLE_MIGRATOR = 'tracefab_migrator';
export const ROLE_WORKER = 'tracefab_worker';

/**
 * Attributs attendus, par rôle. Toute divergence est un écart, pas un détail :
 * un `rolsuper` ou `rolbypassrls` à `true` suffit à rendre la RLS décorative.
 */
export const ATTRIBUTS_ATTENDUS = Object.freeze({
  [ROLE_APP]: Object.freeze({
    rolcanlogin: true,
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolinherit: true,
  }),
  [ROLE_MIGRATOR]: Object.freeze({
    rolcanlogin: true,
    rolsuper: false,
    // BYPASSRLS est JUSTIFIE ici, et mesure : plusieurs migrations historiques
    // ecrivent des donnees de reference dans des tables en FORCE ROW LEVEL
    // SECURITY (`dpp_requirement_profiles`, 20261006160000). Sous FORCE, le
    // PROPRIETAIRE lui-meme est soumis aux politiques ; une table qui n'a
    // qu'une politique SELECT refuse donc l'INSERT du role de migration.
    // Mesure du 30/10/2026 : sans BYPASSRLS, la chaine s'arrete a la 31e
    // migration (« new row violates row-level security policy »).
    //
    // Ce n'est PAS un elargissement : le role de migration possede deja tous
    // les objets et peut, sans ce droit, faire `DROP POLICY`,
    // `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` ou remplacer n'importe
    // quelle fonction. BYPASSRLS ne lui donne rien de plus. Ce qui compte est
    // qu'il ne soit JAMAIS le runtime — et qu'aucun autre role ne puisse le
    // prendre (teste : appartenances fermees, `SET ROLE` refuse).
    rolbypassrls: true,
    // CREATEROLE est necessaire a la CHAINE HISTORIQUE : la migration
    // 20261028120100 cree `tracefab_worker` et lui transfere la propriete de
    // six fonctions. Sans CREATEROLE, elle ne peut pas s'executer sur une base
    // vierge autrement qu'en superutilisateur — c'est exactement le blocage B2.
    // CREATEROLE n'ouvre aucun objet applicatif : il ne donne ni SUPERUSER,
    // ni BYPASSRLS, ni la propriete des tables existantes.
    rolcreaterole: true,
    rolcreatedb: false,
    rolinherit: true,
  }),
  [ROLE_WORKER]: Object.freeze({
    rolcanlogin: false,
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolinherit: false,
  }),
});

export const ROLES = Object.freeze([ROLE_APP, ROLE_MIGRATOR, ROLE_WORKER]);

/**
 * Rôles dont l'appartenance, pour `tracefab_app`, serait une escalade.
 *
 * La liste n'est pas « les rôles méchants » : ce sont les rôles qui, sur cette
 * base, portent soit `BYPASSRLS`, soit la propriété des objets, soit des
 * privilèges d'administration. Y être membre — même sans INHERIT — suffit à
 * autoriser `SET ROLE`, donc à obtenir leurs attributs (mesuré en P10.4 :
 * `tracefab_app` passait de 0 à 4 produits visibles).
 */
export function rolesInterditsPourApp({ proprietaireBase, proprietaireObjets }) {
  return [...new Set([ROLE_MIGRATOR, ROLE_WORKER, proprietaireBase, proprietaireObjets]
    .filter((x) => typeof x === 'string' && x.length > 0))];
}

/** État d'un rôle, ou `null` s'il n'existe pas. Lecture seule. */
export async function etatRole(db, nom) {
  const { rows } = await db.query(
    `SELECT r.oid, r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole,
            r.rolcreatedb, r.rolcanlogin, r.rolbypassrls, r.rolreplication,
            (SELECT count(*)::int FROM pg_catalog.pg_class c
              WHERE pg_catalog.pg_get_userbyid(c.relowner) = r.rolname) AS objets_possedes,
            (SELECT count(*)::int FROM pg_catalog.pg_proc p
              WHERE pg_catalog.pg_get_userbyid(p.proowner) = r.rolname) AS fonctions_possedees
       FROM pg_catalog.pg_roles r
      WHERE r.rolname = $1`,
    [nom],
  );
  return rows[0] ?? null;
}

/** Écarts entre l'état mesuré d'un rôle et les attributs attendus. */
export function ecartsAttributs(nom, etat) {
  const attendus = ATTRIBUTS_ATTENDUS[nom];
  if (!attendus) throw new Error(`aucun attribut attendu déclaré pour ${nom}`);
  if (!etat) return [`le rôle ${nom} n'existe pas`];
  const ecarts = [];
  for (const [attribut, valeur] of Object.entries(attendus)) {
    if (etat[attribut] !== valeur) {
      ecarts.push(`${nom}.${attribut} = ${etat[attribut]}, attendu ${valeur}`);
    }
  }
  if (etat.rolreplication) ecarts.push(`${nom}.rolreplication = true, attendu false`);
  return ecarts;
}

/**
 * Appartenances DIRECTES d'un rôle, avec les trois options de PostgreSQL 16+.
 * Lue dans `pg_auth_members` : `pg_has_role(…,'MEMBER')` rend vrai aussi pour
 * un superutilisateur sans octroi explicite, ce qui masquerait le néant.
 */
export async function appartenancesDirectes(db, nom) {
  const { rows } = await db.query(
    `SELECT c.rolname AS role_accorde,
            m.admin_option, m.inherit_option, m.set_option,
            pg_catalog.pg_get_userbyid(m.grantor) AS accorde_par
       FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.member
       JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
      WHERE r.rolname = $1
      ORDER BY 1`,
    [nom],
  );
  return rows;
}

/**
 * Fermeture transitive : tous les rôles atteignables depuis `nom` par une
 * chaîne d'appartenances, avec la profondeur. C'est ce qui compte vraiment :
 * `app -> X -> proprietaire` est aussi dangereux que `app -> proprietaire`.
 */
export async function appartenancesTransitives(db, nom) {
  const { rows } = await db.query(
    `WITH RECURSIVE graphe AS (
        SELECT c.rolname AS atteint, 1 AS profondeur, ARRAY[r.rolname, c.rolname] AS chemin
          FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles r ON r.oid = m.member
          JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
         WHERE r.rolname = $1
       UNION ALL
        SELECT c.rolname, g.profondeur + 1, g.chemin || c.rolname
          FROM graphe g
          JOIN pg_catalog.pg_roles r ON r.rolname = g.atteint
          JOIN pg_catalog.pg_auth_members m ON m.member = r.oid
          JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
         WHERE g.profondeur < 10 AND NOT c.rolname = ANY(g.chemin)
     )
     SELECT atteint, min(profondeur) AS profondeur, min(chemin::text) AS chemin
       FROM graphe GROUP BY atteint ORDER BY profondeur, atteint`,
    [nom],
  );
  return rows;
}

/** Propriétaires effectifs des objets du schéma public. Lecture seule. */
export async function proprietairesObjets(db, schema = 'public') {
  const { rows } = await db.query(
    `SELECT 'table' AS genre, pg_catalog.pg_get_userbyid(c.relowner) AS proprietaire, count(*)::int AS n
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S')
      GROUP BY 1, 2
     UNION ALL
     SELECT 'fonction', pg_catalog.pg_get_userbyid(p.proowner), count(*)::int
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
      GROUP BY 1, 2
     ORDER BY 1, 3 DESC`,
    [schema],
  );
  return rows;
}

/** Mode session (lecture seule) : `on` si le serveur applique déjà la RLS. */
export async function baseCourante(db) {
  const { rows } = await db.query('SELECT current_database() AS base, current_user AS role_courant, session_user AS role_session');
  return rows[0];
}

export function resume(ecarts) {
  return ecarts.length === 0 ? 'conforme' : `${ecarts.length} écart(s)`;
}
