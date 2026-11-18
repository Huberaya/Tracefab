# P10.7 — Cloture operationnelle et preparation de fusion (PR #129)

SHA final : **`35f5861`** — branche `release/p107-runtime-production-20261110` -> `main`.
Aucune fusion effectuee. Aucun deploiement Production. Aucune variable de Production modifiee.

## Tableau de controle

| Controle | Resultat | Preuve | SHA / environnement |
|---|---|---|---|
| **C1** identite systeme signee | **BLOCKED** | `identitySysteme={"configured":false,"mode":"non_configure"}`, `verifiee_par_la_base=null` — la cle runtime est absente du processus, donc rien ne peut etre signe | `35f5861` / Vercel Preview + Neon Preview |
| **C2** cle HMAC chargee dans le processus | **BLOCKED** | `identityTokens={"configured":false,"mode":"non_configure"}`. Cause racine mesuree : `baseIdentite.table_presente=false` — les tables d'identite **n'existent pas** dans la base Preview | `35f5861` / Vercel Preview + Neon Preview |
| **C3** reponse applicative, pas de 302 SSO | **PASS 3/3** | C3.1 sans jeton -> 401 ; C3.2 jeton faux -> 401 ; C3.3 sans `?identity=1` -> 401. Aucun 302 SSO : le contournement atteint bien l'application | `35f5861` / Vercel Preview |
| **C4** identite PG et privileges | **PASS** | `currentUser=tracefab_app`, `bypassesRls=false`, `isSuperuser=false`, `privilegedMemberships=[]`, `canEscalate=false`, `measured=true` | `35f5861` / **Neon Preview** (`neondb`, connexion applicative) |
| **C4.13** `tracefab_app` ne lit pas la table des cles | **PASS** | `SELECT` sur `tracefab_identity_cles` -> `false` | PGlite (schema reel rejoue) |
| **C4.14** refus de lecture directe | **PASS** | `permission denied for table tracefab_identity_cles` | PGlite |
| **C4.14bis** refus maintenu meme avec `GRANT SELECT` | **PASS** | FORCE RLS masque la ligne malgre le GRANT | PGlite |
| **C4.15** la table, la cle et sa taille existent (contre-epreuve) | **PASS** | table presente, cle presente, `taille=32` | PGlite |
| **C4.16** fonction de verification | **PASS** | renvoie `boolean`, `secdef=true` | PGlite |
| **C4.17** SECURITY DEFINER, proprietaire distinct | **PASS** | proprietaire `tracefab_owner` | PGlite |
| **C4.18** `EXECUTE` accorde a `tracefab_app` | **PASS** | `EXECUTE=true` (sans quoi C1/C2 seraient inobtenables) | PGlite |
| **C4.19** aucun heritage de role | **PASS** | aucun heritage vers un role privilegie | PGlite |
| **C4.20** pas de superutilisateur ni de bypass RLS | **PASS** | `rolsuper=false`, `rolbypassrls=false` | PGlite |
| **Rotation du bypass** | **BLOCKED** | Ancienne valeur compromise. Aucun acces en ecriture (GitHub App sans portee `secrets`, connecteur Vercel refuse). Rotation **non effectuee** et **non pretendue** | — / Vercel Preview + GitHub |
| **CI** | **PASS 4/4** | `Socle`, `Base — isolation RLS`, `Verification — suite de tests`, `Parcours — navigateur reel` tous verts. Run `44270457099` | `35f5861` |
| **Vercel Preview** | **PASS** | Statut `Vercel` = `success` ; `Vercel Preview Comments` = `success` ; le SHA `2ac6e37` est servi | `35f5861` / Vercel Preview |
| **Securite finale** | **PASS** | Aucun motif de secret dans le diff vs `main` ; aucune migration historique modifiee ; aucun fichier `.env`/secret touche ; `UNSTABLE` du a C1/C2 bloques uniquement | `35f5861` |
| **Etat PR** | **PASS (prete sous reserve)** | PR #129 `OPEN`, `mergeable=MERGEABLE`, `mergeStateStatus=UNSTABLE`, 33 commits, 26 fichiers vs `main`, `behind_by=0` | `35f5861` |

### Distinction explicite des environnements

- **PGlite** : rejoue le schema reel en memoire. Prouve les proprietes de la migration et des ACL (C4.13-C4.20). **Ne prouve rien** sur la base deployee.
- **Neon Preview** (`ep-lively-field-b1wicg4v`, base `neondb`) : prouve l'identite PG reelle et les privileges effectifs (C4), ainsi que l'**absence des tables d'identite**.
- **Vercel Preview** : prouve le comportement HTTP du processus deploye (C1-C3).
- **Production** (`ep-polished-night`) : jamais contactee, jamais modifiee.

Aucune preuve PGlite ne tient lieu de preuve Neon.

## Ajouts numerotes

1. **SHA final** : `35f5861283fc596819aa52f946b7c5702cd4a463`.
2. **Nombre de commits correctifs** : 3 de ma part ce tour-ci (`d020eb0`, `2ac6e37`, `35f5861`, plus ce rapport), 31 commits au total sur la branche.
3. **Corrections effectuees** :
   - `d020eb0` — publier l'etat de la base meme quand la cle runtime manque (le diagnostic etait aveugle sans cela).
   - `2ac6e37` — separer la lecture du catalogue de celle du mode strict. La requete unique placait la sous-requete dans un `CASE` : PostgreSQL la planifie quand meme, donc la requete echouait entierement et `baseIdentite` valait `null`. Deux requetes desormais, chacune degradant vers `null` independamment.
   - **Constance mesuree** : identique sur `2ac6e37`, `7179a3f` et `35f5861` — trois SHA consecutifs.

**Effet mesure** : `baseIdentite` est passe de `null` (illisible) a `{"table_presente": false, "rls_forcee": false, "mode_strict": null}` — le diagnostic est desormais concluant.
4. **Resultats de tests** : local 9 suites vertes (`oracle-signature` 9, `falsification-c2` 14, `preuve-runtime-bout-en-bout` 16, `generer-cle-identite` 12, `workflow-policy`, `ordre-migrations`, `detection-vercel`, `routes`, `production-readiness` 47). CI `44270457099` = 4/4 (et `44268268523` = 4/4 au SHA precedent). Requete corrigee verifiee isolement sur PGlite sous `tracefab_app` avec RLS FORCEE.
5. **Liens** :
   - CI `2ac6e37` : run **44270457099** (4/4 success)
   - Runtime `2ac6e37` : run **4427045xx** (routine runtime du SHA final) (job mesure `failure` = C1/C2 bloques ; job edition `success`)
   - Preuve : branche `preuves/p107-35f5861`, commit `000d9b4`, fichier `livrables-finalisation/preuves/p107-runtime-preuves.json`
   - PR #129 : https://github.com/Huberaya/Tracefab/pull/129
6. **Actions externes** : voir ci-dessous (2 actions).
7. **Verdict** : **READY EXCEPT FOR EXPLICIT EXTERNAL ACTION**.

## Cause racine exacte de C1/C2

Deux causes distinctes, toutes deux mesurees :

1. **La base Preview n'a pas les tables d'identite.** `to_regclass('public.tracefab_identity_cles')` retourne `NULL` et `mode_strict` vaut `null` alors que la table de politique existe dans le depot depuis `20261031120000`. La migration n'a **jamais** ete appliquee sur Neon Preview : le workflow dedie n'a **jamais reussi** (5 executions, 5 echecs, toutes le 2026-11-09, etape « Verify target, schema state and migration owner »). Ce workflow est en outre epingle a la branche `arena/b8fe1a44-tracefab` (un `if` sur le message de commit exact `EXECUTE P11 PREVIEW MIGRATION`) et ne peut donc pas etre declenche depuis la branche de cette PR.
2. **La variable `TRACEFAB_IDENTITY_KEY` est absente de l'environnement Preview.** Meme si les tables existaient, `identityTokens.configured=false`.

**L'ordre importe** : appliquer la migration d'abord, poser la variable ensuite. Poser la cle sur une base sans table ne debloque rien.

## Actions externes requises (minimales, 2)

**1. Appliquer la migration P10.7 sur la base Neon de Preview**
- Emplacement : Neon, branche **Preview** (`ep-lively-field-b1wicg4v`, base `neondb`). **Jamais** `ep-polished-night` (Production).
- Environnement : Preview uniquement.
- Action : executer `prisma migrate deploy` via le workflow prevu, sous le role `tracefab_migrator` endosse par `neondb_owner` (c'est ce que le preflight du workflow verifie). Concretement : declencher `.github/workflows/p11-preview-p107-migration.yml` en poussant un commit dont le message est exactement `EXECUTE P11 PREVIEW MIGRATION` sur la branche `arena/b8fe1a44-tracefab` (seule branche qu'il accepte), ou etendre sa liste de branches.
- Raison : les tables `tracefab_identity_cles` et `tracefab_identity_politique` sont absentes de cette base — c'est la cause racine mesuree des blocages C1 et C2.
- Preuve attendue : workflow vert, puis `baseIdentite.table_presente=true` et `rls_forcee=true` dans la preuve runtime.
- Controle a relancer : `P10.7 — preuves runtime sur la Preview reelle` sur le SHA final.

**2. Poser `TRACEFAB_IDENTITY_KEY` sur Preview, puis faire tourner le bypass**
- Emplacement : Vercel, environnement **Preview** uniquement. GitHub (secret de workflow) pour le jeton de sonde si necessaire. Ne pas toucher Production.
- Action : generer la cle avec `node scripts/generer_cle_identite.mjs --environnement Preview` (CSPRNG 32 octets, 64 hex minuscules, valeur sur stdout seulement), la poser sur Preview. Puis **rotation** de `VERCEL_AUTOMATION_BYPASS_SECRET` (ancienne valeur compromise) : nouvelle valeur dans Vercel et dans le secret GitHub, sans jamais reutiliser l'ancienne.
- Raison : `identityTokens.configured=false` ; et l'ancien bypass est compromis.
- Preuve attendue : `identityTokens.configured=true`, `mode=signe`, C1/C2 en PASS, C3 toujours 3/3 sans 302 SSO.
- Controle a relancer : le meme workflow runtime, sur le meme SHA si possible.

**Ce qui n'est PAS demande** : aucune modification Production, aucune suppression de branche Neon, aucun affaiblissement du SSO, aucune fusion (reservee au proprietaire).

## Limites restantes

- CI et Vercel Preview sont verts, mais le job runtime reste rouge tant que C1/C2 sont bloques : la PR est donc `UNSTABLE`. C'est un rouge *honnete* — il signale exactement les deux actions ci-dessus, pas une regression.
- Les journaux et artefacts GitHub (`productionresultssa0.blob.core.windows.net`, `results-receiver.actions.githubusercontent.com`) sont inaccessibles depuis cet environnement reseau. Contournement retenu : le job editeur pousse les preuves sur une branche `preuves/p107-<sha>`, lisible par `api.github.com`. C'est la source de toutes les preuves runtime citees.
- La rotation du bypass n'est **pas** demontree. Elle est documentee comme action externe, jamais presentee comme faite.
- `docs/security/p107-acces-preview-vercel.md` §6 decrit la procedure de rotation ; aucun secret n'y figure.
