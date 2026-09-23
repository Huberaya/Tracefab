# 17. Data Collection Productization — Chantier 14

## Décision de périmètre

Le Chantier 14 complète l'API du Chantier 13 pour fournir les briques nécessaires aux deux surfaces applicatives :

- **Brand Console** : catalogue des questionnaires, création/initialisation, envoi et revue ;
- **Supplier Portal** : consultation des demandes envoyées, réponse item par item et soumission ;
- **notifications métier** : information du fournisseur et de la marque après les transitions importantes ;
- **contrats de questionnaires** : versions immuables et validation serveur des réponses.

Le repository ne contient pas encore de runtime frontend. Les routes documentées ci-dessous sont donc les contrats backend consommés par la future Brand Console et le futur Supplier Portal.

## Questionnaire catalogue

Les versions actuellement livrées sont des contrats TypeScript versionnés dans `api/_lib/questionnaires.ts` :

```text
GET /api/questionnaires
GET /api/questionnaires/:questionnaireKey?version=1.0
POST /api/data-requests/:requestId/items/from-template
```

Une demande conserve `questionnaire_key` et `questionnaire_version`. L'initialisation à partir d'un template est atomique, limitée au brouillon et idempotente par refus explicite si des items existent déjà. Les items persistés restent la copie contractuelle envoyée au fournisseur : une nouvelle version du template ne modifie jamais une demande déjà créée.

Le passage en base de données des templates pourra être ajouté avec une console d'administration et une validation de publication. Il ne doit pas changer l'instance d'un questionnaire déjà envoyée.

## Validation serveur

Avant `tracefab_submit_data_response(...)`, l'API contrôle le type de la valeur et les règles persistées de l'item :

- chaîne, nombre fini, booléen, date ISO, pays alpha-2 ;
- pourcentages bornés ;
- longueur minimale/maximale ;
- valeurs d'énumération ;
- forme de composition matière ;
- objets JSON/document non nuls.

La même valeur reste soumise à la fonction SQL et aux contrôles de rôle. Une donnée acceptée par le type n'est donc pas automatiquement vérifiée, certifiée ou conforme.

## Notifications

Les transitions suivantes créent désormais une entrée durable dans `tracefab_notification_outbox` dans la même transaction que la mutation. Le worker privé effectue ensuite la livraison Resend :

| Transition | Destinataires | Événement |
|---|---|---|
| marque envoie la demande | membres actifs du fournisseur | `request_sent` |
| fournisseur soumet la demande | membres actifs de la marque | `request_submitted` |
| marque vérifie une réponse | membres actifs du fournisseur | `response_verified` |
| marque demande des changements | membres actifs du fournisseur | `changes_requested` |

Les adresses sont dédupliquées et le payload ne contient ni token d'invitation ni secret. Le statut de livraison est suivi séparément (`pending`, `processing`, `sent`, `failed`) : une panne Resend ne revient pas sur une transition déjà committée. Les retries sont bornés à cinq tentatives ; les relances métier planifiées restent une évolution d'exploitation distincte.

## Surfaces Brand Console / Supplier Portal

Les contrôles d'accès restent dans le backend, pas dans l'interface :

- les routes de lecture et de mutation du Chantier 13 appliquent les memberships actifs ;
- les brouillons sont invisibles côté fournisseur ;
- la marque peut initialiser et envoyer une demande, puis revoir une réponse ;
- le fournisseur ne peut répondre qu'à une demande envoyée et soumettre lorsque les obligatoires sont complets ;
- toutes les mutations sensibles passent par les fonctions SQL `SECURITY DEFINER` existantes.

Une future interface peut consommer ces routes sans reproduire les règles de transition.

## Tests

```bash
npm run test:questionnaires
npm run test:email
npm run test:neon:collection
```

Le test questionnaire couvre le catalogue versionné et les formes de valeur. Le test email couvre les notifications Resend, l'échappement HTML, la déduplication et le fallback sûr. Le test Neon conserve le parcours multi-rôle du Chantier 13.
