# Phase 1 — Sécurisation du pipeline GitHub

**Date :** 2026-10-12
**Branche de travail :** `arena/879cd8db-tracefab`
**Autorisation :** niveau B (préparation, corrections locales, branches). Aucune
modification distante, aucun réglage GitHub, aucun déploiement.

Ce document décrit ce qui a été **exécuté**, ce qui a été **préparé**, et ce qui
**attend une autorisation ou un accès**. Rien n'y est présenté comme appliqué en
production.

---

## 1. État constaté avant correction

| Élément | État |
|---|---|
| `main` protégée | non — aucune règle, aucun ruleset |
| Environnements GitHub | deux, sans règle de protection |
| Collaborateurs | un seul |
| Dépôt | public, forking autorisé, pas de secret scanning |
| Workflow `CI` | désactivé manuellement (`disabled_manually`) |
| Workflow `Figer la reference visuelle` | actif, `contents: write` |
| Secret `DATABASE_URL` | présent (les requêtes `gh secret list` et `actions/permissions` répondent 403) |

## 2. Le scénario destructif contre la production

### 2.1 Ce qui existait

`ci.yml`, job `base-de-donnees`, portait deux lignes :

```yaml
env:
  TF_SECRET_PRODUCTION: ${{ secrets.DATABASE_URL }}
```

```yaml
- name: Scenarios croises contre la base de production
  if: ${{ env.TF_SECRET_PRODUCTION != '' }}
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
  run: |
    npm run test:neon:security
    npm run test:neon:supplier
    npm run test:neon:product
    npm run test:neon:quality
    npm run test:neon:collection
```

Le déclencheur du workflow est `push: branches: ['**']`. Un contributeur ayant
le droit d'écriture sur le dépôt et modifiant ce fichier sur **sa** branche
obtenait l'exécution de cinq suites destructives contre le secret lu. Ces
suites créent et suppriment des rôles, accordent et révoquent des privilèges,
et écrivent des lignes.

### 2.2 Ce qui a été corrigé, et comment

La correction ne se limite pas au retrait des lignes. Retirer une étape protège
ce workflow ; elle ne protège pas du suivant. La cause racine est qu'une suite
destructive pouvait s'exécuter **sans avoir prouvé ce qu'elle allait
modifier**. La décision a donc été déplacée du workflow vers les suites
elles-mêmes.

**a) Garde de cible — `scripts/lib/require-throwaway-db.mjs`**

Refus par défaut. Une cible doit être localement jetable, ou distante **et**
déclarée par trois variables concordantes :

```
TRACEFAB_ALLOW_NONLOCAL_TEST_DB=true
TRACEFAB_TEST_DB_HOST_ALLOWLIST=<hote>
TRACEFAB_TEST_DB_NAME_ALLOWLIST=<base>
```

Refus inconditionnels, quel que soit le reste de la configuration :

* contexte de déploiement de production (`VERCEL_ENV=production`) — refusé même
  pour une cible locale ;
* hôte de base managée connu (`*.neon.tech`, `*.supabase.*`, RDS, Azure) non
  explicitement autorisé ;
* nom de base évoquant la production (`prod`, `production`, `live`, `main`) ;
* cible absente, illisible ou non analysable.

Rien de sensible ne sort : ni URL, ni hôte, ni identifiant, ni mot de passe.
Le rapport publie une classification, le nom de base et une empreinte SHA-256
tronquée — assez pour corréler un journal, insuffisant pour reconstituer un
secret. Des codes de sortie distincts séparent les cas : `2` = aucune cible
fournie (le test n'a pas tourné), `3` = cible refusée.

**b) Lanceur commun — `scripts/run-db-suite.mjs`**

Toutes les suites destructives y passent. La garde s'applique donc à **tous**
les chemins d'exécution : CI, poste de développement, commande manuelle,
script d'exploitation, futur workflow. Dix commandes npm ont été réécrites.

**c) Le workflow**

* suppression de `TF_SECRET_PRODUCTION` et de l'étape destructive ;
* le job `base-de-donnees` ne référence plus le contexte `secrets` du tout ;
* `scripts/seed_rls_fixture.mjs`, qui crée un rôle et écrit des lignes, passe
  désormais par la garde (`npm run db:seed-rls`) ;
* les actions tierces sont épinglées par SHA complet avec leur version lisible
  (les SHAs correspondent aux tags flottants `v4` vérifiés le 2026-10-12) ;
* trois nouveaux contrôles dans l'étage `socle` (voir §3).

### 2.3 Preuves d'exécution

La garde est éprouvée dans les deux sens — c'est la seule façon d'établir
qu'un contrôle refuse quelque chose.

```
$ DATABASE_URL="<chaine-neon-jamais-reelle>" \
    node scripts/run-db-suite.mjs scripts/test_neon_security.mjs
  REFUS — cible non autorisee pour : scripts/test_neon_security.mjs
  DATABASE_URL -> REFUSEE | classe=remote_not_opted_in | base=neondb | empreinte=1f2e815c4c37
  ... Aucun secret ni chaine de connexion n a ete affiche : sortie 3.
  (exit 3, aucune connexion ouverte)

$ VERCEL_ENV=production DATABASE_URL="postgresql://postgres:postgres@localhost:55432/tracefab_test" \
    node scripts/run-db-suite.mjs scripts/test_neon_security.mjs
  DATABASE_URL -> REFUSEE | classe=production_context | raison=contexte de deploiement de production
  (exit 3)

$ env -u DATABASE_URL node scripts/run-db-suite.mjs scripts/test_neon_security.mjs
  NON EXECUTE — DATABASE_URL absent(s). ... sortie 2.   (exit 2)

$ npm run test:db-guard
  15 verifications passees, 0 echec(s).
```

Le test de politique des workflows a été éprouvé par contrôle négatif : une
étape lisant `secrets.DATABASE_URL` a été réintroduite temporairement dans
`ci.yml`, le contrôle a échoué sur trois assertions, puis la version correcte a
été restaurée et le contrôle est redevenu vert.

## 3. Contrôles ajoutés, et ce qu'ils empêchent

| Contrôle | Commande | Ce qu'il empêche |
|---|---|---|
| Garde de cible | `npm run test:db-guard` | qu'une cible non jetable soit acceptée, y compris par accident |
| Routage destructif | `npm run test:db-routing` | qu'une nouvelle suite écrivant en base s'ajoute sans garde — un fichier destructif non déclaré fait échouer la CI |
| Politique des workflows | `npm run test:workflow-policy` | lecture de `secrets`, action non épinglée, `contents: write` non déclaré, job écrivain exécutant du code du dépôt, déclencheur privilégié non déclaré |
| Contrôle négatif Prisma | `npm run test:prisma-client` | qu'un contrôle de client Prisma devienne complaisant |
| Client Prisma | `npm run verify:prisma-client` | qu'un paquet soit déployé avec un client factice |
| Chargement des routes | `npm run test:router-load` | le mode de défaillance exact de l'incident du 2026-10-12 |
| Audit lecture seule | `npm run test:audit-script` | qu'un script d'audit puisse écrire, ou divulguer une chaîne de connexion |

Le test de routage vérifie aussi que les outils d'exploitation restent hors des
chaînes automatiques : `scripts/seed_pilot.ts` et
`scripts/verifier_checksums_migrations.mjs` écrivent volontairement vers une
cible nommée, ne sont atteignables ni depuis `npm test` ni depuis `npm run
build`, et portent chacun un mode sans écriture.

## 4. `Figer la reference visuelle` — réduction de privilège préparée

### 4.1 Ce que le workflow fait réellement

* **déclencheurs :** `workflow_dispatch` (n'existe que sur la branche par
  défaut) et `push` sur le chemin `tests/regression/reference/.figer` — donc
  sur **n'importe quelle branche** ;
* **permissions :** `contents: write` **au niveau du workflow** ;
* **actions possibles :** `git commit` et `git push` sur la branche qui a
  déclenché le run ;
* **accès aux secrets :** **aucun**. Ce workflow ne lit pas `secrets` ;
* **accès à la base :** aucun.

### 4.2 Le défaut, énoncé précisément

Le risque n'est pas la lecture de secrets — il n'y en a pas. Le risque est
qu'un jeton capable d'**écrire dans le dépôt** soit détenu par un job qui
installe des dépendances, télécharge un navigateur et **exécute le code du
dépôt**. Un déclencheur qui exécute du code avec un droit d'écriture transforme
ce droit en capacité de commit. C'est la même classe de défaut que
l'incident 2C, où une étape de CI lisait le secret de production.

### 4.3 La correction préparée

Le droit n'est pas supprimé — il est **déplacé là où il sert**.

| Job | Permissions | Ce qu'il exécute |
|---|---|---|
| `generer` | `contents: read` | `npm ci`, `db:generate`, Playwright, serveur, `test:regression --maj` ; dépose les images en artefact |
| `pousser` | `contents: write` | télécharge l'artefact, `git commit`, `git push`. **Aucun code du dépôt** |

Le job `pousser` porte en outre l'environnement GitHub
`figer-reference-visuelle` : y déclarer des relecteurs obligatoires transforme
la poussée automatique en acte approuvé, **sans modifier le fichier**.

Fichiers préparés :

* `docs/security/patches/figer-reference-visuelle.durci.yml` — version durcie complète ;
* `docs/security/patches/figer-reference-visuelle.permissions.patch` — diff applicable.

**Pourquoi un patch et non un fichier actif :** le workflow **n'existe pas sur
`main`** ; il vit sur la branche `arena/91844ee9-tracefab` (PR #34). L'ajouter
dans cette branche produirait un conflit *add/add* à la fusion. Le patch
s'applique sur la branche qui détient le fichier :

```bash
git checkout <branche detenant le fichier>
git apply docs/security/patches/figer-reference-visuelle.permissions.patch
```

### 4.4 Preuve que le contrôle mord

La version d'origine a été placée temporairement dans `.github/workflows/` :

```
--- figer-reference-visuelle.yml        (version d'origine)
  ECHEC D. demande contents: write sans declaration au registre
  ECHEC H. `permissions: contents: write` au niveau du workflow : tous les jobs heritent du droit

--- figer-reference-visuelle.yml        (version durcie)
  ok    D. contents: write declare et justifie
  ok    H. le job « pousser » detient contents: write et n execute aucun code du depot
```

Le contrôle `H` est l'invariant qui compte, et il est **structurel** : il
s'applique à tous les workflows présents dans l'arbre, y compris ceux qui
n'existent pas encore. Un job qui détient `contents: write` et lance `npm`,
`npx` ou `node` fait échouer la CI.

## 5. Protection de `main` — réglages à appliquer par le propriétaire

Aucune de ces opérations n'a été exécutée : elles exigent un accès en écriture
sur la configuration du dépôt.

### 5.1 Ce que GitHub peut et ne peut pas garantir ici

Avec **un seul collaborateur**, exiger une approbation indépendante revient à
exiger que l'unique personne approuve son propre travail — GitHub l'interdit
par défaut. Les trois besoins sont donc distingués :

| Besoin | Mécanisme | Efficace à un collaborateur ? |
|---|---|---|
| Empêcher une modification accidentelle de `main` | PR obligatoire + pas de poussée directe | oui |
| Exiger une relecture indépendante | « Require approvals : 1 » + « Dismiss stale approvals » | **non** — impossible à un collaborateur |
| Validation par le propriétaire | Revue obligatoire par *code owner* | oui, si le propriétaire est *code owner* de tout |

Et une limite qui doit être écrite noir sur blanc : **les protections GitHub ne
bloquent pas les déploiements de l'intégration Vercel.** Un commit poussé sur
`main` déclenche un déploiement de production par l'intégration Vercel, qu'il
soit passé par une PR ou non. La protection de branche filtre les *commits*,
pas les *déploiements*.

### 5.2 Réglages exacts — Settings → Branches → Add branch protection rule

Nom du motif : `main`. Cocher :

* **Require a pull request before merging** → oui
  * Require approvals : **1** *(à un collaborateur, cette case ne peut pas être satisfaite par un tiers ; la laisser à 0 ou accepter que le propriétaire approuve sa propre PR selon le réglage du dépôt)*
  * Dismiss stale pull request approvals when new commits are pushed → **oui**
  * Require review from Code Owners → **oui** (ajouter un `CODEOWNERS` désignant le propriétaire)
  * Require conversation resolution before merging → **oui**
* **Require status checks to pass before merging** → oui
  * Require branches to be up to date before merging → **oui**
  * Checks à retenir (noms exacts des jobs) :
    * `Socle`
    * `Verification`
    * `Parcours`
    * `Base — isolation RLS executee`
  * **Attention :** le workflow `CI` est actuellement `disabled_manually`. Tant
    qu'il reste désactivé, un check obligatoire **bloque toute fusion**, car un
    check attendu et jamais produit n'est jamais vert. Il faut le **réactiver
    d'abord** (Actions → CI → Enable workflow).
* **Require linear history** → au choix du propriétaire
* **Do not allow bypassing the above settings** → **oui** (sinon les
  administrateurs contournent silencieusement les règles)
* **Restrict who can push to matching branches** → oui, personne
* **Allow force pushes** → **non**
* **Allow deletions** → **non**

### 5.3 Réglages Vercel — à traiter séparément

* Project Settings → Git : vérifier si `main` est la *Production Branch*.
* Envisager **Ignored Build Step** pour que seuls les commits destinés à la
  production déclenchent un déploiement de production.
* Vérifier la protection des *Preview Deployments* (accès par mot de passe) si
  les previews exposent des données réelles.
* **Point non vérifié ici :** l'accès à la console Vercel n'est pas disponible
  dans cet environnement. Ces trois points sont à confirmer par le
  propriétaire ; ils ne sont pas constatés.

### 5.4 Environnements

* Settings → Environments → `figer-reference-visuelle` : y ajouter
  **Required reviewers** (le propriétaire). Sans relecteur, l'environnement
  n'est qu'une étiquette.
* Vérifier les règles de branche autorisées pour les deux environnements
  existants.

## 6. Conformité au mode de déploiement réel

Constat qui conditionne tout le reste : **le déploiement de production est
produit par l'intégration Vercel, jamais par un workflow GitHub.** Les 28
déploiements de production du projet sont tous attribués à `vercel[bot]` ; la
production sert exactement `b0c976f`. Aucun workflow du dépôt ne déploie.

Conséquence directe : durcir les workflows et protéger `main` réduit la
surface côté GitHub, mais **ne réduit pas** la surface de déploiement. Celle-ci
se règle dans Vercel.

## 7. Ce qui reste ouvert

1. **Réactiver le workflow `CI`** avant de rendre un check obligatoire, sinon
   toute fusion est bloquée.
2. **Appliquer les réglages de §5.2 et §5.3** — accès non disponible ici.
3. **Appliquer le patch `figer`** sur la branche qui détient le fichier, ou
   accepter que la fusion de la PR #34 fasse rougir la CI sur le contrôle `H` —
   ce qui est le signal attendu, pas une panne.
4. **Revue de la PR #35** : le diff est exactement le retrait minimal et la
   documentation de l'incident 3B.4. Il ne contient **aucun garde-fou** : sa
   fusion seule ne protège pas de la réintroduction, contrairement à ce que ce
   chantier apporte. Les deux sont complémentaires ; la PR #35 peut être
   fusionnée sans risque de régression, mais elle ne clôt pas le sujet.
5. **Preuve que la garde vise la bonne cible** : la CI doit avoir exécuté au
   moins une fois le job `base-de-donnees` avec la garde en place. Non constaté
   à ce jour.
