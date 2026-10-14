-- TRACEFAB — fermer le privilège EXECUTE implicite pour les futures fonctions.
--
-- Les migrations 20261014100000 et 20261014110000 ferment les fonctions déjà
-- présentes. Elles ne ferment pas le défaut GLOBAL PostgreSQL : la révocation
-- limitée à IN SCHEMA public ne neutralise pas l'EXECUTE PUBLIC global.
--
-- Cette migration agit uniquement sur les fonctions créées à l'avenir par le
-- rôle qui l'applique. Elle ne remplace pas les REVOKE explicites des migrations
-- précédentes. Le contrôle témoin est exécuté dans la même transaction ; tout
-- échec annule le changement de privilèges et la fonction témoin.
BEGIN;

DO $default_acl$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
END
$default_acl$;

DO $verify_default$
DECLARE
  probe_oid oid;
  public_can_execute boolean;
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

  EXECUTE 'DROP FUNCTION public.tracefab__default_execute_probe()';

  IF public_can_execute THEN
    RAISE EXCEPTION
      'Migration sans effet : une nouvelle fonction reste exécutable par PUBLIC pour le rôle %',
      current_user;
  END IF;
END
$verify_default$;

COMMIT;
