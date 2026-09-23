# 19. Collection Reminders — Chantier 16

## Objectif

Le Chantier 16 ajoute les relances liées à l'échéance des demandes de données fournisseur, sans modifier les transitions métier et sans transformer une relance en preuve de vérification.

```text
cron privé
  → POST /api/internal/notification-outbox/reminders?horizonHours=72
  → scan Neon des demandes ouvertes
  → une relance due-soon ou overdue par demande et par jour
  → notification_outbox
  → worker Resend du Chantier 15
```

## Règles

Une demande est éligible si :

- `due_at` est renseigné ;
- son statut est `sent`, `in_progress` ou `changes_requested` ;
- elle arrive à échéance dans la fenêtre demandée, ou est déjà en retard.

Les statuts `submitted` et `approved` ne relancent pas le fournisseur. Les demandes sans date d'échéance sont ignorées.

Deux événements sont produits :

- `request_due_soon` jusqu'à l'échéance ;
- `request_overdue` après l'échéance.

La clé inclut la demande, le type de relance et la date civile UTC. Un cron rejoué le même jour n'ajoute donc pas de doublon.

## Route cron

```text
POST /api/internal/notification-outbox/reminders?horizonHours=72
x-tracefab-worker-secret: <secret serveur>
```

La fenêtre est bornée entre 1 et 720 heures. La route est indépendante de Clerk et protégée par `TRACEFAB_NOTIFICATION_WORKER_SECRET`. Elle ne délivre pas directement les emails : elle remplit l'outbox du Chantier 15, qui reste responsable du claim, des retries et de Resend.

Une planification de production peut exécuter cette route une fois par jour, puis appeler le worker d'envoi :

```text
POST /api/internal/notification-outbox/reminders
POST /api/internal/notification-outbox/process?limit=50
```

## Sécurité et données

Les relances sont limitées aux membres actifs de l'organisation fournisseur. Les données de réponse ne sont jamais copiées dans la notification. Les destinataires sont dédupliqués au niveau de l'outbox et les secrets restent des variables serveur.

## Tests

`npm run test:neon:collection` vérifie :

- l'enqueue d'une relance due-soon ;
- l'absence de doublon lors d'un second passage le même jour ;
- la conservation des événements dans l'ordre du workflow ;
- l'isolation des destinataires fournisseur et marque.
