# Matrice des migrations — candidat d'intégration

Base : `origin/main` @ `788df220`. Sept migrations additives, aucune migration existante modifiée.
Empreintes complètes : `preuves/empreintes-migrations.txt`.

| # | Migration | L. | sha256 (12) | Défaut corrigé | Préexistant ? |
|---|---|---|---|---|---|
| 1 | `20261108120000_ingest_plm_graphe_versionne` | 693 | `eebb9f2107c6` | Ingestion : fonction officielle + idempotence nœuds/liens | Non |
| 2 | `20261108120100_worker_fonctions_systeme_completes` | 245 | `f3cb1f41fff8` | Propriété des 2 fonctions Clerk **+ prérequis réels** (INSERT `organization_memberships`, INSERT `audit_logs`, politiques `*_worker_*`, `CREATE` borné et révoqué) | Non |
| 3 | `20261108120200_corrections_p106_ownership_et_appartenance` | 104 | `13a869c9273c` | Appartenance worker bornée, `2BP01` | Oui |
| 4 | `20261108120300_acl_colonnes_bornees_au_runtime` | 145 | `205d108bcf03` | ACL colonnes 24/7 → **9/0** | Oui |
| 5 | `20261108120400_lien_graphe_statut_enum_type` | 119 | `b4e1afd9d5df` | `42804` sur `tracefab_add_supply_chain_link` | Oui |
| 6 | `20261108120500_lecture_users_requise_par_les_politiques` | 100 | `0d51bea0e19f` | `tracefab_app` sans `SELECT` sur `users` ⇒ 3 lectures cassées | **Oui** |
| 7 | `20261108120600_lecture_orders_requise_par_le_runtime` | 91 | `8d1fc35d245e` | `orders` sans privilège ⇒ obstacle de bascule | **Oui** |

## Ordre et dépendances

```
120000 ingestion ──dépend de──> 120400 (type ENUM)
120100 propriété ──exige─────> CREATE sur public (posé puis RETIRÉ, retrait vérifié)
120200 appartenance ─exige───> tracefab_worker créé par 20261028120100
120500 lecture users ─exige──> users RLS active + forcée, users_select_self
120600 lecture orders ─exige─> orders RLS active + forcée, orders_select_participant
```

## Rejouabilité

| État | Résultat |
|---|---|
| Base vierge | 76/76 appliquées |
| Second `migrate deploy` | aucune migration en attente, exit 0 |
| Sous `tracefab_migrator` (non superutilisateur) | 76/76 appliquées |
| `ALTER ... OWNER TO` déjà fait | sans effet (contrôle préalable) |

## Ce que les migrations refusent de laisser passer

Chaque fichier vérifie ses prérequis et **échoue** plutôt que de réussir partiellement :

- `120100` : `worker_create_sur_public_non_revoque`, `tracefab_app_member_of_worker`, `worker_ownership_incomplete`
- `120200` : `worker_membership_admin_forbidden`, `tracefab_app_member_of_worker`
- `120500` : `lecture_users_non_effective`, `users_rls_non_forcee`, `users_select_self_absente`
- `120600` : `lecture_orders_non_effective`, `orders_rls_non_forcee`, `orders_select_participant_absente`

C'est délibéré : un déploiement vert qui casse à la première requête est le pire des états, et c'est exactement ce qui s'est produit deux fois pendant ce travail.
