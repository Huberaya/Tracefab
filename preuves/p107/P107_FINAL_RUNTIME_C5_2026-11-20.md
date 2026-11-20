# P10.7 — Preuve runtime finale C5

**Date/heure UTC :** `2026-11-20T12:46:54.545Z` (mesure) · rédaction `2026-11-20`
**Verdict final : P10.7 NON CLOS** — 2 contrôles sur 4 établis, 2 bloqués par une autorisation manquante.

---

## 1. Compte rendu des quatre contrôles

| Contrôle | Verdict | Preuve |
|---|---|---|
| **C5.1** — l'endpoint joint est NOMMÉ | **PASS** | `hote=ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech (POOLER)` — run [44738603681](https://github.com/Huberaya/Tracefab/actions/runs/44738603681) |
| **C5.2** — l'endpoint attendu est DÉCLARÉ | **BLOCKED** | `TRACEFAB_PREVIEW_DB_ENDPOINT est ABSENT` ; `hote_attendu_declare=false` |
| **C5.3** — l'endpoint joint = l'endpoint déclaré | **BLOCKED** | `aucun endpoint declare : la comparaison n a pas eu lieu` |
| **C5.4** — la Preview ne joint PAS la Production | **PASS** | `hote_est_production=false` sur l'hôte réellement joint |

`C5.2` et `C5.3` sont rendus **INDETERMINATE** par le protocole, et je les classe **BLOCKED** :
la mesure est impossible tant que la variable n'est pas déclarée, et cette déclaration est une
modification de configuration Vercel — **explicitement interdite** par la mission (§ 8, première
ligne). Aucun des deux n'est déclaré `PASS`.

---

## 2. Cible réellement sondée

| Élément | Valeur |
|---|---|
| SHA de `main` | `3dd164993a377960c741f3720935cb226559e641` |
| SHA réellement déployé et sondé | `4203a0398cee5fae4c40eea41aae8f09c0cd03a3` |
| Branche réellement déployée | `release/p107-runtime-production-20261110` |
| Deployment ID (cible de la mesure finale) | `7941966446` |
| URL Preview | `https://tracefab-l0bfipabs-baya-ibraimmayoanouedu-8164s-projects.vercel.app` |
| Environnement | `Preview` |
| État | `success`, construit `2026-11-20T12:45:48Z` |
| `workflow_sha` | `4203a0398cee5fae4c40eea41aae8f09c0cd03a3` |
| `deployment_sha` | `4203a0398cee5fae4c40eea41aae8f09c0cd03a3` |

`workflow_sha` **=** `deployment_sha` **=** code effectivement servi. La branche déployée est
celle de l'allowlist, sans aucune modification de celle-ci.

> **Écart assumé et documenté :** la mission désignait `dpl_8uCrigZrLHn6wc9UGhr6sE1K4XLs`
> (`3dd16499`). Cette cible a d'abord été sondée — run
> [44732047701](https://github.com/Huberaya/Tracefab/actions/runs/44732047701) — et elle a révélé
> que **C5 était totalement imesurable** sur ce code (§ 3). La mesure finale porte donc sur le SHA
> corrigé `4203a03`, conformément à la consigne « si un nouveau commit est nécessaire, attendre une
> Preview READY correspondant exactement à ce SHA ».

---

## 3. Défauts trouvés et corrigés (périmètre P10.7)

La première exécution sur la cible officielle a rendu **C1 à C4.6 tous PASS** et **aucun verdict C5**.
Pas `FAIL`, pas `INDETERMINATE` : les quatre contrôles étaient **absents**, et rien ne le signalait.

### Défaut A — la route ne publiait `baseIdentite` que sur un runtime MALADE

Condition : `wantIdentity && etatSysteme !== 'valide'`. Or `C1.1` publie `mode=signe`, donc
`etatSysteme === 'valide'`, sur un runtime sain. **Plus le runtime allait bien, moins il publiait
sur sa base.** Et la clé système n'a aucun rapport logique avec l'identité de la base jointe.

Correction : `if (wantIdentity)` — `?identity=1` reste la garde.

### Défaut B — le `catch` avalait la cause

`catch { baseIdentite = null; }` rendait le champ absent, indistinguable de « la route ne publie
pas ce champ ». Publication de `echecIdentiteBase`, limité au **code PostgreSQL** (`42501` =
permission refusée) ou `mesure_impossible`. Jamais le message brut, jamais l'URL.

### Défaut C — la sonde ne pouvait pas constater une absence

`if (corpsPourC5.baseIdentite?.identite_base) evaluerC5(...)` : l'appel était conditionné à
l'existence de la donnée qu'il doit juger. Un contrôle qui ne peut pas constater une absence ne
signale jamais un champ manquant — il disparaît en silence. Correction : appel inconditionnel.

### Défaut D — la preuve était illisible (4ᵉ occurrence du même défaut de position)

Trois runs ont produit une preuve que personne ne pouvait lire : artefact servi par un blob store
hors réseau (0 octet reçu), journal du job en `EOF`, branche `preuves/` non poussée en cas de sortie
en 2. Les verdicts sont désormais publiés en **annotation** (API checks, lisible partout), et la
publication est placée **avant** le `process.exit(2)` — quatrième fois que ce fichier plaçait un
contrôle après une sortie.

### Non-régression

| Garde-fou | Vérification |
|---|---|
| § 13 — verdicts publiés avant toute sortie | mutation : déplacer après `exit` ⇒ `publication=-1`, test rouge |
| § 14 — `evaluerC5` inconditionnel | mutation : remettre la condition ⇒ test rouge |
| `api:typecheck` | aucune erreur sur les fichiers touchés |
| 10 suites locales + contrat d'identité | rc=0 |

**Commits :** `4203a03` (correctif principal), `ffcd8f5` (publication des verdicts).
**PR :** [#134](https://github.com/Huberaya/Tracefab/pull/134) — CI **4/4 verte**
([run 44736009523](https://github.com/Huberaya/Tracefab/actions/runs/44736009523)).

---

## 4. Ce que C5.1 et C5.4 établissent, exactement

**C5.1 — l'endpoint est nommé.** Le runtime a extrait `hostname` de la chaîne qu'il utilise
réellement, et l'a publié après expurgation :

```
hote               : ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech
hote_est_pooler    : true
base_oid           : 16396
base_nom           : neondb
hote_empreinte     : 55c809d501c6
```

**C5.4 — la Preview ne joint pas la Production.** `hote_est_production = false`, calculé sur le
code déployé, contre l'hôte de Production du dépôt. Le scénario hostile (opérateur déclarant un
hôte de Production) a été vérifié **sur l'instrumentation** : sur doublure, `C5.3` rend `PASS` et
`C5.4` rend `FAIL`. **Ce n'est pas une preuve runtime et je ne la compte pas comme telle** — le
scénario hostile ne peut pas être rejoué sur le runtime sans modifier la configuration, ce qui est
interdit.

### Concordance indépendante

L'hôte observé aujourd'hui produit exactement l'empreinte observée le 2026-11-19 :

```
sha256("ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech")[:12] = 55c809d501c6
empreinte publiée par le runtime le 2026-11-19                                = 55c809d501c6
```

Deux mesures indépendantes, **deux jours d'écart**, même hôte, même empreinte. Le rattachement de
la Preview à cet endpoint est donc stable, pas un artefact d'un déploiement.

> **Portée :** cela établit que la Preview joint **cet hôte**, de façon reproductible. Le lien de
> cet endpoint vers la branche Neon `br-square-bread-b1gu7jk7` reste appuyé sur le registre
> d'exceptions du dépôt (`docs/security/workflow-privileged-allowlist.json`), qui les nomme ensemble ;
> ce n'est pas une re-mesure de l'API Neon, qui est hors du réseau autorisé.

---

## 5. Le blocage, et l'unique action qui le lève

**Bloqué :** `C5.2` et `C5.3`.

**Cause technique exacte :** la variable `TRACEFAB_PREVIEW_DB_ENDPOINT` **n'est pas déclarée** dans
l'environnement Preview de Vercel. Le runtime le dit lui-même : `hote_attendu_declare=false`,
`hote_conforme=null`. Le protocole rend `INDETERMINATE` — correctement, ce n'est pas un défaut
applicatif mais un état de configuration.

**Pourquoi je ne le corrige pas :** poser cette variable est une **modification de variable
d'environnement Vercel**, que la mission interdit sans autorisation distincte (§ 8). Le connecteur
Vercel disponible refuse d'ailleurs la lecture et l'écriture (`list_projects` ⇒ *Access denied*,
`create_env_var` inaccessible) et l'API GitHub refuse la lecture des variables (403).

**Action minimale unique :** déclarer, dans l'environnement **Preview** de Vercel, pour la branche
`release/p107-runtime-production-20261110` :

```
TRACEFAB_PREVIEW_DB_ENDPOINT = ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech
```

Puis reconstruire la Preview (Vercel ne réinjecte pas une variable dans un déploiement existant) et
relancer :

```bash
gh workflow run p107-preuves-runtime.yml --ref arena/93ced544-tracefab \
  -f sha_attendu=<SHA de la Preview reconstruite> \
  -f branche_deployee=release/p107-runtime-production-20261110
```

Les quatre contrôles sortiront alors sur le même code : `C5.1` et `C5.4` déjà `PASS`, et
`C5.2`/`C5.3` deviendront mesurables. **Aucune modification de code n'est requise** — le correctif
est fait et déployé.

---

## 6. Sécurité et périmètre

| Élément | État |
|---|---|
| Chaîne de connexion dans l'artefact | **absente** — vérifié par motif |
| Suite hexadécimale ≥ 48 (clé HMAC) | **absente** — vérifié par motif |
| `user:pass@` | **absent** — vérifié par motif |
| Allowlist `BRANCHES_SONDE_RUNTIME` | **inchangée** (`release/…` et `fix/…` seules) |
| Vercel Authentication | **intacte** — contournement déjà en place, non modifié |
| Production / Neon / données / migrations | **non touchées** |
| Variables et secrets Vercel | **non modifiés** |
| Fusions hors processus de revue | **aucune** — PR #134 ouverte, CI verte, revue non forcée |

### Opérations de branche effectuées, toutes réversibles

| Opération | Détail |
|---|---|
| `release/p107-runtime-production-20261110` → `4203a03` | alignement sur le SHA corrigé (mission § 2 confie cette branche comme cible de sonde) |
| `backup/p107-release-before-main-alignment-20261120` | `599cbd87` — sauvegarde préexistante, **non touchée** |
| `backup/p107-release-before-fix-20261120` | `3dd16499` — sauvegarde créée **avant** l'alignement |

---

## 7. Limites restantes

1. **`C5.2` et `C5.3` ne sont pas établis.** Aucune preuve runtime du rattachement *comparé*.
2. **Le scénario hostile C5.4 n'a pas été rejoué sur le runtime.** L'instrumentation est vérifiée
   (mutation mordante côté code), mais rejouer le scénario exigerait de déclarer une variable
   interdite. `C5.4` `PASS` porte donc sur l'hôte réel observé, pas sur le cas adverse.
3. **Le lien endpoint → branche Neon** repose sur le registre du dépôt, pas sur une re-mesure Neon.
4. **La PR #134 n'est pas fusionnée** : `mergeStateStatus=UNSTABLE`, revue requise non satisfaite.
   Le SHA corrigé n'est donc pas dans `main` — il est déployé depuis `release/`.
5. **Les services tiers de la Preview restent non configurés** (`PRIVATE_STORAGE_*` × 7,
   `RESEND_API_KEY`/`EMAIL_FROM`, alerting × 2) : le runtime rend `503`. Cela n'affecte pas C5, mais
   interdit de déclarer la Preview « prête » au sens de la readiness applicative.

---

## 8. Verdict

**P10.7 NON CLOS.** Deux contrôles sur quatre sont établis sur le runtime réel (`C5.1`, `C5.4`),
deux sont bloqués par une déclaration de configuration que la mission interdit de faire. Un seul
geste — poser une variable non secrète dans l'environnement Preview — suffit à débloquer les deux
derniers, sans toucher au code.

Annoncer la clôture ici serait exactement le faux vert que ce chantier existe pour supprimer.
