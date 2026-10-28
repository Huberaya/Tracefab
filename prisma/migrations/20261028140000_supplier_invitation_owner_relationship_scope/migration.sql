-- TRACEFAB — invitation d'un `owner` fournisseur : la regle du depot rejoint
-- celle que le code attend, sans elargir d'un pouce.
--
-- POURQUOI CETTE MIGRATION EXISTE
--
-- `20261005090000_supplier_portal_advanced_hardening` a ete executee en
-- production avec un contenu qui n'est plus celui du depot. Mesure du
-- 28/10/2026 (docs/security/2026-10-28-tour28-divergences-empreintes.md) :
--
--   empreinte production  560356c203df6d460f8488f44bdf1ce582d3f609eae1b4acd329ad3cd686bbb7
--   empreinte depot       13581e6c99a7c649e2a2e47280126362342b93adfcb45b6ec8161489455fc422
--
-- Le diff porte sur sept lignes, dans `tracefab_validate_member_invitation_role`,
-- et il porte sur une REGLE D'AUTORISATION, pas sur un commentaire :
--
--   production :  IF NEW.target_role = 'owner' THEN RAISE ...
--   depot      :  IF NEW.target_role = 'owner' AND NEW.relationship_id IS NULL
--                 THEN RAISE ...
--
-- Mesure, les deux versions installees puis sollicitees sur base jetable :
--
--   invitation d'un owner SANS relation (gestion de membres)
--       production : refusee     depot : refusee
--   invitation d'un owner AVEC relation (onboarding fournisseur)
--       production : REFUSEE     depot : ACCEPTEE
--
-- Consequence en production : le parcours d'onboarding fournisseur, qui invite
-- le premier `owner` avec un `relationship_id`, echoue avec
-- `owner_role_not_invitable`.
--
-- POURQUOI LA REGLE DU DEPOT NE SUFFIT PAS
--
-- `NEW.relationship_id IS NULL` ne verifie RIEN sur la relation elle-meme :
-- n'importe quel identifiant non nul ouvre la porte. Or le role applicatif
-- ecrit `organization_invitations` en direct (`TABLES_ECRITURE_DIRECTE`) et la
-- politique `invitations_insert_admin` autorise tout `admin` de
-- l'organisation visee. Consequences mesurees sur base jetable :
--
--   - un `admin` peut inviter un `owner` dans SA PROPRE organisation en
--     presentant une relation quelconque : c'est une elevation de privileges,
--     un `admin` n'a pas le droit de fabriquer un `owner` ;
--   - une relation appartenant a DEUX AUTRES organisations est acceptee :
--     c'est une reutilisation inter-organisations.
--
-- La regle retenue ici est donc celle du parcours reel — `tracefab_invite_supplier`
-- cree une relation (marque -> fournisseur) puis insere l'invitation avec
-- `organization_id = supplier_organization_id` et `target_role = 'owner'` — et
-- rien de plus :
--
--   1. `owner` sans relation                      -> REFUS (inchange)
--   2. relation inexistante                       -> REFUS
--   3. relation dont le FOURNISSEUR n'est pas
--      l'organisation invitee                     -> REFUS  (couvre la marque
--                                                             elle-meme et le
--                                                             tiers)
--   4. relation terminee (`status = 'ended'`)     -> REFUS
--   5. relation au statut invited/active/
--      suspended, cote fournisseur                -> ACCEPT (onboarding)
--
-- Les statuts `invited` et `suspended` sont acceptes deliberement : le premier
-- est celui de l'onboarding, le second ne retire pas le role. Seul `ended`
-- ferme la relation.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--   - aucune ecriture dans `_prisma_migrations` ;
--   - aucune modification de `20261005090000`, `20261005100000` ni d'aucune
--     migration anterieure : cette migration-ci n'a jamais ete appliquee a une
--     base (elle figure parmi les migrations non attestees en production), la
--     completer n'est donc pas une reecriture d'historique livre ;
--   - aucun `GRANT`/`REVOKE` : elle remplace un corps de fonction. La fonction
--     n'est pas appelee par `tracefab_app` (seul le declencheur l'est), et son
--     privilege d'execution reste celui pose par la migration d'origine ;
--   - aucune politique RLS touchee.
--
-- IDEMPOTENCE : `CREATE OR REPLACE` + `DROP TRIGGER IF EXISTS` avant
-- `CREATE TRIGGER`. Rejouable sans erreur.
--
-- RETOUR ARRIERE : reappliquer le corps de la version de production
--   IF NEW.target_role = 'owner' THEN
--     RAISE EXCEPTION 'owner_role_not_invitable';
--   END IF;
-- (copie conservee dans scripts/fixtures/empreintes-production-20261028/).

CREATE OR REPLACE FUNCTION tracefab_validate_member_invitation_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_relation brand_supplier_relationships;
BEGIN
  -- Les invitations de gestion de membres n'ont aucun contexte de relation et
  -- ne peuvent jamais accorder `owner` directement.
  IF NEW.target_role = 'owner' THEN
    IF NEW.relationship_id IS NULL THEN
      RAISE EXCEPTION 'owner_role_not_invitable';
    END IF;

    SELECT * INTO v_relation
      FROM brand_supplier_relationships r
     WHERE r.id = NEW.relationship_id;

    -- La cle etrangere garantit l'existence en pratique ; ce controle couvre le
    -- cas d'un declencheur sollicite hors du chemin nominal, et rend l'echec
    -- explicite plutot que silencieux.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invitation_relationship_not_found';
    END IF;

    -- Le proprietaire invite est celui du FOURNISSEUR. Inviter un `owner` dans
    -- l'organisation marque, ou en presentant la relation d'un autre couple
    -- d'organisations, est refuse. C'est ce controle qui ferme l'elevation de
    -- privileges par un `admin` et la reutilisation inter-organisations.
    IF v_relation.supplier_organization_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'invitation_relationship_organization_mismatch';
    END IF;

    -- Une relation terminee ne porte plus d'invitation de proprietaire.
    IF v_relation.status = 'ended' THEN
      RAISE EXCEPTION 'invitation_relationship_ended';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tracefab_validate_member_invitation_role() IS
  'Interdit l''invitation d''un owner hors onboarding fournisseur. Le owner '
  'n''est acceptable que sur le cote FOURNISSEUR d''une relation non terminee : '
  'sans relation, sur l''organisation marque, sur la relation d''un autre '
  'couple d''organisations, ou sur une relation terminee, l''invitation est '
  'refusee. Aligne la production sur 20261005090000 telle que versionnee, en '
  'fermant la faille de portee de relation.';

-- Le declencheur est repose : s'il manquait ou pointait ailleurs, la fonction
-- corrigee ne serait jamais appelee, et la migration semblerait avoir reussi.
DROP TRIGGER IF EXISTS organization_invitations_validate_role ON organization_invitations;
CREATE TRIGGER organization_invitations_validate_role
  BEFORE INSERT OR UPDATE ON organization_invitations
  FOR EACH ROW EXECUTE FUNCTION tracefab_validate_member_invitation_role();
