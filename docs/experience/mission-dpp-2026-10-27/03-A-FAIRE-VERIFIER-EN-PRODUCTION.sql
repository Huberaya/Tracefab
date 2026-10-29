-- =============================================================================
--  Trois questions à poser à la base de PRODUCTION
--
--  Ce fichier ne contient QUE des lectures (SELECT). Il ne peut rien modifier.
--  Vous pouvez le copier tel quel dans l'éditeur SQL de Neon
--  (tableau de bord du projet → « SQL Editor »), puis me coller les résultats.
--
--  Aucun mot de passe, aucun secret, aucune donnée personnelle ne figure dans
--  les résultats attendus : seulement des nombres et des vrai/faux.
-- =============================================================================


-- -----------------------------------------------------------------------------
--  QUESTION 1 — La correction est-elle déjà en production ?
--
--  À quoi ça sert : savoir si le correctif de la barrière qualité a déjà été
--  appliqué à cette base, ou s'il attend encore. Ne pas le savoir, c'est
--  risquer de « corriger » deux fois, ou de croire que c'est fait alors que non.
-- -----------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL)
    AS migrations_appliquees,
  EXISTS (
    SELECT 1 FROM _prisma_migrations
    WHERE migration_name = '20261027100000_dpp_quality_gate_requires_assessment'
      AND finished_at IS NOT NULL
  ) AS correction_qualite_deja_appliquee;


-- -----------------------------------------------------------------------------
--  QUESTION 2 — La règle en place est-elle l'ancienne ou la corrigée ?
--
--  À quoi ça sert : sans cette réponse, on ne sait pas si un dossier peut
--  encore être déclaré « prêt à publier » sans qu'aucun contrôle qualité ait
--  eu lieu. C'est exactement le défaut qu'on cherche à fermer.
--
--  Lecture du résultat :
--    barriere_exige_une_evaluation = false  →  l'ancienne règle est en place
--                                              (le défaut est toujours ouvert)
--    barriere_exige_une_evaluation = true   →  la correction est active
-- -----------------------------------------------------------------------------
SELECT
  position('data_quality_scores' IN prosrc) > 0 AS barriere_exige_une_evaluation,
  position('quality.no_open_issues' IN prosrc) > 0 AS contient_la_barriere
FROM pg_proc
WHERE proname = 'tracefab_dpp_requirement_met';


-- -----------------------------------------------------------------------------
--  QUESTION 3 — Combien de dossiers seraient concernés par le changement ?
--
--  À quoi ça sert : mesurer l'effet AVANT de le produire. Un dossier déclaré
--  « prêt » ou « publié » sans aucune évaluation qualité verra sa prochaine
--  revue refusée après la correction. Ce n'est pas une régression, c'est le
--  comportement voulu — mais il faut savoir combien de dossiers sont dans ce
--  cas, et lesquels, avant de décider.
-- -----------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM tracefab_products) AS produits,

  (SELECT count(*) FROM tracefab_products p
     WHERE p.data_readiness = 'data_ready'
       AND NOT EXISTS (SELECT 1 FROM data_quality_scores s WHERE s.product_id = p.id))
    AS produits_prets_sans_evaluation,

  (SELECT count(*) FROM dpp_records r
     WHERE r.readiness_status IN ('ready_to_publish', 'published')
       AND NOT EXISTS (SELECT 1 FROM data_quality_scores s WHERE s.product_id = r.product_id))
    AS dossiers_publies_sans_evaluation;


-- -----------------------------------------------------------------------------
--  BONUS (facultatif) — Quels sont précisément ces dossiers ?
--
--  Donne les références et les noms. À n'exécuter que si le compteur de la
--  question 3 est supérieur à zéro, et à ne partager qu'avec les personnes
--  concernées : ce sont des données de l'entreprise.
-- -----------------------------------------------------------------------------
-- SELECT r.readiness_status, p.reference, p.name
-- FROM dpp_records r
-- JOIN tracefab_products p ON p.id = r.product_id
-- WHERE r.readiness_status IN ('ready_to_publish', 'published')
--   AND NOT EXISTS (SELECT 1 FROM data_quality_scores s WHERE s.product_id = p.id)
-- ORDER BY p.reference;
