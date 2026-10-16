# Identité DPP résolvable et QR stable

## Granularité

TRACEFAB distingue explicitement `model`, `variant`, `batch` et `unit`. Une granularité autre que modèle exige un qualifiant métier. Le système n’impose donc pas artificiellement un identifiant par unité.

## Identifiant stable

`dpp_resolvable_identifiers.public_id` est un identifiant public opaque et stable. Il résout par `/api/resolve/:publicId`; le QR encode cette URL de résolution, jamais l’URL d’un document ou une route interne. Une actualisation du contenu ne change pas l’identifiant.

L’unicité porte sur l’identifiant public et sur `(produit, granularité, qualifiant)`, y compris lorsque le qualifiant est nul grâce à un index `COALESCE`.

## Remplacement

Un identifiant ne disparaît pas silencieusement. `tracefab_replace_dpp_identity` crée le remplaçant avec la même granularité, le même qualifiant, le même produit et la même organisation dans une transaction unique. L’ancien identifiant passe à `replaced`, conserve le motif et répond par une redirection permanente HTTP 308 vers le remplaçant.

Un identifiant `retired` retourne HTTP 410 en représentation JSON. La création et le remplacement sont réservés à owner/admin/manager et journalisables dans les événements DPP.

## Publication et confidentialité

La RLS publique exige toujours `tracefab_product_is_public(product_id)`. Un identifiant attaché à un produit non publié ne résout pas et ne produit pas de QR. La connaissance du `public_id` ne constitue jamais une autorisation privée.

## QR

`GET /api/resolve/:publicId/qr` génère un SVG avec correction d’erreur M, contraste sombre/clair et marge calme. La base publique vient de `TRACEFAB_PUBLIC_BASE_URL`, validée comme URL HTTPS (localhost autorisé en test), et jamais du header Host non fiable.

Le QR est un transport d’URL. Il ne prouve ni authenticité, ni conformité GS1, ni intégrité du produit. Le format GS1 Digital Link existant demeure une capacité séparée et ne doit être revendiqué que pour les GTIN valides et les cas réellement testés.

## API privée

`GET/POST/PATCH /api/products/:productId/dpp/identities` liste, crée et remplace les identités dans le contexte tenant.

## Limites

- Pas d’impression d’étiquette dans ce lot.
- Pas de redirection inter-organisation.
- Pas de domaine GS1 Resolver officiellement certifié revendiqué.
- Le transfert d’unité ou de détenteur nécessite un modèle métier ultérieur, distinct de l’identité publique.
