# Moteur déterministe de qualité DPP

## Objectif

`GET /api/products/:productId/dpp/quality-check` analyse les données privées accessibles au tenant et produit des constats explicables. Le moteur ne modifie aucune donnée, ne complète aucun champ et ne prétend pas détecter la fraude.

## Contrôles v1

- référence, nom, catégorie et pays de fabrication manquants ;
- composition absente, pourcentage invalide ou total différent de 100 % (tolérance 0,01) ;
- affirmation expirée ;
- niveau documenté/contrôlé/corroboré/vérifié sans preuve de soutien acceptée ;
- preuve acceptée dont le document est expiré ;
- preuve rejetée ;
- date métier postérieure à l’enregistrement ;
- fabrication postérieure à un événement de réemploi ou recyclage ;
- événement annoncé comme documentaire sans document associé.

Chaque constat contient un code stable, une sévérité, le sujet, le champ, un motif factuel et une action corrective. Les résultats bloquants empêchent de considérer le dossier prêt, mais le moteur ne change jamais lui-même le niveau de confiance.

## Sémantique

- `blocked` : au moins un constat bloquant ;
- `review_required` : avertissements sans blocage ;
- `clear` : aucun constat selon les règles v1.

`clear` signifie seulement que ces règles déterministes n’ont rien détecté. Ce n’est ni une certification, ni une preuve d’absence de fraude, ni une garantie réglementaire.

## Sécurité et exploitation

La route est authentifiée et vérifie l’accès au produit avant toute lecture. Les requêtes restent dans la transaction tenant RLS. Aucun résultat n’est publié automatiquement et aucune donnée n’est envoyée à un service d’IA ou à un tiers.

Le résultat porte `engine`, `version`, `computedAt` et une notice. Les codes stables permettront ultérieurement de mesurer le délai de résolution et le taux d’incohérences sans fabriquer de statistiques.
