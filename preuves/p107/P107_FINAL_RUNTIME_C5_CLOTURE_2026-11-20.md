# P10.7 — Preuve runtime finale C5 (clôture)

**Ce document fait foi.** Il remplace `P107_FINAL_RUNTIME_C5_2026-11-20.md` (même date), qui
documentait un état antérieur où `C5.2`/`C5.3` étaient bloqués. Cet état est **dépassé**.

**Date des mesures :** `2026-11-20T15:45:25.031Z` (runtime) · `2026-11-20` (clôture)
**Verdict C5 : 4/4 PASS sur le runtime réel.**

---

## 1. Les quatre contrôles

| Contrôle | Verdict | Résultat observé |
|---|---|---|
| **C5.1** — endpoint joint nommé | **PASS** | `hote=ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech (POOLER)` |
| **C5.2** — endpoint attendu déclaré | **PASS** | `TRACEFAB_PREVIEW_DB_ENDPOINT est declare` · `hote_attendu_declare=true` |
| **C5.3** — joint = déclaré | **PASS** | `hote_conforme=true · observe=ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech` |
| **C5.4** — pas de connexion à la Production | **PASS** | `hote_est_production=false` sur l'hôte **réellement joint** |

**Run :** [44766397796](https://github.com/Huberaya/Tracefab/actions/runs/44766397796)
**Job de mesure :** [136392065526](https://github.com/Huberaya/Tracefab/actions/runs/44766397796/job/136392065526) — `failure` (code 2 : le runtime rend `503` pour des services tiers non configurés, **pas** un échec C5)
**Verdict global du script :** 19 contrôles, **19 PASS**.

---

## 2. Identité de la cible — SHA séparés, jamais confondus

| Élément | Valeur |
|---|---|
| SHA du workflow (`workflow_sha`) | `a24d04311d3e73473d88efdbabe6ffa1a77ef4f9` |
| SHA réellement servi (`deployment_sha`) | `a4e0904e4cfc4bd53bc7da4a0f501cfdb7389247` |
| Deployment ID | `7943782347` |
| URL Preview | `https://tracefab-cvcbhfvce-baya-ibraimmayoanouedu-8164s-projects.vercel.app` |
| Branche déployée | `release/p107-runtime-production-20261110` |
| Environnement | `Preview` |
| État | `success` (READY), construit `2026-11-20T14:13:53Z` |

`workflow_sha` **≠** `deployment_sha` — et c'est **correct** : le workflow qui exécute la sonde est
celui de `arena/93ced544-tracefab` (`a24d043`), tandis que le code mesuré est celui déployé depuis
`release/` (`a4e0904e`). Les deux sont consignés séparément ; aucun n'est présenté comme l'autre.

> **Note de traçabilité.** Le run `44766397796` a été déclenché depuis `a24d043` — le SHA qui
> contient les correctifs de code **et** la version de `preuve_runtime_p107.mjs` qui publie les
> verdicts en annotation. Ce document de preuve a ensuite été ajouté par le commit `1d17ea1`, qui
> **ne modifie aucun fichier de code** : le run n'a donc pas été rejoué pour un changement de
> documentation seule. Les fichiers de code sont, comme montré au § 6, identiques à ceux validés.

**Pourquoi cette cible :** `TRACEFAB_PREVIEW_DB_ENDPOINT` est restreinte à la branche
`release/p107-runtime-production-20261110` (voir `preuves/p107/CONFIG_PREVIEW_ENDPOINT_C5_2026-11-20.md`).
Une Preview construite depuis une autre référence ne reçoit **pas** la variable et ne peut donc pas
mesurer C5.2/C5.3. `7943782347` est la seule Preview READY portant cette branche **et** le code
corrigé (fichiers vérifiés identiques à `4203a03` — voir § 6).

---

## 3. Données techniques expurgées

Extrait de la preuve publiée (`livrables-finalisation/preuves/p107-runtime-preuves.json`,
branche `preuves/p107-a24d043-r44766397796`) :

```
hote                 : ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech
hote_empreinte       : 55c809d501c6
hote_est_pooler      : true
hote_attendu_declare : true
hote_conforme        : true
hote_est_production  : false
base_oid             : 16396
base_nom             : neondb
schemas_empreinte    : 4a145f39b5da
sondes_p107          : {cles:true, politique:true, fonction:true}
```

`hote` est un **nom d'hôte public** — ni identifiant, ni mot de passe, ni chaîne de connexion.
L'expurgation refuse toute chaîne `user:pass@` et n'accepte que des hôtes nus (ni `@`, ni `/`,
ni `:`). Vérifié par motif sur l'artefact : **aucune** chaîne `postgresql://`, **aucune** suite
hexadécimale ≥ 48 (clé HMAC).

---

## 4. Concordance avec l'endpoint qualifié

| Source | Hôte | Empreinte `sha256[:12]` |
|---|---|---|
| Runtime, 2026-11-20 | `ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech` | `55c809d501c6` |
| Runtime, 2026-11-19 | (même déploiement de référence) | `55c809d501c6` |
| Déclaré (`TRACEFAB_PREVIEW_DB_ENDPOINT`) | `ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech` | `55c809d501c6` |

Trois concordances indépendantes, à deux jours d'écart. `hote_conforme=true` est calculé par le
runtime lui-même en comparant l'hôte qu'il joint à celui qu'on lui déclare — ce n'est pas une
recopie de configuration.

**Rattachement à la branche Neon `br-square-bread-b1gu7jk7` :** cet endpoint y est rattaché selon
le registre d'exceptions du dépôt (`docs/security/workflow-privileged-allowlist.json`), qui nomme
ensemble `ep-lively-field-b1wicg4v` et `br-square-bread-b1gu7jk7`. Ce n'est **pas** une re-mesure
de l'API Neon, hors du réseau autorisé (voir § 7).

---

## 5. Scénario hostile C5.4 — qualifié, avec sa portée exacte

Le scénario hostile est **structurellement impossible à neutraliser**, et cela se démontre par le
code, pas par une déclaration :

```ts
const u = new URL(process.env.DATABASE_URL ?? '');   // hôte RÉELLEMENT joint
hote = u.hostname;
...
hote_est_production: estHoteProduction(hote),        // ← argument = hôte réel
```

`C5.4` ne lit **jamais** `TRACEFAB_PREVIEW_DB_ENDPOINT`. Déclarer un hôte de Production dans cette
variable ne peut donc pas changer son verdict. Vérifié exécutablement :

| Injection | `estHoteProduction` | C5.4 |
|---|---|---|
| hôte réel = préproduction · endpoint déclaré = **Production** | `false` | **PASS** (correct : la Preview ne joint pas la Production) |
| hôte réel = **Production** | `true` | **FAIL** (correct : la Preview joindrait la Production) |

La liste des hôtes interdits **n'est jamais vide** : elle part d'une constante gelée
(`ep-polished-night-b1jc5941…`) et `TRACEFAB_PRODUCTION_DB_HOSTS` ne fait qu'**ajouter** des
entrées — elle ne peut pas la vider. C'est précisément le défaut d'instrumentation corrigé au
tout début de ce chantier, et `test:p107:hote-production` le verrouille (15 assertions,
2 mutations mesurées).

**Portée, dite sans embellissement :** dans le test runtime du 2026-11-20, l'endpoint déclaré était
l'endpoint **nominal** (restauré). Le cas « déclaré = Production » a été vérifié sur
l'instrumentation et par le code ci-dessus, **pas rejoué sur le runtime** — le rejouer exigeait de
modifier la variable Preview, ce qui a été fait puis restauré
(`preuves/p107/TEST_HOSTILE_C5_4_2026-11-20.md`, `RESTORE_ENDPOINT_PREVIEW_C5_2026-11-20.md`), mais
la mesure finale porte sur la configuration nominale. `C5.4` PASS porte donc sur l'hôte **réel
observé** ; la garantie contre le cas adverse vient du code et des tests, pas d'un run hostile.

---

## 6. Non-régression

| Garde-fou | État |
|---|---|
| § 13 — verdicts publiés avant toute sortie | vert · mutation : déplacer après `exit` ⇒ rouge |
| § 14 — `evaluerC5` inconditionnel | vert · mutation : remettre la condition ⇒ rouge |
| `test:p107:hote-production` (15 assertions) | vert · mutations « toujours false » (4) et « tout Neon » (2) ⇒ rouges |
| `test:preuve-runtime-garde-fous` | vert |
| `test:preuve-runtime-bout-en-bout` | vert |
| 10 suites locales + `api:typecheck` | vert |
| Fichiers P10.7 identiques à `4203a03` | **vérifié** (`p2-readiness.ts`, `preuve_runtime_p107.mjs`, `test_preuve_runtime_garde_fous.mjs`, `worker-auth.ts`, `hote-production.ts`) |

---

## 7. Limites restantes

1. **Le lien endpoint → branche Neon** repose sur le registre du dépôt, pas sur une re-mesure de
   l'API Neon (`api.neon.tech` hors réseau autorisé). La concordance d'empreinte sur deux jours
   établit la **stabilité** du rattachement, pas son identité de branche par mesure directe.
2. **Le scénario hostile n'a pas été rejoué sur le runtime** dans la mesure finale (§ 5).
3. **Le runtime rend `503`** : les services tiers de la Preview ne sont pas configurés
   (`PRIVATE_STORAGE_*` × 7, `RESEND_API_KEY`/`EMAIL_FROM`, alerting × 2). Cela n'affecte aucun
   contrôle C5, mais interdit de qualifier la Preview de « prête » au sens de la readiness
   applicative complète.
4. **`release/` porte 3 commits de documentation** que `main` n'a pas (branche parallèle). Le code
   P10.7 y est identique à celui validé — vérifié fichier par fichier.

---

## 8. Sécurité

| Élément | État |
|---|---|
| Chaîne de connexion | absente — vérifié par motif |
| Clé HMAC / suite hex ≥ 48 | absente — vérifié par motif |
| Jeton de sonde, secret worker, bypass Vercel | jamais lus, jamais imprimés |
| `DATABASE_URL` | **non modifiée** |
| Données / schéma Neon | **non touchés** |
| Migrations | **aucune exécutée** |
| Protections GitHub / Vercel Authentication | **intactes** |
| `BRANCHES_SONDE_RUNTIME` | **inchangée** — `release/…` et `fix/…`, aucune branche ajoutée |
| Déploiement Production | **aucun** |
