# Chantier 09 — Certification Intelligence

Statut : livré sur la branche `arena/df246958-tracefab`.
Date : 2026-10-08.

## Objectif (roadmap)

« Certification Health (valid/expiring/expired/missing/needs review), veille
d'expiration actionnable, vue marque des certificats. » Dépendance : 05.

## Point de départ (audit)

- Le schéma et le backend étaient déjà riches : table `certifications`
  (propriétaire, référentiel, numéro, émetteur, dates, preuve liée, statut
  `data_value_status`, `last_verified_at`), fonctions SQL
  `tracefab_register_certification` / `tracefab_update_certification` /
  `tracefab_review_certification` (rôles contrôlés, écriture d'un
  `verification_record` à chaque revue), catalogue **versionné** des
  référentiels (`catalog/certification-standards/2026.10.json` + route
  publique `/api/catalog/certification-standards`).
- Le portail fournisseur possédait déjà liste / création / mise à jour /
  OCR / auto-verify IA de ses propres certificats.
- Côté marque : **aucune API** (`state.certifications` n'était jamais
  alimenté en mode réel) ; la vue Certifications de la console affichait
  uniquement les données de démo, le bouton « Déclarer » était un bouton
  simulé ; la veille d'expiration existait mais dérivait de données
  jamais chargées.

## Ce qui a été fait

### API marque

| Endpoint | Méthode | Comportement |
| --- | --- | --- |
| `/api/certifications` | GET | **Vue marque des certificats** : certificats des organisations de marque actives + certificats des fournisseurs liés par une relation active (`brand_supplier_relationships.status = 'active'`), nom de l'organisation propriétaire, drapeau `ownedByBrand`, compteur de vérifications ; tri `created_at desc`, limite 500. |
| `/api/certifications` | POST | Déclaration d'un certificat propre à la marque via `tracefab_register_certification` (la fonction SQL contrôle rôle + authentification et dérive `declared`/`documented` de la présence d'une preuve). La preuve associée doit être un document `available` de la marque. |
| `/api/certifications/:id/review` | POST | **Revue humaine** via `tracefab_review_certification` : décision bornée (`passed`/`failed`/`needs_review`/`expired`), méthode obligatoire (piste d'audit), insertion d'un `verification_record`. Limitée aux certificats appartenant aux organisations marque de l'utilisateur — la revue des certificats fournisseurs reste dans le portail fournisseur. |

Routes enregistrées dans `api/index.ts` au format vérifié par
`scripts/test_route_registry.mjs`.

### Brand Console : santé, veille, couverture, actions

`certificationsConsoleView()` réécrite sans aucun bouton simulé :

- **Certification Health** : compteurs calculés — total, valides,
  expirant sous 90 jours, expirés, à vérifier — dérivés des statuts
  enregistrés et des dates réelles (priorité : expiré > expirant > à
  vérifier > valide) ; badge de santé par certificat.
- **Veille d'expiration actionnable** : liste triée des échéances ≤ 90 j
  avec prochain renouvellement, et règle de fonctionnement explicite
  (« TRACEFAB prépare et suit, sans garantir la conformité
  réglementaire »).
- **Couverture du catalogue** : comparaison **informative** avec le
  catalogue versionné des référentiels (couverts / non couverts),
  explicitement étiquetée « pas une exigence de conformité ».
- **Table réelle** : référentiel (+ code), numéro, émetteur, propriétaire
  (marque ou fournisseur), expiration, statut `data_value_status`, santé,
  nombre de vérifications, action de revue pour les certificats marque.
- **Déclaration** : formulaire complet (référentiel avec datalist du
  catalogue, numéro, émetteur, dates, preuve associée issue de
  l' Evidence Center) ; en mode réel → POST `/api/certifications`, en
  démo → insertion locale annoncée comme telle.
- **Revue humaine en ligne** : ligne dépliable par certificat marque
  (décision, méthode, notes) avec rappel permanent que la vérification
  est toujours décidée par un humain.
- Chargement **non bloquant** dans `sync()` (`Promise.allSettled` :
  certifications + catalogue). Données de démonstration enrichies
  (statuts variés, dont un certificat expiré appartenant à un
  fournisseur).

### Cohérence avec le chantier 07

La lentille Certifications du détail produit consomme désormais la forme
normalisée (`certNorm`) et affiche le badge de santé ; en-têtes de
colonnes i18n.

### i18n

Namespace `certifications` : **64 clés × 7 langues**, source
`scripts/_chantier09_certifications_i18n.json`, générateur
`scripts/build_certifications_i18n.mjs` (additif, idempotent, ancré au
niveau racine, purge de virgule finale — hérite des correctifs du
chantier 08). FR intégralement couvert ; aucun texte métier en dur.

### Contrat statique

`scripts/test_certifications_chantier09.mjs` (6 volets, ~80
vérifications) : API + garde, honnêteté de la vue, vocabulaire
« préparation » (jamais de promesse de conformité, jamais de promotion
automatique), parité i18n, idempotence du générateur, non-régression des
routes fournisseur/catalogue et des chantiers 07/08. Branché dans
`npm test` (`test:certifications:chantier09`).

## Non-régression

- Routes fournisseur intactes (liste, détail, OCR, auto-verify) ;
  catalogue versionné inchangé ; Command Center (pilule « certifications
  expiring ») et veille historique `certJours` conservés.
- Aucune migration : les fonctions SQL existantes suffisent.
- Contrats des chantiers 07 et 08 toujours verts ; registre de routes et
  consolidation i18n OK.

## Limitations connues (documentées)

1. **« Missing »** : la catégorie *missing* de la roadmap supposerait un
   référentiel d'exigences (par produit ou par DPP). Aucun modèle de ce
   type n'existe en base ; inventer des exigences contreviendrait au
   mandat. La couverture du catalogue versionné fournit l'indicateur
   approchant, étiqueté informatif.
2. **Mise à jour d'un certificat** : la fonction
   `tracefab_update_certification` existe mais n'est pas encore exposée
   côté marque (le portail fournisseur a son PATCH).
3. La revue marque est limitée aux certificats appartenant à la marque
   (contrainte de la fonction SQL : rôle requis dans l'organisation
   propriétaire) ; la revue des certificats fournisseurs se fait dans le
   portail fournisseur.
4. Pas de notification push automatique des échéances dans ce chantier —
   la veille est affichée dans la console et le Command Center.

## Tests

- `npm run test:certifications:chantier09` : OK.
- `npm run test:i18n`, `scripts/test_route_registry.mjs`,
  contrats chantiers 07/08 : OK.
- Matrice `npm test` : voir rapport — seuls les échecs préexistants liés
  à l'absence de client Prisma généré en sandbox demeurent.

## Reste à faire (chantiers suivants)

- Exposer la mise à jour côté marque (PATCH).
- Notifications d'échéance branchées sur l'outbox existant.
- Référentiel d'exigences par produit/DPP pour une catégorie « missing »
  fondée sur les données.
