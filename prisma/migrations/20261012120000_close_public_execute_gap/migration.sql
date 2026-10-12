-- ===========================================================================
-- Fermer l'execution publique par defaut des fonctions
-- ===========================================================================
--
-- POURQUOI CETTE MIGRATION EXISTE
--
-- La migration 20261007100000_security_definer_execute_hardening voulait
-- garantir qu'aucune fonction n'est executable par PUBLIC. Elle a retire le
-- droit sur les fonctions qui existaient alors. Pour celles a venir, elle a
-- pose :
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
--     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--
-- Cette instruction ne fait RIEN. Ce n'est pas une supposition : c'est
-- verifie par execution sur PostgreSQL 18.4, sur une base vierge.
--
--   apres cette instruction, pg_default_acl ne contient AUCUNE ligne ;
--   une fonction creee ensuite porte proacl = NULL, c'est-a-dire le defaut
--   integre : EXECUTE pour PUBLIC ;
--   has_function_privilege('public', ..., 'EXECUTE') repond true.
--
-- La raison est que les defauts par schema ne font qu'AJOUTER au defaut
-- global, et l'EXECUTE de PUBLIC sur les fonctions est un defaut integre du
-- moteur. REVOKE ne retire que ce qui a ete accorde, et un defaut integre
-- n'a jamais ete accorde par cette instruction. Mesure directe :
--
--   IN SCHEMA public REVOKE ... FROM PUBLIC  -> pg_default_acl vide, defaut
--                                              integre conserve, PUBLIC true
--   FOR ROLE <role> REVOKE ... FROM PUBLIC   -> pg_default_acl
--                                              {postgres=X/postgres},
--                                              nouvelle fonction : PUBLIC false
--
-- La forme GLOBALE, sans `IN SCHEMA`, fonctionne. C'est celle de cette
-- migration.
--
-- CONSEQUENCE : LES FONCTIONS DE 20261009120000 ET 20261009180000
--
-- Le durcissement ayant ete sans effet, les cinq fonctions creees APRES lui
-- sont nees executables par PUBLIC :
--
--   tracefab_public_context()                    20261009180000
--   tracefab_product_is_public(uuid)             20261009180000
--   tracefab_material_is_public(uuid)            20261009180000
--   tracefab_supplier_site_is_public(uuid)       20261009180000
--   tracefab_public_brand(uuid)                  20261009180000
--   tracefab_material_visible_via_product(uuid)  20261009120000
--
-- La derniere est la plus exposee : la migration 20261009120000 lui accorde
-- en plus explicitement `GRANT EXECUTE ... TO PUBLIC`. Cette ligne detruit le
-- durcissement pour cette fonction, et contredit
-- docs/operations/p0-neon-reconciliation.md qui affirme qu'aucune fonction
-- n'est executable par PUBLIC.
--
-- POURQUOI C'EST UN PROBLEME, ET POURQUOI CE N'EST PAS UN PROBLEME
--
-- Toutes ces fonctions sont SECURITY DEFINER : elles s'executent avec les
-- droits de leur proprietaire. L'exposition reelle depend de ce que chacune
-- fait et de ce qu'elle verifie. L'exposition n'est pas presumee ici : ce qui
-- est etabli est que le droit est plus large que necessaire, et que la
-- documentation affirme le contraire.
--
-- Le droit doit revenir au role applicatif, pas a PUBLIC. Les politiques RLS
-- qui appellent ces fonctions sont declarees `TO PUBLIC` : cela definit a
-- quels roles la politique s'applique, et non qui doit pouvoir executer la
-- fonction. Le role qui interroge la table doit avoir l'EXECUTE — c'est lui
-- qu'il faut nommer.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
-- Elle ne touche ni aux politiques, ni aux tables, ni aux donnees. Elle ne
-- modifie aucun comportement de lecture : elle remplace un droit accorde a
-- tout le monde par un droit accorde au role qui en a besoin.
--
-- ROLLBACK
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE <proprietaire>
--     GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION tracefab_product_is_public(uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION tracefab_material_is_public(uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION tracefab_supplier_site_is_public(uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION tracefab_public_brand(uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION tracefab_public_context() TO PUBLIC;
--
-- Le rollback est volontairement ecrit ici : un droit retire sans sa
-- reciproque documentee est un droit qu'on ne saura pas rendre.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Fermer le defaut pour les fonctions a venir
-- ---------------------------------------------------------------------------
-- Forme globale : pas de `IN SCHEMA`. Le role vise est celui qui execute la
-- migration, c'est-a-dire le proprietaire des objets. Les fonctions creees
-- par un autre role ne sont pas couvertes — c'est precise dans
-- docs/security/PHASE-3-PRIVILEGES-NEON.md, et le test de non-regression le
-- verifie sur le proprietaire reel.
-- ---------------------------------------------------------------------------

DO $adp$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
END
$adp$;

-- ---------------------------------------------------------------------------
-- 2. Retirer l'EXECUTE de PUBLIC sur les cinq fonctions concernees
-- ---------------------------------------------------------------------------
-- REVOKE sur une fonction qui n'existe pas echoue ; chaque instruction est
-- donc conditionnee a la presence de la fonction, ce qui rend la migration
-- rejouable sur une base dont la chaine differe.
-- ---------------------------------------------------------------------------

DO $revoke$
DECLARE
  signatures text[] := ARRAY[
    'tracefab_material_visible_via_product(uuid)',
    'tracefab_product_is_public(uuid)',
    'tracefab_material_is_public(uuid)',
    'tracefab_supplier_site_is_public(uuid)',
    'tracefab_public_brand(uuid)',
    'tracefab_public_context()'
  ];
  signature text;
BEGIN
  FOREACH signature IN ARRAY signatures LOOP
    IF to_regprocedure(signature) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', signature);
    END IF;
  END LOOP;
END
$revoke$;

-- ---------------------------------------------------------------------------
-- 3. Rendre l'EXECUTE au role applicatif
-- ---------------------------------------------------------------------------
-- Meme convention que 20261009180000 : le role est une donnee
-- d'infrastructure, absent d'une base vierge ou il est cree apres les
-- migrations. Un GRANT inconditionnel ferait echouer toute la chaine sur une
-- base neuve.
--
-- `tracefab_material_visible_via_product` est indispensable ici : la
-- politique `materials_select_authorized` l'appelle, et une politique dont la
-- fonction n'est pas executable leve « permission denied for function » des
-- la premiere lecture de `materials`.
-- ---------------------------------------------------------------------------

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    IF to_regprocedure('tracefab_material_visible_via_product(uuid)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) TO tracefab_app;
    END IF;
    IF to_regprocedure('tracefab_product_is_public(uuid)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION tracefab_product_is_public(uuid) TO tracefab_app;
    END IF;
    IF to_regprocedure('tracefab_material_is_public(uuid)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION tracefab_material_is_public(uuid) TO tracefab_app;
    END IF;
    IF to_regprocedure('tracefab_supplier_site_is_public(uuid)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION tracefab_supplier_site_is_public(uuid) TO tracefab_app;
    END IF;
    IF to_regprocedure('tracefab_public_brand(uuid)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION tracefab_public_brand(uuid) TO tracefab_app;
    END IF;
    IF to_regprocedure('tracefab_public_context()') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION tracefab_public_context() TO tracefab_app;
    END IF;
  END IF;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 4. La migration verifie son propre effet, et echoue si elle ne l'a pas eu
-- ---------------------------------------------------------------------------
-- Une migration de privilege qui reussit sans avoir change le privilege est
-- exactement le defaut qu'elle corrige : le durcissement 20261007100000 a
-- pose une instruction sans effet, et personne ne l'a vu parce que la
-- migration s'est terminee en vert.
--
-- Verification par mesure, pas par relecture : une fonction temoin est creee,
-- son droit d'execution est interroge, puis la fonction est supprimee. Si
-- PUBLIC peut encore executer une fonction creee maintenant, la migration
-- echoue — et une migration qui echoue ne s'applique pas.
--
-- La sonde est creee et supprimee dans la meme migration : rien ne subsiste.
-- Elle porte un nom improbable et un commentaire qui dit d'ou elle vient, au
-- cas ou une interruption laisserait la trace.
-- ---------------------------------------------------------------------------

DO $auto_controle$
DECLARE
  public_peut boolean;
  temoin_oid oid;
BEGIN
  CREATE FUNCTION tracefab__autocontrole_defaut_execute()
    RETURNS boolean LANGUAGE sql STABLE AS $sonde$ SELECT true $sonde$;

  SELECT has_function_privilege('public', 'tracefab__autocontrole_defaut_execute()', 'EXECUTE')
    INTO public_peut;

  DROP FUNCTION tracefab__autocontrole_defaut_execute();

  IF public_peut THEN
    RAISE EXCEPTION
      'Migration sans effet : une fonction creee par % est encore executable par PUBLIC. '
      'La forme utile est globale, sans IN SCHEMA : '
      'ALTER DEFAULT PRIVILEGES FOR ROLE % REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
      current_user, current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RAISE NOTICE 'Verification : une fonction creee par % n est pas executable par PUBLIC.', current_user;
END
$auto_controle$;
