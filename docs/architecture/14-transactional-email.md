# 14. Emails transactionnels — invitation fournisseur

## Périmètre du Chantier 11

Le premier email transactionnel de Tracefab est l'invitation fournisseur créée par :

```text
POST /api/organizations/:organizationId/invitations
```

L'API appelle la fonction SQL d'invitation, puis remet le token brut uniquement à l'adaptateur email de confiance. Le token brut n'est jamais envoyé à PostgreSQL, écrit dans un log ou persisté dans une table.

## Adaptateur

L'implémentation actuelle utilise l'API HTTPS Resend :

```text
RESEND_API_KEY
EMAIL_FROM
TRACEFAB_APP_URL
```

Le lien généré est :

```text
TRACEFAB_APP_URL/invitations/accept?token=<token-brut>
```

L'URL est construite côté serveur et le token est échappé dans la version HTML du message. Le corps texte est également envoyé pour les clients sans HTML.

## Modes de livraison

### Configuration complète

Quand les trois variables sont présentes :

- l'email est envoyé à Resend ;
- la réponse API contient le statut `sent` et l'identifiant fournisseur éventuel ;
- le token brut n'est pas renvoyé au client HTTP.

### Configuration absente

Quand Resend ou l'URL d'application n'est pas configuré :

- l'invitation SQL est quand même créée ;
- la réponse contient `delivery.status = not_configured` ;
- le token brut est retourné une seule fois au backend appelant pour une livraison manuelle ;
- le token n'est jamais enregistré par Tracefab.

### Échec du fournisseur

Si Resend refuse la requête ou est indisponible :

- l'API répond `502` ;
- `delivery.status = failed` est retourné ;
- le token brut est retourné au backend de confiance pour permettre une livraison manuelle ;
- le détail de la réponse Resend n'est pas exposé.

L'invitation reste valable sept jours. Une future évolution pourra ajouter une route de renvoi contrôlée ou une file de jobs, sans stocker le token brut.

## Tests

Le contrat de livraison est testé sans appel externe :

```bash
npm run test:email
```

Le test vérifie le fallback manuel, le payload Resend, l'échappement HTML et la conversion sûre d'une panne fournisseur.

## Production

- ne jamais utiliser une clé Resend de test en production ;
- conserver `RESEND_API_KEY` uniquement dans les variables serveur Vercel ;
- configurer un domaine expéditeur vérifié ;
- renouveler les secrets temporaires déjà communiqués ;
- ne pas ajouter le token d'invitation aux traces HTTP, aux logs ou à une télémétrie non maîtrisée.
