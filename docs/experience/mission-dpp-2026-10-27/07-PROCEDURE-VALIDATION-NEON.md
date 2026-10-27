# Procédure de validation Neon — branche `tracefab-dpp-readiness-validation-20261027`

**Statut : NON EXÉCUTÉE — aucune chaîne de connexion n'a été fournie.**
**Révision à valider :** `e52f769` · **Branche Git :** `arena/c27ddaa4-tracefab`
**Cible annoncée (dernière consigne) :** projet `autumn-breeze-47342493`, base
`neondb`, branche `br-sweet-king-b1n2f4u6` — état initial annoncé 56 migrations
réussies, 0 inachevée, 2 entrées historiques annulées.
*(Consigne antérieure : `br-late-truth-b1q7gy8j`, parent `br-broad-fog-b1rgt68c`.
La branche à utiliser est la plus récente ; l'identité se mesure, elle ne se
suppose pas.)*

> Ce document est écrit pour être exécuté **tel quel** dès que l'URL de la
> branche est disponible. Il ne contient aucun secret et n'en attend aucun dans
> un fichier versionné.

---

## 0. Pourquoi rien n'a encore été exécuté sur Neon

| Constat | Preuve |
|---|---|
| Aucune `DATABASE_URL` dans l'environnement de travail | `env` ne contient ni `DATABASE_URL` ni variable Neon ; aucun `.env` hors du dépôt |
| Le gabarit fourni contient un texte à insérer, pas une chaîne | `[INSÉRER ICI LA CHAÎNE DE CONNEXION…]` |
| L'API Neon reste injoignable depuis cet environnement | `curl https://api.neon.tech` → `000` ; `console.neon.tech` → `000` |
| Le proxy Postgres, lui, est joignable | résolution DNS de `c-5.eu-central-1.aws.neon.tech` réussie |

Conséquence appliquée : **arrêt avant toute écriture**, conformément à la
condition d'arrêt « l'identité de la base n'est pas certaine ». Aucune
supposition n'a été transformée en preuve.

**Ce qui manque, précisément :** la chaîne de connexion de la branche de
validation, et elle seule. Elle doit être fournie par un canal de secrets
(variable d'environnement injectée dans la session), jamais collée dans un
fichier du dépôt ni dans un message de rapport.

---

## 1. Vérifications déjà faites sur le dépôt (phase A)

| Point | Résultat |
|---|---|
| Branche Git | `arena/c27ddaa4-tracefab` |
| SHA de tête | `e52f7697899632686c2b510c600b92a2a812b258` |
| Arbre de travail | propre |
| Migration corrective n° 59 | `20261027130000_dpp_review_preservation_and_publication_coherence` — dernière dans l'ordre lexicographique, donc dernière appliquée |
| Migrations 57 et 58 présentes | `20261021170000_dpp_readiness_truthful_gates`, `20261027100000_dpp_quality_gate_requires_assessment` |
| Nombre de migrations au dépôt | **59** |
| Compatibilité 58 → 59 | testée : base `tf58` laissée à 58, la 59<sup>e</sup> s'ajoute seule ; les 4 revues posées avant migration **survivent** et sont mises à niveau |
| Compatibilité base déjà à 59 | testée : `tf59` recréée de zéro, 59/59, suite de non-régression verte |
| Tests | `npm test` : PASS ; `test:dpp:migrations` (PGlite, 59/59) : PASS ; `test:dpp:review-publication` : PASS ; `valider_branche_dpp` (§9 + 7 scénarios) : PASS |
| CI | run **40522253482** (SHA `e52f769`) — voir §8 |

Aucune de ces lignes ne prouve quoi que ce soit sur Neon.

---

## 2. Séquence d'exécution sur la branche de validation

Chaque étape est bloquante : si elle échoue, on s'arrête, on collecte, on
corrige, on ne contourne pas.

### 2.1 Identité de la cible (lecture seule, avant tout)

```bash
export DATABASE_URL='…'                       # canal de secrets, jamais un fichier
export TF_ATTENDU_HOTE='<hôte exact de la branche>'
export TF_ATTENDU_BASE='neondb'
export TF_ATTENDU_MIGRATIONS='<nombre attendu, mesuré au §2.2>'
npm run verifier:identite-cible
```

Le script `scripts/verifier_identite_branche.mjs` :

- refuse la production (hôte connu et tout hôte `ep-polished-night…`) ;
- refuse une cible non nommée (il ne devine jamais) ;
- compare l'hôte réel à l'hôte déclaré, la base à la base déclarée ;
- imprime le rôle effectif, `rolsuper`, `rolbypassrls`, la version serveur ;
- vérifie la présence des 6 tables et des 5 fonctions DPP ;
- lit `_prisma_migrations` : terminées, en échec, annulées, 5 dernières,
  écart avec le dépôt (en attente / inconnues) ;
- lit le profil actif et son nombre d'exigences ;
- mesure le parc en **agrégats seulement** et les trois incohérences qui
  comptent : slug sans visibilité, visibilité sans slug, publié sans revue.

Codes de sortie : `0` identité prouvée et état cohérent · `2` usage ·
`3` cible refusée · `4` identité différente de la déclaration · `5` état
incohérent (migration en échec, schéma manquant, registre en avance).

**Ce que ce script ne peut pas prouver :** que l'hôte correspond bien à la
branche `br-late-truth-b1q7gy8j`. Neon n'expose pas l'identifiant de branche à
SQL ; l'hôte de la chaîne de connexion est la seule preuve disponible, et il
doit être comparé à la console Neon par l'opérateur. C'est une limite, elle est
dite.

### 2.2 État initial mesuré (lecture seule)

```bash
DATABASE_URL='…' npx prisma migrate status      # attendu : 3 migrations en attente si la branche est à 56
```

Ne pas présumer du point de départ : le diagnostic antérieur annonçait 56
migrations en production, la branche date du 27/10 à 13:39:48Z — **mesurer**.
Si le registre ne contient pas ce qu'annonce le rapport, comparer au dépôt
avant toute migration et s'arrêter si l'écart n'est pas expliqué.

Archiver l'état initial (sortie expurgée) :

```bash
npm run verifier:identite-cible --silent > /tmp/etat-avant.txt 2>&1 || true
# puis, dans un artefact sécurisé (hors dépôt) :
#   - nombre de produits, dossiers, publiés, revus, slugs
#   - nombre de migrations terminées
#   - version du profil actif
```

### 2.3 Migration officielle

```bash
DATABASE_URL='…' npm run db:deploy    # = prisma migrate deploy
echo "code de sortie : $?"
```

- **Outil officiel uniquement.** `scripts/migrer_fidelement.mjs` sert au banc
  local parce que le CLI Prisma y est inutilisable ; il n'est **pas** un
  substitut acceptable ici.
- Ordre attendu : `20261021170000` → `20261027100000` → `20261027130000`.
- Aucune édition manuelle de `_prisma_migrations`, jamais.
- En cas d'échec : ne pas relancer. Lire le message, l'état réel du schéma et
  le registre, puis choisir une reprise sûre (restauration de branche Neon).

### 2.4 Contrôles post-migration (phase G)

```bash
DATABASE_URL='…' TF_ATTENDU_HOTE='…' TF_ATTENDU_BASE='neondb' \
  TF_ATTENDU_MIGRATIONS='<avant + 3>' npm run verifier:identite-cible
DATABASE_URL='…' node scripts/valider_branche_dpp.mjs --dry-run   # section A seule, SELECT
DATABASE_URL='…' node scripts/valider_branche_dpp.mjs             # §9 + 7 scénarios
```

Valeurs attendues :

| Contrôle | Attendu |
|---|---|
| Profil actif | `textile_readiness_mvp` v1.0, **13** exigences |
| Fonction | les 13 exigences du profil implantées ; `quality.no_open_issues` présente ; 15 clés au total (2 branches héritées) |
| Registre | **+3** migrations terminées, **0** en échec, **0** inachevée |
| Privilèges | `PUBLIC` : `false` · `tracefab_app` : `false` |
| Parc | aucune incohérence slug/visibilité, aucun publié sans revue |

### 2.5 Scénarios de non-régression (phase E)

```bash
DATABASE_URL='…' npm run test:dpp:review-publication
```

Neuf cas couvrent les points 1 à 9 de la mission ; le point 10 (isolation entre
organisations) est couvert par `npm run test:neon:rls` sur la même cible si le
rôle applicatif y est provisionné, à défaut par le contrôle d'isolation du job
CI « Base ».

Les cas 7 (produit sans évaluation) et 9 (état initial à 58) exigent un état
précis : le cas 9 ne se joue **qu'avant** la migration, ou sur une seconde
branche restée à 58. Il ne peut pas être rejoué après coup sur la même branche.

### 2.5 bis Banc d'essai sous le rôle applicatif réel (RLS)

Les autres suites se connectent en propriétaire : elles prouvent le
comportement des fonctions, pas l'accès réel de l'application. Ce banc-ci
emploie `tracefab_app`, sans `BYPASSRLS` et sans écriture directe.

```bash
TF_RLS_APP_URL='…' TF_PRODUIT_TEST='<uuid>' TF_ORG_TEST='<uuid>' \
TF_ACTEUR_TEST='<uuid>' [TF_AUTRE_ACTEUR_TEST='<uuid>'] \
  npm run test:dpp:role-applicatif
```

Il vérifie : le rôle effectif, la lecture bornée au locataire, l'isolation
vis-à-vis d'un **utilisateur non membre** (armer un autre locataire ne suffit
pas : les politiques s'appuient sur l'appartenance, pas sur le locataire actif),
le refus de l'écriture directe, l'accès aux fonctions de calcul, de revue et de
visibilité, et — après `ROLLBACK` — qu'aucune trace ne subsiste.

Les trois identifiants sont exigés parce que le rôle applicatif ne peut pas les
découvrir : `users` ne lui est pas lisible et la RLS masque le reste. C'est le
comportement voulu.

### 2.6 Simulation du parc réel (phase F)

```bash
DATABASE_URL='…' TF_SIMULATION_CIBLE='<hôte exact>' \
  node scripts/simuler_recalcul_dpp.mjs --sortie /tmp/simulation-$(date +%Y%m%d%H%M).json
```

Le script ouvre une transaction, exécute le vrai moteur, mesure, puis
**ROLLBACK**, et vérifie après coup que la base est identique (empreintes et
compteurs) ; sinon code de sortie `4`.

Il produit, par dossier et avec identifiants **pseudonymisés** (`P-xxxxxxxx`) :
statut avant/après, score avant/après, exigences manquantes, présence et
validité de l'évaluation, décision de revue, slug et visibilité avant/après,
motif métier, et un **classement** en trois catégories :

- `correction attendue` — le moteur révèle une preuve manquante préexistante ;
- `ANOMALIE TECHNIQUE` — revue perdue sans changement de score, visibilité qui
  bouge sans publication ni suspension ;
- `decision metier a confirmer`.

Il quantifie enfin : passent de « prêt » à « en cours », restent prêts, passent
à revue requise, revues conservées / invalidées, visibilités modifiées, et
**publications par effet de bord** (doit être « aucune »).

**Le recalcul réel n'est pas lancé par cette étape, ni par aucune autre de ce
document.** Il exige une décision explicite après lecture du tableau.

### 2.7 Visibilité publique (phase G, volet API)

Non prouvable ici : aucune API de validation n'est déployée dans cet
environnement, et le client Prisma généré hors ligne ne porte pas de moteur de
requête. Deux preuves sont disponibles et doivent être lues pour ce qu'elles
sont :

1. **en base** — `tracefab_product_is_public()` et les trois invariants mesurés
   par `verifier:identite-cible` ;
2. **par lecture de code** — le résolveur public
   (`api/_lib/wallet/dpp-data-resolver.ts`) applique la même conjonction
   (`public_slug` + `published` + `reviewed_at`).

Pour clore ce volet, exécuter sur un environnement déployé :

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<hôte-api>/api/dpp/<slug-publie>       # attendu 200
curl -s -o /dev/null -w '%{http_code}\n' https://<hôte-api>/api/dpp/<slug-suspendu>     # attendu 404
curl -s -o /dev/null -w '%{http_code}\n' https://<hôte-api>/api/dpp/<produit-non-publie> # attendu 404
```

Tant que ces trois appels n'ont pas été faits, le volet HTTP reste **non
prouvé** — c'est écrit ainsi dans le rapport, et cela ne changera pas sans
exécution réelle.

---

## 3. Conditions d'arrêt (rappel opérationnel)

Arrêter immédiatement, sans tenter de réparer :

- identité de la base ou de la branche incertaine ;
- la chaîne pointe vers la production ;
- une migration échoue ou laisse un état incohérent ;
- le registre ne correspond pas au dépôt ;
- les droits du rôle ne permettent pas une exécution sûre ;
- une revue valide est effacée, ou toutes les revues historiques tombent ;
- la simulation annonce une publication ou une perte de données non prévue ;
- les tests d'isolation entre organisations échouent.

---

## 4. Après la validation : préparation de la production (non exécutée)

1. Sauvegarde logique (`pg_dump --data-only`) de `dpp_requirement_profiles`,
   `dpp_records`, `tracefab_products` **et vérification de restauration** sur
   un environnement jetable — une sauvegarde non restaurée n'est pas une
   sauvegarde.
2. Précontrôles : `prisma migrate status`, `verifier:identite-cible` avec
   `TF_ATTENDU_MIGRATIONS` = état constaté, `valider_branche_dpp --dry-run`.
3. Fenêtre de faible activité ; la migration pose des verrous sur
   `dpp_requirement_profiles` et redéfinit des fonctions.
4. `npm run db:deploy` en production, par un opérateur, jamais depuis un
   environnement qui n'a pas prouvé sa cible.
5. Contrôles post-migration : les quatre du §2.4, exécutés à la main en
   production (les scripts du dépôt refusent la production, c'est voulu).
6. Surveillance 24 h : 5xx sur `/api/products/*/dpp`, `/dpp/publish-review`,
   `/dpp/publication` ; aucune écriture attendue dans `dpp_records` du fait de
   la migration elle-même.
7. Rollback : restauration de branche Neon, pas de rollback SQL. Les lignes de
   `_prisma_migrations` ne se retirent jamais à la main.

---

## 5. Modèle de rapport à remplir pendant l'exécution

| Élément | Valeur à consigner |
|---|---|
| Hôte de la branche (sans identifiants) | |
| Base | `neondb` attendu |
| Migration terminées avant / après | |
| Migrations en échec / inachevées | attendu 0 / 0 |
| Code de sortie de `db:deploy` | |
| Profil actif et nombre d'exigences | attendu v1.0 / 13 |
| `PUBLIC` / `tracefab_app` exécutent la fonction | attendu false / false |
| Produits, dossiers, publiés, revus, slugs avant / après | |
| Scénarios DPP (9 cas) | |
| Idempotence (deux passages) | |
| Dossiers simulés / modifiés | |
| Revues conservées / invalidées | |
| Visibilités modifiées | |
| Publications par effet de bord | attendu aucune |
| Codes HTTP des trois appels publics | 200 / 404 / 404 attendus |
| Confirmations | aucun recalcul réel, aucune publication réelle |
