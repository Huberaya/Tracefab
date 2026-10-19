# Bascule du runtime Neon vers `tracefab_app`

**Statut** : préparée, non exécutée. Aucune variable de production n'a été modifiée.
**Prérequis de décision** : autorisation explicite pour toute étape touchant la production.

---

## 1. Le problème

Le runtime se connecte avec `neondb_owner`. Ce rôle porte `BYPASSRLS=true` : les 128
politiques du schéma ne sont **jamais évaluées** pour lui. L'isolation inter-organisations
repose donc entièrement sur le code applicatif, pas sur la base.

Ce constat n'est pas une découverte de ce chantier. Il est écrit dans
`docs/security/PHASE-3-PRIVILEGES-NEON.md` : « Elle se connecte avec `neondb_owner`, qui
porte `BYPASSRLS` — pour ce rôle, les politiques ne sont **jamais** évaluées. »

**Ce que ce document n'établit pas** : la valeur actuelle de la variable Vercel. La
configuration effective vit dans les variables d'environnement du projet, qui sont des
secrets. La vérifier demande une lecture de la console Vercel, pas une déduction.

## 2. La démonstration

Mesurée sur PostgreSQL 18.4, même contexte acteur dans les deux cas (un utilisateur de
Maison Alpha), mêmes requêtes sur les données de Maison Beta :

| Rôle | documents de Maison Beta | produits de Maison Beta |
|---|---|---|
| `tracefab_app` (`bypassrls=false`) | **0** | **0** |
| rôle identique en tout point, mais `BYPASSRLS` | **1** | **2** |

Le rôle de sonde est créé puis détruit. La RLS cloisonne réellement — à condition que le
rôle runtime n'ait pas `BYPASSRLS`.

## 3. Ce qui bloquait, et qui est levé

`docs/experience/CHANTIER-1-RLS-PREUVE.md` mesurait que la bascule casserait six routes non
authentifiées. Vérification route par route sur 135 routes, contre les **quatre** enveloppeurs
réels de `api/_lib/context.ts` — `withTracefabUserContext`, `withTracefabRequestContext`,
`withTracefabPublicContext`, `withTracefabWorkerContext` :

| Route signalée cassante | Aujourd'hui |
|---|---|
| `webhooks/clerk` | `withTracefabWorkerContext` |
| `gs1/digital-link/[gtin]` | `withTracefabPublicContext` |
| `dpp/[gtin]` | `withTracefabPublicContext` |
| `products/[productId]/wallet/apple` · `google` | `withTracefabPublicContext` |
| `dpp/[gtin]/apple-wallet` · `google-wallet` | `withTracefabPublicContext` |
| `passport/[tokenOrSlug]` | `withTracefabPublicContext` |

Il reste 15 routes sans enveloppeur sur 135, dont **4** accèdent à la base. Chacune a été
éprouvée sous `tracefab_app`, sans contexte armé :

| Route | Résultat |
|---|---|
| `green-claims/rules` | `green_claims_rules` : 5 lignes visibles — table de référence |
| `pef/factors` | `pef_emission_factors` : 23 lignes visibles — table de référence |
| `health` | sonde `$queryRaw`, aucune donnée de locataire |
| `passport/[tokenOrSlug]/request-access` | `passport_access_insert` a `WITH CHECK (true)`, `tracefab_app` a `INSERT` |

## 4. Le piège du webhook Clerk

Le webhook n'insère **pas** directement. Un INSERT nu dans `organizations` échoue sous
`tracefab_app` : `organizations_insert_creator` exige `created_by = tracefab_current_user_id()`,
qu'un contexte worker ne fournit pas. Le code passe par trois fonctions `SECURITY DEFINER`,
toutes exécutables par `tracefab_app` :

```
tracefab_sync_clerk_organization(p_clerk_membership_id text, p_legal_name text, p_display_name text, p_type organization_type)
tracefab_sync_clerk_membership(p_clerk_membership_id text, p_organization_id uuid, p_user_id uuid, p_role membership_role)
tracefab_revoke_clerk_membership(p_clerk_membership_id text)
```

Tout test de la bascule qui rejouerait des INSERT nus mesurerait un chemin que aucune route
n'emprunte. `scripts/test_tracefab_app_readiness.mjs` appelle les fonctions réelles.

## 5. Le test de non-régression

`npm run test:neon:app-readiness` — 11 assertions, exécuté en CI dans le job *Base — isolation
RLS executee*. Il rejoue sous `tracefab_app` réel les quatre contextes :

| | Vérification |
|---|---|
| A | `tracefab_app` n'a ni `SUPERUSER` ni `BYPASSRLS` |
| B | contexte public armé : les produits publiés sont visibles |
| C | contexte public armé : la visibilité ne se restreint jamais |
| D | sans contexte : toutes les tables publiques sont vides |
| E | contexte authentifié : le locataire actif voit ses données |
| F | contexte authentifié : rien du locataire voisin n'est visible |
| G | contexte worker : le provisionnement Clerk passe par ses fonctions `SECURITY DEFINER` |
| H | écriture anonyme : la demande d'accès passeport est acceptée |
| I | contexte public : aucun produit visible ne contredit `tracefab_product_is_public` |

**Contrôle négatif vérifié** : l'ajout d'une politique permissive `FOR SELECT USING (true)` sur
`tracefab_products` fait passer le test au rouge — 3 échecs, sortie 1 — dont l'assertion
d'isolation inter-organisations. Retirée, il repasse au vert.

Toutes les écritures du test sont annulées par `ROLLBACK`.

## 6. Procédure de bascule

### Étape 1 — Preview uniquement, sans toucher la production

1. Dans Vercel, renseigner `DATABASE_URL` **pour l'environnement Preview** avec le rôle
   `tracefab_app`. Ne pas toucher à la valeur Production.
2. Déployer une Preview depuis la branche de travail.
3. Sonder réellement les routes publiques — les suites SQL ne remplacent pas ce sondage :

   ```bash
   curl -i "$PREVIEW/dpp?gtin=<gtin-publie-reel>"     # 200, JSON-LD complet
   curl -i "$PREVIEW/gs1/digital-link/<gtin-reel>"    # 200, résolution
   curl -i "$PREVIEW/health"                          # 200
   curl -i "$PREVIEW/api/pef/factors"                 # 200, table de référence
   curl -i "$PREVIEW/api/green-claims/rules"          # 200, table de référence
   ```

4. Vérifier le provisionnement Clerk sur la Preview : créer un compte de test, constater que
   l'organisation et l'adhésion apparaissent.
5. Vérifier l'isolation : deux comptes de deux organisations, chacun ne voit que ses données.

### Étape 2 — Production, sur autorisation explicite uniquement

6. Conserver la chaîne `neondb_owner` actuelle, notée hors de tout fichier versionné, pour le
   retour arrière.
7. Basculer `DATABASE_URL` de Production vers `tracefab_app`. **Conserver `neondb_owner` pour
   les migrations** : `prisma migrate deploy` a besoin du propriétaire des objets.
8. Redéployer.
9. Surveiller une heure : erreurs `permission denied`, `42501`, `row-level security`, et taux
   de réponses vides sur les routes publiques.

### Retour arrière

Rebasculer `DATABASE_URL` vers la valeur conservée à l'étape 6, puis redéployer.

**Aucune migration à défaire, aucun schéma à restaurer, aucune donnée à récupérer.** La bascule
est un changement de variable d'environnement : le retour arrière est de la même nature et de
la même ampleur que l'aller. C'est ce qui rend l'opération réversible, et c'est la raison pour
laquelle elle doit être tentée sur Preview d'abord.

## 7. Ce qui n'est pas couvert

- Le sondage HTTP ne peut pas être exécuté depuis un environnement dont le réseau bloque
  `*.vercel.app`. Il doit l'être depuis un poste à accès sortant.
- La valeur actuelle de la variable Vercel de production n'est pas lue ici : c'est un secret.
- Les routes internes (`internal/notification-outbox/*`, `operations/overview`) n'ont pas été
  sondées en HTTP ; elles arment un contexte, mais seule une exécution réelle le confirme.
