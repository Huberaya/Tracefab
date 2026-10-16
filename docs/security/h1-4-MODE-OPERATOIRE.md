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

Workflow dédié `.github/workflows/h1-4-postgres.yml` (pas le `ci.yml` préexistant) : matrice **postgres:17 ET postgres:18**, base `tracefab_test`, **aucun** secret, **pas** de migrate / `prepare_ci_db_role`. Les deux versions majeures sont validées parce que Neon de production exécute PostgreSQL 18 (incident P3018 du 15 oct. 2026 — renommage `p_org → p_organization_id` rejeté par PG18 — était spécifique à cette version). Le workflow n’est **pas** dispatché tant que les artefacts H1.4 ne sont pas suivis et qu’une autorisation de push n’est pas donnée. `HEAD` de `ci.yml` injecte encore un secret de connexion : **ne pas** lancer le CI de `HEAD`/`main`.

```bash
bash scripts/run_h1_4_diagnostic_readonly.sh --self-check
bash scripts/run_h1_4_diagnostic_readonly.sh --help
```

## Mode neon-manuel (éditeur)

`\gset` et `\if` sont des commandes **psql**, pas du SQL serveur. Ne pas les coller.

1. Copier uniquement le bloc `>>>H14:Q1` … `<<<H14:Q1`.
2. Lire `prisma_migrations_etat`.
3. Copier Q2, Q3, Q4, Q5.C, Q6 (blocs marqués), **séparément**.
4. **Q5.A et Q5.B** : seulement si l’étape 2 vaut exactement `lecture_ok`.
5. Si `objet_absent`, `refus_privilege`, ou erreur catalogue : **ne pas** coller Q5.A/B ; **ne pas** conclure à cinq migrations absentes.

Chaque collage est une session distincte. Ne jamais les présenter comme une transaction unique. Ne pas communiquer d’identifiant ni d’URL.

```bash
export TRACEFAB_H1_4_MODE=neon-manuel
bash scripts/run_h1_4_diagnostic_readonly.sh
# → exit 2, aucune connexion, rappel de la procédure.
```

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
