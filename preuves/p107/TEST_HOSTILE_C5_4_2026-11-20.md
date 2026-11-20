# P10.7 — test hostile C5.4 (configuration Preview)

Test contrôlé : `TRACEFAB_PREVIEW_DB_ENDPOINT` est temporairement réglé sur l'hôte de Production connu (`ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech`). La variable est limitée à Preview et à `release/p107-runtime-production-20261110`.

**Invariant de sécurité :** `DATABASE_URL` n'est pas modifiée. Le processus continue donc de joindre la base Neon de préproduction. Le test vérifie que la déclaration hostile ne peut pas neutraliser le contrôle C5.4, qui examine l'hôte réellement utilisé (`DATABASE_URL`) indépendamment de l'endpoint attendu.

La mesure runtime sera produite par le workflow P10.7 déclenché par ce commit. Cette configuration temporaire doit être restaurée après la mesure.
