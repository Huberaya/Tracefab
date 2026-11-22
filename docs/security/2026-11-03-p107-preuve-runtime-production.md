# P10.7 — Preuve de l'identité runtime Production

**Mesure exécutée :** 2026-11-03T15:25:01.024Z (UTC)  
**Déploiement mesuré :** `dpl_DhWFDPARLyHcppioNkjywHeu4zcm`  
**Commit mesuré :** `e0653b915d8e9b16b326bcc711459d500d076718` (`ops/p107-runtime-proof-20261103`)  
**Environnement :** Vercel Production · région `iad1`  
**Mécanisme :** Vercel Cron authentifié par `CRON_SECRET`; mesure via le client Prisma partagé et le `DATABASE_URL` du runtime. Aucun secret ni URL de connexion n'a été journalisé.

## Résultat brut expurgé

```json
{
  "schema": "tracefab-p107-runtime-proof-v2",
  "measuredAt": "2026-11-03T15:25:01.024Z",
  "roleExpected": "tracefab_app",
  "identity": {
    "currentUser": "tracefab_app",
    "sessionUser": "tracefab_app",
    "database": "neondb",
    "postgresVersion": "PostgreSQL 18.6",
    "attributes": {
      "superuser": false,
      "bypassRls": false,
      "createRole": false,
      "createDb": false
    }
  },
  "memberships": [],
  "privilegedRolesReachable": [],
  "canEscalateToPrivilegedRole": false,
  "pooler": {
    "mode": "session_or_direct",
    "source": "pg.Client sur DATABASE_URL du runtime",
    "backendCount": 1,
    "transactions": 3,
    "error": null
  },
  "transactionalContext": {
    "visibleInsideTransaction": true,
    "absentAfterTransaction": true,
    "error": null
  },
  "readOnly": {
    "sqlState": "25006",
    "proven": true
  },
  "identityKeyState": "absente",
  "transactionError": null,
  "stops": [],
  "verdict": "IDENTITE_CONFORME"
}
```

## Interprétation

- L'identité réellement utilisée par le runtime est `tracefab_app` pour `current_user` et `session_user`.
- Le rôle ne porte aucun des attributs privilégiés mesurés : `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`.
- Aucune appartenance transitive n'est observée et aucune escalade vers un rôle privilégié n'est possible selon `pg_has_role(..., 'SET')`.
- Le contexte de session posé localement est visible dans sa transaction puis absent après celle-ci.
- Trois transactions ont été mesurées sur un seul backend. Le résultat est volontairement libellé `session_or_direct` : cette observation ne distingue pas une connexion directe d'un pooler en mode session.
- Le témoin SQLSTATE `25006` prouve que **la transaction de mesure**, explicitement passée en `READ ONLY`, refuse l'écriture. Il ne prétend pas prouver que le rôle applicatif ne possède aucun droit DML ordinaire (l'application doit pouvoir écrire sous RLS).
- `TRACEFAB_IDENTITY_KEY` est absente. La readiness correspondante est donc `configured: false`, `mode: non_configure`. C'est un état de transition documenté, mais **pas** une preuve de signature HMAC active.

## Décision

**Chantier A — identité et privilèges effectifs du runtime : CONFORME et mesuré sur Production.**

Cette preuve ne vaut pas GO pour l'activation de `strict`, l'application des migrations 68/69, ni la mise en production de la chaîne HMAC. Le contrôle HMAC reste NO-GO tant que `TRACEFAB_IDENTITY_KEY` n'est pas configurée et vérifiée comme valide sur l'environnement qui sert, et tant que les autres préconditions de migration ne sont pas satisfaites. Aucun réglage `strict`, aucune migration, aucun rôle ou privilège Neon n'a été modifié pendant cette mission.

## Nettoyage après mesure

- La route temporaire `api/_routes/internal/p107-runtime-proof.ts` a été supprimée de la branche de travail.
- `api/index.ts` a été restauré à la version de `main` (plus aucune entrée de routage P107 temporaire).
- `vercel.json` a été restauré à la version de `main`, notamment le cron métier quotidien `/api/internal/notification-outbox/schedule` à `0 7 * * *`.
- La Production a été redéployée depuis le déploiement antérieur de `main` (`788df22019c0d2b39301678ecfbc43ac868561bf`) sous le nouvel ID `dpl_FYHELX51z15ot9Gb2q4Cue7e773c`, état `READY`, alias `tracefab.vercel.app`.
- `main` n'a pas été modifiée. Aucune donnée, migration, variable ou secret n'a été modifié.
