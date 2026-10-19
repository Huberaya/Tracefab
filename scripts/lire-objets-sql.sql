-- Inventaire en LECTURE SEULE des objets de sécurité d'une base.
--
-- Objet : permettre de nommer EXACTEMENT les politiques et les fonctions
-- SECURITY DEFINER présentes sur un environnement mais absentes du schéma
-- reconstruit depuis les migrations. Un simple écart de compte (« 130 contre
-- 128 ») ne dit pas quels objets sont en trop ; cette requête les nomme.
--
-- Cette requête ne modifie rien : trois SELECT, aucune écriture, aucune
-- fonction appelée. Elle peut être exécutée sur n'importe quelle cible, y
-- compris en production, sans autre effet que la lecture du catalogue.
--
-- Usage : exécuter sur la cible, enregistrer la sortie dans un fichier, puis
--   node scripts/comparer-objets-sql.mjs --reference <reference> --cible <sortie>
--
-- Le format de sortie est volontairement stable et trié : une ligne par objet,
-- préfixe de type puis nom qualifié. Aucune donnée applicative n'est lue.

SELECT 'POLICY ' || schemaname || '.' || tablename || '.' || policyname AS objet
FROM pg_policies
WHERE schemaname = 'public'

UNION ALL

SELECT 'SECDEF ' || n.nspname || '.' || p.proname || '(' ||
       pg_get_function_identity_arguments(p.oid) || ')' AS objet
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef

ORDER BY 1;
