# Rapport de mission — P10.7, l'origine des opérations système

**Date :** 2026-11-06
**Objet :** fermer l'escalade multi-tenant mesurée le 2026-11-05
**Livrable :** PR **#114** (`arena/b8fe1a44-tracefab`, commits `b650c6d` et `bd27ed5`)
**Verdict :** **correction prouvée sur base jetable et sur forme de production. Aucune bascule réelle effectuée — elle demande une autorisation humaine.**

---

## 1. Ce que la mission a trouvé, et pourquoi ce n'était pas ce qu'on croyait

L'énoncé initial parlait d'une **identité falsifiée**. La mesure a dit autre chose : l'identité n'était pas falsifiée, elle était **gagnée**.

Un attaquant obtenait un jeton parfaitement valide pour *sa propre* organisation — la chaîne HMAC n'était pas en cause — puis appelait les opérations système **sans aucun jeton**. Elles ne lisaient aucune identité.

Le défaut était donc en amont du contrôle : il manquait sur l'**origine**, pas sur l'identité.

| Étape | Action de l'attaquant | Avant | Après |
|---|---|---|---|
| 1 | jeton valide pour son organisation A | accepté | accepté |
| 2 | `tracefab_sync_clerk_membership('mem_x', B, lui, 'owner')` **sans jeton** | **accepté** | **`42501 authentication_required`** |
| 3 | adhésion écrite chez B | **1** | **0** |
| 4 | `tracefab_has_org_role(B,'owner')` | **true** | **false** |
| 5 | produits de B lus | **2** | **0** |

Mesuré sur deux bases jetables, même rôle `tracefab_app` (`NOSUPERUSER`, `NOBYPASSRLS`), seule la migration différant.

---

## 2. Ce qui a été livré

22 fichiers, **+3 183 / −21**.

| Livrable | Rôle |
|---|---|
| `prisma/migrations/20261106130000_identite_systeme_signee/migration.sql` (663 l.) | la 70ᵉ migration : jeton système vérifié par la base, treize gardes, sonde d'exploitation, postcondition inversée |
| `api/_lib/identite-systeme.ts` (225 l.) | signature et état de la clé, côté application |
| `api/_lib/contexte-systeme.ts` (84 l.) | frontière HTTP : le contexte système n'est posé que si l'appelant a le secret d'exploitation |
| `scripts/activer_identite_systeme_stricte.mjs` (202 l.) | l'acte d'exploitation (`--verifier` / `--dry-run` / `--activer` / `--desactiver`) |
| `scripts/lib/derivation_droits_runtime.mjs` (221 l.) | les droits du runtime sont **dérivés du code**, plus tenus à la main |
| `scripts/test_p107_identite_systeme_signee.mjs` (447 l.) | 54 assertions — arme et restaure le mode |
| `scripts/test_p107_activation_mode_systeme.mjs` (285 l.) | 23 assertions — l'activation refuse sans clé, sans garde |
| `scripts/test_p107_identite_systeme_module.mjs` (223 l.) | 47 assertions — avec **et** sans variable d'environnement |
| `docs/security/2026-11-05-p107-identite-systeme.md` (374 l.) | mesures, risques R1–R7, ordre de déploiement, rollback |
| `docs/security/candidats/2026-11-06-retour-arriere-identite-systeme.sql` (45 l.) | retour arrière pour l'opérateur, testé |

---

## 3. Résultats mesurés

Toutes les suites lancées depuis une base **permissive** — c'est-à-dire dans l'état où la CI la trouve, sans aucun secret.

| Suite | Résultat |
|---|---|
| `test:p107:identite-systeme` | **54/54** |
| `test:p107:activation-stricte` | **23/23** |
| `test:p107:identite-systeme-module` | **47/47** (variable posée **et** absente) |
| `test:neon:privileges-role-app` | 42/42 |
| `test:neon:registre-fonctions`, `ecarts-privileges`, `rls`, `bypass-control`, `app-readiness`, `write-policies` | vertes |
| `test:p106:identite-negative`, `rejouabilite-chaine`, `p105:*`, `p107:*` | vertes |
| **Balayage complet** | **27 suites vertes · 0 échec** |

**Base neuve, sans aucun secret :** 70 migrations, `systeme_strict = false`, **13 gardées / 0 non gardée**, **0 clé active**.

**Forme de production** (propriétaire des objets non superutilisateur, `BYPASSRLS`, `pgcrypto` installé avant la chaîne) : 70 migrations, **54/54**.

**Chaîne hors ligne** (PGlite) : 7 suites vertes, 70/70 dans chacune.

### Les contrôles négatifs, sans lesquels aucun chiffre ci-dessus ne vaut

| Contrôle | Résultat |
|---|---|
| mode permissif rétabli | **16 échecs** : les 13 opérations acceptent, l'adhésion est écrite |
| garde retirée d'une fonction | la sonde voit `1`, l'activation **refuse** (code 3) |
| aucune clé active | l'activation **refuse**, le mode reste `false` |
| 4 mutations du module de signature | 4 cas nommés échouent |
| fonction du dépôt hors registre | `test:neon:registre-fonctions` **échoue toujours** |

---

## 4. Défauts trouvés pendant la mission

### 4.1 Trois décisions de conception, chacune refusée par une suite au départ

1. **Le basculement ne peut pas être une migration.** Il exige une clé ACTIVE, donc un secret — et une base neuve n'en a aucun. Deux suites tombaient en `P0001`. Le mode est un **acte d'exploitation**, avec refus code 3 **avant** toute écriture, exactement comme `strict` depuis `20261102120000`.
2. **La sonde d'exploitation et le prédicat ne sont pas des droits du runtime.** Les deux élargissaient le périmètre **sans usage** : le prédicat n'est appelé que depuis des corps `SECURITY DEFINER`, et la sonde n'a pas à être exécutable par l'application. `EXECUTE` retiré, aucun nom ajouté au registre.
3. **Les droits du runtime sont désormais dérivés du code** (règles R4/R5/R6), au lieu d'une liste tenue à la main — le mécanisme même qui avait laissé passer le défaut.

### 4.2 Deux défauts dans mon propre code, trouvés par mes propres tests

- **`etatCleSysteme(undefined)`** retombait sur la variable d'environnement, la déclarait *valide*, puis levait un `TypeError` : le chemin de repli **fermé** devenait une panne. Trois écritures essayées, **deux fausses** — une valeur par défaut s'applique aussi sur un `undefined` explicite ; seul `arguments.length` distingue les deux appels.
- **La route de readiness** lisait `wantIdentity` **avant sa déclaration** (`ReferenceError` à chaque appel). Le `typecheck` local ne pouvait pas le voir : `@prisma/client` n'est pas généré dans cet environnement, donc `api:typecheck` s'arrête avant. **Le build Vercel de la PR est vert** — la vérification réelle a donc bien eu lieu, cette fois.

### 4.3 Deux registres rendus faux par la 70ᵉ migration

La CI les a signalés avant moi, ce qui est exactement leur fonction :

- `test:chantiers` → **« 69 = 70 »** : le registre de pilotage annonçait encore 69 migrations et ne décrivait pas la 70ᵉ ;
- `test:jetables:verrou-cluster` → **« chemin non classé : `test_p107_activation_mode_systeme.mjs` »**. La suite prenait bien le verrou, mais son nom ne figurait dans aucune des deux listes. La mesure était juste sur le fond, fausse dans sa forme : un chemin qui prend le verrou doit être **déclaré**.

### 4.4 Un contrôle trop large, corrigé pour ne pas casser le produit

`test:neon:registre-fonctions` refusait *tout* `GRANT EXECUTE` postérieur au registre — y compris celui d'une fonction **déclarée**. Il poussait donc à retirer un droit dont l'application a besoin, c'est-à-dire à faire passer un test en cassant le produit. Il exige désormais l'**égalité**.

---

## 5. Ce qui n'est PAS prouvé

- **Aucune mesure en Production.** Elle est en lecture seule pour cette mission ; aucune n'a été tentée.
- **Aucune mesure sur Neon.** Le classifieur de cible refuse les hôtes managés : la *forme* a été reproduite, pas l'hôte.
- **Aucun déploiement de la révision applicative** sur un environnement qui sert : la sonde `identitySysteme` est écrite et testée hors ligne, elle n'a encore servi nulle part.
- **Empreintes de migration Prisma (divergence PLM)** : hors périmètre, comme convenu.

---

## 6. Risques résiduels

Sept risques documentés au § 6 du rapport technique ; les trois qui pèsent sur la décision :

| # | Risque | Portée |
|---|---|---|
| **R1** | un détenteur de `TRACEFAB_IDENTITY_KEY` peut émettre un jeton système | inhérent à tout secret partagé, **même modèle** que le secret worker ; la clé vit hors de la base, donc un détenteur des seuls identifiants PostgreSQL ne peut plus rien |
| **R3** | mode permissif : une opération sans jeton reste acceptée | c'est l'état d'une base neuve, et il est **mesuré** ; le retour arrière est une ligne |
| **R7** | 37 fonctions `pgcrypto` exécutables par le runtime | **pré-existant** (mesure identique avant P10.7), aucune ne permet de signer sans clé ; ACL posée par `CREATE EXTENSION`, non retirable sans le détruire |

---

## 7. État de livraison

**PR #114** — les **sept vérifications CI sont vertes** :

| Vérification | Résultat |
|---|---|
| Socle — types, compilation, isolation | ✅ 4 min 34 |
| Base — isolation RLS exécutée | ✅ 2 min 19 |
| Chaîne 34/36/41 sur Postgres 17 jetable | ✅ 1 min 20 |
| Parcours — navigateur réel | ✅ 10 min 47 |
| Vérification — suite de tests | ✅ 11 min 03 |
| Vercel · Vercel Preview Comments | ✅ |

**PR #108** n'est ni modifiée ni fusionnée ; les preuves y sont rattachées en commentaire.

Aucune base jetable résiduelle, aucun rôle résiduel, aucun secret en clair dans le diff.

---

## 8. Ce qui demande une décision humaine

Rien de ce qui suit n'a été fait, et rien ne sera fait sans accord explicite.

1. déployer la révision qui signe le contexte système ;
2. provisionner `TRACEFAB_IDENTITY_KEY` (CSPRNG, ≥ 32 octets hexadécimaux), sans jamais l'afficher ;
3. mesurer `GET /api/internal/p2-readiness?identity=1` → `mode = "signe"` **et** `verifiee_par_la_base = true` ;
4. rejouer un webhook Clerk, puis vider l'outbox ;
5. **seulement alors** poser `systeme_strict = true` ;
6. revérifier que l'absence de jeton est refusée en `42501`.

Tant que 3 et 4 ne sont pas verts sur l'environnement visé, **le mode permissif reste en place** : c'est l'état actuel, et il est assumé plutôt que subi.

---

## 9. Conclusion

Le défaut du 2026-11-05 est fermé **dans le code**, avec des preuves qui incluent les contrôles négatifs — sans eux, un test de sécurité ne prouve que sa propre capacité à passer.

Trois choses valent d'être retenues au-delà de ce chantier :

- **le contrôle manquait sur l'origine, pas sur l'identité** : c'est la question qu'il faut poser à chaque opération privilégiée ;
- **une liste tenue à la main est un défaut en attente** : les droits sont maintenant dérivés du code ;
- **« le typecheck passe » n'est pas « le typecheck a regardé ce fichier »** : deux défauts de cette mission étaient invisibles en local et visibles en intégration continue.

La bascule en production reste une décision d'exploitation, pas une conséquence de ce rapport.

---

*Rapport technique détaillé, mesures et ordre de déploiement : `docs/security/2026-11-05-p107-identite-systeme.md`.*
