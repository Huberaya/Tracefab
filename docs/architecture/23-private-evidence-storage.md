# 23. Stockage privé des preuves — Chantier 20

## Périmètre livré

Le repository ajoute un adaptateur serveur S3-compatible pour les preuves privées. Neon conserve uniquement la métadonnée et le cycle de vie du document ; l'objet est stocké dans un bucket privé externe.

Le cycle livré est :

```text
POST /api/supplier/documents/upload-intent
  → tracefab_register_document(...)
  → URL PUT présignée courte
  → upload direct navigateur vers l'objet privé
  → POST /api/supplier/documents/:documentId/scan
  → HEAD + taille + type + téléchargement serveur
  → hash SHA-256 serveur
  → scanner antivirus
  → tracefab_finalize_document_upload(...)
  → available ou rejected
```

Les endpoints fournisseur livrés sont :

```text
GET  /api/supplier/documents
POST /api/supplier/documents/upload-intent
POST /api/supplier/documents/:documentId/scan
GET  /api/supplier/documents/:documentId/download
GET  /api/documents/:documentId/download
```

Le téléchargement retourne une URL présignée temporaire uniquement après un contrôle d'accès et lorsque le document est `available`. Les documents `uploaded`, `scanning`, `rejected` et `deleted` ne sont pas téléchargeables.

## Contrôles de sécurité

- bucket fixe `tracefab-private` et visibilité privée côté fonction SQL ;
- chemin généré serveur : `<organizationId>/<uuid>/<filename-sanitized>` ;
- aucun chemin fourni par le navigateur n'est utilisé ;
- limite de taille à 50 MiB avec S3 ; l'adaptateur Preview ci-dessous est limité à 1 MiB ;
- liste MIME initiale limitée à PDF, PNG, JPEG et texte brut ;
- le hash est calculé côté serveur après lecture de l'objet ;
- la taille et le type annoncés sont comparés à l'objet ;
- le navigateur ne peut pas déclarer `scanPassed`, `available` ou `sha256` ;
- les champs gérés par SQL restent protégés par le trigger de document ;
- les URLs PUT/GET expirent après une fenêtre courte et ne sont jamais persistées ;
- l'accès marque éventuel passe par `/api/documents/:documentId/download` et les policies Neon/RLS ;
- un scanner absent ou une réponse antivirus invalide bloque la disponibilité du document.

Le scanner antivirus est volontairement un contrat explicite et non un faux contrôle local. `PRIVATE_STORAGE_ANTIVIRUS_URL` reçoit les octets bruts avec `X-Tracefab-Scan-Protocol: tracefab-v1` et doit répondre par `{ "clean": true|false, "mimeType": "..." }`. Hors fixture locale, HTTPS et le jeton Bearer `PRIVATE_STORAGE_ANTIVIRUS_TOKEN` sont obligatoires ; les redirections sont refusées et le délai est borné. Sans ce service, l'objet reste enregistré mais ne peut pas devenir `available`. Le rapport de sécurité ne transforme pas la metadata client, l'état du document ou une heuristique en attestation de moteur ou de chiffrement.

## Intégrations Supplier Portal

Le portail affiche les documents privés, permet leur téléversement et propose un téléchargement temporaire. Les documents disponibles peuvent être associés :

- à un certificat fournisseur ;
- à une réponse de collecte qui demande une preuve.

La présence d'un document fait passer une donnée à l'état documenté selon la fonction métier, mais ne constitue jamais une vérification ou une certification.

## Configuration requise

```text
PRIVATE_STORAGE_ENDPOINT
PRIVATE_STORAGE_BUCKET=tracefab-private
PRIVATE_STORAGE_REGION
PRIVATE_STORAGE_ACCESS_KEY_ID
PRIVATE_STORAGE_SECRET_ACCESS_KEY
PRIVATE_STORAGE_PRESIGN_SECONDS
PRIVATE_STORAGE_ANTIVIRUS_URL
PRIVATE_STORAGE_ANTIVIRUS_TOKEN
```

Le fournisseur S3-compatible doit désactiver l'accès public au bucket, limiter les permissions de la clé au bucket Tracefab et configurer CORS uniquement pour les origines d'application autorisées avec `PUT` et les headers nécessaires. Les secrets doivent être renouvelés avant staging/production.

## Validation

```bash
npm run build
npm run test:private-storage
npm run test:supplier-portal
npm run test:supplier-portal:browser
npm run api:typecheck
npm run typecheck
npm run schema:static
git diff --check
```

Le test navigateur utilise uniquement le mode démo. Une validation réelle nécessite un bucket privé S3-compatible et un scanner antivirus de staging ; aucune URL d'objet réelle ne doit être ajoutée aux fixtures ou aux logs.

## Limites restantes

- pas de suppression objet interactive dans le portail ; la suppression reste un workflow de confiance à planifier ;
- pas de job asynchrone de reprise pour les documents bloqués en `uploaded` ;
- pas de quarantaines ou d'OCR ;
- le scanner est un contrat HTTP à connecter à une implémentation opérationnelle ;
- rotation, rétention et nettoyage des objets supprimés restent à industrialiser ;
- les permissions IAM/CORS du fournisseur doivent être validées sur staging puis production.

## Adaptateur PostgreSQL réservé à la Preview de test

L'adaptateur `preview-postgres` permet de tester les flux sur **une base de
TEST PostgreSQL déjà isolée**, sans créer de compte de stockage objet. Il est
opt-in, limité à la branche `arena/647ac97c-tracefab`, à `VERCEL_ENV=preview`
et à une clé Clerk `sk_test_`. S3 reste le défaut ; ni l'application ni la CI
ne provisionnent automatiquement cet adaptateur sur une base distante. Il ne
convient ni à la production ni à des documents réels ou personnels.

### Prérequis et décision opérateur

1. Un administrateur vérifie d'abord s'il existe déjà un stockage objet privé
   de **test**, utilisable avec S3 ; les permissions actuelles ne permettent
   pas d'affirmer qu'un tel service existe ou non. S'il n'est pas utilisable,
   une base PostgreSQL de test indépendante sur un service déjà existant peut
   être employée, sans créer un autre compte de stockage.
2. L'administrateur doit vérifier indépendamment que la base, les identités
   Clerk, les deux organisations, le scanner et tous les documents sont
   strictement de test, sans connexion à la production ni données sensibles.
   Le calcul d'empreinte et les drapeaux **ne démontrent pas** cette isolation.
   Si aucune base isolée ni scanner réel de test ne sont disponibles, le
   parcours reste **BLOCKED** jusqu'à leur mise à disposition ou autorisation.
3. La base de test doit déjà disposer des migrations applicatives et du rôle
   `tracefab_app` existant, sans `SUPERUSER` ni `BYPASSRLS`, avec les droits
   applicatifs nécessaires. Le rôle runtime n'est ni propriétaire du nouveau
   schéma, ni membre du rôle propriétaire. Le script ne crée pas de rôle et ne
   modifie aucune table ni politique RLS existante.

### Provisionnement explicite, uniquement sur la base isolée

Depuis un poste sûr, hors Vercel et hors `NODE_ENV=production`, l'opérateur
injecte **sans afficher ni copier dans le terminal** la `DATABASE_URL` du
propriétaire de la base de test. Les variables non secrètes nécessaires sont
`VERCEL_ENV=preview`, `VERCEL_GIT_COMMIT_REF=arena/647ac97c-tracefab` et
`TF_PREVIEW_STORAGE_TEST_ONLY=1`. Vérifier la cible avant toute écriture :

```bash
npx tsx scripts/provision_preview_storage.ts --dry-run
```

La commande ne modifie rien et imprime uniquement un SHA-256 du triplet
hôte/port/base, sans utilisateur ni mot de passe. Après vérification externe,
l'opérateur fournit cette empreinte dans `TF_PREVIEW_STORAGE_DB_FINGERPRINT`
et confirme `TF_PREVIEW_STORAGE_PROVISION_ACK=ISOLATED_TEST_DATABASE_ONLY`.
L'étape suivante est **une écriture** et ne doit être exécutée qu'avec une
approbation explicite sur la base de test :

```bash
npx tsx scripts/provision_preview_storage.ts --provision
```

Elle crée le seul schéma `tracefab_preview_store`, ses politiques RLS forcées
et une table privée. Si le schéma existe déjà, elle refuse de le remplacer ou
de modifier son contenu. Il n'y a pas de migration Prisma pour ce schéma.
Seul `tracefab_app` reçoit `SELECT` et `INSERT`, pas `UPDATE` ou `DELETE` ;
le propriétaire peut purger les objets expirés. Chaque transaction runtime
vérifie que le rôle courant est bien `tracefab_app` sans privilège RLS bypass.
La RLS limite les lectures accidentelles à la clé placée en contexte
transactionnel. Elle **n'est pas une frontière d'isolation forte contre un
rôle SQL arbitraire** capable de fixer lui-même cette clé : la sécurité des
locataires repose aussi sur les contrôles Clerk, les contrôles d'organisation
et les capacités d'objet émises par le serveur.

### Configuration de Preview et fonctionnement

- Limiter les variables au déploiement Preview de **cette branche**, jamais
  à la production : `PRIVATE_STORAGE_BACKEND=preview-postgres`,
  `TF_PREVIEW_STORAGE_TEST_ONLY=1`, `TF_PREVIEW_STORAGE_DB_FINGERPRINT`,
  `CLERK_SECRET_KEY` de l'instance de test, `DATABASE_URL` du rôle runtime
  `tracefab_app` et les variables de scanner ci-dessous. Toute connexion
  PostgreSQL distante doit imposer `sslmode=verify-full`, sans option qui
  désactive ou affaiblit la vérification TLS. La cible utilisée pour calculer
  l'empreinte et la cible runtime doivent avoir le même hôte, port et nom de
  base ; seule l'identité SQL peut différer.
- Le transfert passe par l'origine Preview de la branche et une capacité
  courte, signée et portée dans un en-tête ; aucun secret n'est mis dans l'URL.
  La capacité est liée à l'objet et à la méthode, expire au maximum après
  10 minutes et ne peut pas remplacer un objet déjà inséré. Sa clé est dérivée
  de la clé Clerk de test : la rotation de celle-ci invalide les capacités en
  cours. Le téléchargement est privé et marqué `no-store`.
- Taille maximale **1 MiB par objet**. Les objets ne sont plus accessibles
  après 24 h ; ce délai ne les supprime pas physiquement. L'opérateur doit
  lancer explicitement `--purge-expired` avec les mêmes gardes, depuis le rôle
  propriétaire et uniquement sur la base isolée. Il peut aussi détruire la
  base jetable selon le processus approuvé par son propriétaire.
- `PRIVATE_STORAGE_ANTIVIRUS_URL` et `PRIVATE_STORAGE_ANTIVIRUS_TOKEN` doivent
  désigner un vrai scanner de test fonctionnel, HTTPS et authentifié, parlant
  le contrat `tracefab-v1`. Aucun scanner n'est fourni par cet adaptateur.
  Un scanner absent, injoignable ou renvoyant une réponse invalide bloque la
  publication ; l'échantillon EICAR doit être rejeté. Ne jamais configurer la
  fixture locale ou un scanner simulé comme service de Preview.
- L'adaptateur de test ne prouve ni le chiffrement au repos ni l'identité du
  moteur antivirus. Il ne remplace pas les garanties d'un stockage objet
  privé en production et son schéma exige une maintenance limitée aux tests.

### Exécution des preuves

L'environnement GitHub protégé `tracefab-clerk-test` doit rester soumis à ses
reviewers et à sa politique de branche. L'administrateur y renseigne les
prérequis déjà déclarés dans `.github/workflows/preview-http-journeys.yml` :
origine Preview approuvée, SHA effectivement déployé identique au SHA du code,
attestation de services de test, utilisateurs et organisations de test,
clé Clerk de test et bypass d'automatisation Vercel **approuvé**. Pour cet
adaptateur, `TF_PREVIEW_STORAGE_HOST` est le nom d'hôte de la Preview ; pour
S3 c'est l'hôte du stockage privé de test. Aucun secret ni valeur ne doit être
transmis dans une issue, un log, une preuve ou une conversation.

Après déploiement du SHA exact et approbation du job protégé, exécuter ou
relancer le workflow Preview. Sa preuve JSON expurgée distingue `PASS`, `FAIL`,
`BLOCKED` et `NOT RUN`. Un résultat local n'est jamais une preuve Preview.
La CI peut exécuter le vrai moteur ClamAV local avec **la seule signature
EICAR** sur des données synthétiques : ce contrôle du protocole ne prouve pas
qu'un antivirus géré est disponible ni qu'il protège d'autres menaces.
