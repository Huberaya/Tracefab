-- ---------------------------------------------------------------------------
-- Un identifiant public doit designer un seul produit.
--
-- LE PROBLEME
--
-- La migration 20261009180000 retro-remplit le slug public ainsi :
--
--     UPDATE tracefab_products SET public_slug = lower(reference)
--      WHERE status = 'active' AND public_slug IS NULL;
--
-- en s'appuyant sur le fait que `reference` est unique PAR MARQUE. C'est vrai,
-- et c'est precisement le defaut : deux marques employant la meme reference
-- interne — « MB-SHIRT-001 » n'a rien d'original — obtiennent le meme slug
-- public. La contrainte existante
-- (tracefab_products_brand_organization_id_public_slug_key) n'y voit rien,
-- puisqu'elle porte sur le couple (marque, slug).
--
-- Consequence : /dpp/mb-shirt-001 designe plusieurs produits de marques
-- differentes. La resolution rendait l'un d'eux, trie pour etre stable, donc
-- « deterministe mais arbitraire » — un consommateur pouvait lire la
-- composition, l'origine et les certificats du produit d'un concurrent.
--
-- CE QUE FAIT CETTE MIGRATION
--
-- 1. Elle desambigue les collisions existantes. La ligne la plus ancienne
--    garde son slug — les codes QR deja imprimes qui pointaient vers elle
--    continuent de fonctionner, et c'est deja celle que la resolution triee
--    rendait. Les autres recoivent un suffixe tire de leur identifiant.
--
--    Les URL de ces autres produits changent donc. Elles servaient jusqu'ici
--    les donnees d'un tiers : un 404 vaut mieux qu'un passeport faux, et un
--    slug corrige vaut mieux que les deux.
--
-- 2. Elle pose l'unicite au niveau mondial, pour que le cas ne puisse pas
--    revenir. Aucune route d'ecriture n'attribue de public_slug aujourd'hui
--    (seule la migration 35 le fait), donc cet index ne peut pas faire echouer
--    une creation de produit.
--
-- Si une collision residuelle subsistait — un slug deja egal a
-- « <slug>-<8 hexa> » —, la creation de l'index echouerait et la migration
-- s'arreterait. C'est voulu : mieux vaut un deploiement bloque qu'une
-- ambiguite silencieuse.
-- ---------------------------------------------------------------------------

WITH classees AS (
  SELECT id,
         public_slug,
         row_number() OVER (
           PARTITION BY public_slug
           ORDER BY created_at ASC, id ASC
         ) AS rang
    FROM tracefab_products
   WHERE public_slug IS NOT NULL
)
UPDATE tracefab_products AS p
   SET public_slug = c.public_slug || '-' || left(replace(p.id::text, '-', ''), 8)
  FROM classees AS c
 WHERE p.id = c.id
   AND c.rang > 1;

CREATE UNIQUE INDEX IF NOT EXISTS tracefab_products_public_slug_global_key
    ON tracefab_products (public_slug)
 WHERE public_slug IS NOT NULL;
