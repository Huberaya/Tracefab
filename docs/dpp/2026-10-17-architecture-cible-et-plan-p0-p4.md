# TRACEFAB — architecture cible du DPP et plan exécutable P0–P4

Date : 2026-10-17
Périmètre : passeport numérique textile, du produit au lot et à l'unité.
Principe directeur : **une donnée sans source est un état explicite, jamais une valeur inventée.**

## 1. Architecture cible

### 1.1 Identité et résolution

```
produit (model)
  └── variante (variant)
        └── lot (batch)
              └── unité (unit)
```

- `dpp_resolvable_identifiers` porte `public_id`, `granularity`, `status`, `replaced_by_id`.
- Un identifiant remplacé répond **308** vers l'identifiant courant ; un identifiant retiré ne résout plus.
- Le QR encode une URL de résolution stable (`/api/resolve/:publicId`), pas un identifiant interne.
- Le GTIN n'est qu'un identifiant parmi d'autres : il ne prouve ni l'origine ni la propriété.

### 1.2 Données produit

- Champs structurés par catégorie à moyen terme ; aujourd'hui un noyau commun (identité, composition, origine, poids, entretien, fin de vie).
- Chaque champ exposé publiquement porte `{ value, status, source }`.
- `status` : `sourced`, `unverified`, `not_filled`, `unavailable`.
- `source` est une **catégorie lisible** (`product_record`, `materials_record`, `brand_record`, `transaction_record`, `published_record`, `computed`), jamais un nom de table.

### 1.3 Matières et transformation

- Niveau 1 (existant) : `product_materials` (nom, pourcentage, rôle, origine déclarée).
- Niveau 2 (cible) : graphe de transformation `fil → tissu → produit`, avec quantité, site, date, preuve.
- Une étape de transformation sans preuve reste `declared` ; elle ne devient pas « traçable » par le seul fait d'être affichée.

### 1.4 Moteur d'événements

```
commande / API
   → validation de forme (route)
   → fonction SQL SECURITY DEFINER (autorisation + règles)
   → dpp_lifecycle_events (append-only)
   → projection publique en liste blanche
   → page publique / QR / wallet / export
```

- Aucun `UPDATE` ni `DELETE` sur un événement ; trigger `tracefab_reject_dpp_event_mutation`.
- Une correction est un **nouvel** événement avec `corrects_event_id`; l'ancien reste lisible.
- Les événements système (`published`, `publication_suspended`, `publication_withdrawn`, `publication_reviewed`) ne peuvent pas être forgés par un appelant : `source_kind='system'` est réservé aux fonctions de publication.
- `idempotency_key` empêche le double enregistrement d'une même action.
- La cascade est vérifiée par test : écrire un événement change l'historique public **et** la page publique, sans redéploiement.

### 1.5 Fraîcheur et validité

- Chaque payload public porte `presentation.lastUpdatedAt`.
- Une affirmation expirée est affichée avec `expired: true` et un libellé explicite ; elle n'est pas supprimée.
- Une donnée ancienne n'est pas fausse, mais elle est **signalée** : date, absence de revue, preuve contradictoire.
- Pas de score de confiance unique : un score agrégé masquerait la nature de chaque preuve.

## 2. Modèle de confiance

Niveaux, règles serveur et signification réelle. Tous sont vérifiés dans `prisma/migrations/20261017120000_dpp_trust_reviews/migration.sql`.

| Niveau | Règle serveur | Ce que cela veut dire | Ce que cela ne veut pas dire |
|---|---|---|---|
| `declared` | état initial obligatoire de toute affirmation | un acteur affirme | rien n'est vérifié |
| `documented` | ≥ 1 preuve acceptée + revue interne (owner/admin/manager/auditor) | un justificatif existe et a été accepté par la marque | pas une certification, pas un contrôle indépendant |
| `controlled` | ≥ 1 preuve acceptée + revue interne | un contrôle interne défini par TRACEFAB a été réalisé | pas un audit externe |
| `corroborated` | ≥ 2 preuves acceptées concordantes + revue interne | deux éléments indépendants se recoupent | pas une garantie d'exhaustivité |
| `third_party_verified` | revue par un organisme `verifier`, membre actif, **mandaté** par la marque, ≥ 1 preuve acceptée | un tiers identifié a contrôlé un périmètre | pas une certification produit, pas une conformité réglementaire |
| `rejected` | motif obligatoire | l'affirmation est refusée | l'affirmation n'est pas effacée, elle reste dans l'historique privé |

Règles complémentaires :

- Une affirmation ne peut pas naître avec un autre statut que `declared` (`dpp_claim_initial_status_must_be_declared`).
- Une revue est **append-only** (`dpp_claim_reviews_are_append_only`) ; le statut effectif est la dernière revue.
- Le statut public effectif vient de la dernière revue, jamais d'une écriture directe.
- Une preuve contradictoire acceptée est comptée et affichée publiquement ; elle n'est pas noyée.
- Un organisme `verifier` ne lit **aucun** document privé de la marque ; il lit l'affirmation et ses libellés publics.
- La révocation d'un mandat bloque les nouvelles revues et **conserve** les attestations passées, avec leur date.

### 2.1 Mandats

`dpp_verification_mandates` :

- `brand_organization_id`, `verifier_organization_id`, `scope`, `status` (`active`/`revoked`), `granted_by/at`, `revoked_by/at/reason` ;
- index unique sur la paire active ;
- octroi/retrait réservés aux rôles de marque, journalisés dans `audit_logs` ;
- RLS : la marque voit ses mandats, le vérificateur voit les siens.

Le mandat est la seule preuve d'autorisation d'un tiers. Il n'existe pas de « vérificateur implicite ».

## 3. Intelligence artificielle : utile, encadrée, jamais décisionnaire

L'IA n'est admise que si elle produit un gain mesurable et reste sous validation humaine.

| Usage | Entrée | Sortie | Garde-fou |
|---|---|---|---|
| Extraction documentaire | PDF de certificat, facture, rapport | champs proposés avec page et extrait | **aucune écriture** sans validation humaine ; l'extrait est conservé |
| Rapprochement | données déclarées vs documents | divergences proposées | seuil explicite, liste des règles, pas de score opaque |
| Détection de lacunes | produit + catégorie | champs manquants ou incohérents | déterministe d'abord, IA seulement pour le texte libre |
| Assistant | question d'un acteur | réponse sourcée | cite les champs/preuves, refuse de conclure sans source |
| Tâches de remédiation | lacunes | tâche assignée, échéance | l'humain choisit, l'IA ne change aucun statut |

Non-objectifs assumés :

- pas de génération de valeurs manquantes ;
- pas de statut de confiance décidé par un modèle ;
- pas d'envoi de documents confidentiels à un tiers sans base légale et information ;
- pas de blockchain : le besoin démontré est l'intégrité et l'auditabilité, pas un consensus multi-parties ; un hachage et un journal suffisent.

## 4. Expérience publique

- Mobile d'abord, lisible sans JavaScript pour le contenu statique de démonstration clairement étiqueté.
- Le passeport réel n'affiche **que** des données publiées ; les champs absents ont un libellé explicite.
- Le niveau de confiance est un texte, pas un logo ; chaque niveau a une explication.
- Les preuves publiques sont des **libellés** déclarés publics, jamais des fichiers ni des identifiants de documents.
- Une section « limites de ce passeport » liste les absences et les contradictions.
- Accessibilité : contrastes, focus, titres hiérarchisés, `aria-labelledby`, pas d'information portée par la seule couleur.
- JSON-LD généré uniquement depuis des champs `sourced` ; aucun certificat de démonstration.

## 5. Vues privées et permissions

| Acteur | Peut voir | Peut écrire |
|---|---|---|
| Marque (owner/admin) | tout le passeport privé, preuves, mandats | publier, déclarer, reviewer en interne, mandater |
| Marque (manager/auditor) | idem | reviewer en interne, déclarer ; pas de mandat (owner/admin seulement) |
| Vérificateur mandaté | affirmations + libellés de preuve, **pas les fichiers** | `third_party_verified` ou `rejected`, dans son périmètre |
| Fournisseur | ses données et demandes | ses données, pas le passeport de la marque |
| Auditeur interne | lecture | revue interne selon rôle |
| Réparateur / recycleur | cible : événements `repair`/`reuse`/`recycling` | cible : ajout d'événement avec preuve |
| Consommateur | projection publique uniquement | rien |

Les permissions sont dans les fonctions SQL et la RLS, pas dans l'affichage. L'interface ne fait que refléter ce que le serveur autorise.

## 6. Interopérabilité et base réglementaire

### 6.1 Niveau démontré aujourd'hui

- GTIN : calcul du chiffre de contrôle modulo 10, GTIN-8/12/13/14.
- GS1 Digital Link : construction `/01/{gtin}` et `/21/{serial}`, lot en `?10=`.
- **Niveau de compatibilité : structurel, non certifié GS1.** Aucun test officiel GS1 n'a été exécuté, aucune adhésion GS1 n'est prouvée.
- QR : SVG généré par `qrcode`, cible stable, en-têtes `CSP: default-src 'none'`.
- Export : payload JSON public et JSON-LD côté page. Pas encore d'export CIRPASS versionné côté serveur.

### 6.2 Réglementation

- ESPR (UE) 2024/1781 est cité par le produit ; **aucun texte officiel n'a pu être téléchargé et vérifié dans cet environnement** (accès réseau restreint). Aucune conformité n'est donc revendiquée.
- Aucun acte délégué DPP n'est implémenté comme exigence juridique.
- L'interface dit désormais « ESPR-oriented — not certified », pas « ESPR-aligned ».
- Toute exigence par catégorie/marché devra être versionnée avec sa source officielle, sa date d'entrée en vigueur et son statut (en vigueur / adopté en attente / projet / guide volontaire).

## 7. Sécurité by design

- Aucune route publique ne lit une table sans passer par une fonction/projection en liste blanche.
- `SECURITY DEFINER` avec `search_path = public` et `REVOKE ALL FROM PUBLIC` pour chaque fonction.
- RLS forcée sur les nouvelles tables ; `tracefab_app` sans `BYPASSRLS`.
- Les documents privés ne sont jamais exposés par le DPP public ; le vérificateur ne lit pas les fichiers.
- Aucun secret dans les payloads ni les logs ; les erreurs SQL sont mappées vers des codes métier.
- Les événements et revues sont immuables, donc une correction laisse une trace.
- Hachage : utile pour l'intégrité d'un export ou d'un document ; pas une preuve d'origine à lui seul.

## 8. Plan P0–P4

Chaque lot a un objectif, des fichiers, des migrations, des tests, des risques, un critère d'acceptation et une preuve. Les statuts sont ceux du 2026-10-17.

### P0 — Vérité publique et identité

**Objectif** : aucune donnée interne ou fictive dans le passeport public.

- Fichiers : `api/_lib/dpp-public.ts` (nouveau), `api/_routes/dpp/[gtin].ts`, `dpp/index.html`, `assets/js/dpp.2.js`.
- Migration : aucune.
- Tests : `scripts/test_dpp_public_projection.ts` (34 assertions), `scripts/test_dpp_public_dom.mjs` (34 assertions), `test_asset_versions.mjs`, `test_i18n_consolidation.mjs`.
- Risques : casser les champs historiques ; sur-masquer des données utiles.
- Acceptation : aucun UUID, aucun nom de table, aucun certificat de démo dans un passeport réel ; erreur réseau = aucun fallback fictif.
- Preuve : suites ci-dessus ; DOM réel avec `jsdom`.
- **Statut : fait et prouvé.**

### P1 — Confiance vérifiable

**Objectif** : un statut ne s'écrit pas, il se démontre.

- Fichiers : `prisma/migrations/20261017120000_dpp_trust_reviews/migration.sql`, `claims.ts`, `claims/[claimId]/review.ts`, `events.ts`, `api/_lib/dpp-access.ts`.
- Migration : `dpp_claim_reviews`, `dpp_verification_mandates`, fonctions de revue, triggers, RLS, projection publique des preuves.
- Tests : `scripts/test_neon_dynamic_dpp_lifecycle.mjs` (55 preuves, base réelle), `scripts/test_dynamic_dpp_lifecycle.mjs` (38 assertions statiques), `scripts/test_dpp_trust_console.mjs`.
- Risques : verrouiller trop fort et bloquer un parcours légitime ; oublier la révocation.
- Acceptation : `declared` initial obligatoire ; `documented`/`controlled` exigent une preuve ; `corroborated` deux ; `third_party_verified` exige un mandat actif ; révocation bloque le futur sans effacer le passé.
- Preuve : suite lifecycle 55/55, y compris revue tierce, refus de revue étrangère, auto-vérification refusée, preuve contradictoire exposée.
- **Statut : fait et prouvé en base ; interface privée ajoutée, non validée en navigateur.**

### P2 — Parcours privés et correction

**Objectif** : une marque peut déclarer, prouver, faire revoir, corriger et publier sans SQL.

- Fichiers : `brand-console/index.html`, `assets/js/brand-console.1.js`, routes `dpp/mandates*`, `claims*`, `events`.
- Migration : aucune supplémentaire (P1).
- Tests : `test_dpp_trust_console.mjs`, `test_brand_console.mjs`, `test_chantier5_console.mjs`.
- Risques : une interface qui appelle une route non autorisée ; statut affiché sans preuve.
- Acceptation : chaque action passe par une fonction SQL ; aucun statut saisi librement ; mandat accordé/révoqué avec motif ; événement de correction lié.
- Preuve : contrats statiques + routes typées ; captures navigateur à faire en CI.
- **Statut : implémenté, validation navigateur incomplète.**

### P3 — Interopérabilité et exports

**Objectif** : un passeport lisible par un tiers, sans surpromesse.

- Fichiers : `api/_lib/plm-erp/gtin-engine.ts`, `api/_routes/resolve/[publicId]/qr.ts`, wallet, `dpp-public.ts`.
- Tests : `test_dpp_resolvable_identity.mjs` (15 assertions), `test_dpp_quantitative.mjs`/wallet en CI.
- Risques : confondre structure GS1 et certification ; exporter un champ non publié.
- Acceptation : QR stable, 308 sur remplacement, 404 sur retiré ; export JSON-LD limité aux champs `sourced` ; niveau de compatibilité documenté.
- Preuve : tests QR/résolution + DOM JSON-LD.
- **Statut : partiel ; export CIRPASS versionné reste à faire.**

### P4 — IA utile et base réglementaire

**Objectif** : réduire le travail de collecte sans déléguer la décision.

- Fichiers cibles : `api/_routes/documents/*` (extraction), `api/_lib/document-ai*`, `docs/regulatory/*`.
- Migration cible : `dpp_extraction_proposals` (champ, extrait, page, confiance, validateur, décision).
- Tests cibles : proposition non écrite sans validation ; refus d'un document d'un autre tenant ; restitution de l'extrait.
- Risques : fuite de documents, coût par appel, hallucination, dépendance à un fournisseur.
- Acceptation : aucune valeur écrite automatiquement ; chaque proposition cite sa source ; coût plafonné par document ; repli déterministe.
- **Statut : non commencé. À faire seulement après P0–P2 stabilisés.**

## 9. Critères d'acceptation transverses A–L

| Critère | Preuve |
|---|---|
| A. Le passeport public ne montre que du publié | projection + DOM |
| B. Aucune valeur manquante inventée | états explicites + DOM |
| C. Un statut exige une preuve | triggers/fonctions + 55 preuves |
| D. Un tiers exige un mandat | mandats + suite lifecycle |
| E. Une correction n'efface rien | append-only + test correction |
| F. Le public ne voit pas le privé | projection + RLS + test documents vérificateur |
| G. Isolation multi-locataires | RLS 52 tables + 12/12 cross-tenant |
| H. QR et identité stable | 15 assertions + 308/404 |
| I. Aucune conformité inventée | badge « not certified », JSON-LD sans certificat |
| J. Interface privée utilisable | console + contrats statiques (navigateur en CI) |
| K. Tests reproductibles | commandes du rapport final |
| L. CI observable | à confirmer sur le commit final |

## 10. Décisions de scope

- **Pas de blockchain** : aucun besoin multi-parties non couvert par un journal append-only et des mandats.
- **Pas de score de confiance unique** : un score agrégé serait plus vendeur que vrai.
- **Pas de certification réglementaire** : les textes officiels ne sont pas vérifiables ici.
- **Pas d'IA décisionnaire** : l'IA proposera, l'humain validera.
- **Pas de suppression de preuve** : une preuve contradictoire est un signal, pas un détail à cacher.
