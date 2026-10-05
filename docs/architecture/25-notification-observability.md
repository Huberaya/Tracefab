# 25. Notification Observability — Chantier 22

## Objectif

Le Chantier 22 rend les relances et la livraison de notifications observables sans exposer de données fournisseur, de destinataires, de contenu de demande ou de secret.

Il ajoute :

- un `runId` par exécution du scheduler ;
- des logs JSON corrélés et sans PII ;
- un endpoint d'état protégé de l'outbox ;
- un webhook d'alerte externe optionnel pour les échecs de livraison et du scheduler ;
- un timeout strict et un contrat de payload versionné pour le webhook.

## État protégé de l'outbox

```text
GET /api/internal/notification-outbox/health
x-tracefab-worker-secret: <TRACEFAB_NOTIFICATION_WORKER_SECRET>
```

La réponse contient uniquement des métriques agrégées :

- jobs `pending`, `processing`, `sent` et `failed` ;
- jobs prêts à être traités ;
- jobs `processing` bloqués depuis plus de quinze minutes ;
- jobs épuisés après cinq tentatives ;
- date du plus ancien job prêt.

L'endpoint retourne `503` si des jobs sont bloqués ou épuisés. Il ne révèle ni identifiant de demande, ni email, ni titre, ni erreur fournisseur brute.

## Logs corrélés

Le scheduler génère un UUID `runId` et écrit des événements JSON :

```json
{
  "service": "tracefab-notification",
  "event": "notification_schedule_completed",
  "runId": "uuid",
  "enqueued": 2,
  "claimed": 2,
  "sent": 2,
  "pending": 0,
  "failed": 0,
  "alertingConfigured": true
}
```

Les logs utilisent des compteurs et codes d'erreur stables. Aucun email, titre, identifiant de demande, contenu de réponse ou token n'est placé dans un log.

## Alertes webhook

Lorsque l'envoi rencontre des jobs définitivement échoués, un email provider non configuré ou une erreur du scheduler, l'API peut appeler :

```text
POST ${TRACEFAB_NOTIFICATION_ALERT_URL}
Authorization: Bearer <TRACEFAB_NOTIFICATION_ALERT_TOKEN>
Content-Type: application/json
```

Contrat :

```json
{
  "schema": "tracefab-notification-alert-v1",
  "source": "tracefab-api",
  "event": "notification_delivery_failed",
  "occurredAt": "2026-10-05T07:00:00.000Z",
  "details": {
    "runId": "uuid",
    "failed": 1,
    "pending": 2
  }
}
```

Le webhook est appelé avec un timeout entre une et quinze secondes, cinq secondes par défaut. Une réponse HTTP hors 2xx, une erreur réseau ou un timeout sont journalisés comme `alert_delivery_failed` sans enregistrer le body de l'endpoint.

L'absence de `TRACEFAB_NOTIFICATION_ALERT_URL` est explicitement exposée comme `alertingConfigured: false`. Le produit ne présente donc pas l'alerting comme actif sans endpoint réel.

## Sécurité et défaillance

- `CRON_SECRET` protège le scheduler Vercel ;
- `TRACEFAB_NOTIFICATION_WORKER_SECRET` protège les commandes et l'état opérateur ;
- `TRACEFAB_NOTIFICATION_ALERT_TOKEN` n'est lu que côté serveur ;
- le webhook d'alerte ne reçoit pas de données métier ;
- une indisponibilité du webhook ne doit pas bloquer le traitement de l'outbox ;
- les alertes sont best effort, tandis que l'outbox reste la source durable de vérité ;
- les secrets d'alerte doivent être renouvelés avant production.

## Configuration

```text
TRACEFAB_NOTIFICATION_ALERT_URL=https://alerts.internal.example/tracefab
TRACEFAB_NOTIFICATION_ALERT_TOKEN=secret_webhook
TRACEFAB_NOTIFICATION_ALERT_TIMEOUT_MS=5000
```

Le endpoint doit être HTTPS en production. Le système ne vérifie pas que le fournisseur tiers est un outil d'astreinte particulier : l'intégration réelle doit être testée sur staging avec une URL dédiée et une politique de rétention adaptée.

## Validation

```bash
npm run build
npm run test:notification-scheduler
npm run test:notification-observability
npm run test:neon:collection
```

Les tests statiques vérifient les limites, les routes, l'authentification, le contrat webhook, le timeout et l'absence de PII. Le test Neon reste nécessaire pour valider les compteurs et les états de jobs sur une base réelle.

## Limites

- le webhook et le tableau de bord externe restent à configurer ;
- il n'y a pas encore de page d'administration Tracefab pour consulter les métriques ;
- les notifications d'expiration de documents et les alertes qualité restent hors de ce chantier ;
- la déduplication des alertes externes est laissée au récepteur, grâce au `runId` et à l'événement stable.
