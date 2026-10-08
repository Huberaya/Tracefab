# Chantier 12 — TRACEFAB Intelligence : moteur de questions sur données réelles

> Statut : LIVRÉ · Dépendance respectée : Chantier 05 (données produit) + Chantier 09 (certifications) + Chantier 08 (documents).
> Principe fondateur : **aucune génération de texte, aucun LLM**. Le moteur est
> déterministe : une liste fixe d'intentions, chacune étant un calcul explicite
> sur les tables réelles du tenant. Le serveur ne retourne que des faits ; le
> client formule les phrases et traduit. Une réponse ne peut donc jamais être
> inventée.

## 1. Ce qui existait (verdict d'audit)

La vue « ✦ TRACEFAB Intelligence » de la Brand Console (`intelligenceView()`)
était **100 % simulée** :

| Élément | Verdict |
|---|---|
| Badge « AGENTIC TEXTILE REASONING ENGINE · ZERO HALLUCINATION » | Marketing absolu sans fondement |
| Réponse unique codée en dur (SKUs AW26, TCs, empreintes SHA-256 inventées) | FAUX |
| Quatre puces de suggestions avec `onclick="askIntel(...)"` | FAUX (prompts fictifs) |
| `askIntel(q)` / `submitIntelQuery()` | Stubs : recopient la question et ré-affichent la même réponse fabriquée |
| Badge « Verified Synthesis » | FAUX (aucune vérification) |
| API `/api/intel/*` | **Inexistante** — aucune route |

Rien dans cette vue n'était réel. Elle violait frontalement le mandat :
« les réponses IA doivent citer leurs sources et distinguer Known / Inferred /
Missing / Needs review ; ne jamais inventer de risque ou de donnée ».

## 2. Ce qui a été ajouté

### 2.1 API — `GET /api/intel/ask` (`api/_routes/intel/ask.ts`, nouveau)

- **Méthode** : GET uniquement. Paramètres : `intent` (obligatoire), `windowDays`
  (facultatif, encadré entre 1 et 365, défaut 45).
- **Six intentions** (liste fixe, toute autre valeur → `400 invalid_intent`) :
  1. `certificates_expiring` — certificats expirant dans la fenêtre
     (Known) **et** certificats sans date d'expiration (Missing) ;
  2. `certificates_expired` — certificats déjà expirés (Known) ;
  3. `certifications_needs_review` — certifications en statut
     `declared`/`needs_review` (Needs review) ;
  4. `products_missing_data` — produits `not_started` ou complétude < 50 %
     (Missing) et produits `needs_review` (Needs review) ;
  5. `documents_pending` — documents `uploaded`/`scanning` (Known) ou
     `rejected` (Needs review) ;
  6. `evidence_unlinked` — documents `available` dont tous les compteurs de
     liens sont à zéro (Inferred — déduction par une règle explicite).
- **Isolation tenant** : `requireClerkUser` puis `withTracefabUserContext` ;
  périmètre = organisations de marque actives (`activeBrandOrganizationIds`)
  + organisations fournisseurs liées actives. Marque sans organisation →
  `200` avec résultat vide (jamais 404/500).
- **Plafond** : 100 résultats (`FINDING_LIMIT`), requêtes bornées (`take: 300`).
- **Réponse** : `{ intent, windowDays, computedAt, basedOn { certifications,
  products, documents }, findings[] }` — chaque finding porte
  `{ category: known|inferred|missing|needs_review, entityType, id, label,
  sub, daysLeft, expiresAt }`. Les identifiants sont ceux des vraies lignes
  Prisma : rien n'est fabriqué.
- **Erreurs** : 401 non autorisé d'abord, puis `sqlBusinessError`, puis
  `missing_clerk_secret_key` → 503, sinon 500 journalisé.
- **Zéro LLM** : aucun appel sortant (`fetch`), aucun aléatoire, aucune
  bibliothèque de génération. Le contrat statique le vérifie.

### 2.2 Brand Console — vue réécrite (bloc Chantier 12)

- Héros honnête : « moteur de questions déterministe sur vos données
  enregistrées » + garde-fou explicite (aucun chiffre/risque/preuve inventé,
  chaque résultat cite ses enregistrements sources). Le badge marketing et la
  réponse codée en dur sont **supprimés**.
- Six intentions cliquables (`data-action="intel-ask"`), état actif visible.
- **Saisie libre** : formulaire `#intel-ask-form` ; `iaMatchIntent()` rattache
  la question à une intention par mots-clés multilingues (EN/FR/DE/IT/ES/NL/PT).
  Si aucune intention ne correspond → panneau honnête **« Cette question n'est
  pas encore couverte »** expliquant que la génération libre est volontairement
  indisponible. Le moteur ne prétend jamais comprendre ce qu'il ne calcule pas.
- **Panneau de réponse** : résumé localisé (comptes interpolés), badges des
  quatre catégories avec leurs compteurs, table des résultats (entité, détail,
  jours restants, lien profond vers Certifications / fiche produit /
  Documents), ligne **« Based on »** : nombre d'enregistrements de
  certifications, produits et documents réellement consultés + horodatage du
  calcul, légende épistémique Known / Inferred / Missing / Needs review avec
  rappel que TRACEFAB ne promeut rien automatiquement.
- **Mode démo** (`?demo=1`) : `intelDemoAnswer()` calcule les mêmes règles côté
  client à partir de l'état démo réel (certifications, produits, documents) —
  jamais de réponse pré-écrite.
- États `intelQuery / intelAnswer / intelState / intelLoading / intelError`
  ajoutés ; gestion chargement / erreur localisée.

### 2.3 i18n — namespace `intelAsk` (nouveau, 38 clés × 7 langues)

`hero.*`, `intents.*` (6), `input.*`, `notCovered.*`, `answer.*` (7),
`category.*` (4), `legend.note`, `table.*` (4), `summary.*` (6, avec
interpolation `{count}/{days}/{missing}`), `sources.*` (3, `{n}`).
Source : `scripts/_chantier12_intel_ask_i18n.json` ; générateur
`scripts/build_intel_ask_i18n.mjs` (idempotent) ; injection dans
`assets/i18n/en.js` + 6 locales JSON. Mise à jour Chantier 15 : les fichiers
`tr.json`/`zh.json` partiels ont depuis été retirés du produit.
Le helper console `ia(key, vars)` traduit via `TF_I18N` et interpole.
Aucun texte métier codé en dur dans la vue.

## 3. Ce qui a été supprimé

- La réponse codée en dur (faux SKUs, faux TCs, fausses empreintes SHA-256).
- Le badge « AGENTIC TEXTILE REASONING ENGINE · ZERO HALLUCINATION ».
- Les quatre puces de suggestions fictives et leurs `onclick` inline.
- Les stubs `askIntel(q)` / `submitIntelQuery()` et l'ancien champ
  `intel-query-input`, l'état `activeIntelQuery/activeIntelAnswer`.
- Les clés de suggestions IA factices ne sont plus référencées par la vue
  (les clés `iaIntro` existantes restent utilisées pour l'introduction).

## 4. Ce qui n'a PAS changé (non-régression vérifiée)

- Navigation « ✦ TRACEFAB Intelligence » et son routage (identiques).
- Namespace `intel` du Chantier 07 (Product Intelligence de la fiche produit) :
  intact, vérifié par le contrat.
- Aucune autre vue, aucune route existante, aucun schéma Prisma modifié.
- README : libellé « Notification Observability » préservé.

## 5. Tests

- `scripts/test_intel_chantier12.mjs` — contrat statique (~65 vérifications,
  7 volets) : API déterministe (méthode, intentions, fenêtre, isolation,
  plafond, catégories, erreurs), **absence de tout LLM** (aucune référence
  openai/anthropic/gpt/claude/completion/prompt, aucun `fetch`, aucun
  `Math.random`), routeur, vue réelle, suppression des fakes, i18n parité
  7 langues, générateur idempotent, non-régression. **OK, stable ×3.**
- Contrats Chantiers 07, 08, 09, 10, 11 : **OK** (relancés).
- `npm run test:brand-console` et `npm run test:i18n` : **OK**.
- Script npm : `test:intelask:chantier12`, ajouté en fin de chaîne `test`.

## 6. Limitations assumées

- Le moteur répond à **six** questions. C'est volontaire : chaque intention est
  un calcul auditable. Étendre la liste = nouvelle intention déclarée côté
  serveur, jamais de compréhension du langage naturel.
- Le rattachement de la saisie libre est une correspondance par mots-clés
  (multilingue mais simple). Une question ambiguë tombe dans « non couverte » :
  c'est le comportement honnête exigé par le mandat.
- `windowDays` est fixé côté console à 45 jours (l'API accepte 1–365).
- Pas de LLM : pas de synthèse narrative, pas de recommandation probabiliste —
  conforme au principe « ne jamais inventer de risque ».

## 7. Suite (backlog)

- Historiser les questions posées (table `intel_queries`) pour un audit trail.
- Intentions supplémentaires candidates : fournisseurs sans certification
  active, réponses de données en retard, DPP readiness par produit.
- Option : exposer `windowDays` dans l'UI.
