#!/usr/bin/env -S npx tsx
/**
 * Provisionnement EXPLICITE du stockage Postgres de la PR #101, dans une
 * base de TEST deja isolee. Pas de migration Prisma, pas de role cree, aucun
 * secret ni URL affiche. Jamais execute automatiquement par l'application.
 *
 * --fingerprint : calcule uniquement l'empreinte host/port/base de DATABASE_URL.
 * --provision   : cree un schema neuf + la table et accorde uniquement
 *                 SELECT/INSERT au role existant tracefab_app, apres gardes.
 * --purge-expired : supprime uniquement les objets expires dans cette table.
 *
 * L'empreinte et les drapeaux ne prouvent PAS l'isolation : l'operateur doit
 * la verifier independamment avant d'attester et d'executer une ecriture.
 */
import pg from 'pg';
import { assertPreviewDatabaseTarget, previewDatabaseFingerprint } from '../api/_lib/preview-storage-policy.js';

const [argument, ...extra] = process.argv.slice(2);
// --dry-run est l'alias sans ecriture du calcul d'empreinte.
const action = argument === '--dry-run' ? '--fingerprint' : argument;
if (extra.length || !['--fingerprint', '--provision', '--purge-expired'].includes(action || '')) {
  console.error('REFUS — utiliser --dry-run, --fingerprint, --provision ou --purge-expired sans autre argument.');
  process.exit(3);
}
if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
  console.error('REFUS — ce script ne doit pas etre execute dans un deploiement ou un contexte de production.');
  process.exit(3);
}

try {
  if (action === '--fingerprint') {
    console.log(previewDatabaseFingerprint(process.env.DATABASE_URL || ''));
  } else {
    if (process.env.TF_PREVIEW_STORAGE_PROVISION_ACK !== 'ISOLATED_TEST_DATABASE_ONLY') {
      throw new Error('ack_missing');
    }
    assertPreviewDatabaseTarget();
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
    try {
      await client.connect();
      if (action === '--provision') {
        await client.query('BEGIN');
        const role = await client.query(`SELECT current_user AS current_role, rolname, rolsuper, rolbypassrls,
          pg_has_role('tracefab_app', current_user, 'MEMBER') AS inherits_owner
          FROM pg_roles WHERE rolname = 'tracefab_app'`);
        if (!role.rows[0] || role.rows[0].current_role === 'tracefab_app'
            || role.rows[0].rolsuper || role.rows[0].rolbypassrls || role.rows[0].inherits_owner) throw new Error('application_role_invalid');
        const existing = await client.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tracefab_preview_store') AS present");
        if (existing.rows[0].present) throw new Error('preview_schema_already_exists');
        await client.query('CREATE SCHEMA tracefab_preview_store');
        await client.query('REVOKE ALL ON SCHEMA tracefab_preview_store FROM PUBLIC');
        await client.query(`CREATE TABLE tracefab_preview_store.objects (
          object_key text PRIMARY KEY,
          content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg', 'text/plain')),
          body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 1048576),
          created_at timestamptz NOT NULL DEFAULT NOW(),
          expires_at timestamptz NOT NULL
        )`);
        await client.query('CREATE INDEX preview_objects_expiry ON tracefab_preview_store.objects (expires_at)');
        await client.query('ALTER TABLE tracefab_preview_store.objects ENABLE ROW LEVEL SECURITY');
        await client.query('ALTER TABLE tracefab_preview_store.objects FORCE ROW LEVEL SECURITY');
        await client.query(`CREATE POLICY preview_object_read ON tracefab_preview_store.objects FOR SELECT TO tracefab_app
          USING (object_key = current_setting('tracefab.preview_storage_key', true) AND expires_at > NOW())`);
        await client.query(`CREATE POLICY preview_object_insert ON tracefab_preview_store.objects FOR INSERT TO tracefab_app
          WITH CHECK (object_key = current_setting('tracefab.preview_storage_key', true)
            AND expires_at > NOW() AND expires_at <= NOW() + INTERVAL '25 hours')`);
        await client.query(`CREATE POLICY preview_owner_expired_read ON tracefab_preview_store.objects FOR SELECT TO CURRENT_USER
          USING (expires_at <= NOW())`);
        await client.query(`CREATE POLICY preview_owner_expired_delete ON tracefab_preview_store.objects FOR DELETE TO CURRENT_USER
          USING (expires_at <= NOW())`);
        await client.query('REVOKE ALL ON TABLE tracefab_preview_store.objects FROM PUBLIC');
        await client.query('GRANT USAGE ON SCHEMA tracefab_preview_store TO tracefab_app');
        await client.query('GRANT SELECT, INSERT ON TABLE tracefab_preview_store.objects TO tracefab_app');
        const permissions = await client.query(`SELECT
          has_table_privilege('tracefab_app', 'tracefab_preview_store.objects', 'UPDATE') AS can_update,
          has_table_privilege('tracefab_app', 'tracefab_preview_store.objects', 'DELETE') AS can_delete`);
        if (permissions.rows[0].can_update || permissions.rows[0].can_delete) throw new Error('application_role_too_privileged');
        await client.query('COMMIT');
        console.log('PASS — table de test creee ; role applicatif limite a SELECT/INSERT.');
      } else {
        const result = await client.query('DELETE FROM tracefab_preview_store.objects WHERE expires_at <= NOW()');
        console.log(`PASS — ${result.rowCount} objet(s) de test expire(s) purge(s).`);
      }
    } catch (error) {
      if (action === '--provision') await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(?:private_storage_[a-z_]+|ack_missing|application_role_invalid|application_role_too_privileged|preview_schema_already_exists)$/.test(message)
    ? message : 'database_operation_failed';
  console.error(`REFUS/ECHEC — ${safe} ; aucune URL ni valeur de secret n'est affichee.`);
  process.exit(3);
}
