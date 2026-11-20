# P10.7 — Preuve runtime finale C5

**État : C5.1 à C5.4 PASS sur le runtime réel en configuration nominale.**
**Clôture d'intégration : en attente de revue et fusion de la PR #134.**

## 1. Mesure nominale — 4/4 PASS

- Workflow : [44750641214](https://github.com/Huberaya/Tracefab/actions/runs/44750641214)
- SHA workflow = SHA déployé : `38e7e6dd9f2a0744d5e31c64ff697e8f52568439`
- Déploiement Vercel : `dpl_GHWqY5EZrKU7d6QWfJYckFGmYg34` — READY
- URL : https://tracefab-1mz4k1mym-baya-ibraimmayoanouedu-8164s-projects.vercel.app
- Branche : `release/p107-runtime-production-20261110`
- Mesure UTC : `2026-11-20T14:09:35.024Z`

| Contrôle | Verdict | Mesure |
|---|---|---|
| C5.1 — endpoint joint nommé | **PASS** | `ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech` |
| C5.2 — endpoint déclaré | **PASS** | variable Preview présente |
| C5.3 — joint = déclaré | **PASS** | `hote_conforme=true` |
| C5.4 — Preview hors Production | **PASS** | `hote_est_production=false` |

C1.1–C1.3, C2.1–C2.3, C3.1–C3.3 et C4.1–C4.6 sont également PASS : 19 assertions runtime PASS au total.

Preuve JSON : [artefact runtime nominal](https://github.com/Huberaya/Tracefab/blob/preuves/p107-38e7e6d-r44750641214/livrables-finalisation/preuves/p107-runtime-preuves.json).

## 2. Scénario hostile — hôte Production déclaré dans Preview

- Workflow : [44751212084](https://github.com/Huberaya/Tracefab/actions/runs/44751212084)
- SHA workflow/déploiement : `7f463d1da92bb87f7f9ac5ca275541cd9d01b500`
- Déploiement Vercel : `dpl_8RhkGa7vVeHBAphoj873jvYJoUym` — READY
- Test : `TRACEFAB_PREVIEW_DB_ENDPOINT` temporairement réglée sur l'hôte Production connu `ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech`.
- **`DATABASE_URL` n'a pas été modifiée** : aucune connexion à Production.

| Contrôle | Verdict | Interprétation |
|---|---|---|
| C5.1 | PASS | hôte réellement joint identifié |
| C5.2 | PASS | valeur attendue déclarée |
| C5.3 | **FAIL attendu** | la déclaration hostile ne correspond pas à l'hôte réellement joint |
| C5.4 | **PASS** | le contrôle continue d'examiner l'hôte réel et le reconnaît non-Production |

Ce test runtime confirme que la déclaration hostile ne peut pas neutraliser C5.4 : elle fait échouer la concordance C5.3, tandis que le contrôle anti-Production reste indépendant et correct.

Preuve JSON : [artefact runtime du scénario hostile](https://github.com/Huberaya/Tracefab/blob/preuves/p107-7f463d1-r44751212084/livrables-finalisation/preuves/p107-runtime-preuves.json).

## 3. Restauration de la configuration

Après le scénario hostile, la variable a été restaurée et relue :

- `TRACEFAB_PREVIEW_DB_ENDPOINT=ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech`
- Cible : `preview` uniquement
- Branche : `release/p107-runtime-production-20261110`
- Type : `plain`, nom d'hôte non secret

Une nouvelle Preview a été reconstruite après restauration :
- Deployment : `dpl_EqXDaFKbHhMt8iUZFabeJbubQToj`
- SHA : `a4e0904e4cfc4bd53bc7da4a0f501cfdb7389247`
- État : READY

[Preuve de restauration](https://github.com/Huberaya/Tracefab/blob/release/p107-runtime-production-20261110/preuves/p107/RESTORE_ENDPOINT_PREVIEW_C5_2026-11-20.md).

## 4. Résultat des jobs et portée

Les jobs de mesure 44750641214 et 44751212084 terminent en échec (exit 2), car la route globale de readiness renvoie HTTP 503. Le corps expurgé montre que l'identité est saine, mais que des services hors périmètre restent non configurés : stockage privé (`PRIVATE_STORAGE_*`), e-mail (`RESEND_API_KEY`, `EMAIL_FROM`) et alerting (`TRACEFAB_NOTIFICATION_ALERT_*`). Le job séparé de publication des preuves a réussi pour les deux runs.

Ce HTTP 503 interdit de déclarer la Preview globalement prête ; il ne change pas les verdicts explicites C1–C5 mesurés dans les corps runtime. Aucun service tiers n'a été configuré dans le cadre de P10.7.

## 5. CI et intégration

- CI PR #134 : [run 44736009523](https://github.com/Huberaya/Tracefab/actions/runs/44736009523), 4/4 jobs PASS.
- Le job RLS exécute le test `P10.7 — la règle « cet hôte est-il la Production ? » discrimine`, PASS.
- `main` reste sur `3dd164993a377960c741f3720935cb226559e641`.
- Le correctif runtime est dans la PR #134, SHA de code `4203a0398cee5fae4c40eea41aae8f09c0cd03a3`, non encore intégré à `main`.
- Aucune revue n'est enregistrée à la dernière vérification ; aucune fusion n'a été effectuée.

## 6. Périmètre de sécurité

- Aucune modification de `DATABASE_URL`.
- Aucune connexion du runtime Preview à la base Production.
- Aucune écriture, migration ou modification de données Neon.
- Aucune modification de variable Production, secret, protection Vercel ou allowlist.
- Seule `TRACEFAB_PREVIEW_DB_ENDPOINT` a été modifiée, dans Preview et sur la branche release ; elle est maintenant restaurée.

## Verdict

**Les quatre contrôles C5 sont établis sur le runtime réel.** Le scénario hostile de déclaration d'un hôte Production a aussi été exercé sans connecter la Preview à Production : C5.3 refuse la fausse concordance et C5.4 continue d'identifier correctement l'hôte réellement joint.

**P10.7 — preuves runtime terminées ; clôture d'intégration en attente.** Le correctif doit encore passer la revue requise et être fusionné dans `main`. La readiness globale de la Preview reste HTTP 503 pour les services tiers non configurés, hors périmètre des quatre contrôles C5.
