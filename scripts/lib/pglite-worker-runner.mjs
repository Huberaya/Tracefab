/**
 * Banc PGlite : reproduit le protocole worker du runner de migrations.
 *
 * Le banc reste non représentatif des privilèges Neon, mais il ne doit plus
 * exécuter le bootstrap comme si le migrateur pouvait créer ou s'accorder
 * lui-même le rôle worker. Le rôle est préprovisionné avant 201 ; le bail
 * SET/INHERIT est borné à chaque migration déclarée et ne porte jamais ADMIN.
 */
const BOOTSTRAP = '20261028120100_worker_identity_not_forgeable';
export const MIGRATIONS_AVEC_WORKER_TEMPORAIRE = new Set([
  BOOTSTRAP,
  '20261028120200_document_reserved_fields_internal_only',
  '20261031120000_identite_hmac_liee_au_contexte',
  '20261105235900_active_tenant_policy_and_worker_closure',
  '20261108120100_worker_fonctions_systeme_completes',
  '20261108120200_corrections_p106_ownership_et_appartenance',
]);

const identifiant = (valeur) => '"' + String(valeur).replace(/"/g, '""') + '"';

/**
 * Prépare le rôle et le contexte avant d'exécuter une migration.
 * Retourne un nettoyage idempotent à appeler après COMMIT ou après ROLLBACK.
 */
export async function preparerWorkerPglite(db, migration) {
  if (!MIGRATIONS_AVEC_WORKER_TEMPORAIRE.has(migration)) return async () => {};

  const role = (await db.query('SELECT current_user AS nom')).rows[0]?.nom;
  if (!role) throw new Error('PGlite : current_user absent');

  let existe = (await db.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker'",
  )).rows.length > 0;

  if (migration === BOOTSTRAP && !existe) {
    await db.exec(`
      CREATE ROLE tracefab_worker NOLOGIN NOINHERIT NOBYPASSRLS
        NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION;
    `);
    existe = true;
  }

  // Si le bootstrap a volontairement été omis dans une expérience négative,
  // ne pas réparer artificiellement son absence : la migration doit échouer
  // avec son propre garde-fou.
  if (!existe) return async () => {};

  await db.exec(`
    GRANT tracefab_worker TO ${identifiant(role)}
      WITH SET TRUE, INHERIT TRUE, ADMIN FALSE;
    SET tracefab.worker_membership_managed = 'true';
  `);

  let nettoye = false;
  return async () => {
    if (nettoye) return;
    await db.exec('RESET tracefab.worker_membership_managed;');
    await db.exec(`REVOKE tracefab_worker FROM ${identifiant(role)};`);
    nettoye = true;
  };
}

/** Joue le SQL avec le bail worker du runner ; transaction au choix de l'appelant. */
export async function executerMigrationPglite(db, migration, sql) {
  const nettoyer = await preparerWorkerPglite(db, migration);
  try {
    await db.exec(sql);
  } catch (erreur) {
    // En transaction abortée, ce nettoyage peut lui-même être refusé ; le
    // ROLLBACK de l'appelant annule alors aussi le bail temporaire.
    await nettoyer().catch(() => {});
    throw erreur;
  }
  await nettoyer();
}

/** Variante atomique : préprovisionnement, SQL et révocation dans la même transaction. */
export async function executerMigrationPgliteTransaction(db, migration, sql) {
  await db.exec('BEGIN');
  let nettoyer = async () => {};
  try {
    nettoyer = await preparerWorkerPglite(db, migration);
    await db.exec(sql);
    await nettoyer();
    await db.exec('COMMIT');
  } catch (erreur) {
    await db.exec('ROLLBACK').catch(() => {});
    await nettoyer().catch(() => {});
    throw erreur;
  }
}
