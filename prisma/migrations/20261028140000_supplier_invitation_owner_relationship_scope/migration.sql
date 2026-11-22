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
-- POURQUOI LA REGLE DU DEPOT NE SUFFIT PAS — ET OU J'AI EU TORT
--
-- J'ai d'abord ecrit ici que la regle du depot ouvrait deux contournements :
-- un `admin` fabriquant un `owner` dans sa propre organisation, et la
-- reutilisation d'une relation d'un autre couple d'organisations. C'etait FAUX.
--
-- La chaine pose un SECOND declencheur sur `organization_invitations`,
-- `invitations_validate_relationship` (migration initiale 20260923130000), dont
-- la fonction `tracefab_validate_invitation_relationship` exige deja :
--
--     r.id = NEW.relationship_id AND r.supplier_organization_id = NEW.organization_id
--
-- Il tire avant celui-ci (ordre alphabetique) et refuse les deux cas. Mesure sur
-- la chaine complete, tous declencheurs en place :
--
--   owner cote marque                     -> invitation_relationship_mismatch
--   relation d'un autre couple            -> invitation_relationship_mismatch
--
-- Mon erreur venait de mon propre montage de test : un schema ecrit a la main,
-- avec une seule fonction, donc sans ce declencheur. Un test qui reconstruit une
-- partie du systeme ne mesure pas le systeme.
--
-- CE QUI RESTE VRAI APRES CORRECTION
--
-- Sur la chaine complete, l'ecart reel entre production et depot tient en deux
-- lignes, pas en deux failles :
--
--   onboarding (owner + relation fournisseur)  production : REFUSE
--                                              depot      : accepte
--
--   relation terminee (`status = 'ended'`)     production : refuse (parce que
--                                                         TOUT owner est refuse)
--                                              depot      : ACCEPTE   <- le trou
--
-- Le second point est le seul trou reel de la regle du depot : rien, dans aucun
-- des deux declencheurs, ne regarde le statut de la relation. Une relation
-- terminee porte encore une invitation de proprietaire.
--
-- LA REGLE RETENUE ICI
--
--   1. owner sans relation                     -> REFUS (inchange)
--   2. relation inexistante                    -> REFUS
--   3. relation dont le FOURNISSEUR n'est pas
--      l'organisation invitee                  -> REFUS
--   4. relation terminee (`status = 'ended'`)  -> REFUS   <- ce qui est nouveau
--   5. relation invited/active/suspended       -> ACCEPT  (l'onboarding)
--
-- Les points 2 et 3 sont une REDONDANCE ASSUMEE avec
-- `tracefab_validate_invitation_relationship`. Elle est mesuree dans les deux
-- sens par `test:supplier-invitation-corrective` : sur la chaine complete, la
-- retirer ne change rien ; sans l'autre declencheur, elle est la seule barriere.
-- Deux verrous sur la meme porte ne sont pas un defaut — a condition de dire
-- lequel porte, et de le prouver. C'est fait.
--
-- Les statuts `invited` et `suspended` restent acceptes deliberement : le
-- premier est celui de l'onboarding, le second ne retire pas le role. Seul
-- `ended` ferme la relation.
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
--   - elle ne touche pas `tracefab_validate_invitation_relationship`, l'autre
--     declencheur : le laisser tel quel est deliberé, c'est la defense en
--     profondeur ;
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
