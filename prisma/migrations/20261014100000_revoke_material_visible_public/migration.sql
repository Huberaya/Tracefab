-- Migration: 20261014100000_revoke_material_visible_public
--
-- REVOKE PUBLIC EXECUTE sur tracefab_material_visible_via_product,
-- GRANT conditionnel à tracefab_app.
--
-- Cette fonction SECURITY DEFINER a été créée avec GRANT EXECUTE TO PUBLIC
-- dans la migration 20261009120000. C'est une erreur : une fonction
-- SECURITY DEFINER s'exécute avec les privilèges du propriétaire, ce qui
-- permet à n'importe quel rôle de la base de contourner la RLS en appelant
-- cette fonction.
--
-- La fonction est appelée par la politique materials_select_authorized,
-- donc elle doit rester exécutable par le rôle applicatif tracefab_app.
-- On retire seulement le droit PUBLIC.
--
-- Le GRANT est conditionnel, comme dans la migration
-- 20261009180000_public_read_context : le rôle est une donnée
-- d'infrastructure, il existe déjà en production mais pas sur une base
-- vierge, où il est créé APRES les migrations (scripts/seed_rls_fixture.mjs,
-- qui pose ensuite GRANT EXECUTE ON ALL FUNCTIONS). Un GRANT inconditionnel
-- ferait échouer toute la chaîne de migrations sur une base neuve avec
-- « role tracefab_app does not exist ». Sans ce GRANT, en production,
-- tracefab_app perdrait EXECUTE et les politiques RLS casseraient.

REVOKE EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) TO tracefab_app;
  END IF;
END
$grants$;
