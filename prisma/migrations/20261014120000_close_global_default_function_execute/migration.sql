-- TRACEFAB — fermer le privilège EXECUTE implicite pour les futures fonctions.
--
-- Les migrations 20261014100000 et 20261014110000 ferment les droits publics
-- historiques ciblés ; 20261014130000 vérifie et ferme toutes les fonctions
-- existantes du schéma public. Cette migration sécurise aussi les créations
-- futures pour le rôle qui exécute Prisma Migrate.
--
-- PostgreSQL combine les ACL globales et celles propres au schéma. Nous
-- révoquons donc PUBLIC au niveau global ET dans public. Si tracefab_app existe,
-- les fonctions futures lui restent accessibles explicitement. Sur une base
-- vierge où le rôle n'existe pas encore, le seed configure ces droits ensuite.
--
-- La sonde est créée, contrôlée puis supprimée dans la même transaction :
-- un résultat inattendu annule aussi le changement des ACL par défaut.

BEGIN;

DO $default_acl$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
      current_user,
      'tracefab_app'
    );
  END IF;
END
$default_acl$;

DO $verify_default$
DECLARE
  probe_oid oid;
  public_can_execute boolean;
  app_can_execute boolean;
BEGIN
  IF to_regprocedure('public.tracefab__default_execute_probe()') IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration refusée : public.tracefab__default_execute_probe() existe déjà';
  END IF;

  EXECUTE
    'CREATE FUNCTION public.tracefab__default_execute_probe() ' ||
    'RETURNS boolean LANGUAGE sql AS $probe$ SELECT true $probe$';

  SELECT p.oid
    INTO probe_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab__default_execute_probe'
     AND p.prokind = 'f'
     AND pg_get_function_identity_arguments(p.oid) = '';

  IF probe_oid IS NULL THEN
    RAISE EXCEPTION
      'Migration sans effet : la fonction témoin n''a pas été créée';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) acl
     WHERE p.oid = probe_oid
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  )
    INTO public_can_execute;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    SELECT has_function_privilege('tracefab_app', probe_oid, 'EXECUTE')
      INTO app_can_execute;
  ELSE
    app_can_execute := true; -- rôle absent : les GRANTs seront posés par le seed.
  END IF;

  EXECUTE 'DROP FUNCTION public.tracefab__default_execute_probe()';

  IF public_can_execute THEN
    RAISE EXCEPTION
      'Migration sans effet : une nouvelle fonction reste exécutable par PUBLIC pour le rôle %',
      current_user;
  END IF;

  IF NOT app_can_execute THEN
    RAISE EXCEPTION
      'Migration sans effet : tracefab_app ne reçoit pas EXECUTE sur une fonction future créée par %',
      current_user;
  END IF;
END
$verify_default$;

COMMIT;
