# PLM/ERP — politiques RLS de `plm_erp_sync_jobs` : rapport de remise

Périmètre strict : **uniquement** les politiques RLS de `plm_erp_sync_jobs`.
Migrations (au-delà de ce correctif), autres contrôles de sécurité, décision de
fusion : **chef de chantier**. Aucun accès en écriture à la production n'a été
effectué. Aucun `prisma migrate deploy`. `_prisma_migrations` non touchée.

## A. SHA

| Élément | Valeur |
|---|---|
| SHA de départ de cette sous-mission | `bc61dc7` |
| SHA final (ce rapport, avant ce commit) | `3b83138d3de052a9c56fb773c45c840841fd810c` |
| Branche | `arena/c27ddaa4-tracefab` (PR #102, **Draft maintenu**) |
| `main` | `bf55f2ae6534cde84d072d9b975520216c7b6d4e` (inchangé) |

## B. Constat majeur — le correctif demandé existait déjà

`prisma/migrations/20261028150000_reconcile_plm_erp_sync_job_policies/migration.sql`
est **présente dans `bc61dc7`** et fait exactement ce qui était demandé :

- `BEGIN` … `COMMIT` (atomique) ;
- gardes **fail-closed** exécutées **avant tout DROP** : table absente,
  politiques canoniques absentes, `WITH CHECK` canonique contenant
  `contributor` ⇒ `RAISE EXCEPTION` ;
- exactement **deux** `DROP POLICY IF EXISTS` :
  `plm_erp_sync_jobs_insert_brand` et `plm_erp_sync_jobs_select_brand` ;
- aucune migration historique modifiée ; migration **additive**.

**Aucune nouvelle migration n'a donc été écrite.** La valeur ajoutée de ce
tour est la **preuve exécutable**, pas un second correctif.

## C. Ce qui a été produit

| Fichier | Nature |
|---|---|
| `scripts/test_plm_rls_isolation_prouvee.mjs` | nouveau — **43 vérifications**, PGlite, chaîne complète des migrations |
| `package.json` | ajout `test:plm-rls-isolation` |
| `.github/workflows/ci.yml` | ajout d'une étape dédiée (job « Socle ») |
| ce rapport | livrable |

### Ce que le test prouve, par exécution

1. **La politique partielle est insuffisante** — état A (4 politiques) / B
   (insert retirée seule) / C (correctif complet). En B, l'écriture est bien
   fermée **mais** `contributor` lit toujours les jobs de l'autre organisation :
   la combinaison **OR** est confirmée par mesure, pas par raisonnement.
2. **Après correctif, exactement deux politiques subsistent** :
   `plm_sync_jobs_insert_brand`, `plm_sync_jobs_select_org` — obtenu par un
   **balayage exhaustif** de `pg_policies` (predicat `tracefab_is_org_member` /
   `tracefab_has_org_role`), pas par une liste écrite à la main.
3. **Refus** : `contributor` ne peut pas insérer (erreur `42501` sur le
   `WITH CHECK`).
4. **Acceptation** : owner / admin / manager insèrent.
5. **Isolation entre deux organisations** : aucune ligne de l'organisation B
   n'est visible depuis A, et réciproquement.
6. **Aucun accès induit par une politique permissive résiduelle** : aucun
   prédicat orphelin ne subsiste.
7. **Idempotence** : migration rejouée **3 fois** de suite sur la même base.
8. **Gardes fail-closed** : base neuve sans les canoniques, canonique absente,
   table absente ⇒ la migration **refuse** au lieu de supprimer à l'aveugle.
9. **Privilèges effectifs** de `tracefab_app` : SELECT/INSERT/UPDATE/DELETE =
   **true** (DELETE est bien accordé par `20261019160000`), TRUNCATE /
   REFERENCES / TRIGGER = false, `PUBLIC` = false partout.
   `relrowsecurity = true` **et** `relforcerowsecurity = true`.

### Point de méthode corrigé (important pour la revue)

L'assertion portant sur DELETE a d'abord échoué, et l'échec était **instructif** :

- **`USING` filtre, il ne rejette pas.** Un DELETE sans politique ne lève
  **aucune erreur** : il supprime 0 ligne. Attendre `42501` était faux.
- L'anomalie « `avant=0 apres=1` » venait d'un **comptage sous deux rôles
  différents** (le `avant` était mesuré sous le rôle applicatif, donc filtré
  par la RLS). Elle est levée : les deux comptages sont désormais faits **sous
  le même rôle**, et l'assertion porte sur l'**effet** (aucune ligne ne
  disparaît), pas sur un code d'erreur.
- L'assertion n'a **pas** été affaiblie : elle est devenue **vraie**, et le test
  vérifie en plus qu'aucune politique `polcmd='d'` **ni** `polcmd='*'`
  (FOR ALL) ne couvre DELETE.

## D. Tests et CI au SHA exact

- Suite nouvelle : **43/43**.
- Suites PLM voisines, rejouées : `test_plm_sync_jobs_acces` 19/19,
  `test_plm_erp_convergence_chaine` 27/27,
  `test_plm_sync_job_policy_reconciliation` 12/12,
  `test_provenance_politiques_plm` 12/12,
  `test_plm_erp_policy_convergence` PASS.
- Batterie autonome (PGlite / statique) : **18/19** — le seul code non nul est
  `verifier_confrontation_production`, un **outil** qui exige un fichier `psql`
  en argument, pas un test.
- **CI `40869768422` sur `3b83138`, 4/4 jobs verts**, étape
  « PLM — politique partielle vs complete, idempotence, privileGES effectifs »
  effectivement **exécutée** (`success`).

## E. Non exécuté (à ne pas lire comme réussi)

- `prisma migrate deploy` : **gelé** par consigne, non exécuté.
- Application réelle sur la branche `production` : **non exécutée**, aucun
  accès en écriture.
- Lots 1 à 4 de la stratégie de réconciliation : non exécutés.
- Plusieurs suites `test:neon:*` : sortie 2 « NON EXÉCUTÉ — `DATABASE_URL`
  absent ». Elles ne comptent pas comme vertes.

## F. Risques résiduels

1. La preuve est établie en **PGlite**, pas sur la base Neon réelle. Elle
   démontre la sémantique SQL et le comportement des politiques, pas l'état de
   production de `plm_erp_sync_jobs`.
2. La migration est **idempotente et fail-closed**, mais elle **supprime** :
   si la production ne correspond pas aux canoniques attendues, elle **refuse**
   — comportement voulu, mais qui nécessitera une décision du chef de chantier.
3. Les 11 écarts de la matrice de migrations et les autres P0 (identité worker,
   champs sensibles) sont **hors périmètre** de ce correctif et restent ouverts.

## G. Verdict

**PASS** — pour le périmètre « politiques RLS de `plm_erp_sync_jobs` », sur
`3b83138` : correctif présent et vérifié, preuve exécutable complète, CI verte
sur le SHA exact.

Ce verdict **ne vaut pas** autorisation de fusion. La PR #102 reste en **Draft** ;
la décision de fusion et le sort des migrations relèvent du chef de chantier
après revue indépendante.
