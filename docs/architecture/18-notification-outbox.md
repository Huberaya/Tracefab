# 18. Notification Outbox — Chantier 15

## Objectif

Les notifications de collecte ne doivent pas dépendre de la disponibilité immédiate de Resend. Le Chantier 15 ajoute une file durable Neon, transactionnelle avec les transitions métier.

```text
workflow SQL
  → trigger de transition
  → tracefab_notification_outbox (pending)
  → worker privé
  → Resend
  → sent / pending avec retry / failed
```

La file ne conserve ni token d'invitation, ni secret fournisseur, ni valeur brute d'une réponse. Elle conserve uniquement les métadonnées nécessaires à l'envoi et une copie des adresses destinataires au moment de l'événement.

## Événements

- `request_sent` : marque vers membres actifs du fournisseur ;
- `request_submitted` : fournisseur vers membres actifs de la marque ;
- `response_verified` : marque vers membres actifs du fournisseur ;
- `changes_requested` : marque vers membres actifs du fournisseur.

Une clé métier unique empêche les doublons lorsque l'API ou le worker est rejoué. Une nouvelle soumission après `changes_requested` reçoit une nouvelle clé basée sur la nouvelle date de soumission.

## Worker privé

```text
POST /api/internal/notification-outbox/process?limit=10
x-tracefab-worker-secret: <secret serveur>
```

La route ne dépend pas de Clerk : elle exige `TRACEFAB_NOTIFICATION_WORKER_SECRET` et est destinée à un cron ou un worker de confiance. Le claim SQL utilise `FOR UPDATE SKIP LOCKED`, marque les jobs `processing` et récupère les jobs bloqués depuis plus de quinze minutes.

- succès Resend : `sent` ;
- configuration absente : retour en `pending` avec nouvelle date ;
- panne fournisseur : retry exponentiel jusqu'à cinq tentatives ;
- échec définitif : `failed` sans exposer le détail Resend au client.

Le worker renvoie uniquement un résumé de compteurs et ne journalise aucune adresse email.

## Migration et isolation

La migration `20260923190000_tracefab_notification_outbox` crée les enums, la table, les fonctions de claim/complete et les triggers de transitions. La table est protégée par RLS sans accès direct public ; les fonctions SQL `SECURITY DEFINER` constituent la frontière contrôlée.

Le runtime API conserve le filtrage multi-tenant du Chantier 13. Les lectures de memberships sont effectuées dans les fonctions de confiance pour constituer l'audience de l'événement, puis le worker ne fait qu'exécuter la livraison déjà autorisée.

## Tests

```bash
npm run test:neon:collection
```

Le test Neon vérifie la création des trois événements du parcours, l'idempotence implicite, le claim `SKIP LOCKED`, l'incrément de tentative et le retour à `pending` pour un retry.
