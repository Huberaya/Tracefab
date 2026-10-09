# Contrat de variables d'environnement

Source de vérité unique pour la configuration de TRACEFAB en production.

`scripts/test_production_readiness.mjs` compare ce document au code : **toute
variable lue par `api/` et absente de ce tableau fait échouer la CI.** Une
variable oubliée ici est une panne de mise en production qui attend son tour.

Colonne **Criticité** :

- **bloquante** — sans elle, l'application ne sert pas, ou sert faux.
- **fonctionnelle** — une fonctionnalité entière est indisponible.
- **réglage** — valeur par défaut raisonnable, à ajuster si besoin.
- **plateforme** — fournie par Vercel, à ne pas définir à la main.

---

## Socle

| Variable | Criticité | Rôle | Conséquence si absente |
|---|---|---|---|
| `DATABASE_URL` | bloquante | Connexion Neon, pooler inclus | Aucune route de données ne répond |
| `CLERK_SECRET_KEY` | bloquante | Vérification serveur des sessions | Toute route authentifiée renvoie 401 |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | bloquante | Clé publique côté navigateur | Impossible de se connecter |
| `TRACEFAB_APP_URL` | bloquante | URL canonique, utilisée dans les e-mails et les liens de passeport | Liens d'invitation cassés |
| `CLERK_WEBHOOK_SIGNING_SECRET` | bloquante | Signature du webhook Clerk | Les comptes ne se créent plus |
| `TRACEFAB_AUTHORIZED_PARTIES` | bloquante | Origines autorisées pour les jetons Clerk | Jetons d'une autre origine acceptés |

## Stockage privé — documents, preuves, certificats

| Variable | Criticité | Rôle | Conséquence si absente |
|---|---|---|---|
| `PRIVATE_STORAGE_ENDPOINT` | fonctionnelle | Hôte S3 compatible | Aucun dépôt ni téléchargement de document |
| `PRIVATE_STORAGE_BUCKET` | fonctionnelle | Nom du bucket | Idem |
| `PRIVATE_STORAGE_REGION` | fonctionnelle | Région, entre dans la signature SigV4 | Signature refusée |
| `PRIVATE_STORAGE_ACCESS_KEY_ID` | fonctionnelle | Identifiant d'accès | Signature refusée |
| `PRIVATE_STORAGE_SECRET_ACCESS_KEY` | fonctionnelle | Clé secrète | Signature refusée |
| `PRIVATE_STORAGE_ANTIVIRUS_URL` | fonctionnelle | Analyseur antivirus des pièces jointes | **Les dépôts sont refusés** : aucun fichier n'entre sans analyse |
| `PRIVATE_STORAGE_ANTIVIRUS_TOKEN` | fonctionnelle | Jeton de l'analyseur | Idem |
| `PRIVATE_STORAGE_PRESIGN_SECONDS` | réglage | Durée de vie des URL signées, 60 à 3 600 s | Défaut appliqué |
| `ORGANIZATION_STORAGE_QUOTA_BYTES` | réglage | Quota de stockage par organisation | Défaut appliqué |

## Courrier électronique

| Variable | Criticité | Rôle | Conséquence si absente |
|---|---|---|---|
| `RESEND_API_KEY` | fonctionnelle | Envoi via Resend | Aucune invitation ni relance n'est envoyée |
| `EMAIL_FROM` | fonctionnelle | Expéditeur, domaine devant être vérifié chez Resend | Envois rejetés |
| `TRACEFAB_ALLOW_MANUAL_INVITATION_FALLBACK` | réglage | Autorise le repli manuel en production | Repli interdit hors développement |

## Tâches de fond et supervision

| Variable | Criticité | Rôle | Conséquence si absente |
|---|---|---|---|
| `TRACEFAB_NOTIFICATION_WORKER_SECRET` | bloquante | Secret partagé des routes `internal/` | Les routes internes renvoient 503 |
| `CRON_SECRET` | bloquante | Secret des déclenchements planifiés Vercel | La file de notifications ne se vide plus |
| `TRACEFAB_NOTIFICATION_ALERT_URL` | fonctionnelle | Collecteur d'alertes de notification | Les échecs d'envoi passent inaperçus |
| `TRACEFAB_NOTIFICATION_ALERT_TOKEN` | fonctionnelle | Jeton du collecteur | Alertes refusées |
| `TRACEFAB_NOTIFICATION_ALERT_TIMEOUT_MS` | réglage | Délai d'attente, 1 000 à 15 000 ms | 5 000 ms |
| `TRACEFAB_NOTIFICATION_BATCH_LIMIT` | réglage | Nombre de notifications traitées par passage, 1 à 50 | 10 |
| `TRACEFAB_REMINDER_HORIZON_HOURS` | réglage | Horizon de programmation des relances, 1 à 720 h | 72 h |

## Suivi d'erreurs

| Variable | Criticité | Rôle | Conséquence si absente |
|---|---|---|---|
| `TRACEFAB_ERROR_WEBHOOK_URL` | fonctionnelle | Collecteur d'erreurs applicatives | Les erreurs restent dans le journal `stderr` de Vercel, sans alerte |
| `TRACEFAB_ERROR_WEBHOOK_TOKEN` | fonctionnelle | Jeton du collecteur | Remontées refusées |
| `TRACEFAB_ERROR_WEBHOOK_TIMEOUT_MS` | réglage | Délai d'attente, 500 à 10 000 ms | 3 000 ms |
| `TRACEFAB_READINESS_PROBE_TIMEOUT_MS` | réglage | Délai des sondes de disponibilité, 1 000 à 15 000 ms | 4 000 ms |

## Cartes de portefeuille numérique

| Variable | Criticité | Rôle | Conséquence si absente |
|---|---|---|---|
| `APPLE_PASS_CERTIFICATE_PEM` | fonctionnelle | Certificat de signature Apple Wallet | Pas de carte Apple |
| `APPLE_PASS_KEY_PEM` | fonctionnelle | Clé privée associée | Idem |
| `APPLE_PASS_TYPE_IDENTIFIER` | fonctionnelle | Identifiant de type de carte | Idem |
| `APPLE_TEAM_IDENTIFIER` | fonctionnelle | Identifiant d'équipe Apple | Idem |
| `GOOGLE_WALLET_ISSUER_ID` | fonctionnelle | Émetteur Google Wallet | Pas de carte Google |
| `GOOGLE_WALLET_PRIVATE_KEY` | fonctionnelle | Clé de service Google | Idem |

## Intégrations

| Variable | Criticité | Rôle | Conséquence si absente |
|---|---|---|---|
| `TRACEFAB_PLM_ENABLED` | réglage | Active le connecteur PLM/ERP | Connecteur inactif |

## Fournies par la plateforme

| Variable | Criticité | Rôle |
|---|---|---|
| `NODE_ENV` | plateforme | Durcit plusieurs contrôles quand sa valeur est `production` |
| `VERCEL_ENV` | plateforme | Environnement, repris dans chaque remontée d'erreur |
| `VERCEL_GIT_COMMIT_SHA` | plateforme | Version déployée, reprise dans chaque remontée d'erreur |

---

## Vérifier avant d'ouvrir le trafic

```bash
# Configuration seule — rapide, aucun appel externe
curl -s -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
  "$TRACEFAB_APP_URL/api/internal/p2/readiness" | jq

# Sondes réelles — interroge base, stockage, antivirus, Resend, collecteurs
curl -s -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
  "$TRACEFAB_APP_URL/api/internal/p2/readiness?probe=live" | jq
```

Le second appel renvoie `200` seulement si la base, le stockage, l'antivirus,
Resend et le collecteur d'alertes répondent tous. Le collecteur d'erreurs est
rapporté mais ne bloque pas : son absence dégrade l'exploitation sans empêcher
de servir.

> **Une clé présente n'est pas une clé valide.** Le mode par défaut vérifie
> seulement que les variables existent. Seul `?probe=live` prouve que les
> services répondent. C'est celui qu'il faut passer avant d'ouvrir le trafic.
