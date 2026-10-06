# 27. P2 — Référentiel des certifications et infrastructure staging

## Périmètre

Le P2 couvre le Chantier 9 de la roadmap :

1. référentiel versionné de standards textiles et de management ;
2. readiness explicite des intégrations réelles de staging ;
3. scénario Playwright sans mocks ni mode démo.

Le référentiel est une aide à la saisie et à la collecte de preuves. Il ne transforme jamais une certification déclarée en certification vérifiée.

## Référentiel versionné

La source est `catalog/certification-standards/2026.10.json`. Elle contient les codes, émetteurs, versions de référence, périmètres, types de preuves, champs attendus, URLs officielles et caveats de revendication pour :

- GOTS 7.0 ;
- OEKO-TEX STANDARD 100, édition 01.2026 ;
- GRS 4.0 ;
- RCS 2.0 ;
- OCS 3.0 ;
- ISO 14001:2026 ;
- ISO 9001:2015.

API publique de consultation :

```text
GET /api/catalog/certification-standards
GET /api/catalog/certification-standards?code=GOTS
```

La réponse expose la version du catalogue et un disclaimer explicite. Le catalogue n'est pas une preuve d'émission, de validité, de périmètre ou de certification.

## Readiness des intégrations réelles

Endpoint opérateur protégé :

```text
GET /api/internal/p2/readiness
x-tracefab-worker-secret: <TRACEFAB_NOTIFICATION_WORKER_SECRET>
```

La réponse ne divulgue aucune valeur secrète. Elle indique uniquement si les variables obligatoires sont présentes et si la configuration privée est syntaxiquement valide pour :

- bucket S3-compatible privé et scanner antivirus ;
- Resend et URL applicative ;
- webhook d'alerte et son token.

Le mode `configuration_only` est volontaire : un test de readiness ne doit ni envoyer un email réel, ni déclencher une alerte externe, ni écrire un objet arbitraire dans un bucket. Les probes de bout en bout utilisent ensuite des ressources de staging dédiées.

## Test E2E staging non mocké

Le script `npm run test:p2:staging` refuse de démarrer sans :

```text
TRACEFAB_STAGING_URL=https://...
TRACEFAB_E2E_STORAGE_STATE=/chemin/vers/state.json
TRACEFAB_STAGING_WORKER_SECRET=...
```

Il exige HTTPS, vérifie le readiness réel en HTTP, puis ouvre avec Playwright les surfaces Supplier Portal, Brand Console et Quality Center avec un storage state authentifié. Il n'active jamais `?demo`, n'intercepte aucune requête et n'utilise aucun faux service.

## Variables staging obligatoires

```text
PRIVATE_STORAGE_ENDPOINT
PRIVATE_STORAGE_BUCKET=tracefab-private
PRIVATE_STORAGE_REGION
PRIVATE_STORAGE_ACCESS_KEY_ID
PRIVATE_STORAGE_SECRET_ACCESS_KEY
PRIVATE_STORAGE_ANTIVIRUS_URL
RESEND_API_KEY
EMAIL_FROM
TRACEFAB_APP_URL
TRACEFAB_NOTIFICATION_ALERT_URL
TRACEFAB_NOTIFICATION_ALERT_TOKEN
TRACEFAB_NOTIFICATION_WORKER_SECRET
```

Les credentials sont injectés uniquement dans les variables Vercel/staging. Ils ne doivent pas être écrits dans Git, les fixtures, les logs ou les commits. Les secrets temporaires doivent être renouvelés avant production.

## Validation

```bash
npm run build
npm run test:p2:certification-catalog
npm run test:private-storage
npm run test:notification-observability
npm run test:p2:staging
```

`test:p2:staging` ne peut être marqué comme réussi que contre un staging raccordé aux services réels. Un test en mode démo ou avec des mocks ne constitue pas une preuve P2.
