# 24. Notification Scheduler — Chantier 21

## Objectif

Le Chantier 21 rend opérationnel le passage planifié du workflow de relances. Le Chantier 16 exposait déjà les routes manuelles d'enqueue et de traitement ; cette étape ajoute une entrée Vercel Cron qui enchaîne les deux opérations sans exposer Clerk ni une identité navigateur.

```text
Vercel Cron — 07:00 UTC chaque jour
  → GET /api/internal/notification-outbox/schedule
  → authentification CRON_SECRET
  → tracefab_enqueue_due_data_request_reminders(72)
  → tracefab_claim_notification_outbox(10)
  → livraison Resend / retry outbox
```

La route est idempotente : l'enqueue SQL conserve la clé par demande, type de relance et jour civil UTC. Un retry du cron ou une exécution manuelle ne produit pas un doublon de relance.

## Route planifiée

```text
GET /api/internal/notification-outbox/schedule
Authorization: Bearer <CRON_SECRET>
```

La planification est déclarée dans `vercel.json` :

```json
{
  "crons": [
    {
      "path": "/api/internal/notification-outbox/schedule",
      "schedule": "0 7 * * *"
    }
  ]
}
```

L'expression est en UTC. Vercel envoie automatiquement `Authorization: Bearer <CRON_SECRET>` lorsque `CRON_SECRET` est configuré sur le projet. Un header `x-tracefab-cron-secret` est également accepté pour un runner de confiance hors Vercel, mais le secret reste distinct de `TRACEFAB_NOTIFICATION_WORKER_SECRET`.

La réponse contient :

- le nombre de relances nouvellement enqueueées ;
- la fenêtre de relance utilisée ;
- la taille de batch ;
- le résumé du worker (`claimed`, `sent`, `pending`, `failed`, `notConfigured`).

## Configuration

```text
CRON_SECRET=secret_long_et_distinct
TRACEFAB_REMINDER_HORIZON_HOURS=72
TRACEFAB_NOTIFICATION_BATCH_LIMIT=10
TRACEFAB_NOTIFICATION_WORKER_SECRET=secret_pour_routes_manuelles
```

`TRACEFAB_REMINDER_HORIZON_HOURS` est borné entre 1 et 720 heures. `TRACEFAB_NOTIFICATION_BATCH_LIMIT` est borné entre 1 et 50. Une configuration invalide retourne une indisponibilité explicite plutôt qu'une exécution partielle silencieuse.

Le endpoint planifié n'utilise pas Clerk, ne reçoit pas de données fournisseur dans la requête et ne délivre pas directement les emails. L'audience est calculée par la fonction SQL et le worker existant conserve les claims, retries et transitions de l'outbox.

## Routes manuelles conservées

Les routes suivantes restent utiles pour une exécution opérateur ou un runner externe :

```text
POST /api/internal/notification-outbox/reminders
POST /api/internal/notification-outbox/process?limit=50
x-tracefab-worker-secret: <TRACEFAB_NOTIFICATION_WORKER_SECRET>
```

Elles gardent une authentification séparée afin qu'une fuite du secret de cron ne donne pas automatiquement accès aux commandes manuelles.

## Validation

```bash
npm run build
npm run test:notification-scheduler
npm run test:neon:collection
npm run schema:static
git diff --check
```

Le test de contrat vérifie la route GET, l'authentification bearer, la planification Vercel, les limites de configuration et l'enchaînement enqueue/processing. Le test Neon de collecte valide l'idempotence et l'isolation des destinataires sur un environnement Neon configuré.

## Limites

- la livraison réelle dépend toujours de `RESEND_API_KEY`, `EMAIL_FROM` et d'une configuration Vercel Cron active ;
- une seule exécution quotidienne est configurée ; les relances sont néanmoins protégées contre les doublons journaliers ;
- les événements échoués et les retries restent gouvernés par l'outbox du Chantier 15 ;
- les logs corrélés, l'état protégé de l'outbox et le webhook d'alerte sont détaillés dans le Chantier 22 ; son endpoint d'alerte réel et ses dashboards restent à configurer.
