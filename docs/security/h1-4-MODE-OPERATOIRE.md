# H1.4 — mode opératoire lecture seule

15 octobre 2026. Artefact : `docs/security/h1-4-diagnostic-lecture-seule.sql`.  
**Aucune connexion de production n’est autorisée depuis l’agent. Ce document ne demande aucune chaîne de connexion.**

Le diagnostic SQL local antérieur `diagnostic-pre-migration-close-public-execute-gap.sql` est **conservé**. Il n’est pas le véhicule Q1–Q6.

## Deux modes, deux garanties — refus par défaut

| Mode | Variable | Connexion | Transaction unique READ ONLY | Q5.A/B |
|---|---|---|---|---|
| **jetable** (validation locale) | `TRACEFAB_H1_4_MODE=jetable` + `TRACEFAB_H1_4_CIBLE=locale` + `TRACEFAB_H1_4_CONFIRM_READONLY=oui` | PostgreSQL **local** seulement (`PGHOST` ∈ {localhost, 127.0.0.1, ::1} ou socket Unix). `PGSERVICE` / `PGHOSTADDR` non local / `PGOPTIONS host=` : **refus avant connexion**. | **Oui**, via le wrapper uniquement. | Envoyés au serveur **seulement** si `\gset` + `\if` (commandes **psql**) voient `lecture_ok`. |
| **neon-manuel** (collecte) | `TRACEFAB_H1_4_MODE=neon-manuel` | **Aucune.** Le wrapper refuse d’ouvrir une session. | **Non.** Chaque collage dans l’éditeur = une session. | Coller Q5.A/B **seulement** si `Q1.prisma_migrations_etat = lecture_ok`. |

Le wrapper **n’est pas** un client Neon. Il ne se lance pas « contre la production ». Un hôte non local est refusé en mode jetable **parce qu’il n’est pas local**, pas par une liste `*.neon.tech`.

Interdit : `psql -f …sql` **seul**, `psql -1` / `--single-transaction`, coller une URL, `GRANT` / `REVOKE` / `migrate`.

## Limites lecture seule (ne pas les présenter comme inviolables)

- `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` et `default_transaction_read_only=on` : défaut des transactions **suivantes**. Un superutilisateur, ou un `SET TRANSACTION READ WRITE` (absent du SQL actuel), peut les outrepasser.
- `BEGIN READ ONLY` : **cette** transaction. Un `COMMIT` dans le fichier (absent aujourd’hui) la terminerait.
- `ON_ERROR_STOP=1` : si une instruction du fichier échoue, `psql` quitte **avant** le `-c ROLLBACK`. L’abort à la déconnexion annule la transaction (ROLLBACK **implicite**). Ce n’est pas le `ROLLBACK` explicite.

## Mode jetable

```bash
export TRACEFAB_H1_4_MODE=jetable
export TRACEFAB_H1_4_CIBLE=locale
export TRACEFAB_H1_4_CONFIRM_READONLY=oui
# libpq local déjà configuré — ne pas coller d'URL.
bash scripts/run_h1_4_diagnostic_readonly.sh
```

Sans `psql` : sortie 2, **non exécuté**, pas un succès.

Workflow dédié `.github/workflows/h1-4-postgres.yml` (pas le `ci.yml` préexistant) : matrice **postgres:17 ET postgres:18**, base `tracefab_test`, **aucun** secret, **pas** de migrate / `prepare_ci_db_role`. Les deux versions majeures sont validées parce que Neon de production exécute PostgreSQL 18 (incident P3018 du 15 oct. 2026 — renommage `p_org → p_organization_id` rejeté par PG18 — était spécifique à cette version). Le workflow n’est **pas** dispatché manuellement tant que les artefacts H1.4 ne sont pas suivis et qu’une autorisation de push n’est pas donnée. Le `ci.yml` de `main` n’injecte aucun secret (base jetable `localhost/tracefab_test`) et peut être lancé sans risque sur n’importe quelle branche.

```bash
bash scripts/run_h1_4_diagnostic_readonly.sh --self-check
bash scripts/run_h1_4_diagnostic_readonly.sh --help
```

## Mode neon-manuel (éditeur SQL Neon) — procédure opérateur pas à pas

Ce mode est une collecte manuelle par un opérateur autorisé. L’agent et le wrapper ne se connectent pas à Neon. Chaque bloc exécuté dans l’éditeur est une requête distincte : les résultats ne forment pas une transaction unique.

### Prérequis opérateur

- Utiliser son accès autorisé et l’éditeur SQL du projet et de la base à examiner, sélectionnés dans l’interface selon la procédure interne. Vérifier la cible dans l’interface, mais ne communiquer ni identifiant de projet, ni hôte, ni URL.
- Ouvrir la version examinée de `docs/security/h1-4-diagnostic-lecture-seule.sql`. Copier les blocs depuis ce fichier sans les réécrire ni les concaténer.
- Exécuter un seul bloc à la fois dans l’éditeur, lire son résultat avant de poursuivre et conserver l’ordre ci-dessous. Ne pas lancer le fichier entier avec `psql`.
- Garder hors du chat et de l’agent tout mot de passe, URL de connexion et autre secret. Cette procédure ne demande aucune chaîne de connexion à l’agent.

### Ordre de collage (strict — 8 blocs au total)

Copier séparément chaque bloc SQL délimité par ses marqueurs `-- >>>H14:…` et `-- <<<H14:…`, dans cet ordre :

1. `Q1` — `-- >>>H14:Q1` … `-- <<<H14:Q1`.
2. `Q2` — `-- >>>H14:Q2` … `-- <<<H14:Q2`.
3. `Q3` — `-- >>>H14:Q3` … `-- <<<H14:Q3`.
4. `Q4` — `-- >>>H14:Q4` … `-- <<<H14:Q4`.
5. `Q5.C` — `-- >>>H14:Q5C` … `-- <<<H14:Q5C`.
6. `Q6` — `-- >>>H14:Q6` … `-- <<<H14:Q6`.
7. `Q5.A` — `-- >>>H14:Q5A` … `-- <<<H14:Q5A`, **uniquement si** la porte Q1 vaut exactement `lecture_ok`.
8. `Q5.B` — `-- >>>H14:Q5B` … `-- <<<H14:Q5B`, **uniquement si** la porte Q1 vaut exactement `lecture_ok`.

Q5.A et Q5.B sont deux collages distincts, après Q6. Si la porte ne vaut pas `lecture_ok`, ne pas les coller ; indiquer explicitement qu’ils n’ont pas été exécutés et pourquoi. Les huit blocs sont des requêtes isolées, pas les étapes d’une transaction commune.

### Décision de porte (après Q1)

Lire la valeur de `Q1.prisma_migrations_etat` exactement :

- `lecture_ok` : poursuivre Q2, Q3, Q4, Q5.C et Q6 ; Q5.A puis Q5.B sont autorisés dans l’ordre indiqué.
- `objet_absent` : poursuivre Q2, Q3, Q4, Q5.C et Q6, mais **ne pas** coller Q5.A/B. L’absence de la table n’autorise aucune conclusion sur cinq migrations.
- `refus_privilege` : poursuivre Q2, Q3, Q4, Q5.C et Q6, mais **ne pas** coller Q5.A/B. Un refus de lecture n’est pas une absence de migrations.
- Erreur SQL/catalogue, résultat Q1 incomplet ou état inattendu : **arrêter**. Ne pas coller de bloc suivant et transmettre le texte de l’erreur, avec les éléments sensibles masqués.

Ne jamais remplacer ces états par une interprétation déduite d’un résultat partiel. Une erreur catalogue n’est pas `objet_absent`.

### Lecture des résultats Q1..Q6 (attendus)

| Bloc | Résultat attendu | Lecture critique |
|---|---|---|
| Q1 | 1 ligne. | Distinguer `current_user` / `session_user` (session de diagnostic) et `prisma_migrations_etat`. Le migrateur Prisma reste `inconnu` : `current_user` ne le prouve pas. |
| Q2 | 6 lignes. | Inventaire des six fonctions, présence, propriétaire et propriétés de catalogue. Si une fonction est absente, les colonnes qui en dépendent sont `NULL` ; `NULL` n’est pas une valeur `false`. |
| Q3 | 6 lignes. | Distinguer l’ACL `PUBLIC` directe, les porteurs d’ACL directs et le droit effectif de `tracefab_app` (héritage compris). Si fonction ou rôle manque, les valeurs prévues peuvent être `NULL` : ce n’est pas une preuve de refus. |
| Q4 | n lignes d’ACL par défaut, puis 1 ligne de synthèse. | La synthèse compte les lignes `pg_default_acl`. Zéro ligne signifie que le défaut intégré du moteur s’applique ; ce n’est pas une preuve sur le migrateur. Évaluer les défauts selon le créateur d’objet, pas selon `current_user`. |
| Q5.C | 1 ligne : six booléens et `statut_lecture`. | Un `false` avec `lecture_ok` signifie que la fonction n’a pas été résolue ; un `false` avec `refus_privilege` est indéterminé, pas une absence prouvée. |
| Q6 | 4 lignes. | Lire les états et propriétaires des quatre objets. `proprietaire` est le propriétaire d’objet ; `migrateur_prisma` reste `inconnu` tant que l’opérateur ne confirme pas le rôle de `prisma migrate deploy` et que les éléments historiques ne concordent pas. |
| Q5.A | 5 lignes, seulement si Q1 vaut `lecture_ok`. | État des cinq migrations ciblées (`absente`, `annulee`, `incomplete` ou `terminee`). Ne pas inférer cet état si le bloc n’a pas été exécuté. |
| Q5.B | 0 à 5 lignes, seulement si Q1 vaut `lecture_ok`. | Jusqu’aux cinq migrations récentes terminées et non annulées. Zéro ligne ici ne remplace pas Q5.A et ne prouve pas l’absence des cinq migrations ciblées. |

Si un bloc renvoie une erreur, appliquer la règle d’arrêt ci-dessus : ne pas transformer l’erreur en absence d’objet ou en résultat vide.

### Règles d’or (jamais de dérogation)

1. **Pas de `psql -f` sur Neon**, ni de collage du fichier entier : seuls les blocs délimités ci-dessus sont destinés à l’éditeur.
2. **Pas de `BEGIN` ou `COMMIT` manuel** et aucune affirmation de transaction unique : chaque collage est une exécution indépendante.
3. **Ne pas coller `Q1_GATE`, `\if`, `\gset` ou `\endif`** : ce sont des commandes `psql`, pas du SQL serveur. Ne coller que les blocs Q1, Q2, Q3, Q4, Q5.C, Q6 et, si autorisés, Q5.A/Q5.B.
4. **Masquer systématiquement** avant tout partage les mots de passe, URL, hôtes, identifiants de projet et tout autre secret. Ne jamais les envoyer à l’agent.
5. **Q5.A/B seulement si** `Q1.prisma_migrations_etat = lecture_ok` exactement. `objet_absent` ou `refus_privilege` ne signifie pas « cinq migrations absentes ».
6. **Ne jamais inférer le migrateur de `current_user`, `session_user` ou du seul propriétaire d’objet.** Il reste `inconnu` jusqu’à confirmation explicite de l’opérateur et concordance historique.
7. **Toute erreur SQL, catalogue ou résultat inattendu = arrêt immédiat.** Ne pas poursuivre, corriger ou interpréter l’erreur comme une absence ; transmettre le message d’erreur avec les valeurs sensibles masquées.

### Vérifications avant collage (self-check)

Depuis le dépôt local, ces contrôles ne se connectent à aucune base :

```bash
bash scripts/run_h1_4_diagnostic_readonly.sh --self-check
TRACEFAB_H1_4_MODE=neon-manuel bash scripts/run_h1_4_diagnostic_readonly.sh
```

Le premier vérifie la présence de l’artefact et des marqueurs Q1–Q6 et doit sortir `0`. Le second est un refus intentionnel : le wrapper affiche un rappel, n’ouvre aucune connexion et sort `2`. Ce code `2` n’est ni une exécution du diagnostic ni un succès de requête. Ne pas utiliser le mode `jetable` contre Neon.

### Après exécution — transmission du résultat

- Transmettre les sorties sous forme de tableaux séparés, dans l’ordre Q1, Q2, Q3, Q4, Q5.C, Q6, puis Q5.A et Q5.B si et seulement si Q1 valait `lecture_ok`. Il y a au plus huit tableaux ; pour Q5.A/B non exécutés, indiquer l’état exact de la porte, sans fabriquer de lignes.
- Si une requête échoue, arrêter la séquence et transmettre le texte brut de l’erreur, en masquant les secrets, URL, hôtes et identifiants de projet. Ne pas envoyer des résultats partiels comme s’ils étaient complets.
- Garder les libellés et les valeurs nécessaires à l’analyse, mais ne transmettre aucune information de connexion. Ne pas conclure sur les migrations ni nommer un migrateur à partir de la seule identité de session.
- Pour la suite de l’analyse et l’interprétation, voir **H1.5 ensuite** ; ne pas choisir ici une variante de migration.

## Identités (ne pas fusionner)

1. Session de diagnostic = `Q1.current_user` / `Q1.session_user`.
2. Propriétaire d’objet = `Q6.proprietaire` (4 lignes).
3. Migrateur Prisma = `inconnu` jusqu’à concordance des propriétaires **et** un mot d’opérateur (rôle de `prisma migrate deploy`, zéro URL).

## Cardinalités (quand la requête **s’exécute**)

| Q | Lignes |
|---|---|
| Q1 | 1 |
| Q2 | 6 (`presente = false` + NULL si fonction absente) |
| Q3 | 6 (`app_execute_effectif` NULL si rôle absent) |
| Q4 | n ACL + 1 synthèse |
| Q5.A | 5 — **uniquement si** `lecture_ok` |
| Q5.B | 0 à 5 |
| Q5.C | 1 (6 booléens + `statut_lecture`) |
| Q6 | 4 |

Erreur catalogue → arrêt (`ON_ERROR_STOP`) ou message d’erreur éditeur. Ce n’est pas une absence d’objet.

## H1.5 ensuite

Recueillir les résultats **sans** choisir une variante de `20261012120000` ici. H1 reste non établie tant que le migrateur n’est pas nommé par l’opérateur.
