# P10.7 — Mission finale de cloture (PR #129)

## 1. SHA final

**`713ecbb54a8a0ccef953ed8a20b575c0bb77f3f4`** — branche
`release/p107-runtime-production-20261110` -> `main`.
`ahead=44`, `behind=0`, 28 fichiers, `mergeable=MERGEABLE`. Aucun conflit.

## 2. Corrections effectivement appliquees

| Commit | Correction | Motif mesure |
|---|---|---|
| `ae73467` | Type de `baseIdentite` complete | `tsc` refusait la compilation, donc **le build Vercel echouait** et il n'existait aucun deploiement Preview a interroger. Le job runtime s'arretait a « aucun deploiement Preview en succes pour le SHA apres 10 min ». **C'etait le blocage reel, pas la base.** |
| `c015249` | `identite_base` : oid, nom, empreinte d'hote, concordance avec l'endpoint declare | Prouver a quelle base le deploiement est rattache sans jamais exposer la chaine de connexion. |
| `4407208` | Empreinte de schema + sondes P10.7 nommees | Deux bases homonymes divergent par leur contenu ; l'empreinte repond a « est-ce la meme base ? ». |
| `713ecbb` | `TRACEFAB_PREVIEW_DB_ENDPOINT` documentee | Le garde-fou « variables lues par api/ documentees » a refuse la CI sur `4407208`, a raison. 46/46 verts. |

Aucun defaut applicatif reproduit : la sonde degrade correctement (une erreur de
mesure n'est jamais lue comme un « non », `verificationDetail` distingue
`verification_non_accordee_au_runtime` de `verification_base_a_refuse`).

## 3. Resultats CI sur le SHA final

Run **`44323069509`**, SHA `713ecbb` : **4/4 success**
(`Socle — types, compilation, isolation`, `Base — isolation RLS executee`,
`Verification — suite de tests`, `Parcours — navigateur reel`).

Local : 9 suites vertes (`production-readiness` 46/46, `oracle-signature` 9,
`falsification-c2` 14, `preuve-runtime-bout-en-bout`, `workflow-policy`,
`ordre-migrations`, `generer-cle-identite`, `detection-vercel`, `routes`).

## 4. Resultats C1–C4 sur le runtime reel

Deploiement : `https://tracefab-nc6yyxfwf-baya-ibraimmayoanouedu-8164s-projects.vercel.app`
(`713ecbb`), workflow `443226xxx` serie `p107-preuves-runtime`, preuve sur la
branche `preuves/p107-713ecbb`.

| Critere | Verdict | Preuve |
|---|---|---|
| **C1** | **BLOCKED** | `identitySysteme.configured=false`, `mode=non_configure`, `verifiee_par_la_base=null` |
| **C2** | **BLOCKED** | `identityTokens.configured=false`, `mode=non_configure` |
| **C3** | **PASS 3/3** | 401 sans jeton, 401 jeton faux, 401 sans `?identity=1` — aucun 302 SSO, l'application est bien atteinte |
| **C4** | **PASS** | `currentUser=tracefab_app`, `bypassesRls=false`, `isSuperuser=false`, `privilegedMemberships=[]`, `canEscalate=false` |
| C4.13–C4.20 | **PASS 9/9** (PGlite) | dont C4.13 `SELECT=false` et C4.14bis refus maintenu meme avec `GRANT SELECT` |

### Le rattachement de la base, desormais prouve et non deduit

```
base_oid          : 16396
base_nom          : neondb
hote_empreinte    : e4142a5ef80a     (SHA-256 tronque de l'hote injecte)
schemas_empreinte : 4a145f39b5da     (empreinte des schemas publics)
sondes_p107 :
  tracefab_identity_cles       : false
  tracefab_identity_politique  : false
  tracefab_current_user_email  : true
```

Stable et identique sur `c015249`, `4407208`, `713ecbb` — trois SHA consecutifs,
trois deployments Preview distincts, une seule et meme base.

**Lecture.** La base jointe par le deploiement de la PR est migree
(`_prisma_migrations` presente, 51 tables) et a **avance au-dela** de
`20261031120000` (`tracefab_current_user_email`, creee par `20261102120000`,
existe). Les deux tables d'identite y sont pourtant **absentes**. Ce n'est ni un
retard, ni une base vide, ni un defaut de deploiement : la migration
`20261031120000` est **marquee appliquee sans que ses objets existent**, ou n'a
jamais tourne sur cette base. Le preflight de
`verification_p107_preview_migration.mjs` detecte precisement cet etat
(`p107Rows`, `prerequisites.active_keys`).

Cette base **n'est pas** celle decrite en preambule (`br-square-bread-b1gu7jk7`,
tables presentes, `strict=true`, cle v1 de 32 octets). Aucune branche Neon ne se
deduit de son nom : la seule preuve de rattachement disponible est celle
ci-dessus, produite par le runtime lui-meme.

## 5. Etat de la PR et absence de conflit

- `OPEN`, `mergeable=MERGEABLE`, `behind_by=0`, 28 fichiers, 44 commits.
- `mergeStateStatus=UNSTABLE` : du **seul** job runtime, rouge parce que C1/C2
  sont bloques. C'est un rouge honnete, pas une regression.
- Aucun motif de secret dans le diff vs `main` ; aucune migration historique
  modifiee ; aucun fichier `.env`/secret/credential ; aucun workflow ciblant
  Production ; aucun changement d'environnement Production.

## 6. Dependances restantes — UNE

**Reglage :** `TRACEFAB_IDENTITY_KEY`, sur l'environnement **Vercel Preview**
uniquement.

**Raison :** la base effectivement jointe n'a pas les tables d'identite ; poser
la cle sans elles ne debloque rien. L'ordre est impose par la mesure.

**Action minimale, en deux gestes indivisibles :**

1. Sur la base reellement jointe — identifier par `base_oid = 16396` /
   `hote_empreinte = e4142a5ef80a`, **pas** par un nom de branche — appliquer
   `prisma migrate deploy` (jamais `resolve`, jamais `_prisma_migrations` a la
   main), via le workflow prevu. Verifier ensuite que
   `sondes_p107.tracefab_identity_cles = true`.
2. Poser `TRACEFAB_IDENTITY_KEY` sur Preview avec la valeur de la ligne `actif`
   de `tracefab_identity_cles` de **cette** base. Generation si besoin :
   `node scripts/generer_cle_identite.mjs --environnement Preview` (valeur sur
   stdout uniquement, jamais dans ce chat).

**Verification attendue :** `sondes_p107` passe a `true/true` et
`identityTokens.configured=true`, `mode=signe`.

**Controle a relancer :** workflow `p107-preuves-runtime`, sur le meme SHA.

Rien a faire en Production. Aucune fusion.

## 7. Verdict

**BLOCKED** — une seule dependance externe, precise et verifiable.
CI verte, PR sans conflit, C3 et C4 prouves sur le runtime reel. C1 et C2 ne
peuvent pas etre declares PASS : la base jointe n'a pas les objets, et la
variable n'est pas posee. Aucun des deux ne releve du code de la branche.
