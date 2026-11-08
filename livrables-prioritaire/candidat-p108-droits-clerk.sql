-- CANDIDAT DE TRAVAIL NON INTÉGRÉ. Dépend de #114, notamment du validateur
-- de jeton système. À ajouter comme migration forward seulement après revue de
-- la chaîne consolidée et preuves d'intégration. Ne change pas le mode strict.
-- Les politiques RESTRICTIVE empêchent qu'une autre politique permissive
-- autorise le worker sans jeton, y compris pendant la transition permissive.
DO $preconditions$
BEGIN
  IF to_regprocedure('public.tracefab_identite_systeme_jeton_valide(text)') IS NULL THEN
    RAISE EXCEPTION 'P10.8 Clerk : validateur #114 absent' USING ERRCODE = 'P0001';
  END IF;
  IF NOT pg_catalog.has_function_privilege('tracefab_worker',
       'public.tracefab_identite_systeme_jeton_valide(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P10.8 Clerk : validateur inaccessible au worker' USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'P10.8 Clerk : runtime membre du worker' USING ERRCODE = 'P0001';
  END IF;
END
$preconditions$;

GRANT INSERT (clerk_organization_id, type, legal_name, display_name, status)
  ON public.organizations TO tracefab_worker;
GRANT INSERT (clerk_membership_id, organization_id, user_id, role, status, joined_at)
  ON public.organization_memberships TO tracefab_worker;
GRANT INSERT (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
  ON public.audit_logs TO tracefab_worker;

CREATE POLICY tf_worker_clerk_org_insert ON public.organizations
  FOR INSERT TO tracefab_worker WITH CHECK (current_user = 'tracefab_worker');
CREATE POLICY tf_worker_clerk_org_insert_signed ON public.organizations
  AS RESTRICTIVE FOR INSERT TO tracefab_worker
  WITH CHECK (public.tracefab_identite_systeme_jeton_valide(current_setting('tracefab.identity_systeme', true)));
CREATE POLICY tf_worker_clerk_org_update ON public.organizations
  FOR UPDATE TO tracefab_worker USING (current_user = 'tracefab_worker') WITH CHECK (current_user = 'tracefab_worker');
CREATE POLICY tf_worker_clerk_org_update_signed ON public.organizations
  AS RESTRICTIVE FOR UPDATE TO tracefab_worker
  USING (public.tracefab_identite_systeme_jeton_valide(current_setting('tracefab.identity_systeme', true)))
  WITH CHECK (public.tracefab_identite_systeme_jeton_valide(current_setting('tracefab.identity_systeme', true)));

CREATE POLICY tf_worker_clerk_membership_insert ON public.organization_memberships
  FOR INSERT TO tracefab_worker WITH CHECK (current_user = 'tracefab_worker');
CREATE POLICY tf_worker_clerk_membership_insert_signed ON public.organization_memberships
  AS RESTRICTIVE FOR INSERT TO tracefab_worker
  WITH CHECK (public.tracefab_identite_systeme_jeton_valide(current_setting('tracefab.identity_systeme', true)));
CREATE POLICY tf_worker_clerk_membership_update ON public.organization_memberships
  FOR UPDATE TO tracefab_worker USING (current_user = 'tracefab_worker') WITH CHECK (current_user = 'tracefab_worker');
CREATE POLICY tf_worker_clerk_membership_update_signed ON public.organization_memberships
  AS RESTRICTIVE FOR UPDATE TO tracefab_worker
  USING (public.tracefab_identite_systeme_jeton_valide(current_setting('tracefab.identity_systeme', true)))
  WITH CHECK (public.tracefab_identite_systeme_jeton_valide(current_setting('tracefab.identity_systeme', true)));

CREATE POLICY tf_worker_clerk_audit_insert ON public.audit_logs
  FOR INSERT TO tracefab_worker WITH CHECK (current_user = 'tracefab_worker');
CREATE POLICY tf_worker_clerk_audit_insert_signed ON public.audit_logs
  AS RESTRICTIVE FOR INSERT TO tracefab_worker
  WITH CHECK (public.tracefab_identite_systeme_jeton_valide(current_setting('tracefab.identity_systeme', true)));
