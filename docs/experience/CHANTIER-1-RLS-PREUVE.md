# Chantier 1 — La RLS était inerte. Preuve, correctif, et ce qui reste avant la bascule

## Ce qui était faux

Le dépôt affichait « 46 ENABLE / 50 FORCE ROW LEVEL SECURITY » et en tirait la
conclusion que l'isolation multi-locataires était verrouillée. Les deux nombres
sont exacts. La conclusion était fausse.

`ENABLE ROW LEVEL SECURITY` et `FORCE ROW LEVEL SECURITY` sont des drapeaux de
catalogue. `BYPASSRLS` est un attribut de **rôle**, et il prime sur les deux.
`FORCE` ne lève que l'exemption du *propriétaire de table* ; il ne touche pas
celle du rôle. L'application se connecte sous `neondb_owner`, qui porte
`rolbypassrls = true`.

Conséquence : aucune politique n'a jamais été évaluée en production.

Mesure directe, sans aucun contexte armé, sous le rôle applicatif d'alors :

```
audit_logs : 4 lignes sur 4 visibles, malgré la politique audit_select_admin
```

Le commentaire d'en-tête de la migration `20261007120000_force_rls_schema_bindings`
affirmait que `FORCE` fermait le trou « puisque Prisma se connecte sous
neondb_owner ». C'est précisément l'inverse : c'est parce que Prisma se connecte
sous `neondb_owner` que `FORCE` ne pouvait rien fermer.

## Le défaut que l'inertie cachait

Première requête jamais exécutée sous un rôle réellement soumis à la RLS :

```
select count(*) from materials
ERREUR : infinite recursion detected in policy for relation "materials"
```

Le cycle :

| Politique | interroge |
|---|---|
| `materials_select_authorized` | `product_materials` ⋈ `tracefab_products` |
| `product_materials_select_authorized` | `materials` |

Chaque sous-requête déclenche la politique de l'autre table, sans fin.

La politique de `materials` n'était donc pas trop permissive : elle était
**inexécutable**. Le jour de la bascule, sans ce correctif, toute lecture de
matière aurait renvoyé une erreur serveur. Le défaut était invisible tant qu'un
rôle `BYPASSRLS` ne parcourait jamais le cycle.

Correctif : migration `20261009120000_fix_materials_policy_recursion`. Le détour
par les produits devient une fonction `SECURITY DEFINER`, comme tous les autres
prédicats du schéma (`tracefab_can_access_org`, `tracefab_is_org_member`, …).
Exécutée sous le propriétaire, sa sous-requête ne redéclenche pas les
politiques. La logique d'autorisation est conservée à l'identique ; seule la
mécanique d'évaluation change. Migration appliquée sur Neon.

## Le rôle applicatif

Créé sur Neon : **`tracefab_app`**.

| Attribut | Valeur |
|---|---|
| `rolbypassrls` | `false` |
| `rolsuper` | `false` |
| `rolcreaterole` | `false` |
| propriétaire de tables | non |

Droits accordés : `CONNECT`, `USAGE` sur le schéma, `SELECT/INSERT/UPDATE/DELETE`
sur toutes les tables, `USAGE, SELECT` sur les séquences, `EXECUTE` sur les
fonctions, plus `ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner` pour que les
objets futurs soient couverts sans intervention.

Le mot de passe vit hors du dépôt et n'a jamais été affiché.

## La preuve

`scripts/test_rls_isolation.mjs` — `npm run test:neon:rls`.

Il remplace un comptage de drapeaux par une mesure d'exécution. Résultat sur la
base de production :

```
ok    role de test « tracefab_app », BYPASSRLS=false
ok    46 tables interrogees, aucune erreur de politique
ok    sans contexte arme, aucune table de locataire ne laisse voir une ligne
ok    tables de reference lisibles sans contexte (routes publiques preservees)
      locataire 1 : brand_e252f0c3@tracefab.test        — 14 ligne(s) visibles
      locataire 2 : compliance-115130@massbalancetest.com — 7 ligne(s) visibles
ok    les deux locataires voient des ensembles differents sur 9 table(s)
ok    aucune table de locataire n est integralement visible par un seul utilisateur
```

Cinq vérifications, et une discipline :

- **A.** le rôle de test n'a pas `BYPASSRLS` — sinon le test le dit et échoue,
  au lieu de mesurer le vide et de passer au vert ;
- **B.** aucune table ne lève d'erreur de politique (c'est ce qui a attrapé la
  récursion) ;
- **C.** sans contexte, aucune table de locataire ne laisse voir une ligne ;
- **D.** les tables de référence restent lisibles sans contexte ;
- **E.** deux locataires d'organisations différentes voient des ensembles
  différents.

Contrôles négatifs exécutés — un garde qu'on n'a jamais vu échouer ne prouve
rien :

| Situation | Attendu | Obtenu |
|---|---|---|
| rôle de test = `neondb_owner` (bypass) | échec | échec, code 1 |
| aucun identifiant fourni | ne passe pas | « NON EXECUTE », code **2** |

Le code 2 est délibéré. Un test qui n'a pas tourné n'est pas un test qui passe —
c'est exactement le défaut que ce chantier est venu corriger.

## Ce qui bloque encore la bascule

`DATABASE_URL` pointe toujours `neondb_owner`. **Le basculer aujourd'hui casserait
la production.** Mesuré, pas supposé — sous `tracefab_app`, sans contexte armé :

```
INVISIBLE  tracefab_products        0 ligne
INVISIBLE  product_identifiers      0 ligne
INVISIBLE  supply_chain_nodes       0 ligne
INVISIBLE  supply_chain_links       0 ligne
INVISIBLE  documents, certifications, users, organizations, memberships
```

Dix routes n'arment aucun contexte, parce qu'elles sont délibérément non
authentifiées. Quatre d'entre elles survivent, six tombent :

| Route | Lit | Sous `tracefab_app` |
|---|---|---|
| `pef/factors` | `pef_emission_factors` | **passe** — table de référence |
| `green-claims/rules` | `green_claims_rules` | **passe** — table de référence |
| `health` | — | **passe** |
| `passport/…/request-access` | écriture seule | à vérifier à la bascule |
| `webhooks/clerk` | écrit `users`, `organizations`, `organization_memberships` | **casse** — provisionnement des comptes |
| `gs1/digital-link/[gtin]` | `product_identifiers`, `supply_chain_*` | **casse** — résolveur GS1 muet |
| `dpp/[gtin]` | via `wallet/dpp-data-resolver` | **casse** — DPP public vide |
| `products/[id]/wallet/apple` · `google` | via `wallet/dpp-data-resolver` | **casse** — cartes wallet vides |
| `passport/[tokenOrSlug]` | via `supplier-passport/passport-manager` | **casse** — passeport fournisseur vide |

Ces routes ne sont pas des oublis : elles servent le DPP public, le scan
consommateur et le webhook d'inscription. Elles doivent voir des données sans
utilisateur connecté. La bascule exige donc **d'abord** l'un des deux :

1. un contexte public explicite — un `withTracefabPublicContext` qui arme un
   indicateur, et des clauses de politique autorisant la lecture des seules
   données *publiées* (produit publié, passeport partagé, jeton valide) ; ou
2. un second rôle restreint pour les chemins publics, avec ses propres
   politiques.

La première option est la plus fidèle à l'architecture existante : le schéma
raisonne déjà par prédicats `SECURITY DEFINER`, un prédicat `tracefab_is_public_read()`
s'y insère naturellement. Elle demande une revue table par table de ce qui est
légitimement public — c'est un travail de conception, pas une substitution de
chaîne de connexion.

## Procédure de bascule, le jour venu

1. Implémenter le contexte public et ses clauses de politique.
2. `npm run test:neon:rls` doit rester vert, **et** les six routes ci-dessus
   doivent répondre sous `tracefab_app`.
3. Basculer `DATABASE_URL` et `DIRECT_URL` vers `tracefab_app` dans Vercel.
4. Garder `neondb_owner` pour les migrations uniquement — `prisma migrate deploy`
   a besoin du propriétaire.
5. Surveiller les 429/500 sur les routes publiques pendant une heure.
6. Retour arrière : rebasculer `DATABASE_URL`. Aucune migration n'est à défaire,
   le correctif de récursion est bénéfique sous les deux rôles.

## État

| | |
|---|---|
| RLS réellement évaluable | **oui** — rôle créé, politiques exercées |
| Récursion `materials` | **corrigée** — migration 34 appliquée |
| Preuve par exécution | **oui** — `test:neon:rls`, contrôles négatifs inclus |
| Test trompeur neutralisé | **oui** — `test_cross_tenant` ne parle plus de « verrou » |
| Production protégée par la RLS | **pas encore** — bascule conditionnée au contexte public |
