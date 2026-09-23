# 20. Quality Center API — Chantier 17

## Périmètre

Le Chantier 17 expose les fonctions de qualité déjà présentes dans Neon afin de fournir le backend du futur Quality Center :

- calcul d'un score fournisseur explicable ;
- calcul d'un score produit explicable ;
- lecture des snapshots et des issues ;
- acquittement d'une issue ;
- waiver contrôlé avec justification.

Un score mesure la qualité et la complétude opérationnelles des données. Il ne constitue ni une vérification, ni une certification, ni une conformité réglementaire.

## Routes

```text
GET  /api/quality/suppliers/:supplierId
POST /api/quality/suppliers/:supplierId

GET  /api/quality/products/:productId
POST /api/quality/products/:productId

POST /api/quality-issues/:issueId/acknowledge
POST /api/quality-issues/:issueId/waive
```

Les POST de calcul acceptent une version facultative :

```json
{
  "calculationVersion": "supplier_quality_v1"
}
```

Le score le plus récent est renvoyé avec les issues non résolues. Les snapshots précédents restent conservés en base.

## Accès

- fournisseur propriétaire : score et détail de ses issues ;
- marque avec partage fournisseur explicite : score fournisseur synthétique, sans détail des issues internes ;
- marque propriétaire du produit : score et issues produit ;
- viewer sans rôle de calcul ou utilisateur d'un autre tenant : refus par la fonction SQL ;
- acquittement : `owner`, `admin`, `manager` ou `auditor` ;
- waiver : `owner` ou `admin`, avec une justification d'au moins dix caractères.

Les routes filtrent explicitement l'accès avant lecture, puis délèguent toutes les mutations aux fonctions `SECURITY DEFINER` :

- `tracefab_compute_supplier_quality(...)` ;
- `tracefab_compute_product_quality(...)` ;
- `tracefab_acknowledge_quality_issue(...)` ;
- `tracefab_waive_quality_issue(...)`.

## Exploitabilité

Les réponses exposent les dimensions `completeness`, `freshness`, `documentationCoverage` et `consistency`, ainsi que les `missingFields` et `blockingIssues`. Les valeurs de score sont sérialisées en chaînes décimales afin de ne pas perdre la précision PostgreSQL dans JSON.

Les issues retournent leur règle, version, sévérité, statut, champ concerné, message, détails et acteurs de traitement. Une issue `waived` reste une décision de gouvernance interne ; elle ne transforme pas la donnée en preuve vérifiée.

## Tests

```bash
npm run test:neon:quality
```

Le test crée des fixtures fournisseur/produit et vérifie le calcul des deux scores, la création d'issues explicables, l'acquittement, le waiver et le refus d'un viewer.
