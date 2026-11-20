# P10.7 — restauration de l'endpoint Preview après test hostile

Le test hostile temporaire est terminé. `TRACEFAB_PREVIEW_DB_ENDPOINT` a été restauré à l'endpoint Neon de préproduction qualifié. La variable reste limitée à `preview` et à `release/p107-runtime-production-20261110`.

`DATABASE_URL`, les secrets, Production et Neon n'ont pas été modifiés. Une nouvelle Preview est construite depuis ce commit pour la mesure finale C5.1–C5.4 sur la configuration nominale restaurée.
