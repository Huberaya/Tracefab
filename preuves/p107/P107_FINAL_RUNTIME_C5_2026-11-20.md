# P10.7 — preuve runtime finale C5 (2026-11-20)

**État : preuves runtime C5 établies ; intégration de la correction encore en attente.**

## 1. Mesure nominale — les quatre C5 passent

- Workflow : [44750641214](https://github.com/Huberaya/Tracefab/actions/runs/44750641214)
- SHA du workflow = SHA du déploiement : `38e7e6dd9f2a0744d5e31c64ff697e8f52568439`
- Déploiement Vercel : `dpl_GHWqY5EZrKU7d6QWfJYckFGmYg34` — READY
- URL : https://tracefab-1mz4k1mym-baya-ibraimmayoanouedu-8164s-projects.vercel.app
- Branche réellement déployée : `release/p107-runtime-production-20261110`
- Mesure : `2026-11-20T14:09:35.024Z`

| Contrôle | Verdict | Mesure |
|---|---|---|
| C5.1 — endpoint joint nommé | PASS | `ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech` |
| C5.2 — endpoint déclaré | PASS | variable Preview présente |
| C5.3 — joint = déclaré | PASS | `hote_conforme=true` |
| C5.4 — Preview hors Production | PASS | `hote_est_production=false` |

Les contrôles C1.1–C1.3, C2.1–C2.3, C3.1–C3.3 et C4.1–C4.6 sont également PASS sur cette mesure. Soit 19 assertions runtime PASS au total.

Preuve JSON expurgée : [artefact runtime nominal](https://github.com/Huberaya/Tracefab/blob/preuves/p107-38e7e6d-r44750641214/livrables-finalisation/preuves/p107-runtime-preuves.json).

## 2. Scénario hostile — configuration Preview déclarant l'hôte Production

- Workflow : [44751212084](https://github.com/Huberaya/Tracefab/actions/runs/44751212084)
- SHA workflow/déploiement : `7f463d1da92bb87f7f9ac5ca275541cd9d01b500`
- Déploiement Vercel : `dpl_8RhkGa7vVeHBAphoj873jvYJoUym` — READY
- Pendant ce test uniquement, `TRACEFAB_PREVIEW_DB_ENDPOINT` a été remplacée dans Preview par l'hôte Production connu : `ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech`.
- **`DATABASE_URL` n'a pas été modifiée** : le runtime est resté connecté à Neon préproduction.

Résultat observé sur le runtime réel :

| Contrôle | Verdict | Interprétation |
|---|---|---|
| C5.1 | PASS | le runtime nomme toujours l'hôte réellement joint |
| C5.2 | PASS | une valeur attendue est déclarée |
| C5.3 | FAIL | la déclaration hostile ne correspond pas à l'hôte réellement joint — résultat attendu |
| C5.4 | PASS | l'hôte réellement joint reste reconnu comme non-Production |

C'est le résultat recherché : la configuration attendue peut provoquer un échec de concordance, mais elle ne peut pas rendre aveugle le contrôle anti-Production, qui examine l'hôte issu de `DATABASE_URL`.

Preuve JSON expurgée : [artefact runtime du scénario hostile](https://github.com/Huberaya/Tracefab/blob/preuves/p107-7f463d1-r44751212084/livrables-finalisation/preuves/p107-runtime-preuves.json).

## 3. Restauration et état final de configuration

Après le scénario hostile, la variable a été restaurée et relue :

- Clé : `TRACEFAB_PREVIEW_DB_ENDPOINT`
- Valeur : `ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech`
- Cible : `preview` uniquement
- Branche : `release/p107-runtime-production-20261110`
- Type : `plain` (nom d'hôte public, non secret)

Une Preview a été reconstruite après restauration :
- Deployment : `dpl_EqXDaFKbHhMt8iUZFabeJbubQToj`
- SHA : `a4e0904e4cfc4bd53bc7da4a0f501cfdb7389247`
- État : READY

Note de restauration : [preuve de configuration](https://github.com/Huberaya/Tracefab/blob/release/p107-runtime-production-20261110/preuves/p107/RESTORE_ENDPOINT_PREVIEW_C5_2026-11-20.md).

## 4. Pourquoi les jobs de mesure sont en échec malgré les verdicts

Les jobs de mesure des runs 44750641214 et 44751212084 terminent en échec parce que la route de readiness renvoie HTTP 503 : d'autres services restent non configurés (stockage privé, e-mail, alerting). Le corps expurgé confirme toutefois `identiteSaine=true`, l'identité signée vérifiée par la base, le rôle `tracefab_app`, et les 19 verdicts de sécurité listés ci-dessus.

Le job séparé de publication des preuves a réussi pour les deux runs. Le HTTP 503 est un blocage de readiness applicative plus large, pas un échec de C5.1–C5.4. Les services tiers n'ont pas été configurés dans le cadre de P10.7.

## 5. CI, code et intégration

- CI PR #134 : [run 44736009523](https://github.com/Huberaya/Tracefab/actions/runs/44736009523), 4/4 jobs PASS.
- Le job RLS inclut le test `P10.7 — la règle « cet hôte est-il la Production ? » discrimine`, PASS.
- `main` reste sur `3dd164993a377960c741f3720935cb226559e641`.
- Le correctif runtime est dans la branche de PR #134 (`4203a0398cee5fae4c40eea41aae8f09c0cd03a3`) et n'est pas encore intégré à `main`.
- Aucune revue n'est enregistrée sur la PR au dernier contrôle. Aucune fusion n'a été effectuée.

## 6. Périmètre de sécurité

- Aucune modification de `DATABASE_URL`.
- Aucune connexion du runtime Preview à la base Production.
- Aucune écriture, migration ou modification de données Neon.
- Aucune modification de variable Production, de secret, de protection Vercel ou d'allowlist.
- La seule variable modifiée était `TRACEFAB_PREVIEW_DB_ENDPOINT`, Preview/branche release uniquement, et elle est maintenant restaurée.

## Verdict

**C5.1–C5.4 : PASS sur le runtime réel en configuration nominale.** Le scénario hostile de déclaration d'un hôte Production a également été exercé sur le runtime : C5.3 refuse la fausse concordance et C5.4 continue d'identifier l'hôte réellement joint comme non-Production.

**P10.7 — preuves runtime terminées ; clôture d'intégration en attente.** Le code correctif doit encore passer la revue requise et être intégré à `main`. La readiness globale de la Preview reste par ailleurs HTTP 503 du fait des services tiers non configurés, hors périmètre de ces contrôles.
