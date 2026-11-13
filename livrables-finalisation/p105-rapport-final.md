# P10.5 / P10.6 / P10.8 — rapport final

Branche `arena/9c419587-tracefab`, base `71855014`. Trois commits, une PR.

---

## A. Résultat

**Le job `Base — isolation RLS executee` est vert, en entier.**

| Étape | Avant | Après |
|---|---|---|
| 54 — P10.5 chaîne de migrations et escalade | **ÉCHEC** | vert |
| 55–57 — P10.5 jetons, HMAC, ingestion PLM | jamais atteintes | vertes |
| 58 — P10.6 contrôle négatif d'identité | jamais atteinte | vert |
| 59 — P10.6 chaîne rejouable | jamais atteinte | vert |
| 60 — P10.8 préflight D6 | jamais atteinte | vert |
| 61–67+ — P10.7 (7 étapes) | jamais atteintes | vertes |

`gh run view 43276485969` : `completed/success`, 4 jobs verts sur 4
(Socle, Base, Verification, Parcours), 79 étapes vertes sur 79 dans `Base`,
aucune étape non-verte.

Sur `main` (`71855014`, run `42531250889`) le même job était vert : la
régression est née dans cette branche, et elle est corrigée ici.

---

## B. GitHub

- **PR #126** — https://github.com/Huberaya/Tracefab/pull/126
  `OPEN`, prête pour revue, `MERGEABLE`, état `CLEAN`. Tous les checks passent.
- **PR #121** suit la branche `release/p107-runtime-production-20261110`,
  **pas** cette branche. Ses checks (dont un `Base` en échec sur `01c50a2`)
  mesurent du code qui n'est pas celui d'ici : ne pas les lire comme un
  verdict sur ce travail. #126 existe précisément pour donner à
  `arena/9c419587-tracefab` la vraie CI.

---

## C. Corrections

### 1. `131ef0d` — le banc P10.5 se donne un administrateur conforme

Trois causes, toutes dans le banc, aucune dans le produit.

**a. `TF_ADMIN_URL` n'est pas exporté au niveau du job** — seule l'étape
`db:deploy:throwaway` le reçoit. Sans lui la suite passait `DATABASE_URL`
(`postgres`, SUPERUSER) au runner, qui refuse cette identité depuis `f2c5dc1`
(« CREATEROLE non-superuser requis »), et c'est le comportement voulu. Le banc
crée donc `tf_p105_admin` — CREATEROLE, **non** superuser — avec ADMIN sur le
migrateur et sur le worker, exactement ce que pose
`prepare_ci_migration_roles.mjs` pour la CI, et le détruit à la fin. **La garde
n'est pas contournée** : le rôle créé n'est pas superutilisateur.

**b. B2.1 mesurait un mécanisme supprimé.** Elle cherchait les traces de
l'élévation temporaire de `tracefab_migrator` en SUPERUSER puis de sa
révocation. `MIGRATIONS_ASSISTEES` est désormais vide : le worker est
préprovisionné par un administrateur distinct, et le migrateur n'est plus
jamais élevé. L'assertion mesure maintenant ce qui le remplace — le
préprovisionnement est observé, aucune élévation n'apparaît, et
`pg_roles.rolsuper = false` après coup.

**c. B2.6 faisait tourner la matrice de rôles sous l'administrateur.** Cet
administrateur n'a aucun privilège de table (mesuré : `org_ins=false`,
`users_ins=false`). Ses cinq `INSERT` de décor échouaient donc en `42501`, par
le déclencheur `tracefab_refresh_supplier_profile_from_organization`, propriété
de `tracefab_migrator` — ce qui masquait la cause derrière le nom du helper
d'email. La matrice **sème avant de mesurer** : elle reçoit le propriétaire de
la base. Ses mesures, elles, restent sous `SET SESSION AUTHORIZATION` des trois
rôles, comme documenté dans son en-tête.

Deux robustesses au passage : `lancer()` ne transmet plus `TF_APP_MDP` /
`TF_MIGRATOR_MDP` hérités (une valeur périmée faisait échouer la matrice en
`28P01`) ; la simulation d'appartenance résiduelle est posée par le **même
grantor** que la révocation (PostgreSQL n'autorise la révocation qu'à lui).

### 2. `81bc237` — R7 ne compte comme jetable que ce que la suite a créé

`f2c5dc1` avait retiré le `DROP OWNED BY` inconditionnel du nettoyage, à juste
titre : dans le banc local `tracefab_worker` possède le schéma `public` et 11
fonctions de `tracefab_test`, et l'instruction les effaçait silencieusement
(erreur avalée par `.catch`).

Mais `tracefab_app` n'était pas enregistré comme préexistant, alors qu'en CI il
est créé **avant** le job par `db:prepare-ci-role`. R7 exigeait donc de détruire
un rôle qui ne lui appartenait pas ; `DROP ROLE` échouait sur les privilèges que
la chaîne lui avait accordés (93 fonctions, 72 relations, 4 politiques, plus
`CONNECT` sur la base — que `DROP OWNED BY` ne peut pas retirer, l'ACL d'une
base étant un objet de cluster).

### 3. `a8b4e9d` — P10.8 : E1 rejoue comme la production, et la précondition est écrite

E1 jouait la chaîne par le **propriétaire** (`postgres`). Depuis que la 62e
migration est préprovisionnée, le runner refuse une session qui n'est pas
`tracefab_migrator` : E1 s'arrêtait au rang 62.

E1 rejoue désormais la chaîne **par le migrateur**, dans le cadre de la
production (administrateur conforme, `pgcrypto` installé par l'administration,
`public` appartenant au migrateur, `TF_ADMIN_URL` pointant la base de travail).
Ce changement **dissout la précondition** du scénario — la fonction appartient
alors au migrateur, donc le préflight n'a plus rien à refuser et E2/E3
passeraient au vert sans rien mesurer. La fonction est donc **explicitement
rendue au propriétaire**, sur la base de travail : la propriété est l'hypothèse
testée, elle doit être écrite et non déduite d'un effet de bord.

---

## D. Preuves

**CI** — run `43276485969` sur `a8b4e9d` : `completed/success`.
`Base` : 79/79 étapes vertes, aucune non-verte. Les quatre jobs verts.

**Local**, à partir d'un cluster préparé
(`TF_APP_PASSWORD=isolation_ci_jetable npm run db:prepare-ci-role`), deux
exécutions consécutives pour chaque suite :

| Suite | Avant | Après |
|---|---|---|
| `test:p105:roles-et-migrations` | 31/32 (B2.6) | **32/32** ×2 |
| `test:p106:rejouabilite-chaine` | 31/32 (R7) | **32/32** ×2 |
| `test:p106:preflight-avant-ecriture` | 16/20 | **20/20** ×2 |
| `test:jetables:garde-cible` | — | **80/80** |
| `test:p107:grants-helpers-definer` | — | vert |
| `test:p107:chaine-grants-helpers` | — | vert |
| `test:migrations:restauration-role` | — | vert |

P10.5 est vérifiée **dans les deux topologies** : avec `TF_ADMIN_URL` fourni, et
sans (celle de la CI). Aucun rôle résiduel après les suites
(`tf_p105*`, `tf_p106*`, `tf_d6*` : aucun).

---

## E. Points non résolus

1. **Une seule machine locale ne peut pas enchaîner toutes les suites.** P10.5
   et P10.6 font tourner les mots de passe de `tracefab_app` /
   `tracefab_migrator` : la suite suivante échoue en `28P01`. Ce n'est pas un
   défaut du dépôt — c'est une propriété du banc, et la CI, qui part d'un
   cluster neuf, n'y est pas exposée. Remise en état :
   `TF_APP_PASSWORD=isolation_ci_jetable npm run db:prepare-ci-role`.

2. **Le contrôle final `TF_RLS_APP_URL` compare à l'environnement de
   l'opérateur**, pas à l'état réel du cluster. Une exécution qui a tourné le
   mot de passe le restaure (2 vérifieurs restaurés, vérifié), mais si le mot de
   passe du cluster diffère de celui de l'opérateur au départ, l'assertion
   tombe. Comportement attendu, non modifié : ne pas l'assouplir.

3. **`verify:prisma-client` ne peut pas passer en local** (pas de moteur natif,
   pas de réseau). CI uniquement.

4. **PR #121** reste en échec sur sa propre branche, pour des raisons
   antérieures et extérieures à ce travail. Elle n'a pas été touchée.

---

## F. Décision

Les trois défauts sont corrigés, chacun avec sa cause écrite dans le code et
dans un commit séparé, et chacun prouvé par une exécution locale doublée et par
la CI complète.

**Le job `Base` est vert de bout en bout, pour la première fois sur cette
branche.** Cela a débloqué huit étapes qui n'avaient jamais été exécutées ici
(58 à 67), et trois d'entre elles ont révélé de vrais défauts — tous dans les
bancs, aucun dans le produit. C'est la signature d'une réparation : plus on
avance, plus on découvre, et rien de ce qu'on découvre ne remet en cause le
produit.

**Prêt à fusionner.** PR #126, `CLEAN`, tous checks verts.
