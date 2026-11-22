# P10.7 — Chantier final de levée des blocages — PR #129

**Date des mesures** : 2026-11-17
**Branche** : `release/p107-runtime-production-20261110`

## 1. SHA initial et final

| | |
| --- | --- |
| SHA de départ annoncé | `c059d95` |
| Tête réelle à l'ouverture | `c059d95` — **aucun écart**, PR sans nouveau commit |
| SHA final poussé | `0def5ab` |
| CI sur le SHA final | **4/4 success** (run `44090003153`) |
| `main` | `ec59d27` — **inchangée** |
| PR #129 | `OPEN`, `MERGEABLE`, `UNSTABLE`, non fusionnée |

---

## 2. Variables manquantes — état mesuré, sans aucune valeur

Source : run `44089996217` (SHA `0def5ab`), preuve publiée
`preuves/p107-0def5ab`.

| Variable | Emplacement | État mesuré | Effet |
| --- | --- | --- | --- |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | GitHub secret | **PRÉSENT** | Accès à la Preview établi |
| `TRACEFAB_RUNTIME_PROBE_TOKEN` | GitHub secret + variable Vercel | **PRÉSENT** (les deux côtés correspondent) | Sonde autorisée |
| **`TRACEFAB_IDENTITY_KEY`** | **Variable Vercel Preview** | **ABSENTE** (`identitySysteme.mode = non_configure`) | **C1 et C2 BLOCKED** |
| `PRIVATE_STORAGE_*` (7) | Variable Vercel Preview | **ABSENTES** | `configurationSuffisante=false` → `503` |
| `RESEND_API_KEY`, `EMAIL_FROM`, `TRACEFAB_APP_URL` | Variable Vercel Preview | **ABSENTES** | idem |
| `TRACEFAB_NOTIFICATION_ALERT_*` (2) | Variable Vercel Preview | **ABSENTES** | sans effet sur le statut (facultatives) |

**Distinction capitale, mesurée** : `configurationSuffisante: false` **et**
`identiteSaine: true`. Les 11 variables manquantes expliquent le `503` ; elles
n'affectent **aucun** critère C1–C4. Le blocage de C1/C2 a une **autre** cause :
`TRACEFAB_IDENTITY_KEY`.

Le contrat exhaustif (nom, emplacement, caractère obligatoire, consommateur,
comportement si absent, lien avec C1–C4) est versé dans
`docs/security/p107-contrat-configuration-preview.md`.

### Correspondance avec la base Neon

La clé du runtime et celles de la base sont **deux choses distinctes** : le
runtime signe avec `TRACEFAB_IDENTITY_KEY` ; la base vérifie avec les secrets de
`public.tracefab_identity_cles` (toutes versions **actives** essayées, sans
sortie anticipée). Une clé runtime correcte mais une clé base différente donne
`verifiee_par_la_base: false` — que la sonde rendrait visible.

Il est **explicitement déconseillé** de réutiliser une clé de Préproduction :
deux environnements dépendraient d'un même secret, et une rotation deviendrait
un incident simultané.

---

## 3. Rotation du secret Vercel — **BLOCKED**

| Question | Réponse mesurable |
| --- | --- |
| Le secret existe-t-il ? | **Oui** — `bypass=PRESENT` |
| Fonctionne-t-il ? | **Oui** — la requête atteint l'application (`401` applicatif, plus de `302`) |
| Le nom utilisé est-il correct ? | **Oui** — `VERCEL_AUTOMATION_BYPASS_SECRET` (vérifié dans le code) |
| La Preview reste-t-elle protégée par SSO ? | **Oui** — la protection n'a jamais été touchée ; l'accès passe par l'en-tête officiel |
| Fuite dans les logs ? | **Aucune** — le workflow mesure la présence (`[ -n "$BYPASS" ]`), le script ne journalise jamais la valeur |
| Requêtes authentifiées confondues avec la protection Vercel ? | **Non** — le détecteur classe `302`/`vercel_auth_enabled` en INDÉTERMINÉ, jamais en refus applicatif |
| **La valeur a-t-elle été régénérée ?** | **INDÉTERMINABLE** |

**Statut : BLOCKED.** Je peux constater que le secret fonctionne ; **rien ne me
permet de savoir** si la valeur est celle d'avant l'exposition. Le connecteur
Vercel est `limited: true` (mesuré), et l'API GitHub rend `403` sur
`actions/secrets`. Je ne déclare donc **pas** la rotation faite.

Procédure à exécuter par le propriétaire :
`docs/security/p107-acces-preview-vercel.md` § 6.

---

## 4. Résultats C1 à C4 — sur le processus déployé

Environnement : Preview Vercel, SHA `0def5ab`, run `44089996217`.
Requête exécutée : `GET /api/internal/p2/readiness?identity=1`, en-tête
`x-tracefab-runtime-probe-token`, plus `x-vercel-protection-bypass`.

| Critère | Attendu | Requête / scénario | Code HTTP | Mesure applicative | Verdict |
| --- | --- | --- | --- | --- | --- |
| **C1** — identité signée vérifiée en base | Aller-retour signature ↔ base | `?identity=1` authentifié | `503` | `identitySysteme.mode = "non_configure"`, `verifiee_par_la_base = null` | **BLOCKED** |
| **C2** — clé HMAC chargée | `etatCleSysteme() === 'valide'` | idem | `503` | `identityTokens.mode = "non_configure"` | **BLOCKED** |
| **C3** — refus sans jeton / jeton forgé | 401 attendu | 3 appels non authentifiés | `401`, `401`, `401` | Corps `tracefab-p2-readiness-v1` (applicatif) | **PASS** (3/3) |
| **C4** — privilèges effectifs du rôle PG | `tracefab_app`, sans évasion | `probeDatabaseIdentity` sur la connexion Prisma du processus | `503` | `currentUser=tracefab_app`, `sessionUser=tracefab_app`, `bypassesRls=false`, `isSuperuser=false`, `canEscalate=false`, `privilegedMemberships=[]` | **PASS** |

**Pourquoi C1/C2 sont BLOCKED et non FAIL** : la variable
`TRACEFAB_IDENTITY_KEY` n'existe pas dans l'environnement Preview. Aucune
signature n'est donc tentée. Ce n'est pas un défaut de comportement : c'est une
absence de configuration. Un `503` n'est pas compté comme une preuve positive —
il fournit seulement les champs de diagnostic exploités ci-dessus.

**Pourquoi C4 est PASS malgré le `503`** : l'identité PostgreSQL est mesurée
**avant** le calcul du statut, et `identiteSaine: true` est un champ distinct de
`configurationSuffisante`. La mesure est donc bien celle du processus déployé.

**Preuve d'accès réel** : les appels non authentifiés rendent `401` avec un
corps applicatif, et non `302` vers `vercel.com/sso-api`. La requête franchit
Vercel et atteint le handler.

---

## 5. Tests PostgreSQL C4.13 à C4.20 — **exécutés**, 9/9 PASS

Exécutés sur **PGlite** (PostgreSQL en WASM), avec le schéma **et** l'ACL rejoués
depuis la migration `20261031120000`. Commande :
`npm run test:p107:oracle-signature`.

| Contrôle | Question | Résultat mesuré |
| --- | --- | --- |
| C4.13 | `tracefab_app` peut-il lire la table des clés ? | `SELECT=false` — **PASS** |
| C4.14 | Tentative **réelle** sous `SET LOCAL ROLE` | `permission denied for table tracefab_identity_cles` — **PASS** |
| C4.14bis | **Contre-épreuve** : même avec `SELECT` accordé | RLS FORCÉE masque la ligne (0 ligne) — **PASS** |
| C4.15 | Contre-épreuve : les objets existent | table, clé, taille 32 — **PASS** |
| C4.16 | La fonction de vérification signe-t-elle ? | retour `boolean`, `secdef=true` — **PASS** |
| C4.17 | Est-elle `SECURITY DEFINER` ? | oui — **PASS** |
| C4.18 | Reste-t-elle **appelable** (sinon C1/C2 inobtenables) | `EXECUTE=true` — **PASS** |
| C4.19 | Héritage de rôle | aucun — **PASS** |
| C4.20 | Ni superuser ni BYPASSRLS | `super=false`, `bypassrls=false` — **PASS** |

### Une prémisse fausse, corrigée par la mesure

La première version exigeait que `tracefab_app` **ne puisse pas** appeler
`hmac()`. Mesure : il le peut (`EXECUTE=true`). **Ce n'est pas un défaut.**

`hmac(message, clé, algo)` prend la clé **en argument** : un appelant qui fournit
sa propre clé calcule un HMAC ordinaire, exactement comme `digest()`. Un *oracle*
serait une fonction qui signe avec la clé **stockée** sans la révéler. Le test
mesurait donc une propriété qui n'a pas de sens, et aurait réclamé un
durcissement inutile. Il mesure désormais ce qui compte : **la clé stockée est
inatteignable**.

### Éprouvé dans les deux sens

En rendant `tracefab_app` **propriétaire** de `tracefab_identity_cles`, C4.13
échoue (`SELECT=true`). C'est la propriété qui protège, et le test le dit.

### Ce que ce test ne prouve pas

PGlite n'est pas le cluster Neon. Les rôles, ACL et RLS y sont réels, mais la
preuve qui fait foi reste celle exécutée sur la base cible
(`preuve_pg_identite_p107.mjs`, qui porte les contrôles C4.13–C4.15 pour la
campagne runtime). Ce test rend le contrôle **reproductible** et le protège
d'une régression.

---

## 6. Résultats CI et workflows

| Run | SHA | Objet | Résultat |
| --- | --- | --- | --- |
| `44083276494` | `c059d95` | CI (état initial) | **4/4 success** |
| `44083266806` | `c059d95` | Preuves runtime | Mesure `503`, publication **success** |
| `44090003153` | `0def5ab` | CI (**SHA final**) | **4/4 success** — Socle, Vérification, Base RLS, Parcours |
| `44089996217` | `0def5ab` | Preuves runtime | Mesure `503` (diagnostic), publication **success** |

Le job « Socle » du run final exécute les deux nouveaux contrôles
(`test:p107:oracle-signature`, `test:ordre-migrations`) : ils passent **en CI**,
pas seulement en local.

---

## 7. Corrections apportées dans ce chantier

| Fichier | Problème | Correction | Test |
| --- | --- | --- | --- |
| `scripts/test_p107_oracle_signature_pglite.mjs` *(nouveau)* | C4.13–C4.15 écrits mais **jamais démontrés** | Exécution sur PGlite avec schéma et ACL réels ; prémisse « oracle » corrigée en « clé inatteignable » | 9 contrôles, éprouvés dans les deux sens |
| `docs/security/p107-contrat-configuration-preview.md` *(nouveau)* | Le blocage C1/C2 n'était rattaché à aucune variable nommée | Contrat exhaustif, sans aucune valeur | — |
| `.github/workflows/p107-preuves-runtime.yml` | Le message d'erreur citait `TRACEFAB_AUTOMATION_BYPASS`, nom que **rien ne lit** (correction précédente perdue) | Rétabli vers `VERCEL_AUTOMATION_BYPASS_SECRET` | `test:workflow-policy` |
| `.github/workflows/ci.yml` | Les contrôles C4.13–C4.20 n'étaient pas exécutés en CI | Étape ajoutée au job Socle | run `44090003153` |

---

## 8. Réserves restantes

| # | Réserve | État | Débloquée par |
| --- | --- | --- | --- |
| 1 | **`TRACEFAB_IDENTITY_KEY` absente de la Preview** | **BLOQUÉE** | Poser la variable sur l'environnement Preview Vercel |
| 2 | **Rotation du secret de contournement non démontrable** | **BLOQUÉE** | Régénération côté Vercel + mise à jour du secret GitHub |
| 3 | Configuration Preview incomplète (11 variables) | **BLOQUÉE** | Compléter les variables ; n'affecte aucun critère C1–C4 |
| 4 | Preuve C4.13–C4.15 sur le cluster **cible** (Neon) | **NON EXÉCUTÉE** | Campagne runtime ; le test PGlite est un complément, pas un substitut |
| 5 | `mergeStateStatus = UNSTABLE` | Conséquence de 1 et 2, pas d'un défaut de code | — |

---

## 9. Verdict final

# NON PRÊTE — CONFIGURATION PREVIEW

**Justification vérifiable**

- Les défauts **techniques** sont levés : C3 **PASS** (3/3), C4 **PASS** sur le
  processus déployé, C4.13–C4.20 **PASS** (9/9) et reproductibles en CI.
- Aucun défaut de code ne bloque plus la fusion. Le test « oracle » mesurait une
  propriété fausse ; corrigé, il mesure la bonne et **mord**.
- Ce qui bloque est **exclusivement de la configuration Preview** :
  `TRACEFAB_IDENTITY_KEY` absente — donc C1 et C2 sont **BLOCKED**, pas FAIL.
- La rotation du secret de contournement reste **BLOCKED** faute de pouvoir
  constater la régénération.

**Ce qui reste à faire, hors de mon périmètre**

1. Poser `TRACEFAB_IDENTITY_KEY` sur l'environnement **Preview** Vercel
   (32 octets hexadécimaux), avec une version active correspondante dans
   `tracefab_identity_cles`.
2. Régénérer le contournement d'automatisation Vercel et mettre à jour le
   secret GitHub.
3. (Optionnel, pour un `200`) Compléter les 11 variables de services.
4. Relancer le workflow : C1 et C2 deviennent mesurables **sans aucune
   modification de code**.

**Aucune fusion, aucun déploiement Production, aucune modification de base
Production, aucune manipulation de `_prisma_migrations`, aucune rotation de
secret.** Un contrôle BLOCKED n'est jamais compté comme PASS.
