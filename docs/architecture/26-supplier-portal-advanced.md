# 26. Supplier Portal avancé — Chantier 23

## Périmètre

Le Chantier 23 complète le Supplier Portal avec les trois surfaces qui restaient au backlog :

- faits structurés fournisseur et site (`data_points`) ;
- gestion des membres et invitations d'une organisation fournisseur ;
- sélection explicite entre plusieurs organisations fournisseur auxquelles un même utilisateur appartient.

La donnée reste déclarative. Aucun écran ne transforme un statut `declared` ou `documented` en vérification, certification ou conformité.

## Contexte multi-organisation

Le portail initialise l'organisation active depuis les memberships Clerk/Neon, conserve le choix localement et l'envoie dans :

```text
X-Tracefab-Organization-Id: <organization UUID>
```

Le serveur ne fait jamais confiance à cet identifiant seul. `requestedOrganizationId(...)` le valide comme UUID, puis `currentSupplier(...)` exige un membership actif de l'utilisateur dans une organisation de type `supplier`. Un identifiant appartenant à un autre tenant retourne une absence d'organisation autorisée.

Le contexte sélectionné est utilisé par les routes profil, sites, certificats, qualité, documents, data points, membres et demandes de collecte fournisseur. La lecture des demandes accepte aussi `organizationId` pour borner la requête au fournisseur sélectionné.

## Données structurées

Routes :

```text
GET   /api/supplier/data-points
POST  /api/supplier/data-points
PATCH /api/supplier/data-points/:dataPointId
```

Un data point fournisseur accepte :

- une clé technique bornée (`data_key`) ; les clés connues (`country_of_manufacture`, `annual_production_capacity`, `activity_types`, `material_composition`, etc.) imposent un type et, pour les structures JSON, une forme métier bornée ;
- un type `text`, `number`, `percentage`, `boolean`, `date`, `country` ou `json` ;
- une valeur validée selon son type ;
- un sujet fournisseur ou un site fournisseur actif ;
- des dates `validFrom` et `validUntil` cohérentes ;
- une preuve privée déjà `available`, facultative mais nécessaire pour obtenir `documented`.

Le navigateur ne fournit pas le statut. Le serveur pose `declared` sans preuve et `documented` avec une preuve disponible. Une modification crée une nouvelle ligne avec `version + 1` et `supersedes_id` ; l'historique reste conservé.

Les contrôles SQL/RLS historiques complètent les contrôles API : le sujet, l'organisation propriétaire et la preuve ne peuvent pas traverser un tenant. Les valeurs `data_ready` et `ready_to_publish` restent des projections DPP distinctes et ne sont jamais produites par cette interface.

## Membres et invitations

Route :

```text
GET   /api/supplier/members
POST  /api/supplier/members
PATCH /api/supplier/members
POST  /api/supplier/member-invitations/:invitationId   # renvoi
DELETE /api/supplier/member-invitations/:invitationId # révocation
```

Les owners et admins peuvent :

- lister les membres actifs, suspendus ou révoqués et les invitations en attente ;
- inviter une adresse avec un rôle `admin`, `manager`, `contributor`, `viewer` ou `auditor` ;
- modifier le rôle ou l'état d'un membre différent d'eux-mêmes ;
- suspendre ou révoquer un accès.

Le rôle `owner` ne peut pas être attribué par le formulaire. Le dernier owner actif ne peut pas être suspendu, révoqué ou rétrogradé. Les lecteurs et auditeurs ont une lecture sans capacité de mutation.

Les invitations utilisent le même modèle d'acceptation que l'onboarding : seul le hash SHA-256 du token est écrit en base. Le token brut n'est conservé que pendant la requête ; il est envoyé par Resend si configuré. Le fallback manuel n'est autorisé qu'hors production ou avec `TRACEFAB_ALLOW_MANUAL_INVITATION_FALLBACK=true`, et le token n'est alors retourné qu'une seule fois à l'administrateur de confiance. Il n'est jamais journalisé. La page `/invitations/accept/` charge Clerk, lit le token d’URL puis retire immédiatement le paramètre de l’historique du navigateur avant d’appeler `POST /api/invitations/accept`. Une invitation révoquée peut être renvoyée et une membership précédemment révoquée peut être réactivée après acceptation d'une nouvelle invitation.

## Validation

```bash
npm run build
npm run test:supplier-advanced
npm run test:neon:supplier:advanced
npm run test:supplier-portal
npm run test:supplier-portal:browser
npm run schema:static
git diff --check
```

Le parcours navigateur démo couvre l'ouverture des données structurées, la déclaration d'un point, l'invitation d'un membre et le changement d'organisation. La validation réelle des RLS, des invitations et de la versionisation nécessite `DATABASE_URL`, Clerk et des memberships Neon de test.

## Limites résiduelles

- la synchronisation d'annuaire avec Clerk n'est pas automatique : l'acceptation crée ou réactive le membership Neon après authentification ;
- les data keys inconnues restent extensibles ; les clés structurées principales disposent néanmoins de validations dédiées ;
- les alertes et scores qualité restent séparés des data points déclaratifs.
