-- TRACEFAB: fermer EXECUTE à PUBLIC sur les fonctions de lecture publique.
-- Cette migration est volontairement transactionnelle et fail-closed.
-- L'état de Neon n'est pas présumé : tester d'abord sur une base jetable.
BEGIN;

SET LOCAL search_path = pg_catalog, public;

-- 1. Préconditions : les six fonctions attendues doivent exister dans public et
-- appartenir au rôle qui applique cette migration. Cinq d'entre elles doivent en
-- outre être SECURITY DEFINER : elles interrogent des tables depuis les
-- politiques, et c'est ce qui evite la recursion infinie materials <->
-- product_materials.
--
-- `tracefab_public_context()` fait exception, par conception : elle ne lit
-- qu'un reglage de session (`current_setting('tracefab.public_context')`) et
-- n'accede a aucune table. La migration 20261009180000 la cree volontairement
-- SANS SECURITY DEFINER (lignes 29 a 35), et `scripts/test_neon_privileges.mjs`
-- ne classe dans son controle A que les fonctions SECURITY DEFINER. L'exiger
-- ici rendait la migration impossible a appliquer sur toute base construite
-- par cette chaine — le preflight refusait avant toute ecriture.
--
-- Une fonction manquante, une fonction de politique non SECURITY DEFINER ou un
-- rôle migrateur différent doit arrêter la migration au lieu de produire un
-- succès partiel ou un durcissement inopérant.
DO $preflight$
DECLARE
  signature text;
  function_oid oid;
  owner_oid oid;
  is_secdef boolean;
  -- Fonctions qui n'ont pas a etre SECURITY DEFINER : elles ne touchent aucune
  -- table. Exigence du proprietaire conservee pour toutes, sans exception.
  sans_secdef text[] := ARRAY['public.tracefab_public_context()'];
  signatures text[] := ARRAY[
    'public.tracefab_material_visible_via_product(uuid)',
    'public.tracefab_product_is_public(uuid)',
    'public.tracefab_material_is_public(uuid)',
    'public.tracefab_supplier_site_is_public(uuid)',
    'public.tracefab_public_brand(uuid)',
    'public.tracefab_public_context()'
  ];
BEGIN
  FOREACH signature IN ARRAY signatures LOOP
    function_oid := to_regprocedure(signature)::oid;
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'Migration refusée : fonction obligatoire absente : %', signature
        USING ERRCODE = 'undefined_function';
    END IF;

    SELECT p.proowner, p.prosecdef
      INTO owner_oid, is_secdef
      FROM pg_proc p
     WHERE p.oid = function_oid;

    IF NOT is_secdef AND NOT (signature = ANY(sans_secdef)) THEN
      RAISE EXCEPTION 'Migration refusée : % n''est pas SECURITY DEFINER', signature
        USING ERRCODE = 'invalid_object_definition';
    END IF;

    IF owner_oid <> (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
      RAISE EXCEPTION
        'Migration refusée : % appartient à %, mais le migrateur est %. Appliquer avec le propriétaire des fonctions ou corriger explicitement les propriétaires.',
        signature, pg_get_userbyid(owner_oid), current_user
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
END
$preflight$;

-- 2. Corriger le défaut GLOBAL pour les fonctions créées à l'avenir par le
-- rôle migrateur. La variante IN SCHEMA ne peut pas retirer le droit intégré
-- EXECUTE de PUBLIC.
DO $default_acl$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
END
$default_acl$;

-- 3. Retirer explicitement EXECUTE à PUBLIC. Toutes les fonctions ont été
-- prévalidées et les noms sont qualifiés : aucune absence n'est ignorée.
REVOKE EXECUTE ON FUNCTION public.tracefab_material_visible_via_product(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tracefab_product_is_public(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tracefab_material_is_public(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tracefab_supplier_site_is_public(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tracefab_public_brand(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tracefab_public_context() FROM PUBLIC;

-- 4. Si le rôle applicatif existe déjà, lui accorder explicitement les droits
-- nécessaires. L'absence du rôle est tolérée uniquement pour les chaînes de
-- migration qui le créent après les migrations ; le contrôle de privilèges
-- devra alors être exécuté après le bootstrap du rôle.
DO $grant_app$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON FUNCTION public.tracefab_material_visible_via_product(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION public.tracefab_product_is_public(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION public.tracefab_material_is_public(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION public.tracefab_supplier_site_is_public(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION public.tracefab_public_brand(uuid) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION public.tracefab_public_context() TO tracefab_app;
  END IF;
END
$grant_app$;

-- 5. Vérifier par lecture du catalogue les six ACL effectives, y compris le
-- défaut PostgreSQL lorsque proacl est NULL. PUBLIC est le grantee OID 0 ;
-- il ne faut pas le traiter comme un rôle nommé via has_function_privilege.
DO $verify_functions$
DECLARE
  signature text;
  function_oid oid;
  public_can_execute boolean;
  app_can_execute boolean;
  app_exists boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app');
  signatures text[] := ARRAY[
    'public.tracefab_material_visible_via_product(uuid)',
    'public.tracefab_product_is_public(uuid)',
    'public.tracefab_material_is_public(uuid)',
    'public.tracefab_supplier_site_is_public(uuid)',
    'public.tracefab_public_brand(uuid)',
    'public.tracefab_public_context()'
  ];
BEGIN
  FOREACH signature IN ARRAY signatures LOOP
    function_oid := to_regprocedure(signature)::oid;

    SELECT EXISTS (
      SELECT 1
        FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
       WHERE p.oid = function_oid
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
    ) INTO public_can_execute;

    IF public_can_execute THEN
      RAISE EXCEPTION 'Durcissement incomplet : PUBLIC conserve EXECUTE sur %', signature
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF app_exists THEN
      SELECT has_function_privilege('tracefab_app', function_oid, 'EXECUTE')
        INTO app_can_execute;
      IF NOT app_can_execute THEN
        RAISE EXCEPTION 'Lecture applicative cassée : tracefab_app ne peut pas exécuter %', signature
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END LOOP;
END
$verify_functions$;

-- 6. Contrôle négatif du défaut futur : une fonction témoin créée par le
-- migrateur ne doit pas donner EXECUTE à PUBLIC. En cas d'échec, BEGIN/ROLLBACK
-- garantit que les modifications précédentes de cette migration sont annulées.
DO $verify_default$
DECLARE
  public_can_execute boolean;
BEGIN
  CREATE FUNCTION public.tracefab__autocontrole_defaut_execute()
    RETURNS boolean LANGUAGE sql STABLE AS $probe$ SELECT true $probe$;

  SELECT EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
     WHERE p.oid = 'public.tracefab__autocontrole_defaut_execute()'::regprocedure
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ) INTO public_can_execute;

  DROP FUNCTION public.tracefab__autocontrole_defaut_execute();

  IF public_can_execute THEN
    RAISE EXCEPTION
      'Migration sans effet : une fonction créée par % reste exécutable par PUBLIC',
      current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$verify_default$;

COMMIT;

-- RETOUR ARRIÈRE :
-- Ne pas réaccorder EXECUTE à PUBLIC comme rollback générique : cela réouvre
-- précisément l'exposition corrigée. En cas d'incident, identifier d'abord
-- les consommateurs nécessaires et restaurer uniquement les rôles nommés,
-- tout en conservant le défaut global fermé. Toute restauration doit être
-- testée sur une base jetable et revue avant exécution sur Neon.
