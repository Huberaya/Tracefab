# P10.7 — Contrat de configuration de la Preview

Ce document répond à une question précise : **quelles variables la sonde runtime
exige-t-elle, et que se passe-t-il quand l'une manque ?** Il existe parce que le
diagnostic du 2026-11-17 (`configurationSuffisante: false`,
`identiteSaine: true`) ne dit pas *quelle* variable bloque *quel* critère.

Aucune valeur n'y figure. Le nom, l'emplacement et l'effet suffisent.

## 1. Les trois portes, dans l'ordre où elles s'ouvrent

La route `GET /api/internal/p2/readiness?identity=1` franchit trois étapes
distinctes. Les confondre est l'erreur qui a produit les faux diagnostics
précédents.

| Étape | Décidée par | Refus | Origine d'un échec |
| --- | --- | --- | --- |
| 1. Accès au déploiement | Vercel Authentication + contournement d'automatisation | `302` vers `vercel.com/sso-api` | **Vercel**, pas l'application |
| 2. Autorisation de la sonde | `TRACEFAB_RUNTIME_PROBE_TOKEN` (en-tête), `VERCEL_ENV=preview`, branche dans la liste gelée | `401 worker_unauthorized` | **configuration** du secret de sonde |
| 3. Contenu de la réponse | `configured_` (services) et `identitySafe` (rôle PG) | `503`, corps `tracefab-p2-readiness-v1` | **configuration des services** ou **identité** |

**Conséquence pratique** : un `302` n'est jamais un refus applicatif ; un `401`
n'est jamais un problème d'identité ; un `503` n'est jamais un problème de jeton.

## 2. Variables qui décident l'accès (étape 1)

| Variable | Emplacement | Obligatoire | Consommée par | Si absente | Effet sur C1–C4 |
| --- | --- | --- | --- | --- | --- |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | **GitHub Actions secret** | Oui pour toute preuve automatisée | `scripts/preuve_runtime_p107.mjs` (en-tête `x-vercel-protection-bypass`) | La Preview répond `302` ; aucun verdict n'est rendu | **C1–C4 : BLOCKED** |
| *(côté Vercel)* Protection Bypass for Automation | Vercel → Settings → Deployment Protection | Oui | Vercel lui-même | Le secret GitHub ne correspond à rien | **C1–C4 : BLOCKED** |

**Sécurité** : ni la valeur ni un fragment ne sont journalisés. Le workflow
mesure la **présence** (`[ -n "$BYPASS" ]`), jamais le contenu.

**Rotation** : une valeur ayant figuré dans une conversation est compromise.
Procédure : `docs/security/p107-acces-preview-vercel.md` § 6.

## 3. Variables qui autorisent la sonde (étape 2)

| Variable | Emplacement | Obligatoire | Consommée par | Si absente | Effet |
| --- | --- | --- | --- | --- | --- |
| `TRACEFAB_RUNTIME_PROBE_TOKEN` | **GitHub secret** *et* **variable Vercel Preview** — la même valeur des deux côtés | Oui | `runtimeProbeAuthorized` (`api/_lib/worker-auth.ts`) | La sonde rend `401` sur son propre jeton | **C1–C4 : BLOCKED** |
| `VERCEL_ENV` | fournie par Vercel | — | `runtimeProbeAuthorized` | Refus immédiat, toute branche confondue | — |
| `VERCEL_GIT_COMMIT_REF` | fournie par Vercel | — | `runtimeProbeAuthorized` | Refus : la liste `BRANCHES_SONDE_RUNTIME` est explicite, sans joker | — |

**Mesure du 2026-11-17** : `sonde=PRESENT` côté GitHub, et la sonde rend `401`
aux appels **sans** jeton et **avec** un faux jeton — donc la valeur côté Vercel
correspond, sinon l'appel authentifié rendrait aussi `401`.

Le jeton n'est accepté **que** dans l'en-tête `x-tracefab-runtime-probe-token`.
Il l'a aussi été en `?runtimeProbeToken=` jusqu'au 2026-11-17 ; ce chemin a été
fermé (un secret dans une URL fuite par les journaux d'accès, `Referer`,
l'historique et les caches).

## 4. Variables qui décident le contenu (étape 3)

`configured_` vaut `privateStorage.configured && email.configured`. L'alerte est
**facultative** et ne peut pas rendre la readiness rouge
(`docs/operations/production-hardening.md`).

### 4.1 Stockage privé — obligatoire

| Variable | Si absente |
| --- | --- |
| `PRIVATE_STORAGE_ENDPOINT` | `privateStorage.configured = false` |
| `PRIVATE_STORAGE_BUCKET` | idem |
| `PRIVATE_STORAGE_REGION` | idem |
| `PRIVATE_STORAGE_ACCESS_KEY_ID` | idem |
| `PRIVATE_STORAGE_SECRET_ACCESS_KEY` | idem |
| `PRIVATE_STORAGE_ANTIVIRUS_URL` | idem |
| `PRIVATE_STORAGE_ANTIVIRUS_TOKEN` | idem |

### 4.2 Email — obligatoire

| Variable | Si absente |
| --- | --- |
| `RESEND_API_KEY` | `email.configured = false` |
| `EMAIL_FROM` | idem |
| `TRACEFAB_APP_URL` | idem |

### 4.3 Alerte — facultative

| Variable | Si absente |
| --- | --- |
| `TRACEFAB_NOTIFICATION_ALERT_URL` | `alerting.configured = false`, **sans effet sur le statut** |
| `TRACEFAB_NOTIFICATION_ALERT_TOKEN` | idem |

**Effet sur les critères** : ces variables n'affectent **aucun** des C1–C4.
Elles décident seulement si la sonde rend `200` ou `503`. Mesure du 2026-11-17 :
`configurationSuffisante: false` avec `identiteSaine: true` — 11 variables
absentes (7 stockage, 3 email, 1 alerte), et **l'identité est saine**.

## 5. `TRACEFAB_IDENTITY_KEY` — le blocage de C1 et C2

| | |
| --- | --- |
| **Emplacement** | **Variable d'environnement Vercel Preview** (le processus la lit via `process.env`) |
| **Obligatoire** | Oui pour C1 et C2 |
| **Consommée par** | `etatCleSysteme` / `signerIdentiteSysteme` (`api/_lib/identite-systeme.ts`), `etatCleIdentite` (`api/_lib/identite-jeton.ts`) |
| **Format** | Chaîne hexadécimale, longueur paire, **≥ 64 caractères** (32 octets) |
| **Si absente** | `mode = "non_configure"`, `verifiee_par_la_base = null`. Aucune signature n'est tentée. Ce n'est pas une erreur : c'est l'état de transition documenté. |
| **Valeur invalide** | `mode = "cle_invalide"` — état **distinct** de « absente », pour qu'une clé malformée ne dégrade pas silencieusement vers l'identité non signée |
| **Effet C1** | **BLOCKED** — sans clé, aucun jeton n'est signé, donc l'aller-retour base impossible |
| **Effet C2** | **BLOCKED** — la question « la clé est-elle chargée ? » a pour réponse mesurée : non |
| **Effet C3** | Aucun — C3 porte sur le refus des jetons invalides, mesuré `PASS` (3/3) |
| **Effet C4** | Aucun — C4 porte sur le rôle PostgreSQL, mesuré `PASS` |

### La correspondance avec la base

La clé du runtime et celle de la base sont **deux choses distinctes** :

- le runtime signe avec `TRACEFAB_IDENTITY_KEY` ;
- la base vérifie avec les secrets stockés dans `public.tracefab_identity_cles`,
  toutes versions **actives** essayées (`actif = true`), sans sortie anticipée.

Une clé runtime correcte mais une clé base différente donne
`verifiee_par_la_base: false` — un mode de panne que la sonde rend visible
**avant** la bascule. C'est précisément pourquoi `verifiee_par_la_base` est un
aller-retour réel et non un constat de configuration.

**Ne pas réutiliser une clé de Préproduction** : la rotation se fait par version
dans `tracefab_identity_cles` (`provisionner_cle_identite.mjs`). Copier une clé
d'un environnement à l'autre rend deux environnements dépendants d'un même
secret, et une rotation devient un incident simultané sur les deux.

### Ce qui est exigé pour débloquer C1/C2

1. Générer une clé dédiée à la Preview (32 octets, hexadécimal).
2. La poser comme **variable Vercel** sur l'environnement Preview — jamais dans
   le dépôt, jamais dans un journal, jamais dans une conversation.
3. Vérifier que la base porte une version active correspondante
   (`tracefab_identity_cles`), sinon `verifiee_par_la_base` sera `false`.
4. Relancer le workflow. Aucune modification de code n'est nécessaire.

## 6. Tableau de diagnostic

| Observation | Signification | Action |
| --- | --- | --- |
| `bypass=ABSENT` | Aucun accès automatisé | Poser le secret GitHub |
| `302` malgré `bypass=PRESENT` | Secret GitHub ≠ secret Vercel (rotation d'un seul côté) | Régénérer et synchroniser |
| `401` sur l'appel authentifié | Jeton GitHub ≠ jeton Vercel | Synchroniser la même valeur |
| `503` + `configurationSuffisante=false` | Variables de services absentes | Compléter la configuration Preview |
| `503` + `identiteSaine=false` + `identiteEcarts` | Rôle PG non conforme | Lire les écarts, corriger les privilèges |
| `503` + `identitySysteme.mode=non_configure` | Clé HMAC absente | § 5 |
| `200` | Tout est vert | C1–C4 mesurables |
