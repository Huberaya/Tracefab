-- TRACEFAB — TF-03 : durcir les privileges sur les tables DPP publiques.
--
-- CONSTAT CONFIRME (catalogue effectif, base jetable PG17, 2026-10-17)
--
-- Les migrations 20261016130000 / 20261016150000 / 20261016170000 ont
-- re-introduit des privileges SELECT pour PUBLIC sur :
--   dpp_lifecycle_events, dpp_claims, dpp_claim_evidence,
--   dpp_resolvable_identifiers
-- (exactement les quatre tables signalees par l'audit).
--
-- Analyse des dependances avant revocation :
--
--   * dpp_claims et dpp_claim_evidence n'ont AUCUNE politique publique :
--     le privilege SELECT a PUBLIC n'a aucune utilite metier ;
--   * dpp_lifecycle_events et dpp_resolvable_identifiers ont des politiques
--     publiques bornees (tracefab_public_context() + produit publie) ; les
--     lectures publiques passent par l'API, qui s'execute en tracefab_app
--     (ou en proprietaire) — pas par une connexion anonyme directe ;
--   * toutes les ecritures applicatives passent par les fonctions
--     SECURITY DEFINER (tracefab_add_dpp_event, tracefab_add_dpp_claim,
--     tracefab_link_dpp_claim_evidence, tracefab_create_dpp_identity,
--     tracefab_replace_dpp_identity) : aucune route n'ecrit directement
--     dans ces tables ;
--   * le bootstrap du role applicatif (scripts/lib/tracefab_app_role.mjs)
--     accorde SELECT (et plus) a tracefab_app sur toutes les tables ; un
--     GRANT explicite ci-dessous couvre aussi les deploiements ou ce
--     bootstrap n'a pas tourne.
--
-- CORRECTION
--
--   1. PUBLIC perd tout privilege sur les quatre tables ;
--   2. tracefab_app garde SELECT (lecture via les politiques RLS) ;
--   3. tracefab_app perd INSERT/UPDATE/DELETE sur ces tables : les
--      mutations passent par les fonctions SECURITY DEFINER, conformement a
--      l'intention documentee de la migration 20261016130000 (« aucun droit
--      INSERT direct n'est accorde au role applicatif »).
--
-- Les politiques RLS (FORCE active) restent la premiere frontiere : ces
-- privileges retirent la seconde surface — l'acces catalogue direct.

REVOKE ALL ON dpp_lifecycle_events FROM PUBLIC;
REVOKE ALL ON dpp_claims FROM PUBLIC;
REVOKE ALL ON dpp_claim_evidence FROM PUBLIC;
REVOKE ALL ON dpp_resolvable_identifiers FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE 'GRANT SELECT ON dpp_lifecycle_events, dpp_claims, dpp_claim_evidence, dpp_resolvable_identifiers TO tracefab_app';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON dpp_lifecycle_events, dpp_claims, dpp_claim_evidence, dpp_resolvable_identifiers FROM tracefab_app';
  END IF;
END
$$;

COMMENT ON TABLE dpp_lifecycle_events IS
  'Evenements de cycle de vie DPP, append-only. Acces catalogue : aucun pour '
  'PUBLIC, SELECT pour tracefab_app ; ecritures par tracefab_add_dpp_event uniquement.';
COMMENT ON TABLE dpp_claims IS
  'Affirmations DPP, append-only. Aucun privilege PUBLIC ; ecritures par '
  'tracefab_add_dpp_claim uniquement.';
COMMENT ON TABLE dpp_claim_evidence IS
  'Liens affirmation/preuve, append-only. Aucun privilege PUBLIC ; ecritures '
  'par tracefab_link_dpp_claim_evidence uniquement.';
COMMENT ON TABLE dpp_resolvable_identifiers IS
  'Identifiants resolubles du passeport. Aucun privilege PUBLIC ; mutations '
  'par tracefab_create_dpp_identity / tracefab_replace_dpp_identity uniquement.';
