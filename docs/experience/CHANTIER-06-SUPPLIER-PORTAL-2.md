# Chantier 06 — Supplier Portal 2.0

Statut : livré sur la branche `arena/df246958-tracefab`.
Date : 2026-10-08.

## Objectif (roadmap)

« Dashboard “WHAT DO I NEED TO DO?”, wizard onboarding 9 étapes,
completeness en direct, gestion des partages par marque (API `data_shares`
à exposer), mobile-first. »

## Principes directeurs

1. **Vérité des données.** Toutes les tâches, étapes et partages affichés
   sont dérivés de l'état déjà chargé par le portail (`state.requests`,
   `state.caps`, `state.certifications`, `state.shares`, profil, sites,
   matières, documents, membres, passeport). Aucune donnée inventée, aucun
   nouvel appel API. Deux replis factices existants ont été supprimés :
   `state.shares?.length || 4` (KPI partages) et la variable morte
   `profileCompletion || 82`.
2. **Ne rien casser.** L'onboarding autonome existant
   (`selfOnboardingView` → `POST /api/supplier/onboarding`) est conservé
   intact : son contrat historique (`test:onboarding:chantier6`) reste vert.
3. **Honnêteté sur les partages.** L'API `data_shares` n'expose que GET et
   POST ; il n'existe aucune route de révocation. La nouvelle vue montre
   donc les partages en lecture (marque, périmètre, statut, période) et dit
   explicitement que l'octroi et la révocation sont gérés par chaque marque
   — aucune action de révocation simulée.
4. **i18n complet.** Namespace `portal2` : 47 clés × 7 langues
   (EN/FR/DE/IT/ES/NL/PT), FR irréprochable. TR/ZH, locales partielles du
   portail, bénéficient du repli anglais automatique de tf-i18n.
5. **Mobile-first.** Médias queries dédiées ≤ 720 px pour les nouveaux
   composants (tâches, étapes, partages), `prefers-reduced-motion` respecté.

## Ce qui a été ajouté

| Fichier | Rôle |
| --- | --- |
| `assets/design-system/tracefab-portal2.css` | Styles `.sp2-*` : cartes de tâches par sévérité, stepper 9 étapes avec barre de progression, cartes de partage avec chips de périmètre, responsive + reduced-motion. |
| `scripts/_chantier06_portal2_i18n.json` | Source unique des 47 clés × 7 langues. |
| `scripts/build_portal2_i18n.mjs` | Générateur additif/idempotent borné au namespace `portal2`. |
| `scripts/test_portal2_chantier6.mjs` | Test de contrat (6 volets). |
| `package.json` | Script `test:portal2:chantier6` ajouté à la chaîne `npm test`. |

## Ce qui a été modifié (supplier-portal/index.html uniquement)

- **Dashboard « WHAT DO I NEED TO DO? »** (`todoTasks`/`todoSection`) dans
  l'overview : tâches priorisées par sévérité, toutes dérivées de l'état —
  demandes en retard (critique), échéance ≤ 7 jours (avertissement),
  demandes `in_progress` à répondre (info), CAP ouverts, certifications
  expirant sous 60 jours, dimension du profil sous le seuil de 70 %. Chaque
  tâche est cliquable : ouverture réelle de la demande (`data-request-id`)
  ou navigation vers la vue concernée (`data-view`). État vide dédié quand
  rien n'est à faire.
- **Onboarding guidé 9 étapes** (`onboardingView`, nouvelle entrée de
  navigation ⚑) : barre de progression `n/9` calculée en direct ; chaque
  étape est un fait vérifiable : complétude profil ≥ 80 %, activités
  déclarées, au moins un site, des matières, des certifications, des
  preuves, une équipe (> 1 membre), une réponse soumise à une marque, un
  passeport configuré. L'étape courante est mise en évidence et chaque étape
  à faire propose un bouton d'ouverture vers la vue correspondante.
- **Partages de données par marque** (`sharesView`, nouvelle entrée de
  navigation ⇄) : liste des partages lus dans `state.shares` (chargés depuis
  `GET /api/supplier/shares`) avec marque, chips de périmètre, statut,
  période (date de fin ou « sans date de fin ») et date de création ; état
  vide et note d'honnêteté sur la gestion côté marque.
- **Overview** : suppression du repli factice `|| 4` sur le KPI des
  partages et de la variable morte `completionPct || 82` ; la completeness
  en direct existante (`spProgressPanel`, dérivée de `profileCompletion` /
  score qualité) reste affichée au-dessus des tâches.

## Ce qui a été supprimé

Deux valeurs factices uniquement (`|| 4`, `|| 82`). Aucune fonctionnalité.

## Contrats vérifiés par `scripts/test_portal2_chantier6.mjs`

1. CSS `.sp2-*`, mobile-first, reduced-motion.
2. Dashboard : dérivations depuis l'état, clics réels, replis factices
   absents, état vide.
3. Onboarding : exactement 9 étapes, chacune dérivée d'un fait d'état, vue
   câblée au rendu, et les cinq marqueurs de l'onboarding historique
   vérifiés intacts.
4. Partages : lecture exclusive de `state.shares`, scope réel affiché, état
   vide, aucune révocation inventée (pas de DELETE dans l'API).
5. i18n : 47 clés × 7 langues paritaires ; bloc présent dans en.js et les
   six locales complètes ; TR/ZH exclus (repli EN).
6. Générateur : idempotent, sans motif de suppression.

## Non-régression

- Matrice hors-ligne : **23/25 suites PASS**, dont
  `test:onboarding:chantier6` (contrat backend onboarding) et
  `test:supplier-portal`. Les 2 échecs (`test:wallet:chantier9`,
  `test:storage:chantier10`) proviennent de l'impossibilité de générer le
  client Prisma dans la sandbox — identiques sur le commit de base.
- `npm run test:i18n` vert ; garde générateurs OK.
- Aucune route API, migration ou schéma modifiés.

## Limitations connues

- La gestion des partages est en lecture seule côté fournisseur : la
  création de partage (`POST /api/supplier/shares`) exige un `relationshipId`
  qu'aucune route ne permet aujourd'hui de lister côté fournisseur, et la
  révocation n'existe pas dans l'API. Un chantier dédié (API relationships +
  DELETE `data_shares` avec isolation tenant) est nécessaire pour une
  gestion complète — à programmer avec le chantier sécurité.
- L'onboarding guidé est une checklist dérivée de l'état, pas un formulaire
  séquentiel bloquant : c'est volontaire, car chaque étape correspond à une
  vue fonctionnelle existante.
- TR/ZH utilisent le repli anglais pour `portal2.*` (politique locales
  partielles).

## Prochaine étape suggérée

Chantier 07 de la roadmap : **Product Intelligence réelle** (fiche produit
11 lentilles branchée sur l'API, actions produit) — à confirmer avec
l'utilisateur.
