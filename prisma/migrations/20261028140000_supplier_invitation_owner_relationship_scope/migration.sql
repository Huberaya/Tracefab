-- TRACEFAB — invitation d'un `owner` fournisseur : la regle du depot rejoint
-- celle que le code attend.
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
-- `owner_role_not_invitable`. Le correctif existe dans le depot depuis le commit
-- « fix: preserve supplier onboarding owner invitations », il n'est pas applique.
--
-- POURQUOI UNE MIGRATION NOUVELLE, ET NON UNE REECRITURE
--
-- Reecrire `20261005090000` changerait son empreinte une seconde fois et
-- laisserait la base de production, qui l'a deja executee, avec un historique
-- qui ne correspond a aucun contenu. L'historique ne se reecrit pas : on ajoute.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--   - aucune ecriture dans `_prisma_migrations` ;
--   - aucune modification de `20261005090000` ni d'aucune migration anterieure ;
--   - aucun GRANT : elle remplace un corps de fonction, elle n'accorde rien.
--     Le registre runtime (20261028120000) n'est pas touche ;
--   - aucun elargissement : `owner` reste non invitable SANS relation. Le seul
--     changement est l'acceptation du cas « owner + relation », qui est celui du
--     parcours produit.
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
BEGIN
  -- L'onboarding marque-fournisseur invite volontairement le premier
  -- proprietaire. Les invitations de gestion de membres n'ont aucun contexte de
  -- relation et ne peuvent jamais accorder `owner` directement.
  IF NEW.target_role = 'owner' AND NEW.relationship_id IS NULL THEN
    RAISE EXCEPTION 'owner_role_not_invitable';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tracefab_validate_member_invitation_role() IS
  'Interdit l''invitation d''un owner sans contexte de relation. Le cas '
  'owner + relationship_id est celui de l''onboarding fournisseur et reste '
  'autorise. Aligne la production sur 20261005090000 telle que versionnee.';

-- Le declencheur est repose : s'il manquait ou pointait ailleurs, la fonction
-- corrigee ne serait jamais appelee, et la migration semblerait avoir reussi.
DROP TRIGGER IF EXISTS organization_invitations_validate_role ON organization_invitations;
CREATE TRIGGER organization_invitations_validate_role
  BEFORE INSERT OR UPDATE ON organization_invitations
  FOR EACH ROW EXECUTE FUNCTION tracefab_validate_member_invitation_role();
