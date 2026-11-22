# Plan de traitement des 13 PR ouvertes

**Date :** 2026-11-22
**`main` de référence :** `6ef90c6` (1241 commits)
**Base :** `2026-11-22-etat-des-lieux-13-pr.md` (mesures) — ce document est le **plan d'exécution**.

> ## Avancement au 2026-11-22 (fin de session) — `main` = `94c4c09`
>
> | Lot | État | Détail |
> |---|---|---|
> | **A — #108** | ✅ **fusionnée** | `94c4c09`, CI 4/4 après relance d'un test instable |
> | **B — #70** | ✅ **fermée** | sous-ensemble plus faible de `main`, motif mesuré |
> | **B — #82** | ✅ **fermée** | régression de privilèges sur 3 tables |
> | **D — #80** | ✅ **fusionnée** | `282862e`, allowlist fusionnée sans perte d'entrée |
> | C, E, F | ⏸️ en attente | accord de fermeture / choix de base / chantier |
>
> Deux PR ont donc été **fusionnées** et deux **fermées**. Le nombre de PR ouvertes est passé de 15 à 10 — une PR neuve, **#138**, est apparue et n'est pas analysée ici.
>
> **Incident de CI rencontré** : après la fusion de #108, `Verification — suite de tests` a échoué sur `test:p1:browser` (attente de 30 s expirée sur un message du portail fournisseur, job à 2 min au lieu de 10). Le code a été vérifié sain (la clé i18n `portal.spNRequestSubmittedDemo` existe et est câblée dans `supplier-portal.1.js:548`) ; la relance est passée au vert. **Ce test n'a ni retry ni timeout explicite** : il retombera. Voir §10.

---

## 0. Découverte qui change le plan : #82 est un risque de sécurité

L'état des lieux disait « #82 est le plus récupérable ». **Mesure faite depuis : c'est faux, et en pire.**

La migration de #82 (`20261022120000_minimize_app_table_dml`, 22 octobre) réaccorde explicitement des droits DML que `main` a **retirés exprès depuis** :

| Table | #82 réaccorde | `main` aujourd'hui |
|---|---|---|
| `documents` | `UPDATE` | **SELECT seul.** Le chemin `uploaded → scanning` passe par `tracefab_mark_document_scanning`. Un `UPDATE` brut permettait de forger `status`, `sha256`, `available_at` via un GUC de session. |
| `tracefab_products` | `INSERT`, `UPDATE` | **Colonne par colonne.** Les 4 colonnes calculées ne sont accessibles que par les fonctions `SECURITY DEFINER`. |
| `users` | `INSERT`, `UPDATE` | **Absent de la matrice DML.** |

Fusionner #82 **rouvrirait trois chemins d'écriture que `main` a fermés après le 22 octobre**, dont un qui permet de forger le résultat d'un scan antivirus sur un document.

Sa migration est *structurellement* antérieure au durcissement du 28 octobre. Elle était intelligente (liste blanche fermée par défaut) mais elle est **périmée dans son contenu**. **Verdict : ne pas fusionner. À fermer.** Ce n'est pas « un chantier à reprendre » : c'est un risque.

---

## 1. Vue d'ensemble

| Lot | PR | Nature | Effort | Risque |
|---|---|---|---|---|
| **A** | #108 | Sortir du draft, fusionner | **Très faible** | Décision politique, pas technique |
| **B** | #70, #82 | Fermer (périmées / régressives) | **Très faible** | Nul — accord explicite requis |
| **C** | #122→#125 | Fermer les 4 (contrat inverse) | **Faible** | Nul — accord explicite requis |
| **D** | #80 | Résoudre le conflit d'allowlist | **Moyen** | Faible |
| **E** | #91→#94 | Choisir une base, rebrancher 2 harnais, fermer 3 | **Moyen** | Moyen |
| **F** | #101 | Découper | **Élevé** | Élevé |

**Ordre recommandé : A → B → C → D → E → F.** A, B et C ne touchent aucun code : ce sont des décisions, et elles débloquent le reste. D et E produisent du code. F est un chantier à part.

---

## 2. Lot A — #108 (la seule fusionnable)

**État :** 1 fichier doc, 0 conflit, CI verte 4/4, 468 commits de retard, draft.

**Le document est lu et contrôlé** : 0 motif sensible (`postgresql://`, `sk_live`, `npg_`, `@ep-`, `neon.tech`), 76 lignes, cohérent avec lui-même, honnête sur ses limites (dit explicitement que la signature HMAC n'est **pas** prouvée et que ce n'est **pas** un GO pour `strict`).

**Étapes :**
1. Votre accord sur le **principe** : fusionner acte par écrit dans `main` qu'une mesure de Production a été exécutée le 3 novembre. C'est la seule question ouverte.
2. **Réaligner la branche sur `main`** avant fusion (468 commits de retard + `strict_required_status_checks_policy: true` l'impose).
3. `gh pr ready 108`, attendre la CI au nouveau SHA, `gh pr merge 108 --squash`.

**Piège attendu :** après le réalignement, la CI repart de zéro (~15 min). Si `main` bouge entre-temps, il faut recommencer.

---

## 3. Lot B — fermer #70 et #82

Aucun code à écrire. Deux fermetures, chacune avec un motif mesuré à recopier dans le commentaire de fermeture.

**#70** — sous-ensemble **strictement plus faible** de `main`. Sa migration `20261021110000_revoke_app_migration_table_dml` fait un `REVOKE` partiel sur `_prisma_migrations` ; `main` fait `REVOKE ALL PRIVILEGES` **suivi de** `has_table_privilege(...)` qui lève une exception si un privilège subsiste (`20261021130000`). CI rouge (3 jobs), 619 commits de retard.

> ⚠️ **Correction à mon rapport du 21/11** : j'avais écrit « réintroduit une migration au contenu différent ». C'était un artefact de mesure (le fichier n'existait pas dans la base de #70, `main` l'a créé après). Le motif de fermeture est celui ci-dessus, pas l'ancien.

**#82** — voir §0. Réaccorde `UPDATE` sur `documents`, `INSERT/UPDATE` sur `tracefab_products` et `users`. Migration antérieure au durcissement du 28/10.

> ⚠️ **Correction** : dans l'état des lieux j'ai écrit « la PR la plus récupérable ». La mesure des tables accordées montre l'inverse.

**À joindre aux deux fermetures :** le commentaire doit dire *pourquoi* (sous-ensemble plus faible / régression de privilèges), pas seulement « obsolète ». Ces PR contiennent un raisonnement de sécurité qui mérite d'être laissé tracé.

---

## 4. Lot C — fermer #122 → #125

Chaîne d'itérations, #125 la plus aboutie. **Le point de rupture est vérifié :** #125 écrit `CREATE ROLE admin ... BYPASSRLS` et contrôle `!r.rolbypassrls` pour l'administrateur **et** le migrateur. `main` fait délibérément l'inverse :

```
admin    : NOBYPASSRLS   (contrôlé : rolbypassrls -> rejet)
migrator : BYPASSRLS     (contrôlé : !rolbypassrls -> rejet)
```

Donner `BYPASSRLS` à l'administrateur annule l'isolation RLS que ces PR prétendent apporter. Les 4 sont rouges (Socle pour #122, Base pour les trois autres).

**Une chose à sauver avant de fermer :** #125 porte un script npm `db:prepare-ci-migration-roles` **absent de `main`** (dont l'étape CI l. 757 appelle `node scripts/...` en dur). Ce n'est pas un correctif de sécurité, c'est de la lisibilité — à reporter dans une PR neuve si vous y tenez, mais **pas** un motif pour fusionner #125.

**Étapes par PR :** fermer avec le motif « contrat `BYPASSRLS` inverse de `main`, cf. `prepare_ci_migration_roles.mjs` ». Aucune n'est en conflit avec `main` (#122 : 0 conflit) — la fermeture sera donc propre.

**Alternative si vous préférez ne rien fermer :** garder #125 en draft unique représentant la chaîne, fermer #122/#123/#124 comme doublons. Cela réduit de 4 à 2 le bruit sur le tableau des PR.

---

## 5. Lot D — #80 (le seul vrai travail de fusion)

**État :** 3 fichiers, 1 conflit, CI verte 8/8 (c'est la PR la mieux testée du lot), 548 commits de retard.

**Le conflit n'est pas trivial** — contrairement à ce que j'avais écrit. `docs/security/workflow-privileged-allowlist.json` a été modifié **7 fois** dans `main` après le fork de #80 (`82bb8a5`, `9f2d492`, `88d18da`, `556125e`, `a7fc222`, `5030268`…). #80 ajoute une entrée `clerk-tenant-journeys.yml` en milieu de ce fichier.

**Étapes :**
1. `git checkout -B treat/80 origin/security/clerk-tenant-journeys-20261021`
2. `git merge origin/main` → conflit attendu sur l'allowlist
3. **Réinsérer l'entrée `clerk-tenant-journeys.yml`** à sa place alphabétique dans l'objet de `main`, en **gardant** les entrées ajoutées depuis. Ne pas prendre un côté en bloc : ce fichier est un registre de sécurité, une entrée perdue est un trou d'audit.
4. Vérifier `//updated` (la date sera à réactualiser).
5. **Lancer `node scripts/test_workflow_policy.mjs`** — ce garde valide la politique des workflows **et** l'allowlist (« Politique des workflows : OK »). Vérifié : il passe sur `main` aujourd'hui, il exige la devDependency `yaml` (présente dans `main`), et il tourne en ~1 s.

   > **Il n'est branché dans AUCUN workflow.** Même défaut que #119/#118/#91–#94, cette fois dans `main` lui-même. Le registre de sécurité le plus sensible du dépôt — celui qui liste quels workflows ont le droit de voir quel secret — n'est protégé par aucune garde automatique. C'est à corriger séparément (§10).
6. Pousser, CI, fusionner.

**Effort réaliste :** 1 à 2 tours, dont l'essentiel à relire le fichier fusionné. C'est le seul lot où une erreur silencieuse (entrée perdue) est plus probable qu'un échec bruyant.

---

## 6. Lot E — #91 → #94

Quatre itérations sur le même sujet (preuve P1 staging sur Preview), même merge-base, 541 commits de retard.

| PR | CI | Fichiers | Lecture |
|---|---|---|---|
| #94 | ROUGE (3 jobs) | 28 | contenu le plus abouti |
| #92 | VERT 5/5 | 26 | seule verte |
| #93 | en cours | 21 | draft |
| #91 | ROUGE (1 job) | 15 | point de départ |

**Découverte :** `test_p1_staging_harness.mjs` et `test_preview_deployment_selection.mjs` ne sont référencés dans **aucun** workflow de **aucune** des quatre — vérifié dans l'arbre de chaque PR, pas dans `main`. C'est le défaut de #119/#118, répété deux fois.

**Étapes :**
1. Choisir la base : **#94** (contenu) ou **#92** (CI verte). Recommandation : **#94**, parce que son rouge porte sur les 3 preuves qu'on cherche justement à obtenir, alors que #92 est verte peut-être parce qu'elle teste moins.
2. Sur cette base, **rebrancher les deux harnais** dans `p1-staging-authenticated.yml` (ou le workflow approprié).
3. Rebaser sur `main` (541 commits) — attendre des conflits sur `ci.yml`.
4. Faire passer la CI, dont les 3 preuves Preview qui exigent des secrets `sk_test_`.
5. Fermer les trois autres avec « remplacée par #X ».

**Le vrai obstacle n'est pas git : ce sont les secrets.** Ces preuves exigent un environnement Preview et des jetons Clerk de test. Si l'environnement `tracefab-clerk-test` ou l'allowlist n'est pas prêt, ce lot ne peut pas aboutir, quelle que soit la qualité du rebase. **À vérifier avant de commencer**, pas après.

---

## 7. Lot F — #101

72 fichiers, **16 conflits**, 521 commits de retard, CI non concluante, 6 scripts de test ajoutés dont aucun n'est branché (sauf 2). C'est du DPP complet : persistance, aperçu brouillon privé, preuves HTTP authentifiées.

**Ne pas tenter de recaler.** 16 conflits sur une PR de cette taille, c'est une réécriture, pas un merge. Un rebase produirait un diff que personne ne peut relire — donc pas de revue de sécurité possible, ce qui est précisément le risque.

**Étapes :**
1. Cartographier la branche en lots (les 72 fichiers se regroupent en : migrations, routes API, resolver DPP, UI aperçu, preuves/tests).
2. Créer une PR neuve **par lot**, à partir de `main` actuel, en récupérant les fichiers par `git checkout <sha> -- <chemins>`.
3. Ordonner les lots par dépendance.
4. Fermer #101 une fois les lots extraits.

**Effort :** plusieurs tours, et c'est le seul lot qui justifie un chantier dédié. À traiter en dernier, ou à reporter.

---

## 8. Ce qu'il me faut de vous

Le plan est exécutable, mais trois décisions m'appartiennent pas :

1. **#108** — accordez-vous au principe de fusionner un document qui acte une mesure de Production ? Si oui, je le fais cette session.
2. **Fermetures** — accord explicite pour fermer **#70, #82, #122, #123, #124, #125** (6 PR) ? J'ai le motif mesuré pour chacune. Sans accord, je ne ferme rien.
3. **#91 → #94** — confirmez le choix de #94 comme base, ou préférez #92.

**Ce que je peux faire sans attendre :** le lot D (#80). Il ne demande aucun arbitrage — juste du travail de fusion et de vérification. Je peux commencer par là pendant que vous tranchez.

---

## 9. Réserves

- **Je n'ai exécuté aucun test de #91–#94 ni de #101** : ce sont des preuves Preview/staging qui exigent des secrets. Leurs verdicts reposent sur la CI et les workflows, pas sur une exécution locale.
- **La migration de #82 n'a pas été rejouée** sur une base jetable. L'analyse porte sur son SQL comparé à la matrice de `main`, ce qui suffit pour conclure au risque, mais je n'ai pas mesuré l'effet réel de son exécution.
- **Le clone Git redevient superficiel tout seul.** Constaté deux fois pendant cette session, dont une fois en pleine mesure : `git log -- <fichier>` a affiché le fichier entier comme « ajouté » parce que la frontière du clone tombait dessus. **Toute mesure d'historique doit être précédée de `git fetch --unshallow`.** Un chiffre faux a failli partir dans ce plan à cause de ça.

---

## 10. Hors périmètre des 13 PR, mais trouvé en chemin

**`scripts/test_workflow_policy.mjs` n'est appelé par aucun workflow.** Il valide la politique des workflows et l'allowlist des secrets privilégiés. Lancé à la main : « Politique des workflows : OK » en ~1 s, avec la devDependency `yaml` déjà présente.

C'est le **quatrième cas** de la même famille, après `test:private-storage` (#119), `test:public-dpp-route` (#118) et les deux harnais de #91–#94. Celui-ci est le plus grave : un fichier `workflow-privileged-allowlist.json` peut être édité sans que rien ne vérifie sa cohérence, alors que c'est le registre qui décide quels workflows accèdent à `CLERK_SECRET_KEY` et consorts.

**Recommandation :** une PR dédiée, une seule ligne dans le job `Socle`, exactement comme pour #119 et #118. Petite, sûre, et elle ferme la classe de défaut plutôt qu'une instance.

Cela suggère aussi une vérification systématique à faire une fois : **lister tous les `scripts/test_*.mjs` de `main` et vérifier lesquels ne sont appelés par aucun workflow.** Le chiffre serait utile à connaître.
