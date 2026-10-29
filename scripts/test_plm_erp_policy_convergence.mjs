#!/usr/bin/env node
/**
 * Reproduit la combinaison OR des politiques permissives PLM/ERP et prouve
 * que la migration corrective retire l'insertion contributor sans bloquer
 * manager. Base PGlite jetable ; aucune connexion ni secret.
 */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.waitReady;
try {
  await db.exec(`
    CREATE TYPE membership_role AS ENUM ('owner','admin','manager','contributor');
    CREATE ROLE tracefab_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE TABLE public.plm_erp_sync_jobs (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      brand_organization_id uuid NOT NULL
    );
    ALTER TABLE public.plm_erp_sync_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.plm_erp_sync_jobs FORCE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
    GRANT INSERT, SELECT ON public.plm_erp_sync_jobs TO tracefab_app;
    GRANT USAGE, SELECT ON SEQUENCE public.plm_erp_sync_jobs_id_seq TO tracefab_app;
    CREATE FUNCTION public.tracefab_has_org_role(p_org uuid, p_roles membership_role[])
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT current_setting('tracefab.test_role', true) = ANY (
        SELECT unnest(p_roles)::text
      )
    $$;
    CREATE POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id, ARRAY['owner','admin','manager']::membership_role[])
      );
    CREATE POLICY plm_sync_jobs_select_org ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (true);
    -- Deux politiques observées dans le catalogue production, mais absentes
    -- du fichier de migration versionné.
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id, ARRAY['owner','admin','manager','contributor']::membership_role[])
      );
    CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (true);
  `);

  async function attemptInsert(role) {
    try {
      await db.exec('BEGIN');
      await db.exec('SET LOCAL ROLE tracefab_app');
      await db.query('SELECT set_config($1, $2, true)', ['tracefab.test_role', role]);
      await db.query(
        'INSERT INTO public.plm_erp_sync_jobs (brand_organization_id) VALUES ($1)',
        ['00000000-0000-0000-0000-000000000001']
      );
      await db.exec('ROLLBACK');
      return true;
    } catch {
      try { await db.exec('ROLLBACK'); } catch {}
      return false;
    }
  }

  assert.equal(await attemptInsert('contributor'), true,
    'la politique supplémentaire doit reproduire l’élargissement avant correctif');
  assert.equal(await attemptInsert('manager'), true,
    'manager doit pouvoir insérer avant correctif');

  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const migration = fs.readFileSync(path.join(root, 'prisma/migrations/20261028150000_reconcile_plm_erp_sync_job_policies/migration.sql'), 'utf8');
  await db.exec(migration);

  const policies = (await db.query(`
    SELECT policyname FROM pg_catalog.pg_policies
    WHERE schemaname='public' AND tablename='plm_erp_sync_jobs'
    ORDER BY policyname
  `)).rows.map((r) => r.policyname);
  assert.deepEqual(policies, ['plm_sync_jobs_insert_brand', 'plm_sync_jobs_select_org'],
    'seules les deux politiques canoniques doivent subsister');
  assert.equal(await attemptInsert('contributor'), false,
    'contributor doit être refusé après correctif');
  assert.equal(await attemptInsert('manager'), true,
    'manager doit rester autorisé après correctif');

  console.log('PASS  politique permissive supplémentaire reproduite avant correctif');
  console.log('PASS  contributor accepté avant, refusé après');
  console.log('PASS  manager accepté avant et après');
  console.log('PASS  seules les politiques canoniques subsistent');
  console.log('4/4 vérifications réussies');
} finally {
  await db.close();
}
