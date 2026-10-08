# Chantier 08 — Evidence Center

Statut : livré sur la branche `arena/df246958-tracefab`.
Date : 2026-10-08.

## Objectif (roadmap)

« Evidence Center : surface unifiée (upload, preview, métadonnées, liaisons,
statut de vérification), documents privés par défaut, IA documentaire avec
confirmation humaine. » Dépendance : chantier 04.

## Point de départ (audit)

- La vue Documents de la Brand Console (`documentsConsoleView()`) était
  100 % simulée : lignes codées en dur (GOTS Transaction Certificate,
  ZDHC Test Report, SMETA 4-Pillar, OEKO-TEX Standard 100), compteurs
  fictifs (142 / 48 / 36 / 24 / 34), boutons `data-demo-action`.
- `state.documents` était lu mais **jamais alimenté** : `sync()` ne
  chargeait aucun document.
- Côté API marque, il existait `POST /api/documents/upload-intent`,
  `GET /api/documents/:id/download`, `/security-report`, `/verify-ai`,
  `/verification-report` — mais **aucune liste** `GET /api/documents`
  et **aucun scan côté marque**. Pire : `upload-intent` renvoyait
  `next.scan` vers `/api/supplier/documents/:id/scan`, une route gardée
  par `currentSupplier` → 404 pour une marque.
- Le portail fournisseur possédait déjà un flux complet (liste + scan)
  servant de modèle.

## Ce qui a été fait

### API marque : liste et analyse

| Endpoint | Méthode | Comportement |
| --- | --- | --- |
| `/api/documents` | GET | Liste des documents des organisations de marque actives de l'utilisateur (`activeBrandOrganizationIds`), `status ≠ deleted`, compteurs de liaisons (`_count` : certifications, points de données, réponses, nœuds/liens de chaîne, allégations vertes, TC) et nombre de vérifications ; tri `created_at desc`, limite 500. |
| `/api/documents/:id/scan` | POST | Analyse antivirus + finalisation (`scanAndFinalizeDocument`), garde marque, contrôle de propriété ; mêmes codes d'erreur que la route fournisseur. |

Les routes sont enregistrées dans `api/index.ts` au format littéral
vérifié par `scripts/test_route_registry.mjs`.

### Correction de l'intention d'upload

`POST /api/documents/upload-intent` renvoie désormais
`next.scan → /api/documents/:id/scan` (route marque) au lieu de la route
fournisseur qui répondait 404 aux marques. La visibilité privée par défaut
reste imposée au niveau du schéma (`visibility document_visibility
@default(private)`) ; aucun secret, aucune donnée sensible exposée.

### Brand Console : centre de preuves réel

`documentsConsoleView()` est réécrite sans aucune donnée simulée :

- **Statistiques calculées** depuis `state.documents` : total, disponibles,
  en attente d'analyse, rejetés, expirant sous 90 jours.
- **Table réelle** : fichier (+ empreinte SHA-256 tronquée), type, statut,
  taille, expiration, liaisons, date d'ajout.
- **Actions réelles** : téléchargement (URL présignée via
  `GET /api/documents/:id/download`), relance d'analyse antivirus,
  rapports de vérification et de sécurité affichés dans une ligne de
  détail dépliable (chargement paresseux, état d'erreur explicite).
- **Formulaire d'upload** (fichier, type, expiration) : en mode réel,
  `upload-intent` → PUT présigné → scan → rechargement ; en mode démo,
  insertion locale annoncée comme telle.
- **Chargement non bloquant** dans `sync()` : `Promise.allSettled` après le
  lot principal ; un échec de `/api/documents` ne bloque pas la console.
- **Données de démonstration honnêtes** (`demoData()`) : quatre documents
  couvrant les statuts utiles (available, scanning), identifiants stables.

La lentille « Evidence » du détail produit (chantier 07) affiche désormais
les compteurs réels de documents de l'organisation et ouvre le centre.

### i18n

Namespace `evidence` : **51 clés × 7 langues** (en, fr, de, it, es, nl,
pt), source `scripts/_chantier08_evidence_i18n.json`, générateur
`scripts/build_evidence_i18n.mjs` additif et idempotent (test d'idempotence
ancré au niveau racine pour éviter la collision avec les clés `evidence`
imbriquées existantes). `tr` et `zh` restent des locales partielles avec
repli EN. Le français est intégralement couvert ; aucun texte métier codé
en dur dans la vue.

### Contrat statique

`scripts/test_evidence_chantier08.mjs` (8 volets, ~80 vérifications) :
API + garde, correction upload-intent, absence de tout contenu simulé dans
la vue, colonnes/actions/formulaire, sync non bloquant + démo, parité i18n,
idempotence du générateur, non-régression des routes documents existantes
et du portail fournisseur. Branché dans `npm test`
(`test:evidence:chantier08`).

## Non-régression

- Routes inchangées : `download`, `security-report`, `verification-report`,
  `verify-ai`, liste + scan fournisseur.
- Aucune migration de base de données : le schéma existant suffit.
- `npm run test:i18n` et le registre de routes passent ; le contrat du
  chantier 07 reste vert.

## Limitations connues (documentées, pas de contournement silencieux)

1. **Pas de versions de documents.** Le schéma ne contient pas de table de
   versioning ; introduire un historique de versions exige une migration —
   soumise à la règle STOP, donc non réalisée ici. L'interface ne prétend
   nulle part gérer des versions.
2. **Preview** : le téléchargement ouvre l'URL présignée ; il n'y a pas de
   visionneuse intégrée (PDF/images) à ce stade.
3. **Extraction IA** : `verify-ai` existe côté API mais n'est pas exposé
   dans la console ; conformément au mandat, aucune donnée extraite par IA
   n'est promue automatiquement — la confirmation humaine reste requise.
4. La liste est plafonnée à 500 documents (pas de pagination).

## Tests

- `npm run test:evidence:chantier08` : OK.
- `npm run test:i18n` : OK.
- `scripts/test_route_registry.mjs` : OK.
- `scripts/test_intel_chantier7.mjs` : OK (non-régression chantier 07).
- Matrice `npm test` : voir rapport — seuls les échecs préexistants liés à
  l'absence de client Prisma généré en sandbox (wallet chantier 9, storage
  chantier 10) demeurent.

## Reste à faire (chantiers suivants)

- Versioning des documents (migration dédiée).
- Visionneuse intégrée (preview sans téléchargement).
- Exposition contrôlée de `verify-ai` avec confirmation humaine.
- Liaison explicite document ↔ produit (la lentille Evidence du détail
  produit compte aujourd'hui au niveau de l'organisation).
