# P10.7 — Rapport final

**Branche imposée** : `release/p107-runtime-production-20261110`
**SHA testé** : `347c969` (voir §9 pour la vérification finale sur le SHA livré)
**Date de la mesure** : 2026-11-16

## Décision

**NO-GO Production.** Les critères C1 à C4 ne sont pas démontrés sur le runtime
réel : la Preview est interceptée par Vercel Authentication avant d'atteindre
l'application. Ce n'est pas un défaut applicatif, et ce n'est pas un succès :
c'est un **accès manquant**, nommé et mesuré.

Deux défauts réels ont en revanche été corrigés et **prouvés** pendant cette
session : un faux négatif qui accusait l'application à tort, et une publication
de preuves qui échouait.

---

## 1. État initial vérifié

| Élément | État constaté |
| --- | --- |
| Preview de la branche imposée | **HTTP 302** vers `vercel.com/sso-api` — « Protected by Vercel Authentication » |
| Secret `TRACEFAB_RUNTIME_PROBE_TOKEN` | **PRÉSENT** (portée job, mesuré par comparaison de longueur) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | **ABSENT** |
| `VERCEL_READONLY_TOKEN` | **ABSENT** |
| Connecteur Vercel | `limited: true` — inspection des protections et des variables impossible |

Mesure de référence, run `43873920787`, annotation du workflow :

> `sonde=PRESENT bypass=ABSENT vercel_token=ABSENT`

**Le déplacement du diagnostic est le fait marquant de cette session.** La
session précédente cherchait si le jeton de sonde existait. Il existe. Le
blocage n'est pas là : il est dans l'accès à la Preview.

---

## 2. Anomalies identifiées et traitées

| # | Anomalie | État |
| --- | --- | --- |
| 1 | **Un 302 de Vercel compté comme un échec de C3** — la requête n'atteint jamais l'application, le verdict accusait l'application | **CORRIGÉE ET PROUVÉE** |
| 2 | `git push` en `exit 128` — dépôt sans identifiants (`persist-credentials: false`) | **CORRIGÉE ET PROUVÉE** |
| 3 | Job écrivain absent : le workflow ne déclarait que `contents: read` | **CORRIGÉE ET PROUVÉE** |
| 4 | `exit 4` « authentication required » alors que l'artefact existait — `gh` ne lit que `GH_TOKEN` | **CORRIGÉE ET PROUVÉE** |
| 5 | Job de publication **vert sans rien publier** (reconstitution par le journal échouant en silence) | **CORRIGÉE ET PROUVÉE** |
| 6 | Accès automatisé à la Preview | **BLOQUÉE** — action humaine requise (§5) |

---

## 3. Corrections apportées

### 3.1 Faux négatif Vercel — le défaut de fond

Un 302 n'est pas un refus : c'est une absence d'accès. Les confondre produit un
faux négatif — on déclare l'application fautive quand c'est l'observateur qui
n'a pas le droit d'entrer. C'est exactement ce que la mission interdit.

`scripts/detecter_protection_vercel.mjs` porte désormais la **définition
unique** de « la requête a-t-elle atteint l'application ? », partagée par
`preuve_runtime_p107.mjs` et `sonde_preview.mjs` — pour que les deux outils ne
puissent pas diverger sur cette frontière.

Comportement : un 302, ou un corps/en-tête portant `vercel_auth_enabled` /
`Protected by Vercel Authentication` / `vercel.com/sso-api`, classe le résultat
**INDÉTERMINÉ** et arrête le script en nommant la voie officielle. Un 401 ou un
503 applicatif reste un refus légitime.

**Test de non-régression** : `npm run test:detection-vercel`, 7 assertions,
**dont des contre-épreuves** (401 applicatif, 200, 503). Sans elles, une vraie
régression de sécurité pourrait être masquée par la détection.

### 3.2 Publication des preuves — Phase B

Trois défauts successifs, chacun mesuré puis corrigé :

| Run | Symptôme | Cause réelle |
| --- | --- | --- |
| `43868405432` | exit 128 | `persist-credentials: false` + `git push` nu |
| `43869430514` | job **vert**, rien publié | reconstitution par le journal en échec silencieux |
| `43870575863` | exit 4 | `contents: write` remet les autres portées à `none` → ajout de `actions: read` |
| `43871621158` | exit 4 **encore** | `gh` ne lit que `GH_TOKEN`, jamais `GH_TOKEN_PREUVES` |

Le job écrivain est **séparé** du job de mesure, conformément au contrôle H de
la politique maison : un job qui détient `contents: write` ne doit exécuter
aucun code du dépôt. Le jeton d'écriture n'existe que dans ce job.

**Preuve** : branche `preuves/p107-8cfa890`, commit `b6aa204`, contenu lisible
par l'API GitHub — plus par un blob store inaccessible.

La preuve publiée elle-même dit la vérité : `"arret": "SITUATION 5/5 —
deploiement INACCESSIBLE…"`, `"resultats": []`. Un fichier vide de verdicts
aurait été un faux témoin.

---

## 4. Ce qui n'a pas été fait, et pourquoi

Aucun contrôle n'a été désactivé, aucune sonde supprimée, aucun critère abaissé
pour faire passer la CI. En particulier :

- **La protection Vercel n'a pas été désactivée**, le SSO n'a pas été retiré,
  la Preview n'a pas été rendue publique.
- Aucun secret, cookie ou jeton n'a été affiché, journalisé ou commité. Le
  diagnostic d'accès compare des **longueurs**, jamais des valeurs.
- Aucune preuve locale n'est présentée comme preuve de runtime.

---

## 5. Action humaine requise — une seule, précise

La Preview ne peut pas être atteinte par une voie automatisée tant que le
contournement d'automatisation n'existe pas. La voie **officielle** de Vercel,
qui **maintient la protection active**, est :

1. Vercel → projet `tracefab` → **Settings → Deployment Protection**.
2. Section **Protection Bypass for Automation** → **Generate**.
3. Stocker la valeur comme secret GitHub **`VERCEL_AUTOMATION_BYPASS_SECRET`**.

Le workflow et le script la prennent **déjà** en charge : l'en-tête
`x-vercel-protection-bypass` est envoyé s'il est fourni, et n'est jamais
journalisé.

**Alternative sans secret** : exécuter `vercel curl` contre la Preview depuis
une session authentifiée, puis transmettre la sortie des quatre critères.

Dès que ce secret existe, le workflow `P10.7 — preuves runtime sur la Preview
réelle` produit C1–C4 sans autre modification.

---

## 6. Réserves — état explicite

| Réserve | État |
| --- | --- |
| C1 — identité signée, vérification effective en base | **BLOQUÉE (accès Preview)** |
| C2 — clé HMAC présente et chargée dans le processus runtime | **BLOQUÉE (accès Preview)** |
| C3 — refus sans jeton / jeton forgé, acceptation autorisée | **BLOQUÉE (accès Preview)** — la classification du 302 est corrigée, la mesure reste impossible |
| C4 — utilisateur PG réel, sans superuser, sans BYPASSRLS | **BLOQUÉE (accès Preview)** |
| Publication des preuves (Phase B) | **CORRIGÉE ET PROUVÉE** |
| Faux négatif Vercel | **CORRIGÉE ET PROUVÉE** |
| Accès autorisé à la Preview (Phase A) | **BLOQUÉE — action humaine** |

Aucun critère bloqué n'est déclaré validé. Aucun critère n'est déclaré en échec
applicatif : ils sont **non mesurés**.

---

## 7. État du Preview

| Élément | État |
| --- | --- |
| URL | `https://tracefab-mxiwuuuvl-baya-ibraimmayoanouedu-8164s-projects.vercel.app` |
| Réponse | **302** → `vercel.com/sso-api` |
| Protection | **Active** — non modifiée par cette session |
| SHA déployé | Non vérifiable (le garde-fou de SHA s'exécute après l'accès, qui échoue avant) |

Les requêtes n'atteignent pas l'application. Aucune conclusion applicative ne
peut être tirée de cet état.

---

## 8. État Production

**Aucune action sur la Production.** Aucune migration, aucun changement de
rôle, aucune modification de privilège. `_prisma_migrations` n'a pas été
touché. La Production reste fermée par la première condition du code de sonde
(`VERCEL_ENV === preview`).

---

## 9. Ce que je ne déclare pas

- Je ne déclare pas P10.7 terminé.
- Je ne déclare pas C1–C4 validés.
- Je ne déclare pas la Preview sécurisée **sur la base de preuves runtime** —
  sa protection est active, mais ce fait est observé, pas prouvé par ce
  chantier.
- Je ne déclare pas le blocage résolu : il est **nommé, mesuré, et ramené à une
  action humaine unique**.

Ce qui est acquis : le diagnostic ne ment plus. Une requête interceptée par
Vercel n'est plus comptée comme un refus de l'application, la publication des
preuves fonctionne, et les deux comportements sont couverts par des tests de
non-régression exécutés en CI.
