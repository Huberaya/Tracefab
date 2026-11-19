# P10.7 — Clôture des preuves C1/C2 sur le runtime déployé

**Date de la mesure** : 2026-11-19T08:01:59Z
**Run de preuve** : [44484176388](https://github.com/Huberaya/Tracefab/actions/runs/44484176388)
**Preuve expurgée** : branche `preuves/p107-65bb34d-r44484176388` →
`livrables-finalisation/preuves/p107-runtime-preuves.json` (commit `7ce51ee`)
**Cible interrogée** : `https://tracefab-7iqt5t6gf-baya-ibraimmayoanouedu-8164s-projects.vercel.app`
**Déploiement** : `dpl_EK3rSGAt1xxV7Qv4V5wLREsMCMD3`, statut READY, branche `release/p107-runtime-production-20261110`

## Traçabilité — deux SHA, jamais confondus

| Champ | Valeur | Ce qu'il désigne |
| --- | --- | --- |
| `workflow_sha` | `65bb34dda55c02a06f2f523e77dba5fead9c3b71` | révision du **workflow** qui mesure |
| `deployment_sha` | `599cbd879421bd3ab2b8ea0a99b540b355656bde` | révision du **code déployé** interrogé |
| `sha_traceabilite` | « deployment_sha fourni : la preuve porte sur ce code déployé » | ce que la preuve peut affirmer |

Ces deux valeurs étaient confondues dans un champ unique `sha` avant cette
session. Elles sont désormais enregistrées séparément et lues depuis
`SHA_ATTENDU`, l'input du workflow. Quand cet input manque, `deployment_sha`
vaut `null` — jamais la ref du workflow par défaut.

## Les six verdicts

| Critère | Verdict | Mesure brute |
| --- | --- | --- |
| C1.1 — le runtime sait signer une identité système | **PASS** | `mode=signe` |
| C1.2 — la BASE a vérifié le jeton signé (aller-retour réel) | **PASS** | `verifiee_par_la_base=true · verification=aller_retour_reussi` |
| C1.3 — usage système distinct de l'usage utilisateur | **PASS** | `usage=tracefab_system` |
| C2.1 — clé présente et bien formée dans le processus | **PASS** | `configured=true mode=signe` |
| C2.2 — le système signe avec la même clé, même processus | **PASS** | `systeme.configured=true · utilisateur.configured=true` |
| C2.3 — aucun fragment de clé dans la réponse | **PASS** | aucune suite hexadécimale longue dans le corps |

**C1.2 est un aller-retour réel, pas une présence de variable.** Le runtime
signe un jeton avec `TRACEFAB_IDENTITY_KEY`, puis exécute
`public.tracefab_identite_systeme_jeton_valide(jeton)` sur la base. Cette
fonction (migration `20261106130000_identite_systeme_signee`) recalcule le
HMAC-SHA256 du corps avec chaque clé **active** de `tracefab_identity_cles`,
compare les 32 octets **à temps constant**, et applique une expiration à
plafond de 600 s lue sur l'horloge de la base. Elle est `SECURITY DEFINER` :
le runtime ne peut pas lire la table des clés, donc ne peut pas falsifier.
`true` n'est rendu qu'après une signature acceptée. Le champ vaut `null` quand
la vérification n'a pas eu lieu — et `null` est compté INDETERMINATE, jamais
PASS.

## Les cinq autres critères (déjà mesurés, reproduits ici)

| Critère | Verdict |
| --- | --- |
| C3.1 / C3.2 / C3.3 — la sonde n'ouvre rien sans jeton | **PASS** ×3 (`HTTP 401`) |
| C4.1 — `current_user = session_user` | **PASS** |
| C4.2 — rôle non superutilisateur | **PASS** (`is_superuser=false`) |
| C4.3 — rôle ne contourne pas les RLS | **PASS** (`bypasses_rls=false`) |
| C4.4 — rôle ne peut pas endosser un rôle privilégié | **PASS** (`can_escalate=false`, `membres_privilegies=[]`) |
| C4.5 — rôle applicatif attendu | **PASS** (`tracefab_app`) |
| C4.6 — contexte tenant présent et non falsifié | **INDETERMINATE** |

**C4.6 reste INDETERMINATE et ne sera pas maquillé en PASS.** La route de
diagnostic n'ouvre aucune transaction métier : aucun contexte tenant n'y est
posé, donc la propriété n'est pas mesurable *par cette sonde*. Elle doit être
couverte par les suites RLS dédiées. Un `INDETERMINATE` honnête vaut mieux
qu'un vert qui ne mesure rien — c'est précisément le défaut que cette session
a corrigé.

## Pourquoi le job « Interroger » est en `failure` alors que les six verdicts sont PASS

Le run est en échec, et **ce n'est pas un échec des preuves**. La route
`/api/internal/p2/readiness` répond **HTTP 503** parce que trois services
tierce partie sont non configurés sur cette Preview :

- `privateStorage` — 7 variables absentes (`PRIVATE_STORAGE_*`)
- `email` — `RESEND_API_KEY`, `EMAIL_FROM` absents
- `alerting` — `TRACEFAB_NOTIFICATION_ALERT_URL/TOKEN` absents

Ce sont des dépendances de production, hors du périmètre P10.7, et les poser
serait un changement de configuration que ce mandat interdit. Le corps du 503
est une réponse **applicative complète** : il porte `identitySysteme`,
`identityTokens` et `databaseIdentity`. Tout ce qui est publié est donc
mesurable, et c'est ce qui est mesuré ci-dessus.

L'échec du job est donc un `FAIL` de disponibilité des services tiers, **pas**
un `FAIL` de C1 ou C2.

## Défaut trouvé et corrigé pendant cette session

Le premier run portant la clé (`44483815489`) n'a produit **aucun** verdict
C1/C2. Son corps disait `identityTokens.configured: true` et
`verifiee_par_la_base: true` — et le script sortait en 2 avant de les lire,
puis affirmait dans sa ligne d'arrêt « clé d'identité absente ». Une
interprétation recopiée d'une cause supposée, que son propre corps refusait :
un faux témoin, exactement ce que ce chantier doit éliminer.

Correction (`65bb34d`) : `evaluerC1C2(corps)` est appelée dès que le corps
porte les champs d'identité, quel que soit le statut HTTP ; l'interprétation
du 503 se **déduit** de `identityTokens.configured` et
`verifiee_par_la_base`. Un champ absent donne INDETERMINATE via `null`.

**Non-régression vérifiée mordante** : 5 assertions ajoutées à
`scripts/test_preuve_runtime_garde_fous.mjs`. Jouées contre la version
d'avant correctif, elles produisent **5 échecs** ; contre la version corrigée,
**0**. Un garde-fou qui ne mord pas sur le défaut qu'il protège ne protège rien.

## Second défaut corrigé : la preuve fraîche restait inaccessible

Le nom de branche de publication était figé sur `GITHUB_SHA` seul. Deux runs
sur le même SHA visaient donc la même branche, et le second était refusé en
`non-fast-forward` : le run `44483502417` a bien mesuré (artefact de 1420
octets, différent du précédent), mais sa preuve n'a jamais été lisible. Le nom
porte désormais le run : `preuves/p107-<sha7>-r<run_id>`.

## Ce qui a été fait, et ce qui n'a pas été fait

**Effectué** : lecture du runtime déployé, aucune écriture ; publication de la
preuve expurgée sur une branche dédiée ; deux correctifs de code avec tests de
non-régression ; trois runs de mesure.

**Non effectué, volontairement** : aucune écriture ni migration sur Neon ;
aucune variable créée, modifiée ou tournée ; aucune modification de la
protection Vercel ; aucune fusion de PR ; aucun changement en Production.

## Décision

**Les critères C1 et C2 sont PASS sur le runtime réellement déployé.** Ils ne
l'étaient pas au début de cette session : ils sont mesurés maintenant, avec
une preuve publiée, sur un SHA de déploiement nommé.

Trois réserves nommées, qui ne sont pas des PASS :

- **C4.6 — INDETERMINATE** : non mesurable par cette route, à couvrir par les
  suites RLS dédiées.
- **Services tiers — FAIL** : stockage privé, e-mail et alerting non configurés
  sur la Preview ; c'est la cause du HTTP 503 et de l'échec du job.
- **Rattachement de la base à `br-square-bread-b1gu7jk7` — INDETERMINATE** :
  l'empreinte d'hôte (`55c809d501c6`) ne permet pas de nommer l'endpoint, et
  l'OID seul (16396) ne distingue pas les branches. Non retenté, comme demandé.

**Aucune fusion.** La PR #132 est ouverte, propre, CI 4/4 verte sur son SHA de
tête.
