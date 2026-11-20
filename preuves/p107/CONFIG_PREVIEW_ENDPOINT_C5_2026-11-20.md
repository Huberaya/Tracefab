# P10.7 — configuration C5 Preview

- Date de configuration : 2026-11-20
- Projet Vercel : `tracefab`
- Variable : `TRACEFAB_PREVIEW_DB_ENDPOINT`
- Cible Vercel : `preview` uniquement
- Restriction de branche : `release/p107-runtime-production-20261110`
- Type : `plain` (nom d'hôte non secret)
- Endpoint déclaré : `ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech`
- Création Vercel confirmée : identifiant de variable `AI0HB3wutaFE33IW`
- Aucun ciblage Production, aucune modification de `DATABASE_URL`, aucun accès en écriture à Neon.

Cette note atteste uniquement la configuration Vercel. Elle ne vaut pas preuve runtime C5.2, C5.3 ou C5.4. La validation doit être produite par le workflow `.github/workflows/p107-preuves-runtime.yml` sur le déploiement Preview construit depuis le SHA de ce commit.
