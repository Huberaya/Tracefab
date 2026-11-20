> **AVIS DE MISE À JOUR — 2026-11-20, après les mesures runtime C5**
>
> Ce document est un **constat historique daté du run 44704187929 (08:38:55Z)**. Il décrit correctement le blocage observé à cette heure-là, mais ses conclusions « aucun C5 exécuté » et « unique action nécessaire » ne décrivent plus l'état actuel.
>
> Depuis cette mesure, la branche release a été réalignée sur `main`, l'endpoint Preview a été configuré puis restauré, et les quatre contrôles C5 ont été exécutés sur le runtime réel :
>
> - Mesure nominale : [run 44750641214](https://github.com/Huberaya/Tracefab/actions/runs/44750641214), C5.1–C5.4 PASS.
> - Scénario hostile : [run 44751212084](https://github.com/Huberaya/Tracefab/actions/runs/44751212084), C5.3 FAIL attendu (endpoint déclaré volontairement discordant), C5.4 PASS.
> - Rapport de référence à jour : [P107_FINAL_RUNTIME_C5_2026-11-20.md](../preuves/p107/P107_FINAL_RUNTIME_C5_2026-11-20.md).
>
> **Ne pas utiliser les conclusions des sections historiques ci-dessous comme verdict actuel.** Elles sont conservées pour la traçabilité de la découverte initiale et remplacées par les mesures ci-dessus.
>
>
> **Correction factuelle sur la comparaison de branches :** la phrase historique du § 3 affirmant une divergence de « 1224 commits » était erronée. La comparaison GitHub effectuée lors du réalignement a établi 12 commits d'avance pour `main` et un commit propre à `release/`, puis les deux références ont été réalignées à `3dd164993a377960c741f3720935cb226559e641`. Ne pas réutiliser le chiffre 1224.
>
> ---
>
# P10.7 — Preuve C5 runtime après fusion de la PR #133

**Résultat : CAS 2 — BLOCAGE DÉMONTRÉ.**
Aucun des contrôles C5.1–C5.4 n'a pu s'exécuter sur le runtime réel. Aucun n'est déclaré `PASS`.

---

## 1. Ce qui est établi, et par quelle mesure

| Élément | Valeur | Source |
|---|---|---|
| `main` après fusion | `3dd164993a377960c741f3720935cb226559e641` | `git rev-parse origin/main` ; PR #133 `MERGED` le 2026-11-20T08:32:56Z |
| SHA candidat avant fusion | `4ad6a510898d6edc28081a90e7b70fde51524321` | déploiement Vercel `7930354866` |
| `workflow_sha` (code de la sonde) | `3dd164993a377960c741f3720935cb226559e641` | prévu par `deployment_sha` — voir § 2 |
| `deployment_sha` (code servi par la Preview) | `599cbd879421bd3ab2b8ea0a99b540b355656bde` | preuve runtime produite |
| URL de cette Preview | `https://tracefab-7iqt5t6gf-baya-ibraimmayoanouedu-8164s-projects.vercel.app` | déploiement `7890549771` |
| ID du déploiement | `7890549771` (ref `release/p107-runtime-production-20261110`) | API deployments |
| Branche réelle du déploiement | `release/p107-runtime-production-20261110` | champ `ref` du déploiement |
| État de la Preview du candidat | READY, déploiement `7930354866` (ref `4ad6a510…`) | statut `success` 2026-11-20T01:10:21Z |
| Horodatage de la mesure | `2026-11-20T08:38:55.162Z` | preuve `p107-runtime-preuves.json` |

**Aucun déploiement Vercel n'existe pour `3dd16499`** (fusion) : interrogé par SHA, l'API ne rend rien.
`Vercel` ne déploie pas `main` en Preview — les deux seuls déploiements `ref=main` du dépôt datent du
2026-11-19, portent `e7713dc0`, et sont restés en échec. Il n'existe **aucun déploiement en
environnement `Production`** : les 100 déploiements les plus récents sont tous `Preview`.

---

## 2. Résultat des contrôles C5 — exécution réelle, verdicts

La sonde a été exécutée depuis un runner GitHub (seul chemin réseau autorisé) avec
`TRACEFAB_RUNTIME_PROBE_TOKEN` **PRESENT** et `VERCEL_AUTOMATION_BYPASS_SECRET` **PRESENT**
(annotation `notice` du run, valeurs jamais lues).

| Contrôle | Verdict | Justification mesurée |
|---|---|---|
| **C5.1** endpoint joint nommé | **BLOCKED** | la route a rendu **HTTP 410 Gone** ; aucun corps, donc aucun champ `identite_base.hote` |
| **C5.2** endpoint attendu déclaré | **BLOCKED** | même 410 : `hote_attendu_declare` n'a jamais été lu |
| **C5.3** endpoint joint = attendu | **BLOCKED** | même 410 : la comparaison n'a pas eu lieu |
| **C5.4** Preview ne joint pas la Production | **BLOCKED** | même 410 : `hote_est_production` n'a jamais été publié |

Extrait exact de la preuve publiée (`preuves/p107-3dd1649-r44704187929`,
`livrables-finalisation/preuves/p107-runtime-preuves.json`) :

```
arret : sonde authentifiee -> HTTP 410
C3.1  FAIL  | HTTP 410
C3.2  FAIL  | HTTP 410
C3.3  FAIL  | HTTP 410
résultats : 3  →  aucun C1, C2, C4, C5
corpsExpurge : absent
```

**Un contrôle qui ne s'exécute pas n'est pas un `PASS`.** Ces quatre lignes restent `BLOCKED`.

### Le contrôle anti-Production a été éprouvé, mais pas sur le runtime

Il ne s'agit **pas** d'une preuve C5.4 runtime, et il n'est pas présenté comme telle. C'est la
vérification que le contrôle *saurait* échouer s'il voyait le cas. Sur doublure locale, avec
`TRACEFAB_PREVIEW_DB_ENDPOINT` = hôte de Production :

```
C5.1  PASS  hote=ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech
C5.2  PASS  TRACEFAB_PREVIEW_DB_ENDPOINT est declare
C5.3  PASS  hote_conforme=true
C5.4  FAIL  est un hote de PRODUCTION — la Preview ne doit jamais le joindre
```

C'est la démonstration que le contrôle discrimine : `C5.3` donne un feu vert là où `C5.4` refuse.

---

## 3. Le blocage, nommé précisément

### Blocage principal — la seule Preview au code fusionné n'existe plus

`release/p107-runtime-production-20261110` est **la seule branche présente dans
`BRANCHES_SONDE_RUNTIME`** (`api/_lib/worker-auth.ts`, liste gelée, **inchangée par la fusion** :
`git diff` entre `4ad6a510` et `3dd16499` sur ce fichier est vide).

Cette branche pointe sur `599cbd87`, dont la Preview a été sondée et a répondu **HTTP 410 Gone**.
La branche est en avance de 12 commits sur `release/`, et son déploiement a été retiré par Vercel.

**Conséquence :** la seule cible que la porte autorise est éteinte.

Précision mesurée, pour ne pas surcharger le diagnostic : `599cbd87` **contient déjà** `hote`,
`hote_conforme`, `hote_attendu_declare` et `hote_empreinte` — donc C5.1, C5.2 et C5.3 y existent.
Il lui manque **`hote_est_production`**, absent de ce commit (0 occurrence) et introduit par
`45e4241`. Autrement dit, même si cette Preview avait répondu, **C5.4 n'aurait pas pu être mesuré** :
il aurait été `INDETERMINATE` (« champ absent : déployé avant ce contrôle »), jamais `PASS`.

**Et `release/p107-runtime-production-20261110` n'est pas un ancêtre de `main`** : la branche diverge
de 1224 commits, `main` n'ayant qu'un commit qu'elle n'a pas. Ce n'est donc pas « `main` en retard
d'un commit » : `release/` porte un lignage distinct. La faire avancer sur `3dd16499` est un
**remplacement de contenu**, non un simple `fast-forward` — c'est exactement pour cela que je ne
l'exécute pas de moi-même.

### Blocages secondaires, chacun mesuré

| # | Blocage | Preuve |
|---|---|---|
| B2 | La Preview du candidat `4ad6a510` porte la branche `arena/ecba1849-tracefab` | déploiement `7930354866`, champ `ref` = `4ad6a510…` ; test de branche correspondant : `arena/ecba1849-tracefab` |
| B3 | Cette branche n'est pas dans la liste gelée | run `44704479849`, annotation `failure` : « arena/ecba1849-tracefab n est pas dans BRANCHES_SONDE_RUNTIME : le runtime deploye refusera le jeton de sonde. » — exit 1 |
| B4 | La branche `main` ne déploie pas en Preview, et aucun déploiement n'existe pour `3dd16499` | API deployments : 0 résultat pour ce SHA ; 0 déploiement `Production` |
| B5 | Logs et artefacts des runs illisibles depuis cet environnement | `gh api .../logs` → `EOF` (blob store Azure hors réseau autorisé) ; zip artefact → redirection `productionresultssa19.blob.core.windows.net`, 0 octet reçu |

**Ce qui n'est pas le blocage, et qu'il faut dire pour ne pas se tromper de cible :** les secrets
sont présents (`sonde=PRESENT bypass=PRESENT`), le jeton de sonde est accepté par le runtime, et
l'URLPreview est résolue par l'API. L'accès n'est pas en cause ; c'est la **cible** qui manque.

---

## 4. L'unique action minimale nécessaire

> **Redéployer la branche `release/p107-runtime-production-20261110` sur un commit qui contient
> C5 — c'est-à-dire sur `main` (`3dd16499`) après fusion de #133.**

C'est l'action la plus petite qui débloque l'exécution **sans toucher à aucun contrôle** :

- elle ne modifie **pas** `BRANCHES_SONDE_RUNTIME` (la branche y est déjà) ;
- elle ne désactive **pas** Vercel Authentication (le contournement d'automatisation est déjà présent) ;
- elle ne déclare **pas** une branche différente de celle du déploiement ;
- elle ne touche **ni** à la Production, **ni** aux données, **ni** aux migrations, **ni** aux secrets,
  **ni** à la configuration Neon.

Deux formes équivalentes, au choix de l'opérateur :

1. **Aligner `release/p107-runtime-production-20261110` sur `3dd16499`** — opération de **remplacement
   de contenu** (`git push --force` ou réinitialisation équivalente), les deux lignages divergeant de
   1224 commits. Vercel crée la Preview, le workflow se déclenche même en `push` sur cette branche
   (`on.push.branches` du workflow la cite déjà), et la sonde s'exécute avec C5 complet.
2. **Redéployer `599cbd87` depuis la console Vercel** — débloque C5.1, C5.2 et C5.3 (ces champs
   existent dans ce commit), mais **pas C5.4** : `hote_est_production` y est absent, donc le contrôle
   anti-Production resterait `INDETERMINATE`. Voie partielle, à ne pas confondre avec un déblocage
   complet.

**Je n'exécute aucune des deux** : la première modifie une branche de release, la seconde la
configuration de déploiement Vercel. Les deux sortent du périmètre autorisé pour cette mission.

### Si la mission autorise la forme 1

L'exécution, alors, est immédiate et sans autre intervention :

```bash
gh workflow run p107-preuves-runtime.yml --ref arena/93ced544-tracefab \
  -f sha_attendu=3dd164993a377960c741f3720935cb226559e641 \
  -f branche_deployee=release/p107-runtime-production-20261110
```

La porte acceptera, le runtime répondra sur `/api/internal/p2-readiness?identity=1`, et C5.1–C5.4
rendront leurs verdicts. Le résultat sera publié dans `preuves/p107-3dd1649-r<run>`.

---

## 5. Opérations distantes — faites et non faites

| Opération | État |
|---|---|
| Pousser la branche de travail `arena/93ced544-tracefab` | **FAIT** (elle n'existait pas sur le distant — premier obstacle rencontré) |
| Lancer la sonde sur la Preview `release/` (`599cbd87`) | **FAIT** — run `44704187929`, **HTTP 410** |
| Lancer la sonde sur la Preview du candidat (`4ad6a510`) | **FAIT** — run `44704479849`, **refusé par la porte** |
| Créer un workflow de diagnostic temporaire, puis le retirer | **FAIT** (commit annulé, arbre revenu à l'état fusionné) |
| Ajouter une branche à `BRANCHES_SONDE_RUNTIME` | **NON FAIT** — interdit |
| Désactiver / contourner Vercel Authentication | **NON FAIT** — interdit |
| Déclarer une branche différente de celle du déploiement | **NON FAIT** — interdit |
| Déclarer `PASS` un contrôle non exécuté | **NON FAIT** |
| Toucher Production, données, migrations, secrets, config Neon | **NON FAIT** — interdit |
| Avancer `release/` ou redéployer depuis la console Vercel | **NON FAIT** — hors périmètre, action décrite § 4 |

---

## 6. Limites de ce document

- **Aucune preuve runtime de C5 n'existe.** Tout ce qui précède documente pourquoi, mesure à l'appui.
- Le 410 a été observé **une fois**, à `2026-11-20T08:38:55Z`. Une Preview retirée par Vercel ne
  revient pas ; le fait est stable, mais il n'a pas été réobservé depuis un second chemin, faute de
  réseau vers `*.vercel.app` depuis cet environnement (`curl` → `SSL_ERROR_SYSCALL`, HTTP 000).
- Les journaux des runs ne sont pas lisibles ici (`EOF`). Le diagnostic repose donc sur les
  **annotations** de l'API checks et sur l'**artefact publié sur une branche**, tous deux
  effectivement lus.
