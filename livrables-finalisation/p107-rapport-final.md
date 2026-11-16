# P10.7 — Rapport final

**Date : 2026-11-13.** Aucune opération Production. Aucun secret exposé.

## Décision

**NO-GO — BLOCAGE EXTERNE**, sur un unique point : le secret de sonde n'existe
dans aucune portée atteignable.

Tout le reste est **corrigé, testé et intégré**. C1–C4 ne sont pas obtenues, et
ne peuvent pas l'être sans une action qui exige des permissions que la session
d'analyse n'a pas.

## 1. État initial vérifié

| Élément | Vérifié |
| --- | --- |
| `origin/main` | `af42d723bfb9889a14b58f9eb7cc500e091ae727` ✅ conforme |
| PR #127 | `MERGED` le 2026-11-13T11:57:25Z, commit `af42d72` |
| PR #121 | `MERGED` le 2026-11-13T11:57:27Z, **même commit** `af42d72` |
| Corrections sur `main` | les 5 fichiers clés **PRÉSENTS** |
| CI post-fusion | 4/4 verte sur `af42d72` |

Les chiffres annoncés étaient exacts. J'ai aussi constaté que le clone local
avait été réinitialisé sur `a24406d` : j'ai travaillé depuis `origin/main`, pas
depuis cet état.

## 2. Anomalies identifiées

| # | Anomalie | État |
| --- | --- | --- |
| 1 | `TRACEFAB_RUNTIME_PROBE_TOKEN` absent de toute portée | **BLOQUÉE** |
| 2 | Diagnostic de portée inexact (`TF_ENV_DECLARE` non transmis) | **CORRIGÉE ET PROUVÉE** |
| 3 | Diagnostic et preuves invisibles (journal + artefact inaccessibles) | **CORRIGÉE ET PROUVÉE** |
| 4 | `contents: write` refusé sur un job exécutant du code du dépôt | **CORRIGÉE** (retiré) |
| 5 | Publication des preuves impossible (permission) | **BLOQUÉE** (contournée par annotation) |

## 3. Le blocage, mesuré exhaustivement

Ce n'était pas un 403 à interpréter : j'ai construit une mesure directe dans le
workflow, qui teste la **présence** sans jamais lire la valeur.

| Portée testée | Noms testés | Résultat |
| --- | --- | --- |
| Dépôt | `TRACEFAB_RUNTIME_PROBE_TOKEN` | vide |
| Environnement `Preview` (déclaré par le job) | idem | vide |
| Dépôt + `Preview` | `PREVIEW_TRACEFAB_RUNTIME_PROBE_TOKEN` | vide |
| Dépôt + `Preview` | `RUNTIME_PROBE_TOKEN` | vide |
| Dépôt + `Preview` | `TRACEFAB_PROBE_TOKEN` | vide |
| Organisation | — | inexistante (compte personnel, 404) |

Annotation produite par le workflow (run `43848408548`, SHA `efae1a6`) :

> AUCUN secret de sonde accessible. Noms testés : `TRACEFAB_RUNTIME_PROBE_TOKEN`
> | `PREVIEW_TRACEFAB_RUNTIME_PROBE_TOKEN` | `RUNTIME_PROBE_TOKEN` |
> `TRACEFAB_PROBE_TOKEN`. Portées : dépôt + environnement **Preview**.
> Action : `gh secret set TRACEFAB_RUNTIME_PROBE_TOKEN`.

Côté Vercel, le connecteur répond `limited: true` : je ne peux pas vérifier si
la variable existe côté Preview. **Cela reste donc incertain** et doit être
confirmé par vous.

### Ce qui a été écarté, avec preuve

- ❌ Secret au niveau dépôt — mesuré vide
- ❌ Secret au niveau environnement `Preview` — mesuré vide, environnement
  **déclaré** par le job
- ❌ Mauvais nom (4 variantes testées)
- ❌ Secret d'organisation — le compte n'a pas d'organisation
- ❌ Lecture via l'API GitHub — 403 sur `secrets`, `public-key`,
  `environments/Preview/secrets` ; `X-Oauth-Scopes` vide

## 4. Actions requises — deux, précises

**a) Vercel** — confirmer que `TRACEFAB_RUNTIME_PROBE_TOKEN` existe comme
variable **Preview**. Si elle n'existe pas, vous seul pouvez la créer.

**b) GitHub** — `gh secret set TRACEFAB_RUNTIME_PROBE_TOKEN`
(valeur **identique** à celle de Vercel). Nécessite l'application
`Arena` sur GitHub avec la permission **Secrets : write**.

Sans les deux, C1–C4 sont impossibles. Le workflow est prêt : à la première
exécution avec le secret, il produit les quatre preuves sans autre intervention.

## 5. Corrections effectuées

| Fichier | Correction |
| --- | --- |
| `.github/workflows/p107-preuves-runtime.yml` | Mesure de présence à 4 noms × 2 portées |
| idem | Diagnostic porté par **annotation** (canal fiable) |
| idem | `TF_ENV_DECLARE` transmis au bon step (diagnostic exact) |
| idem | `contents: write` retiré (politique du dépôt) |

## 6. Ce qui reste valide et prouvé

| Contrôle | Résultat | SHA |
| --- | --- | --- |
| CI complète | **4/4 verte** | `3da2647`, `9f2d492`, `af42d72` |
| Suites P10.5/P10.6/P10.7/P10.8 | **22/22** | `3da2647` |
| Chaîne de migrations, base jetable | **100/100**, 0 doublon | `3da2647` |
| Opérations système gardées | **13/13**, 0 non gardée | `3da2647` |
| Grants `PUBLIC` | **0** restant | `3da2647` |
| C1/C2/C3 local (vrai code applicatif) | **21/21** | `3da2647` |
| C4 local (rôle applicatif) | **12/12** | `3da2647` |
| Porte de sonde | **15/15** | `3da2647` |

Ces résultats sont **locaux**. Ils ne remplacent pas les preuves runtime.

## 7. État du Preview

| SHA | État | URL |
| --- | --- | --- |
| `efae1a6` | `success` | `tracefab-qvp3ne266-…vercel.app` |
| `9f2d492` | `success` | `tracefab-5jt6qy83u-…vercel.app` |

Le workflow vérifie à chaque exécution que le SHA déployé est **exactement**
celui du commit testé. Cette étape passe.

## 8. État Production

**Aucune opération Production.**

- Aucune migration exécutée
- Aucun `prisma migrate deploy` / `resolve`
- Aucun accès à `_prisma_migrations` de Production
- Aucun déploiement Production
- Aucun secret Production lu, modifié ou tourné
- Mode strict Production non activé
- Aucune donnée modifiée

## 9. Réserves

| Réserve | État |
| --- | --- |
| C1 identité signée runtime | **BLOQUÉE** — secret absent |
| C2 HMAC chargé runtime | **BLOQUÉE** — secret absent |
| C3 anti-usurpation runtime | **BLOQUÉE** — secret absent |
| C4 identité PostgreSQL runtime | **BLOQUÉE** — secret absent |
| Diagnostic de portée inexact | **CORRIGÉE ET PROUVÉE** |
| Preuves invisibles (journal/artefact) | **CORRIGÉE ET PROUVÉE** |
| `contents: write` non conforme | **CORRIGÉE** |
| Publication en commit des preuves | **BLOQUÉE** — permission, contournée par annotation |

## 10. Ce que je ne déclare pas

Je ne déclare pas P10.7 terminé. Quatre des cinq critères de clôture sont
satisfaits ; les quatre preuves runtime ne le sont pas. Un test local ne vaut
pas une preuve de déploiement, et une variable déclarée ne prouve pas qu'elle
est chargée.
