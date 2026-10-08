/*
 * CHANTIER ADMIN 10 — intégrité référentielle du périmètre commercial.
 *
 * CE QUE CETTE MIGRATION CORRIGE, ET COMMENT ON L'A SU
 *   Les migrations n'avaient jamais été exécutées. En les appliquant sur un vrai
 *   PostgreSQL puis en comparant pg_constraint à prisma/schema.prisma, on a vu
 *   que trois tables portaient la colonne de périmètre `platform_organization_id`
 *   SANS AUCUNE clé étrangère : crm_campaigns, crm_leads et crm_saved_views.
 *
 *   Les six autres tables du bloc CRM (companies, contacts, activities, tasks,
 *   meetings, pilots) référencent organizations(id) en ON DELETE CASCADE. Ces
 *   trois-là étaient les seules à ne pas le faire.
 *
 * POURQUOI C'EST GRAVE
 *   `platform_organization_id` est la colonne de périmètre : c'est elle que les
 *   politiques RLS comparent via tracefab_is_platform_org(). Sans clé étrangère,
 *   rien n'empêche d'écrire un prospect rattaché à une organisation qui n'existe
 *   pas — ni de laisser subsister une ligne dont l'organisation a été supprimée.
 *   La RLS filtre alors sur un identifiant orphelin : la ligne devient
 *   inaccessible sans être effacée, et un import peut en produire en masse.
 *
 * CHOIX
 *   - ON DELETE CASCADE, aligné sur les six autres tables du bloc : supprimer
 *     l'organisation TRACEFAB supprime son périmètre commercial. Ces données
 *     n'appartiennent à aucune marque ni fournisseur (§16), elles ne survivent
 *     donc pas à leur propriétaire.
 *   - Noms explicites identiques à ceux que PostgreSQL aurait générés
 *     (`<table>_<colonne>_fkey`) : un `prisma migrate diff` ne voit alors aucune
 *     dérive de nommage.
 *   - NOT VALID n'est PAS utilisé : une contrainte non validée ne s'applique pas
 *     aux lignes existantes, ce qui laisserait subsister exactement les orphelins
 *     qu'on veut interdire. Aucune donnée de production n'existe encore, la
 *     validation immédiate ne coûte rien.
 */

ALTER TABLE crm_campaigns
  ADD CONSTRAINT crm_campaigns_platform_organization_id_fkey
  FOREIGN KEY (platform_organization_id) REFERENCES organizations(id)
  ON DELETE CASCADE;

ALTER TABLE crm_leads
  ADD CONSTRAINT crm_leads_platform_organization_id_fkey
  FOREIGN KEY (platform_organization_id) REFERENCES organizations(id)
  ON DELETE CASCADE;

ALTER TABLE crm_saved_views
  ADD CONSTRAINT crm_saved_views_platform_organization_id_fkey
  FOREIGN KEY (platform_organization_id) REFERENCES organizations(id)
  ON DELETE CASCADE;
