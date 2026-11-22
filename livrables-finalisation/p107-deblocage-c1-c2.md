# P10.7 — Deblocage HMAC Preview et validation C1/C2 (PR #129)

## Compte rendu

| Element | Resultat |
|---|---|
| **SHA de la PR** | `7310898` (`7310898bd15d8a3d76b7b6b70e763d518e0e4ac7`), branche `release/p107-runtime-production-20261110` |
| **Deploiement Preview correspondant** | `https://tracefab-3si4kex3r-baya-ibraimmayoanouedu-8164s-projects.vercel.app`, statut Vercel `success` sur ce SHA |
| **Base Neon effectivement utilisee** | La base jointe par ce deploiement est `neondb`, **migree par Prisma** : `_prisma_migrations` presente, 51 tables publiques, et la fonction `tracefab_current_user_email` (creee par `20261102120000`) existe. **Ce n'est donc PAS une base vide.** |
| **`TRACEFAB_IDENTITY_KEY` presente** | **NON.** `identityTokens.configured=false`, `mode=non_configure`. `identitySysteme.configured=false`. |
| **Contrat de cle respecte** | Sans objet : la variable est absente, donc rien n'est evalue. Le contrat est neanmoins etabli (voir §2). |
| **C1** | **BLOCKED** |
| **C2** | **BLOCKED** |
| **CI sur SHA final** | **PASS 4/4** (run `44283168882`) |
| **Action manuelle restante** | **UNE** : voir §5 |

## 1. Ce qui a change depuis la mission precedente

Trois corrections de code, toutes poussees sur la branche de la PR :

1. **`b668c5a` → `ae73467`** — un type incomplet (`table_vue_par_pg_class` absent de la
   declaration) cassait `tsc`. Le build Vercel echouait, donc **aucun deploiement
   Preview n'existait** et le job runtime s'arretait a l'etape « resoudre l'URL »
   (« Aucun deploiement Preview en succes pour le SHA ... apres 10 min »). C'etait
   la cause du blocage, pas la base. Corrige.
2. **`ae73467`** — double temoin independant d'existence (`to_regclass` **et**
   `pg_class`) : un seul temoin ne permet pas de distinguer « table absente » de
   « base inattendue ».
3. **`33dfd6a` / `7310898`** — situation de la base dans le temps. `_prisma_migrations`
   est **refusee** a `tracefab_app` (mesure PGlite : `42501 permission denied for
   table _prisma_migrations`) : impossible de la lire. Remplace par une **sonde de
   fonction** lue dans `pg_proc` (aucun privilege requis, aucun secret — seulement
   des noms deja publics dans le depot).

## 2. Contrat de cle, etabli sur le code (pas sur le nom)

| Aspect | Valeur reelle | Source |
|---|---|---|
| Variable | `TRACEFAB_IDENTITY_KEY` | `api/_lib/identite-jeton.ts` |
| Format | hexadecimal, au moins 64 caracteres, longueur **paire** | `cleIdentiteValide` |
| Decodage | `Buffer.from(cle, 'hex')` -> 32 octets | `signerIdentite` |
| Longueur | >= 64 caracteres pour >= 32 octets | idem |
| Version de cle | **le jeton** porte `v1|userId|org|usage|expiration` ; la **cle en base** n'a pas de numero dans son format — sa `version` est un entier de ligne, et la base prend la ligne `actif` de `version` la plus haute (`ORDER BY k.version DESC LIMIT 1`) | `signerIdentite` + migration `20261031120000` |
| Lien runtime <-> base | La base recalcule `hmac(corps, k.secret, 'sha256')` avec **sa** cle active et compare au MAC recu. Le runtime ne connait donc que la **valeur**, pas la version : si la cle runtime ne correspond pas a la cle active en base, **la verification echoue** et `verifiee_par_la_base=false` | migration `20261031120000` |
| Absente | `signerIdentite` rend `null`, mode permissif documente ; `etatCleIdentite='absente'` | `identite-jeton.ts` |
| Invalide | **leve `CleIdentiteInvalide`**, la requete est refusee — pas de repli silencieux | `etatCleIdentite='invalide'` |
| Cle en base lisible par `tracefab_app` | **NON** — `REVOKE ALL` puis `GRANT SELECT` uniquement sur la table de **politique** ; RLS FORCEE sur `tracefab_identity_cles`, proprietaire distinct. C4.13-C4.20 PASS sur PGlite (9/9) | migration `20261031120000` |

**Consequence operationnelle importante** : la cle posee sur Preview doit etre
**exactement** la valeur de la ligne `actif` de `tracefab_identity_cles` (version 1,
32 octets). Toute autre valeur produirait une signature que la base refuserait —
c'est-a-dire C1 `FAIL`, pas C1 `PASS`.

## 3. Preuve runtime du SHA final

Fichier : branche `preuves/p107-7310898`, `livrables-finalisation/preuves/p107-runtime-preuves.json`
(hors ligne `10:13:11Z`, cible `tracefab-3si4kex3r-...`).

```
baseIdentite:
  table_presente                : false
  table_vue_par_pg_class        : false
  prisma_migrations_presente    : true
  tables_publiques              : 51
  fonction_posterieure_presente : true
  rls_forcee                    : false
  mode_strict                   : null
identityTokens   : configured=false, mode=non_configure
identitySysteme  : configured=false, mode=non_configure
databaseIdentity : currentUser=tracefab_app, database=neondb, bypassesRls=false,
                   isSuperuser=false, canEscalate=false
C3               : 3/3 PASS (401 sans jeton, 401 jeton faux, 401 sans ?identity=1)
```

**Lecture, et c'est le point decisif.** La base est **bien migree** (51 tables,
`_prisma_migrations` presente) et elle a **avance au-dela** de la migration
d'identite (la fonction `tracefab_current_user_email` de `20261102120000` existe).
Pourtant les tables `tracefab_identity_cles` et `tracefab_identity_politique` sont
**absentes**.

Ce n'est donc **ni** un retard de migration, **ni** une base vide, **ni** un
probleme de deploiement : la migration `20261031120000` a ete **sautee** sur cette
base, ou appliquee sans creer ces tables. C'est exactement ce que le workflow
`p11-preview-p107-migration.yml` verifie avec `verification_p107_preview_migration.mjs`,
qui **n'a jamais reussi** (5 executions, 5 echecs le 2026-11-09).

**Cette conclusion contredit l'etat annonce en preambule** (« tables presentes,
`strict = true`, une cle active version 1 de 32 octets »). Je le signale sans
l'ignorer : soit l'etat decrit porte sur une **autre branche Neon** que
`br-square-bread-b1gu7jk7`, soit il a ete observe via une connexion admin directe
alors que le runtime Preview joint une autre base. Les trois temoins ci-dessus sont
mesures **par le runtime lui-meme**, sur le deploiement du SHA de la PR : ils font
foi pour C1/C2.

## 4. Aucun PASS sans preuve runtime

C1 et C2 restent **BLOCKED**. Je ne les declare ni PASS sur la foi de l'etat
annonce, ni FAIL : la cause est une configuration absente, pas un defaut du code.
Le code est correct et prouve — c'est la base et la variable qui manquent.

## 5. Action manuelle restante — UNE seule

**Objet : rendre la base Preview **reellement jointe par le runtime** conforme, puis y poser la cle.**

1. Depuis une console Vercel du projet, lire l'URL `DATABASE_URL` de l'environnement
   **Preview** du deploiement `7310898` et relever son **endpoint** Neon. Le comparer
   a `ep-lively-field-b1wicg4v`. S'il differe, c'est cette base-la qu'il faut traiter,
   pas celle du preambule.
2. Sur **cette** base, executer `prisma migrate deploy` (jamais `resolve`, jamais
   `_prisma_migrations` a la main) via le workflow prevu, sous `neondb_owner`
   endossant `tracefab_migrator`.
3. Poser `TRACEFAB_IDENTITY_KEY` sur l'environnement **Preview** uniquement, avec la
   valeur de la ligne `actif` de `tracefab_identity_cles` de cette meme base.
   Generation si necessaire : `node scripts/generer_cle_identite.mjs --environnement Preview`
   — la valeur ne sort que sur stdout, ne la collez nulle part dans ce chat.

**Rien a faire en Production.** Aucune fusion.

## 6. Cause du retard de cette session, sans detour

Les trois premiers SHA (`b668c5a`, `1d3580d` partiellement) n'ont produit **aucune
mesure exploitable** : un type incomplet a casse le build Vercel, donc il n'y avait
pas de deploiement a interroger. Mes tests locaux ne l'ont pas vu parce qu'ils
exercaient une **doublure** du corps de reponse : une doublure valide ne prouve pas
que le module compile. Seul `api:typecheck` le prouve, et il exige `@prisma/client`
genere, absent de cet environnement (`binaries.prisma.sh` injoignable). La CI, elle,
l'avait signale des le premier passage. Le controle retenu pour la suite : lancer
`npx tsc` sur le fichier modifie **avant** chaque push, et lire le statut Vercel.
