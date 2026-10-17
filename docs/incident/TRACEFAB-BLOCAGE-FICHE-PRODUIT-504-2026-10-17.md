# TRACEFAB — Blocage Production : fiche produit invisible (504 /api/schema-bindings)

## Diagnostic et remédiation — 2026-10-17

### Résumé exécutif

**Symptôme signalé.** Sur le tenant `Tracefab Recette Production`, cliquer sur « Ouvrir »
dans la Brand Console déclenche répétitivement
`GET /api/schema-bindings?subjectType=product&subjectId=…` → **HTTP 504**.
`openProduct()` rejette alors tout le chargement et la fiche produit reste invisible.

**Cause racine — côté route, et nulle part ailleurs.** La branche `GET` de
`api/_routes/schema-bindings.ts` se terminait par :

```ts
return bindings.map(serializeBinding);   // ← tableau nu, AUCUNE écriture sur res
```

Le routeur central (`api/index.ts`) fait `return await module.default(req, res)`
et **ignore la valeur de retour** des gestionnaires : rien dans ce chemin n'écrit
jamais sur la réponse. La fonction serverless se termine sans avoir répondu ; la
passerelle de plateforme attend, puis renvoie **504 Gateway Timeout** — sur chaque
appel, pour chaque locataire réel. Le 504 n'était donc ni un timeout de base de
données, ni un blocage RLS : c'était une réponse qui n'existait pas.

**Correctif.** `return json(res, 200, { bindings: bindings.map(serializeBinding) })`
— la forme `{ bindings: […] }` étant exactement celle que la Brand Console attend
déjà côté client (`(await api(…)).bindings || []`).

**Statut RLS : inchangé et prouvé.** Aucune politique n'a été désactivée, aucune
requete ne contourne le contexte locataire. La requête SQL et la politique
`schema_bindings_select_authorized` ont été exécutées sous le rôle applicatif
réellement soumis à la RLS (`tracefab_app`, sans BYPASSRLS) par le test
d'isolation inter-organisations étendu (assertions 13 à 15).

### 1. Diagnostic — comment la cause a été isolée

Le signalement désigne trois suspects possibles : la route, la requête, la RLS.
Chacun a été examiné, et écarté ou confirmé par preuve.

#### 1.1 Côté requête SQL — exécutée, non fautive

La requête de la branche produit est :

```sql
SELECT id, schema_key, schema_version, …
FROM tracefab_schema_bindings
WHERE product_id = $1::uuid
ORDER BY created_at DESC
```

- Les seuls index de la table sont les quatre index uniques partiels menant par
  `(schema_key, schema_version)` : un filtrage par `product_id` seul ne peut pas
  les utiliser, le plan est un parcours séquentiel. La table est de cardinalité
  faible (bornée par le catalogue de schémas), et le prédicat bon marché
  `product_id = $1` est évalué avant les sous-requêtes de politique : le coût
  reste de l'ordre de la milliseconde. Ce n'est pas un timeout de requête.
- Aucune récursion de politique : `schema_bindings_select_authorized` référence
  `tracefab_products`, `materials`, `suppliers` et `data_requests` en `EXISTS` ;
  leurs propres politiques ne s'appuient que sur des prédicats
  `SECURITY DEFINER` (`tracefab_is_org_member`, `tracefab_can_access_org`,
  `tracefab_can_access_shared_subject`, `tracefab_material_visible_via_product`).
  Le cycle `materials ↔ product_materials` corrigé par la migration
  `20261009120000` n'implique pas `tracefab_schema_bindings`. Preuve
  d'exécution : assertion 13 du test d'isolation, qui exécute la requête
  exacte sous `tracefab_app`.

#### 1.2 Côté RLS — armée, évaluée, étanche

- La route exécute la lecture dans `withTracefabUserContext(user.id, user.email, …)` :
  le contexte `tracefab.user_id` est armé par `set_config(…, true)` —
  transaction-local, jamais porté par une connexion du pool vers une requête
  suivante.
- `tracefab_schema_bindings` porte `FORCE ROW LEVEL SECURITY` (migration
  `20261007120000`) : même le propriétaire de la table est soumis aux politiques.
- Preuves nouvelles (assertions 13-15 de `test:neon:cross-tenant`, exécutées sur
  PostgreSQL jetable en CI) :
  - la requête exacte de la route sous le contexte du locataire A rend la liaison
    de A et seulement elle ;
  - la même requête pour le produit de B sous le contexte de A rend zéro ligne,
    **sans erreur** — une frontière, pas un crash ;
  - la fonction `SECURITY DEFINER tracefab_bind_schema` refuse au locataire A de
    lier un schéma au produit de B.

#### 1.3 Côté route — la cause, confirmée

- La branche `GET` retournait un tableau nu au lieu d'appeler `json(res, 200, …)`.
- Le routeur central (`api/index.ts`) ignore sciemment les valeurs de retour des
  gestionnaires — la seule façon d'être servi est d'écrire sur `res`.
- Une fonction serverless qui se termine sans écrire de réponse laisse la
  passerelle attendre jusqu'au délai de plateforme, qui répond alors 504. Le
  comportement est déterministe : **chaque** appel GET sur **chaque** locataire
  réel produisait 504.
- La POST, elle, répondait correctement (`json(res, 201, …)`) : le rattachement
  de schéma fonctionnait depuis le Supplier Portal — ce qui a orienté à tort le
  signalement vers « la lecture qui timeout » plutôt que vers « la lecture qui ne
  répond jamais ».

#### 1.4 Pourquoi le tenant « Recette Production » — et pourquoi personne ne l'avait vu

- Le mode démonstration (`?demo=1`) n'appelle jamais l'API : le parcours produit
  des tests navigateur existants passait par des données de démonstration.
- Aucun test du dépôt n'exerçait `GET /api/schema-bindings` — vérifié par
  recherche exhaustive dans `scripts/` et `tests/` : zéro référence avant ce
  correctif.
- Le tenant de recette production est simplement l'endroit où « Ouvrir » est
  cliqué contre le backend réel ; le défaut touchait en réalité tout locataire
  réel, à chaque ouverture de fiche.

### 2. Remédiation

| # | Changement | Fichier |
|---|---|---|
| 1 | La branche GET écrit la réponse : `json(res, 200, { bindings })` | `api/_routes/schema-bindings.ts` |
| 2 | `openProduct()` rend la fiche **avant** le chargement auxiliaire ; le chargement des liaisons ne peut plus rejeter la fiche | `assets/js/brand-console.1.js` |
| 3 | Panneau « Schémas externes liés » : trois états distincts — chargé / **dégradé explicite** (code d'erreur apparent, rien de masqué) / en cours — avec bouton « Réessayer » qui refait réellement la requête | `assets/js/brand-console.1.js` |
| 4 | Échec du chargement **essentiel** (`/api/products/:id`) : état d'erreur explicite avec réessai, au lieu d'un écran figé sur la vue précédente | `assets/js/brand-console.1.js` |
| 5 | « Corriger dans Produits » (DPP, portefeuille et fiche) ouvre la **fiche du produit visé** au lieu de revenir au catalogue | `assets/js/brand-console.1.js` |
| 6 | Libellés du panneau dans les 7 locales complètes (parité i18n vérifiée) | `assets/i18n/*` |
| 7 | Garde de classe : aucun gestionnaire de route ne peut plus terminer sur un `return` nu sans écrire de réponse | `scripts/test_route_registry.mjs` |
| 8 | Contrat statique Brand Console : réponse écrite, contexte RLS conservé, état dégradé + réessai présents | `scripts/test_brand_console.mjs` |

Ce qui n'a **pas** été fait, à dessein : désactiver ou contourner la RLS, masquer
ou reformuler l'erreur (le code `request_failed_504` reste affiché tel quel dans
l'état dégradé), ou transformer un échec en « aucune liaison ».

### 3. Preuves

- **Reproduction navigateur du 504** : `npm run test:brand-console:schema-bindings`
  (`scripts/test_brand_console_schema_bindings_browser.mjs`) — page réelle,
  JavaScript applicatif réel, seules les réponses HTTP sont simulées au niveau
  réseau. Quatre scénarios : (1) 504 → fiche consultable, état dégradé explicite,
  réessai effectif puis rétablissement ; (2) succès réel : liaisons affichées,
  requête conforme (`subjectType=product`, `subjectId` exact, jeton Clerk porté) ;
  (3) contrôle multi-tenant : deux organisations, chaque fiche n'affiche que les
  liaisons de son locataire, aucune fuite d'état ; (4) « Corriger dans Produits »
  ouvre la fiche visée depuis le portefeuille DPP et depuis la fiche DPP.
- **Garde de classe (le 504 ne doit pas revenir)** : `npm run test:routes` refuse
  désormais tout `return` nu au niveau d'un gestionnaire ; vérifié en négatif
  contre l'ancien code (échec avec message explicite).
- **RLS exécutée sous rôle soumis** : `npm run test:neon:cross-tenant`
  (CI, PostgreSQL 17 jetable, rôle `tracefab_app` sans BYPASSRLS) — assertions
  13 à 15 : requête exacte de la route exécutable et étanche, fonction de liaison
  refusée cross-tenant.

### 4. Limites

- La preuve navigateur simule les réponses HTTP au niveau réseau : elle prouve le
  comportement du client face à un 504 et à un 200, pas le comportement de la
  plateforme Vercel elle-même. La correction côté route est prouvée par la
  lecture du code (la réponse est désormais écrite) et par le garde de classe qui
  interdit la récurrence ; la réponse effective en production sera à confirmer
  sur le déploiement.
- Le garde statique (point 7) couvre les `return` du corps des gestionnaires
  hors délégations de contexte `withTracefab*Context` ; un `return` interne à un
  callback de délégation qui omettrait d'écrire la réponse resterait hors de sa
  portée — le garde exige en compensation qu'une écriture `json(res…)` existe
  dans chaque gestionnaire qui délègue.
