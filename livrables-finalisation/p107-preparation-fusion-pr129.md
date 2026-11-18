# P10.7 — Rapport de préparation à la fusion de la PR #129

**Date des mesures** : 2026-11-17
**Branche** : `release/p107-runtime-production-20261110`
**SHA de référence en début de mission** : `a7f34aa` (dépassé — voir § A)
**SHA final poussé** : `16b4272`
**PR** : #129 — **OUVERTE, NON FUSIONNÉE**

---

## A. État initial — reconstitué, pas supposé

Le SHA de référence fourni (`a7f34aa`) n'était **plus** le SHA courant. La
vérification du dépôt distant donne :

| Élément | Valeur réelle constatée |
| --- | --- |
| Tête de la branche à l'ouverture | `952fc16` |
| Commits ajoutés depuis `a7f34aa` | 4 (`c339a2c`, `16f3cf2`, `f72b880`, `952fc16`) |
| `main` distant | `ec59d27983d49d34d1d0b3a46ceb451e0af57a1a` (inchangé) |
| Retard sur `main` | **0** — `merge-base` = `ec59d27` |
| Avance sur `main` | 23 commits |
| PR #129 | `OPEN`, `MERGEABLE`, tête `952fc16` |
| CI sur `952fc16` | 4/4 **success** |

**Note d'environnement.** Le clone local était superficiel et repointait sur
`a24406d` : `git merge-base` rendait alors « unrelated histories ». Après
`git fetch --deepen`, l'ancêtre commun `ec59d27` apparaît. Le « conflit
d'histoires » était un artefact du clone, pas une divergence.

**Limite d'environnement mesurée (non un défaut du dépôt)** :
`binaries.prisma.sh` est **injoignable** depuis l'environnement d'analyse
(HTTP 000) alors que `registry.npmjs.org` répond 200. `npm run db:generate`
échoue donc localement. Les suites PostgreSQL et le typecheck applicatif ne
peuvent pas être exécutés ici ; ils le sont en CI, qui y accède. Aucun résultat
local n'est présenté comme équivalent.

---

## B. Corrections réalisées

Chaque correction suit la séquence mesurer → corriger → éprouver.

### B.1 — Le jeton de sonde accepté en query string

| | |
| --- | --- |
| **Fichier** | `api/_lib/worker-auth.ts` |
| **Problème** | Le jeton était accepté dans `?runtimeProbeToken=…` en plus de l'en-tête. Un secret dans une URL fuite par les journaux d'accès, l'en-tête `Referer`, l'historique et les caches ; aucune de ces fuites n'existe pour un en-tête. |
| **Preuve que le chemin n'était pas légitime** | `grep` sur `docs/`, `scripts/`, `api/` : la query string n'apparaît **que** dans le code et dans le test qui la déclarait « chemin alternatif documenté ». Aucune documentation ne la mentionne, aucun script de preuve ne l'utilise. |
| **Modification** | En-tête uniquement. |
| **Test associé** | `scripts/test_p107_sonde_runtime_porte.mjs`, cas 9 **retourné** (`accepte` → `refuse`) + cas 9 bis en contre-épreuve (même jeton en en-tête → accepté). |
| **Résultat mesuré** | **1 ÉCHEC sur 16** avant correction → **16 assertions vertes** après. La contre-épreuve prouve que le refus vient du canal, pas d'une fonction qui refuserait tout. |

### B.2 — L'ordre des migrations n'était couvert par aucun contrôle

| | |
| --- | --- |
| **Fichier** | `scripts/test_ordre_migrations_p107.mjs` (nouveau) |
| **Problème** | `prisma migrate` ordonne par nom de dossier. Le dépôt contient **100 migrations et 4 paires d'horodatage identique** : `20261006120000`, `20261006200000`, `20261006220000`, `20261017120000`. Leur ordre relatif dépend de l'alphabet, pas du temps. |
| **Mesure du risque** | Les 4 paires ont été vérifiées : **aucune dépendance croisée**. Rien n'est cassé aujourd'hui. |
| **Modification** | Contrôle à trois niveaux : forme des dossiers, absence de **nouvelle** collision, absence de dépendance croisée dans une paire (existante ou non). Les 4 paires historiques sont **nommées**, pas tolérées en bloc. |
| **Résultat** | 13 assertions vertes. **Éprouvé dans les deux sens** : l'ajout d'une fausse migration en collision fait échouer le test, son retrait le rend vert. |
| **Ce que le test ne fait pas** | Il ne renomme rien et ne touche pas `_prisma_migrations`. Renommer une migration déjà appliquée casserait l'historique des environnements existants — la décision appartient au propriétaire. |

### B.3 — Le contournement Vercel utilisé sans être documenté

| | |
| --- | --- |
| **Fichier** | `docs/security/p107-acces-preview-vercel.md` (nouveau) |
| **Problème** | Le workflow lisait `VERCEL_AUTOMATION_BYPASS_SECRET` et le script envoyait `x-vercel-protection-bypass`, mais **aucun fichier de `docs/`** ne décrivait la procédure, le nom exact, ni la rotation. Une configuration écrite nulle part n'est pas reproductible. |
| **Second défaut** | Le message d'erreur du workflow renvoyait vers `TRACEFAB_AUTOMATION_BYPASS` — un nom que **rien ne lit**. Corrigé vers `VERCEL_AUTOMATION_BYPASS_SECRET`. |
| **Contenu** | Procédure, nom exact attendu, ce que le code fait de la valeur, alternative `vercel curl`, **rotation d'un secret compromis**, et lecture des annotations (`ABSENT` / `PRESENT` mais 302 / 401 applicatif). |

### B.4 — Le 503 de la sonde était jeté avec son diagnostic

| | |
| --- | --- |
| **Fichiers** | `api/_routes/internal/p2-readiness.ts`, `scripts/preuve_runtime_p107.mjs` |
| **Problème** | Mesure du run `44074983675` (`c0f8d6f`) : `bypass=PRESENT`, C3.1–C3.3 **PASS** en 401 — la requête atteint enfin l'application. Mais la sonde authentifiée rendait 503 et la preuve ne conservait que 120 caractères : **impossible de savoir** si le refus venait de la configuration ou de l'identité. Deux causes, deux corrections opposées. |
| **Modification 1** | La route expose `configurationSuffisante`, `identiteSaine`, et `identiteEcarts` (via `ecartIdentiteRuntime`) **uniquement** derrière l'authentification de sonde déjà exigée, et seulement en cas d'écart. Ces champs ne portent que des noms de rôles et des drapeaux. |
| **Modification 2** | Le script conserve le corps du 503 **expurgé par liste fermée** (on garde les champs nommés, on ne retire pas « ce qu'on connaît ») avec garde-fou retirant le corps entier s'il contient une chaîne longue, une URL de connexion ou un jeton. Le message distingue 401 (jeton refusé) de 503 (porte ouverte, runtime non prêt). |
| **Test associé** | `test:preuve-runtime-bout-en-bout` : 4 assertions nouvelles (corps conservé, motif lisible, absence de motif de secret). Doublure étendue au scénario `app503`. |
| **Résultat** | 15 assertions vertes. Le run suivant a produit le diagnostic ci-dessous. |

---

## C. Matrice C1–C4 — preuves sur le processus déployé

Source : run **`44079237489`** (SHA `16b4272`), preuve publiée
`preuves/p107-16b4272`, cible
`https://tracefab-djksw94cb-…vercel.app`.

**Accès établi** : `sonde=PRESENT bypass=PRESENT vercel_token=ABSENT`. La
requête **atteint l'application** (401 applicatif, et non plus 302 Vercel).

| Critère | Attendu | Scénario exécuté | Preuve observée | Résultat |
| --- | --- | --- | --- | --- |
| **C1** — identité signée, vérifiée en base | Le runtime signe un jeton système ; la base le vérifie par aller-retour | `GET ?identity=1` authentifié | `identitySysteme.mode = "non_configure"`, `verifiee_par_la_base = null` | **BLOCKED** — `TRACEFAB_IDENTITY_KEY` absente de la Preview Vercel. Non mesurable, donc ni PASS ni FAIL. |
| **C2** — clé HMAC présente et chargée | `etatCleSysteme() === 'valide'` | idem | `identityTokens.mode = "non_configure"` | **BLOCKED** — même cause. |
| **C3** — refus sans jeton / jeton forgé | 401 sans jeton, 401 avec faux jeton, route fermée | 3 appels non authentifiés | `C3.1 HTTP 401` **PASS**, `C3.2 HTTP 401` **PASS**, `C3.3 HTTP 401` **PASS** | **PASS** (3/3) |
| **C4** — rôle PG réel, sans privilège | `tracefab_app`, ni superuser ni BYPASSRLS, aucune escalade | `probeDatabaseIdentity` sur la connexion Prisma du processus | `currentUser=tracefab_app`, `sessionUser=tracefab_app`, `bypassesRls=false`, `isSuperuser=false`, `canEscalate=false`, `privilegedMemberships=[]` | **PASS** |

### Ce que le 503 a permis de mesurer

`identiteSaine: true` **et** `configurationSuffisante: false`. La preuve
distingue donc explicitement :

- **l'identité est saine** (C4 PASS) ;
- **la configuration est incomplète** : variables absentes de la Preview —
  `PRIVATE_STORAGE_*` (7), `RESEND_API_KEY`, `EMAIL_FROM`,
  `TRACEFAB_NOTIFICATION_ALERT_*` (2).

Ce sont des **variables d'environnement de Preview**, pas des secrets de ce
dépôt. Elles ne peuvent pas être posées depuis ici et **ne doivent pas l'être
par un agent**.

### Contre-épreuve de C4 (ajoutée, non encore exécutée sur le runtime)

`scripts/preuve_pg_identite_p107.mjs` contient désormais **C4.13 à C4.15** :
`tracefab_app` ne peut pas appeler `hmac()` (aucun oracle de signature), ne peut
pas lire `tracefab_identity_cles`, et une contre-épreuve vérifie que ces objets
**existent** — sinon les deux contrôles passeraient par vacuité. Ces contrôles
s'exécutent sur base jetable, pas sur la Preview. **Non exécutés ici** faute de
PostgreSQL joignable dans l'environnement d'analyse ; prévus en CI.

---

## D. Résultats CI et Preview

| Run | SHA | Objet | Résultat |
| --- | --- | --- | --- |
| `44074993166` | `c0f8d6f` | CI (pull_request) | **4/4 success** — Socle, Vérification, Base RLS, Parcours |
| `44074983675` | `c0f8d6f` | Preuves runtime | Mesure échoue (503), publication **success** |
| `44079249014` | `16b4272` | CI (pull_request) | **4/4 success** |
| `44079237489` | `16b4272` | Preuves runtime | Mesure échoue (503 diagnostic), publication **success** |

**Preview** — SHA `16b4272` :
`https://tracefab-djksw94cb-baya-ibraimmayoanouedu-8164s-projects.vercel.app`

- Protection Vercel Authentication : **active**, jamais désactivée.
- Accessible par voie automatisée : **oui**, via le contournement officiel
  (`x-vercel-protection-bypass`), sans exposer la valeur.
- **Preuve d'accès réel à l'application** : les trois appels non authentifiés
  rendent `401` avec un corps applicatif `tracefab-p2-readiness-v1`, et non
  plus `302` vers `vercel.com/sso-api`. La requête franchit Vercel et atteint
  le handler.

**PR #129** : `OPEN`, `MERGEABLE`, `mergeStateStatus = UNSTABLE` — le job
« Interroger le runtime deployé » échoue (C1/C2 bloquées) sans être requis pour
la fusion.

---

## E. Risques et réserves

| # | Réserve | État |
| --- | --- | --- |
| 1 | **Rotation du secret de contournement compromise** — une valeur a figuré dans une conversation | **NON FAITE.** L'état mesuré `bypass=PRESENT` prouve qu'un secret existe côté GitHub ; **rien ne prouve** qu'il s'agit de la valeur compromise ni qu'elle a été régénérée. Le propriétaire doit révoquer et régénérer (procédure : `docs/security/p107-acces-preview-vercel.md` § 6). |
| 2 | `TRACEFAB_IDENTITY_KEY` absente de la Preview | **BLOQUÉE** — C1/C2 non mesurables. Action : poser la variable sur l'environnement Preview Vercel, **sans** l'afficher. |
| 3 | Configuration de Preview incomplète (storage, email, alerting) | **BLOQUÉE** — 11 variables absentes. C'est la cause du 503, distincte de l'identité. |
| 4 | 4 paires d'horodatage de migration | **CORRIGÉE ET PROUVÉE** au sens du diagnostic (aucune dépendance croisée, contrôle permanent). Le renommage reste une décision du propriétaire. |
| 5 | Suites PostgreSQL et typecheck applicatif non exécutés localement | **NON CORRIGÉE** — limite de l'environnement (`binaries.prisma.sh` injoignable). Couverts par la CI. |
| 6 | `mergeStateStatus = UNSTABLE` | Conséquence directe de C1/C2 bloquées, pas d'un défaut de code. |
| 7 | Contrôles C4.13–C4.15 (oracle `hmac`, table des clés) | **NON EXÉCUTÉS** — écrits, pas encore mesurés. Ne pas les compter comme preuve. |

---

## F. Décision finale

### NON PRÊTE — DÉPENDANCES EXTERNES

Justification vérifiable :

**Ce qui est démontré sur le runtime réel**

- C3 **PASS** (3/3) — refus sans jeton, refus avec faux jeton, route fermée.
- C4 **PASS** — `tracefab_app`, sans superuser, sans BYPASSRLS, sans escalade,
  aucune appartenance privilégiée.
- L'accès à la Preview est réel et passe par la voie officielle.

**Ce qui bloque**

- C1 et C2 sont **BLOCKED**, pas FAIL : `TRACEFAB_IDENTITY_KEY` n'existe pas
  dans l'environnement Preview Vercel. Aucune correction de code ne peut lever
  cela.
- Le secret de contournement doit être **roté** par le propriétaire ; une
  valeur a été exposée.
- La configuration de Preview est incomplète (11 variables), ce qui provoque le
  503 et empêche le `200` exigé par le script.

**Aucun critère bloqué n'est compté comme PASS.** Aucune correction n'a été
faite sur `main`, en Production, sur une base Neon, sur un secret, ni sur la
protection Vercel. Aucun `prisma migrate deploy` ni `resolve` n'a été exécuté.
La PR n'a **pas** été fusionnée et ne doit pas l'être avant que C1 et C2 soient
mesurées sur un runtime où la clé est présente.

**Ce que le propriétaire doit faire, dans cet ordre**

1. Révoquer et régénérer le contournement d'automatisation Vercel ; mettre à
   jour `VERCEL_AUTOMATION_BYPASS_SECRET` (§ 6 de la doc).
2. Poser `TRACEFAB_IDENTITY_KEY` sur l'environnement **Preview** Vercel.
3. Compléter les 11 variables de Preview (storage, email, alerting) si un
   `200` est attendu de la sonde.
4. Relancer le workflow : C1 et C2 deviennent mesurables sans aucune
   modification de code.
