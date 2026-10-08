-- -----------------------------------------------------------------------------
-- TRACEFAB COMMAND CENTER — Chantier Admin 06
-- Connexion : Suppliers (§1) et Product Usage (§1).
--
-- Cette migration ajoute UNE colonne : le lien entre un prospect CRM et
-- l'organisation TRACEFAB réelle qu'il est devenu. C'est ce lien qui sépare une
-- donnée DÉCLARÉE par l'équipe commerciale d'une donnée MESURÉE par la plateforme.
--
-- Le précédent existe déjà : `crm_pilots.organization_id`, posé au Chantier 02
-- avec exactement cette sémantique. Le lien est repris au niveau de l'entreprise
-- parce que c'est une propriété de la RELATION, pas d'un pilote : un client qui
-- n'a jamais fait de pilote doit pouvoir être connecté lui aussi.
--
-- Aucune nouvelle politique RLS. `crm_companies` est déjà couverte par
-- crm_companies_select / crm_companies_modify, qui exigent
-- tracefab_is_platform_org(platform_organization_id). Une marque ou un
-- fournisseur n'a de rôle dans aucune organisation `platform` : la nouvelle
-- colonne est donc illisible pour eux, comme le reste de la table.
--
-- Ce que cette migration NE fait PAS : elle ne donne aucun accès aux données des
-- autres organisations. La lecture des fournisseurs d'un client reste gouvernée
-- par suppliers_select_authorized, qui exige tracefab_can_access_org() —
-- c'est-à-dire d'ÊTRE MEMBRE de l'organisation. Un admin plateforme qui n'est pas
-- membre ne verra donc rien, et l'interface le dira au lieu d'afficher zéro.
-- -----------------------------------------------------------------------------

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS organization_id UUID;

/*
 * Pas de clé étrangère, conformément au précédent de crm_pilots.organization_id.
 * Une FK avec ON DELETE SET NULL semblerait plus sûre, mais elle imposerait une
 * relation Prisma là où le pilote n'en a pas, et deux colonnes de même sens
 * traitées différemment finissent par diverger. L'existence de l'organisation est
 * validée à l'écriture par la route, qui refuse un identifiant inconnu.
 */

/* Index partiel : seules les lignes connectées sont interrogées par les vues
   Suppliers et Product Usage. Indexer toute la table indexerait surtout des NULL. */
CREATE INDEX IF NOT EXISTS idx_crm_companies_linked_org
  ON crm_companies (organization_id)
  WHERE organization_id IS NOT NULL;

/* Recherche par plateforme + lien, pour la vue Suppliers. */
CREATE INDEX IF NOT EXISTS idx_crm_companies_org_link
  ON crm_companies (platform_organization_id, organization_id);

COMMENT ON COLUMN crm_companies.organization_id IS
  'Organisation TRACEFAB réelle une fois le prospect devenu client. NULL tant que le lien n''est pas établi. Sans ce lien, les chiffres de la console sont DÉCLARÉS par l''équipe, jamais mesurés.';
