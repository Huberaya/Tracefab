-- TRACEFAB — contexte de locataire actif explicite, lisible depuis PostgreSQL.
--
-- POURQUOI
--
-- Incident Production du 2026-10-17 : un administrateur Clerk membre de Ginger
-- et de Tracefab Recette Production voyait, depuis Ginger, le produit
-- brouillon RECETTE-DPP-20261017 qui n'appartient qu'au tenant de recette.
--
-- Les deux idiomes de bornage existants bornent l'UTILISATEUR, pas le
-- LOCATAIRE ACTIF :
--
--   - `activeBrandOrganizationIds()` puis `{ in: organizationIds }` : union de
--     toutes les organisations du compte ;
--   - `tracefab_can_access_org(org)` : « l'utilisateur est-il membre ? », vrai
--     pour Ginger comme pour la recette.
--
-- Avec un compte mono-organisation, les deux sont indiscernables d'un vrai
-- bornage tenant. C'est pour cela que le defaut n'est apparu qu'avec un compte
-- multi-organisations.
--
-- CE QUE FAIT CETTE MIGRATION
--
-- Elle expose le locataire actif — arme par l'API dans la transaction, via
-- `set_config('tracefab.active_organization_id', ...)` — aux fonctions SQL et
-- aux politiques. Le repli est NULL, jamais « les autres organisations du
-- compte » : une surface qui oublie de borner n'obtient pas un filtre plus
-- large, elle obtient un locataire NULL et ne correspond a rien.
--
-- Cette migration n'ajoute aucune politique et n'en modifie aucune : elle pose
-- l'accessoire. Le durcissement des politiques viendra avec ses propres tests
-- d'etancheite, pour ne pas melanger un changement de surface d'acces avec un
-- changement de contexte.

BEGIN;

-- Locataire actif de la transaction, ou NULL.
--
-- `current_setting(..., true)` rend NULL quand le GUC n'a jamais ete arme :
-- c'est le comportement voulu. Une lecture hors contexte applicatif (psql de
-- diagnostic, migration, worker) n'herite donc d'aucun locataire par accident.
CREATE OR REPLACE FUNCTION tracefab_active_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('tracefab.active_organization_id', true), '')::UUID;
$$;

COMMENT ON FUNCTION tracefab_active_organization_id() IS
  'Locataire actif arme par l''API pour la transaction courante, ou NULL. '
  'NULL ne signifie jamais « toutes les organisations du compte » : une surface '
  'qui n''a pas nomine son locataire ne correspond a aucune ligne.';

-- Vrai si et seulement si l'organisation passee EST le locataire actif.
-- NULL en entree, ou aucun locataire actif : faux. Jamais vrai par defaut.
CREATE OR REPLACE FUNCTION tracefab_in_active_tenant(p_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT p_organization_id IS NOT NULL
     AND p_organization_id = tracefab_active_organization_id();
$$;

COMMENT ON FUNCTION tracefab_in_active_tenant(UUID) IS
  'Comparaison stricte au locataire actif. Echoue fermee : sans locataire arme, '
  'elle est fausse pour toute organisation, y compris celles de l''utilisateur.';

-- Garde explicite pour les fonctions applicatives qui exigent un locataire.
-- Le message d'exception est celui de l'API (`organization_id_required`), pour
-- qu'une erreur remontee par la base et une erreur remontee par la route soient
-- indiscernables pour l'appelant et se mappent sur le meme code HTTP.
CREATE OR REPLACE FUNCTION tracefab_require_active_tenant()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_active UUID;
BEGIN
  v_active := tracefab_active_organization_id();
  IF v_active IS NULL THEN
    RAISE EXCEPTION 'organization_id_required';
  END IF;
  RETURN v_active;
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
-- Invariant du depot (scripts/test_neon_privileges.mjs) : aucune fonction
-- executable par PUBLIC, defaut global ferme. Ces fonctions ne sont pas
-- SECURITY DEFINER — elles ne lisent qu'un GUC — mais elles sont appelees par
-- le role applicatif, et le retirer explicitement a PUBLIC est la seule forme
-- qui ne depende pas du defaut du role proprietaire au moment de l'execution.

REVOKE ALL ON FUNCTION tracefab_active_organization_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_in_active_tenant(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_require_active_tenant() FROM PUBLIC;

DO $grant_app$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON FUNCTION tracefab_active_organization_id() TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_in_active_tenant(UUID) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_require_active_tenant() TO tracefab_app;
  END IF;
END
$grant_app$;

COMMIT;
