-- Migration: 20261014110000_revoke_public_execute_public_context_functions
--
-- REVOKE PUBLIC EXECUTE sur les 5 fonctions de contexte public créées par
-- la migration 20261009180000_public_read_context (migration 35), GRANT
-- conditionnel à tracefab_app.
--
-- `tracefab_public_context`, `tracefab_product_is_public`,
-- `tracefab_material_is_public`, `tracefab_supplier_site_is_public` et
-- `tracefab_public_brand` sont les prédicats des politiques de lecture
-- publique et la seule porte d'exposition de la marque. Quatre d'entre eux
-- sont SECURITY DEFINER : ils contournent la RLS par construction. Les
-- laisser en EXECUTE PUBLIC (le défaut PostgreSQL, proacl NULL) permet à
-- n'importe quel rôle de la base de les invoquer directement — en
-- particulier `tracefab_public_brand`, qui lirait l'identité de marque
-- hors de tout contexte public.
--
-- Ces fonctions doivent rester exécutables par le rôle applicatif
-- `tracefab_app` : les politiques qui les appellent sont évaluées au nom
-- de l'appelant. On retire donc seulement le droit PUBLIC, et on réaccorde
-- explicitement le rôle applicatif.
--
-- Le GRANT est conditionnel, pour la même raison que dans la migration
-- 20261009180000 : le rôle existe déjà en production mais pas sur une base
-- vierge, où il est créé APRES les migrations (scripts/seed_rls_fixture.mjs,
-- qui pose ensuite GRANT EXECUTE ON ALL FUNCTIONS). Un GRANT inconditionnel
-- ferait échouer toute la chaîne de migrations sur une base neuve.

REVOKE EXECUTE ON FUNCTION tracefab_public_context() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_product_is_public(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_material_is_public(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_supplier_site_is_public(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_public_brand(uuid) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON FUNCTION tracefab_public_context() TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_product_is_public(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_material_is_public(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_supplier_site_is_public(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_public_brand(uuid) TO tracefab_app;
  END IF;
END
$grants$;
