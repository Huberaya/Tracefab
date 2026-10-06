-- Migration: 20261006160000_dpp_readiness_exposure
-- Chantier 4 (P0): Exposition & Intégration du DPP Readiness

-- 1. Ensure the active textile readiness requirement profile is seeded and current
INSERT INTO dpp_requirement_profiles (
  profile_key,
  profile_version,
  name,
  status,
  definition
)
VALUES (
  'textile_readiness_mvp',
  '1.0',
  'Tracefab textile readiness MVP',
  'active',
  '{
    "scope": "product_readiness",
    "notice": "Operational readiness projection profile for textile garments and footwear.",
    "requirements": [
      {"key": "product.reference", "label": "Référence produit (SKU)", "blocking": true},
      {"key": "product.name", "label": "Désignation commerciale", "blocking": true},
      {"key": "product.description", "label": "Description détaillée (>= 30 caractères)", "blocking": true},
      {"key": "product.category", "label": "Catégorie textile définie", "blocking": true},
      {"key": "product.country_of_manufacture", "label": "Pays de confection (ISO-2)", "blocking": true},
      {"key": "product.data_ready", "label": "Statut opérationnel produit prêt", "blocking": true},
      {"key": "composition.complete", "label": "Composition matières exhaustive (100%)", "blocking": true},
      {"key": "traceability.graph", "label": "Graphe de traçabilité multi-rangs actif", "blocking": true},
      {"key": "quality.no_blocking_issues", "label": "Absence d’anomalie critique sur le score qualité", "blocking": true}
    ]
  }'::jsonb
)
ON CONFLICT (profile_key, profile_version) DO UPDATE
SET name = EXCLUDED.name,
    status = EXCLUDED.status,
    definition = EXCLUDED.definition,
    updated_at = now();

-- 2. Explicitly grant execution and select privileges for authenticated tenant operations
GRANT SELECT ON dpp_requirement_profiles TO PUBLIC;
GRANT SELECT ON dpp_records TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_compute_dpp_readiness(UUID, TEXT, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_mark_dpp_ready_to_publish(UUID) TO PUBLIC;
