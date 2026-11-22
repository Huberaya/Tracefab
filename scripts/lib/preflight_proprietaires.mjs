/**
 * PRÉFLIGHT DE PROPRIÉTÉ — « qui peut bien remplacer cette fonction ? »
 *
 * LE DÉFAUT MESURÉ (P10.6, 02/11/2026)
 *
 * `CREATE OR REPLACE FUNCTION` n'est pas un privilège : PostgreSQL exige d'être
 * le PROPRIÉTAIRE de la fonction (ou de pouvoir l'endosser). Mesure sur le
 * cluster jetable, avec `tracefab_migrator` et `CREATE` sur le schéma :
 *
 *     CREATE OR REPLACE FUNCTION public.tf_sonde() ...  -> 42501 must be owner of function
 *     DROP FUNCTION public.tf_sonde()                    -> 42501 must be owner of function
 *
 * Conséquence pour la livraison : une chaîne appliquée par le rôle de migration
 * ne peut remplacer que les fonctions QUE CE RÔLE A CRÉÉES. Sur une base où les
 * fonctions appartiennent à un autre rôle (cas d'une base existante migrée par
 * un outil antérieur), la première migration qui fait `CREATE OR REPLACE` sur
 * une fonction héritée échoue en 42501, au MILIEU de la chaîne, en laissant
 * une ligne d'échec dans `_prisma_migrations`.
 *
 * CE QUE CE MODULE FAIT
 *
 * Il lit, dans les fichiers de migration EN ATTENTE, les fonctions visées par
 * un `CREATE OR REPLACE FUNCTION` ou un `ALTER FUNCTION`, et confronte cette
 * liste au catalogue. Il ne modifie rien, il ne devine rien : il rend la liste
 * des fonctions que l'exécutant ne peut pas endosser.
 *
 * Il ne remplace JAMAIS une migration assistée (registre fermé) : ce sont deux
 * mécanismes distincts, et l'élévation reste bornée, tracée et révoquée.
 */

const FONCTION_CIBLE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"public"|public)\s*\.\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
const ALTER_CIBLE = /ALTER\s+FUNCTION\s+(?:"public"|public)\s*\.\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;

/**
 * Noms de fonctions visés par un fichier SQL de migration.
 * @param {string} sql contenu du fichier `migration.sql`
 * @returns {string[]} noms distincts, dans l'ordre de première apparition
 */
export function fonctionsCibles(sql) {
  const noms = new Set();
  for (const motif of [FONCTION_CIBLE, ALTER_CIBLE]) {
    motif.lastIndex = 0;
    let m;
    while ((m = motif.exec(sql)) !== null) noms.add(m[1]);
  }
  return [...noms];
}

/**
 * Fonctions de `public` visées par les migrations en attente dont l'exécutant
 * n'est PAS propriétaire et ne peut pas endosser le propriétaire.
 *
 * @param {import('pg').Client} db connexion qui appliquera les migrations
 * @param {string} executeur rôle de migration (`current_user` attendu)
 * @param {{nom: string, sql: string, assistee?: boolean}[]} migrations
 * @returns {Promise<{migration: string, fonction: string, proprietaire: string}[]>}
 */
export async function propriétairesInjoignables(db, executeur, migrations) {
  const ecarts = [];
  const { rows: superuser } = await db.query(
    'SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1', [executeur],
  );
  if (superuser[0]?.rolsuper === true) return ecarts;

  for (const { nom, sql, assistee } of migrations) {
    if (assistee) continue; // l'élévation bornée est le mécanisme prévu
    for (const fonction of fonctionsCibles(sql)) {
      const { rows } = await db.query(
        `SELECT r.rolname AS proprietaire
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [fonction],
      );
      for (const { proprietaire } of rows) {
        if (proprietaire === executeur) continue;
        // DÉFAUT MESURÉ : `pg_has_role` LÈVE 42704 quand le rôle interrogé
        // n'existe pas — il ne rend pas `false`. Le préflight est appelé sur le
        // cluster de CI par des suites qui ne provisionnent pas
        // `tracefab_migrator` (P10.6 en mode postgres) : la requête faisait
        // tomber la suite en `role "tracefab_migrator" does not exist` au lieu
        // de conclure. Un exécutant absent ne peut rien endosser : le préflight
        // doit le REFUSER, pas lever. `to_regrole` rend NULL au lieu de lever.
        // Ce n'est pas un adoucissement : le cas « rôle absent » reste un écart.
        const { rows: joignable } = await db.query(
          `SELECT CASE WHEN pg_catalog.to_regrole($1) IS NULL THEN false
                       ELSE pg_catalog.pg_has_role($1, $2, $3) END AS ok`,
          [executeur, proprietaire, 'SET'],
        );
        if (joignable[0]?.ok !== true) ecarts.push({ migration: nom, fonction, proprietaire });
      }
    }
  }
  return ecarts;
}
