-- CANDIDAT — NE PAS APPLIQUER EN PRODUCTION SANS AUTORISATION
--
-- Ferme le contournement du contexte worker (voir
-- docs/security/2026-10-27-isolation-contexte-worker.md).
--
-- Remplace une garde par GUC de session :
--     current_setting('tracefab.worker_context', true) = 'true'
-- par une garde par ROLE :
--     current_user = 'tracefab_worker'
--
-- Teste sur un clone de la base migree (PostgreSQL 18.4, 59 migrations) :
--   tracefab_app + SET du GUC  -> 0 ligne (faille fermee)
--   tracefab_app sans GUC      -> 0 ligne (comportement inchange)
--
-- PREREQUIS NON FOURNI ICI, ET C'EST VOLONTAIRE : le role tracefab_worker
-- doit exister ET etre approvisionne (EXECUTE sur les fonctions necessaires),
-- faute de quoi il echoue sur `permission denied for function
-- tracefab_current_user_email`. Le runtime doit par ailleurs disposer d'un
-- second credential pour les chemins worker. Ces deux points sont des
-- decisions d'infrastructure : ils ne sont pas pris ici.

ALTER POLICY "data_request_items_worker_select" ON public."data_request_items" USING (((current_user = 'tracefab_worker'::name)));

ALTER POLICY "data_requests_worker_select" ON public."data_requests" USING (((current_user = 'tracefab_worker'::name)));

ALTER POLICY "data_responses_worker_select" ON public."data_responses" USING (((current_user = 'tracefab_worker'::name)));

ALTER POLICY "organization_memberships_worker_select" ON public."organization_memberships" USING (((current_user = 'tracefab_worker'::name)));

ALTER POLICY "organizations_worker_select" ON public."organizations" USING (((current_user = 'tracefab_worker'::name)));

ALTER POLICY "notification_outbox_insert_trusted" ON public."tracefab_notification_outbox" WITH CHECK ((((current_user = 'tracefab_worker'::name)) OR (tracefab_current_user_id() IS NOT NULL)));

ALTER POLICY "notification_outbox_select_trusted" ON public."tracefab_notification_outbox" USING ((((current_user = 'tracefab_worker'::name)) OR tracefab_has_org_role(recipient_organization_id, ARRAY['owner'::membership_role, 'admin'::membership_role])));

ALTER POLICY "notification_outbox_update_trusted" ON public."tracefab_notification_outbox" USING (((current_user = 'tracefab_worker'::name)))
  WITH CHECK (((current_user = 'tracefab_worker'::name)));

ALTER POLICY "users_insert_worker" ON public."users" WITH CHECK (((current_user = 'tracefab_worker'::name)));

ALTER POLICY "users_update_worker" ON public."users" USING (((current_user = 'tracefab_worker'::name)))
  WITH CHECK (((current_user = 'tracefab_worker'::name)));

ALTER POLICY "users_worker_select" ON public."users" USING (((current_user = 'tracefab_worker'::name)));
