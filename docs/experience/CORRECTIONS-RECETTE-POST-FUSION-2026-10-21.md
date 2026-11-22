# Corrections de la recette post-fusion — 21 octobre 2026

Source : `RECETTE-POST-FUSION-PARCOURS-MARQUE-2026-10-21.md`.

## Objectif

Fermer les constats non conformes sans inventer de donnée, de preuve, de certification, de connexion ou d’autorisation. La conformité Production ne sera déclarée qu’après CI, déploiement puis nouvelle recette visuelle en lecture seule.

## Corrections livrées sur la branche

- Le résumé DPP dérive désormais ses manquants et blocages des 13 exigences du profil actif, même si les anciens champs `missing_fields` sont vides.
- Un statut historique `data_ready` est rétrogradé visuellement quand le profil actif est incomplet.
- Le portefeuille agrège les `requirement_results` stricts en mode fail-closed, avec un dénominateur de 13, au lieu des anciens manquants et du dénominateur 9.
- Les statuts incomplets du portefeuille sont classés `in_progress` et comptés comme bloqués.
- L’Overview consomme ce portefeuille corrigé et inclut les pays de fabrication produit.
- L’action publique `/dpp/` de l’Overview est remplacée par l’inspection de préparation interne.
- Le HTML public ne contient plus le produit, les fournisseurs, impacts, origines, certifications, scores, identifiants, QR ou hash synthétiques.
- Les actions Wallet sont masquées tant que l’API ne fournit pas de liens pour un passeport publié.
- Le badge public devient neutre sans passeport et n’indique « publié » qu’après hydratation réussie.
- Les libellés de complétude précisent leur périmètre structuré, séparé des preuves et vérifications.
- L’indice de risque affiche sa couverture dimensionnelle et distingue les signaux produit directs des risques matière.
- Les relations de traçabilité disposent d’un libellé métier traduit tout en conservant le code technique.
- Les types matière courants sont traduits et la promesse de profondeur fournisseur devient conditionnelle aux données disponibles.
- Les documents distinguent désormais les sources disponibles du contrôle d’intégrité ; les catégories sont présentées comme telles.
- La page Qualité ne suggère plus des rapports d’essais ni une éligibilité DPP lorsque ces dimensions ne sont pas calculées.
- Les paramètres affichent le rôle courant, désactivent l’écriture hors owner/admin, explicitent l’absence de seuil et valident le format DPP côté navigateur et serveur.
- Les copies OCR, demandes annulées, score PEF proxy et badges Overview ont été rendues explicites.
- L’organisation active bénéficie d’un titre complet malgré la largeur limitée du sélecteur.

## Non-régression

Le contrat `test_customer_journey_release_blockers.mjs` vérifie désormais :

- l’agrégation stricte du portefeuille ;
- la dérivation des manquants du détail ;
- la rétrogradation des statuts historiques ;
- l’absence des affirmations synthétiques dans le HTML public ;
- le masquage des Wallets sans lien API ;
- le contrôle de rôle et la validation serveur des paramètres.

Les contrats DPP public, parcours marque, import/export tenant-safe, i18n, assets, routes et TypeScript sont également exécutés avant livraison.
