# Réconciliation de l'identité système signée — 9 novembre 2026

## Base de comparaison

- Ancienne base de la PR : `788df22019c0d2b39301678ecfbc43ac868561bf`
- `main` retenu pour la réconciliation : `71855014f4a4f6212b5475f4c208704c0054fb09`
- Branche : `arena/b8fe1a44-tracefab`

## Résolution du conflit du registre de fonctions

Le conflit de `scripts/test_registre_fonctions_runtime.mjs` est résolu en initialisant l'ensemble des déclarations depuis `nomsSeed`, puis en le complétant avec les ajouts de migrations.

Cette règle conserve les fonctions historiques du registre (dont les grants préexistants de `main`) tout en vérifiant les déclarations apportées par les migrations récentes. Elle évite de traiter comme non déclarée une fonction de seed déjà présente dans le registre de référence.

## Limites de cette réconciliation

- Aucune migration distante n'a été exécutée.
- Aucune donnée Neon n'a été modifiée.
- Aucune variable Production ni aucun déploiement Production n'a été touché.
- La migration `20261106130000_identite_systeme_signee` reste à valider sur une base PostgreSQL jetable avant toute décision de déploiement.

Ce document ne constitue pas une autorisation de fusion ou de déploiement Production.
