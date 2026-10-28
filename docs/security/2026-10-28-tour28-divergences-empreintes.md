# Tour 28 — les trois divergences d'empreinte : contenu retrouvé, effet mesuré, décision

Branche `arena/c27ddaa4-tracefab`, commit `bc6b4a8`. Aucune écriture, aucune
connexion à la production pendant ce tour : tout est calculé et exécuté
localement, à partir de l'export d'historique fourni au tour 26.

## 0. Tableau demandé

| Migration | Empreinte dépôt `bc6b4a8` | Empreinte production | Contenu historique exécuté | Effet réel | Décision |
|---|---|---|---|---|---|
| `20261005090000_supplier_portal_advanced_hardening` | `13581e6c…` | `560356c2…` | **RETROUVÉ** (objet Git `3f5ecb8`) | **SÉMANTIQUE** — règle d'autorisation | **Migration corrective écrite** — `20261028140000`, prouvée au tour 29, non appliquée |
| `20261009180000_public_read_context` | `9100ed08…` | `c12ee333…` | **RETROUVÉ** (objet Git `59a57fa`) | **NUL** en production | **Ne rien faire** |
| `20261006210000_plm_erp_gs1_interoperability` | `330b6689…` | `c944ce0c…` | **INTROUVABLE** | **INCONNU** | **Confrontation requise** |

Les empreintes de production sont celles de l'export du 26/10 ; les empreintes
du dépôt sont recalculées depuis les fichiers au commit `bc6b4a8` par
`scripts/reconcilier-historique-migrations.mjs --sans-export`.

## 1. Comment le contenu historique a été retrouvé

`_prisma_migrations` enregistre `sha256(migration.sql)`. Une empreinte ne
s'inverse pas, mais elle **se vérifie** : il suffit de hacher des candidats.
Toute la base d'objets Git a donc été parcourue — y compris les 90 branches
distantes, non récupérées jusque-là :

```
1 010 blobs examinés (dépôt seul)      -> 0 correspondance
11 885 objets, 5 219 blobs (90 branches) -> 2 correspondances
```

C'est la récupération des branches distantes qui a débloqué le diagnostic. Deux
contenus historiques correspondent **exactement** à l'empreinte de production.

**Pourquoi cela compte** : sans eux, la seule issue aurait été de supposer. Un
diff entre deux fichiers inconnus ne se discute pas ; un diff entre le contenu
réellement exécuté et le contenu actuel se mesure.

Les deux fichiers sont conservés dans
`scripts/fixtures/empreintes-production-20261028/`, avec vérification
d'empreinte dans le test : **si quelqu'un modifie ces fixtures, le test échoue.**

## 2. `supplier_portal_advanced_hardening` — divergence sémantique

Le diff porte sur sept lignes, dans une fonction de déclencheur :

```sql
-- PRODUCTION (560356c2…)           -- DÉPÔT (13581e6c…)
IF NEW.target_role = 'owner' THEN    IF NEW.target_role = 'owner'
                                        AND NEW.relationship_id IS NULL THEN
  RAISE EXCEPTION                      RAISE EXCEPTION
    'owner_role_not_invitable';            'owner_role_not_invitable';
```

Mesuré par l'exécution, sur base jetable, avec les deux versions installées
puis sollicitées :

| Invitation d'un `owner` | Production | Dépôt |
|---|---|---|
| sans contexte de relation (gestion de membres) | **refusée** | **refusée** |
| avec contexte de relation (onboarding fournisseur) | **refusée** | **acceptée** |

**Conclusion** : la divergence n'est pas cosmétique. Elle porte sur une règle
d'autorisation. Le dépôt assouplit ; la production ne l'est pas.

**Le sens de l'écart est rassurant sur le plan sécurité** : la production
applique la règle **la plus stricte**. Le dépôt ne crée aucune ouverture de
droit supplémentaire en production — au contraire, il en manque une.

**Le sens de l'écart est en revanche un défaut fonctionnel** : le parcours
d'onboarding fournisseur qui invite le premier `owner` avec un
`relationship_id` **échoue en production** avec `owner_role_not_invitable`. Le
commit qui introduit ce comportement s'intitule précisément
« fix: preserve supplier onboarding owner invitations ». Le correctif est dans
le dépôt, il n'est pas en production.

**Décision : migration corrective.** Le contenu étant identique au fichier du
dépôt et la migration étant déjà enregistrée, `prisma migrate deploy` ne la
rejouera jamais. Il faut une **nouvelle** migration qui repose la fonction. Elle
ne doit pas être écrite à l'aveugle : elle doit reproduire exactement le corps
du dépôt, et un test doit prouver les deux lignes du tableau ci-dessus.

## 3. `public_read_context` — divergence sans effet

Le diff transforme cinq `GRANT EXECUTE` inconditionnels en un bloc `DO`
conditionné à l'existence du rôle `tracefab_app`.

| Contexte | Production | Dépôt |
|---|---|---|
| rôle `tracefab_app` **présent** (production) | passe | passe |
| rôle `tracefab_app` **absent** (base neuve) | **échoue** `role does not exist` | passe |

**Conclusion** : en production, l'effet est **strictement identique**. La
modification rend seulement la chaîne rejouable sur une base vierge — c'est un
correctif de portabilité, pas de sécurité.

**Décision : ne rien faire.** Aucune migration corrective, aucun risque. Le
contenu du dépôt est meilleur pour une reconstruction ; l'écart d'empreinte est
la trace d'une correction utile, appliquée après coup dans le dépôt.

## 4. `plm_erp_gs1_interoperability` — contenu historique introuvable

Aucun objet Git, sur les 11 885, ne correspond à `c944ce0c…`. Toutes les
versions du fichier dans toutes les refs portent l'empreinte du dépôt. Le
contenu exécuté en production est donc **inconnu** — et je le déclare comme tel
plutôt que de le déduire du diff des commits voisins.

**Décision : ne rien rejouer ; confronter au catalogue de production.** La
migration crée deux tables (`plm_erp_integrations`, `plm_erp_sync_jobs`), une
fonction `SECURITY DEFINER` (`tracefab_ingest_plm_erp_payload`) et quatre
politiques RLS. C'est **la plus sensible des trois** : une différence de
politique ici ne se verrait pas dans un diff de fichiers, mais dans
`pg_policies`.

### Requête de confrontation (lecture seule, à exécuter en production)

```sql
BEGIN READ ONLY;

-- a) Les objets existent-ils, et sous quelle forme ?
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
       pg_catalog.pg_get_userbyid(c.relowner) AS proprietaire
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('plm_erp_integrations', 'plm_erp_sync_jobs');

-- b) Les politiques RLS sont-elles celles du dépôt ?
SELECT tablename, policyname, cmd, qual, with_check
  FROM pg_catalog.pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('plm_erp_integrations', 'plm_erp_sync_jobs')
 ORDER BY tablename, policyname;

-- c) La fonction SECURITY DEFINER est-elle celle du dépôt ?
SELECT p.proname, p.prosecdef, p.provolatile,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
       md5(pg_catalog.pg_get_functiondef(p.oid))            AS empreinte_definition
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'tracefab_ingest_plm_erp_payload';

ROLLBACK;
```

### Valeurs de référence, calculées depuis le dépôt (base jetable, 63 migrations)

Obtenues par `npm run test:divergences-migrations`, au commit `bc6b4a8` :

```
table   plm_erp_integrations  rls=true force_rls=true
table   plm_erp_sync_jobs     rls=true force_rls=true
policy  plm_erp_integrations.plm_integrations_mutate_brand  cmd=ALL     regle=cf202afe7ca317e3f4c02e3ec231eaa6
policy  plm_erp_integrations.plm_integrations_select_org    cmd=SELECT  regle=86ba2040463a9c6c535653985e6c8430
policy  plm_erp_sync_jobs.plm_sync_jobs_insert_brand        cmd=INSERT  regle=31cbd3833cab9edbe7fc026a0cf622a2
policy  plm_erp_sync_jobs.plm_sync_jobs_select_org          cmd=SELECT  regle=0fd6d3265bfe5137447f10213a7e1c81
fonction p_organization_id uuid, p_system_type text, p_payload jsonb, p_integration_id uuid
         secdef=true  definition=bee1aa2b89d6e4c7748b0d7edb2443b3
```

Si la production rend ces **mêmes** valeurs, le contenu exécuté produit le même
schéma et la même règle d'accès : la divergence est cosmétique et il n'y a rien
à faire. Si une seule diffère, la production exécute un autre objet et une
migration corrective est nécessaire — avec, cette fois, la preuve de ce qu'il
faut corriger.

**C'est la seule des trois qui ne peut pas être tranchée hors production.** Et
c'est aussi la seule dont l'objet est `SECURITY DEFINER` avec des politiques
RLS : c'est celle qui mérite la vérification, pas les deux autres.

## 5. Ce que ce tour change au plan

| # | Action | Statut |
|---|---|---|
| 1 | Retrouver les contenus historiques | **fait** — 2 sur 3 |
| 2 | Mesurer l'effet réel des divergences retrouvées | **fait** — 20 vérifications |
| 3 | Confronter `plm_erp_gs1` au catalogue de production | **à faire** — requête fournie |
| 4 | Écrire la migration corrective de `supplier_portal` | **à faire, après accord** |
| 5 | `prisma migrate deploy` des 7 manquantes | **reste déconseillé** tant que 3 et 4 ne sont pas faits |

Votre recommandation de ne pas déployer est confirmée par la mesure : il y a
bien une divergence effective de **règle d'autorisation** derrière l'une des
empreintes. Elle est bénigne dans le sens dangereux (la production est plus
stricte), mais elle est réelle — et l'une des trois reste inconnue.

> **Suites (tour 29).** Le correctif de `supplier_portal` est écrit et prouvé
> hors production : `20261028140000_supplier_invitation_owner_relationship_scope`,
> voir `2026-10-28-tour29-correctif-supplier-portal.md`. Deux assertions de ce
> tour ont été renforcées après revue critique (§1 du document du tour 29).

## 6. Livré dans ce tour

| Fichier | Nature |
|---|---|
| `scripts/test_divergences_migrations_pglite.mjs` | 20 vérifications : contenu retrouvé, effet mesuré par exécution |
| `scripts/fixtures/empreintes-production-20261028/*.sql` | les deux contenus historiques, empreinte vérifiée par le test |

Aucune migration créée ni modifiée, aucun changement de posture, aucune écriture.
