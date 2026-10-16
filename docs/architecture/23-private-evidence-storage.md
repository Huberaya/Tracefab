# 23. Stockage privé des preuves — contrat 2C.36

## Parcours réellement implémenté

Neon conserve les métadonnées et l'état du document ; le fichier reste dans un bucket S3-compatible privé. Le parcours fournisseur (et le parcours organisation générique) est :

```text
POST /api/supplier/documents/upload-intent
  → authentification Clerk + organisation fournisseur active
  → contrôle du rôle et du quota par organisation
  → tracefab_register_document(...), état uploaded
  → PUT présigné vers une clé générée tenant-scoped
     Content-Type et If-None-Match: * signés
  → réponse PUT du fournisseur S3 au navigateur
  → POST /api/supplier/documents/:documentId/scan ou /api/documents/:documentId/scan
  → contrôle organisation + rôle + statut ; commit court de l'état scanning
  → HEAD puis GET signés côté serveur, puis POST au scanner (hors transaction DB)
  → vérification taille déclarée/réelle, MIME, limite 50 MiB et SHA-256
  → finaliseur SQL dans une nouvelle transaction courte : identité, rôle, taille
  → état available si verdict clean, sinon rejected
```

Les intentions fournisseur utilisent `/api/supplier/documents/upload-intent` et le scan fournisseur ; les intentions de marque utilisent `/api/documents/upload-intent` et `/api/documents/:documentId/scan`. La route générique est nécessaire pour que le téléversement d'une organisation non-fournisseur puisse atteindre le même finaliseur sécurisé.

L'URL PUT est une capacité temporaire et conditionnelle : le fournisseur doit faire respecter `If-None-Match: *` afin qu'une même URL ne puisse pas remplacer un objet déjà créé. Le type de contenu est également signé. Le navigateur doit transmettre exactement les headers retournés par `upload-intent`. La configuration CORS doit autoriser `PUT`, `Content-Type` et `If-None-Match` depuis les seules origines applicatives.

`upload-intent` n'envoie pas les octets au serveur TraceFab et ne prouve donc pas que le bucket est disponible. L'échec du PUT S3 est renvoyé au navigateur ; la ligne reste `uploaded` et aucun téléchargement n'est autorisé. Le PUT direct n'est pas couvert par le journal serveur de l'API.

Les seules routes de suppression observées n'existent pas : le cycle SQL contient une suppression logique, pas une suppression d'objet S3. Aucun lien public permanent n'est émis.

## Autorisations et états

- Le chemin objet est construit par le serveur : `<organizationId>/<uuid>/<filename-sanitized>`.
- L'inscription SQL exige un contexte utilisateur et un rôle actif `owner`, `admin`, `manager` ou `contributor` sur l'organisation propriétaire.
- La RLS permet aux membres actifs du tenant propriétaire de lister ses propres lignes `uploaded` et `rejected` pour reprise et diagnostic ; les lignes `deleted` restent cachées. Les accès partagés inter-tenant restent limités aux documents `available`.
- Le finaliseur SQL répète ces contrôles : un rôle applicatif seul ne peut pas finaliser le document d'un autre tenant. Il n'accepte qu'une taille identique à la taille déclarée et un verdict non nul.
- Le téléchargement générique vérifie `tracefab_can_access_document` dans le contexte utilisateur ; la route fournisseur impose en plus l'organisation fournisseur active. Les deux exigent `available`.
- Avant de signer une URL de téléchargement, l'API vérifie par HEAD que l'objet existe et que taille et MIME correspondent aux métadonnées disponibles. L'URL GET est temporaire.
- Les statuts `uploaded`, `scanning`, `rejected` et `deleted` ne sont pas téléchargeables. Un scanner indisponible, en erreur, mal formé ou expiré ne produit jamais `available` ; l'état `scanning` est conservé pour permettre une nouvelle tentative. Les appels réseau sont faits hors transaction Prisma : seul le claim puis la finalisation SQL utilisent des transactions courtes.
- La synthèse antivirus est dérivée de l'état serveur, pas de `metadata` fournie par l'uploader. Les champs de métadonnées réservés `security_scan`, `scan_passed`, `sha256`, `antivirus` et `isEncryptedAtRest` sont refusés à l'entrée et filtrés à la sérialisation. Le rapport ne nomme pas un moteur non enregistré.
- Le chiffrement au repos du fournisseur n'est pas inspectable par cette API ; le rapport expose `isEncryptedAtRest: null` et `encryptionStatus: not_verified` tant qu'une vérification indépendante n'existe pas.

La contrainte `If-None-Match: *` protège contre la réutilisation d'une URL PUT déjà consommée si, et seulement si, le fournisseur respecte les écritures conditionnelles S3. Ce contrat doit être confirmé avec le fournisseur réel en staging ; un double local ne prouve pas cette compatibilité.

## Scanner et limites

Le scanner reçoit les octets bruts par `POST` avec `Authorization: Bearer …`, `Content-Type`, `X-Tracefab-Filename` assaini et `X-Tracefab-Scan-Protocol: tracefab-v1`. Une réponse HTTP 200 propre doit contenir `{ "clean": true, "mimeType": "application/pdf" }` avec un MIME concordant ; un verdict infecté peut renvoyer `clean:false`. La réponse doit provenir du scanner configuré, et non des métadonnées du document.

Les requêtes S3 et scanner ont des timeouts bornés (`PRIVATE_STORAGE_REQUEST_TIMEOUT_MS`, défaut 8 000 ms ; `PRIVATE_STORAGE_ANTIVIRUS_TIMEOUT_MS`, défaut 15 000 ms). HEAD, GET et POST scanner étant séquentiels, leur budget par défaut cumulé peut atteindre 31 secondes, avant l'authentification et les transactions SQL ; avec les deux réglages poussés à leur maximum, il atteint 180 secondes. Aucun budget global de requête n'est imposé par le code : le runtime serverless doit autoriser une durée supérieure au budget configuré, ou les timeouts doivent être abaissés en conséquence. Ce plafond n'a pas été validé sur un déploiement réel ; un hard timeout laisse le document `scanning`, non téléchargeable et réessayable. Le scanner doit être HTTPS en production. L'URL ne peut pas transporter de credentials, query string ou fragment ; l'authentification passe par le bearer token. Les journaux documentaires exposent uniquement un événement fixe et un code d'erreur sûr, jamais l'exception, l'URL signée, les headers, le token ou le corps.

`GET /api/internal/p2/readiness?probe=live` exerce une vraie sonde HEAD S3 sur la sentinelle privée vide `tracefab-readiness-probe/.keep` et un POST scanner avec un petit PDF synthétique non sensible. La sentinelle doit être provisionnée lors du déploiement ; un 403 ou 404 la rend non-ready. Sans `probe=live`, readiness ne fait qu'une vérification de configuration. Le rapport de tests locaux identifie les serveurs HTTP de test comme des doubles ; il ne prouve pas la disponibilité d'un fournisseur réel.

La limite applicative est de 50 MiB et est vérifiée à l'entrée puis sur l'objet réel avant scan. Un objet absent, trop gros, de taille différente ou de MIME différent ne devient pas disponible ; sa taille S3 réelle est enregistrée lors du rejet pour le quota. Comme le PUT est direct, le bucket peut toutefois recevoir un objet trop gros avant le contrôle : ce plafond n'est pas une borne de coût/volume en amont. Une politique fournisseur équivalente ou une passerelle d'upload limitée est nécessaire pour une telle garantie. Le quota par tenant est contrôlé sous verrou transactionnel afin que deux intentions simultanées ne puissent pas dépasser le plafond. L'agrégat SQL ne renvoie que le total et vérifie le rôle actif ; il inclut les lignes `rejected` et `deleted` même si la RLS masque individuellement les lignes supprimées, car aucune suppression physique S3 n'est confirmée.

## Configuration de déploiement

Variables serveur uniquement :

```text
PRIVATE_STORAGE_ENDPOINT                 # endpoint HTTPS S3-compatible
PRIVATE_STORAGE_BUCKET=tracefab-private  # nom fixé par le code
PRIVATE_STORAGE_REGION
PRIVATE_STORAGE_ACCESS_KEY_ID
PRIVATE_STORAGE_SECRET_ACCESS_KEY
PRIVATE_STORAGE_PRESIGN_SECONDS          # 60 à 3600 s, défaut 600
PRIVATE_STORAGE_REQUEST_TIMEOUT_MS       # optionnel, défaut 8000, max 60000
PRIVATE_STORAGE_ANTIVIRUS_URL            # endpoint POST, sans query string
PRIVATE_STORAGE_ANTIVIRUS_TOKEN          # bearer token, jamais côté navigateur
PRIVATE_STORAGE_ANTIVIRUS_TIMEOUT_MS     # optionnel, défaut 15000, max 60000
ORGANIZATION_STORAGE_QUOTA_BYTES         # optionnel, défaut 1 GiB
```

Prérequis à confirmer auprès du fournisseur et sur un environnement de staging :

1. bucket privé, blocage de l'accès public, accès anonyme refusé ;
2. clé serveur limitée au bucket/prefix TraceFab et aux opérations PUT, GET et HEAD requises ; aucun droit de listing ou d'administration n'est demandé ; créer et autoriser en lecture HEAD la sentinelle vide `tracefab-readiness-probe/.keep` ;
3. PUT conditionnel `If-None-Match: *` réellement appliqué et seconde écriture refusée ; CORS limité aux origines autorisées et aux headers ci-dessus ;
4. scanner externe opérationnel, bearer séparé, POST conforme, réponse MIME fiable, timeout et panne testés ;
5. chiffrement au repos configuré et contrôlé directement auprès du fournisseur si requis par la politique ; l'API ne le prétend pas ;
6. stratégie de conservation, rétention, purge et réponse aux incidents décidée avant les données réelles ;
7. pour appliquer cette migration, le rôle de migration doit porter `BYPASSRLS` ou être superutilisateur : la fonction d'agrégat de quota exécute avec `row_security=off` et la migration échoue explicitement sans ce privilège. Le rôle runtime `tracefab_app` reste sans `BYPASSRLS` et reçoit uniquement l'EXECUTE direct sur cette fonction ; aucune exécution n'est accordée à `PUBLIC`.

## Conservation et nettoyage — limites actuelles

Aucune durée de rétention ni politique lifecycle S3 n'est configurée par le code. Les fichiers infectés passent à `rejected` mais restent dans le bucket. Un échec ou timeout de scan laisse la ligne en `scanning` ; l'endpoint autorisé accepte une nouvelle requête POST pour la reprendre, mais aucun worker ni bouton de reprise automatique n'est implémenté. La suppression SQL est logique : sans route ni appel `DeleteObject`, un document `deleted` peut toujours occuper de l'espace. Les lignes `rejected` et `deleted` restent donc comptées dans le quota, mais aucun mécanisme ne garantit que le quota reflète le coût exact du fournisseur en présence d'objets orphelins.

Avant commercialisation, il faut décider et automatiser la purge des objets refusés, orphelins et supprimés, avec rapprochement DB/S3, audit et garde de rétention légale. Une règle lifecycle configurée directement chez un fournisseur peut supprimer des objets encore référencés si elle est trop large ; aucune règle de ce type ne doit être activée sans rapprochement et test staging.

## Tests et portée de la preuve

```bash
npm run test:private-storage
npm run test:storage:chantier10
npm run test:p2:readiness
npm run test:neon:privileges
npm run test:neon:cross-tenant
npm run test:neon:document-storage
npm run typecheck
npm run api:typecheck
npm run schema:static
```

Les tests `test:private-storage` utilisent des doubles HTTP locaux qui vérifient le vrai code SigV4 d'application, la condition PUT, HEAD/GET, POST scanner, le fail-closed, les timeouts, le MIME, les limites et la rédaction des logs. Les tests SQL exigent la garde de cible Postgres jetable. Le test heuristique Chantier 10 ne simule ni ClamAV ni un scanner et ne constitue pas une décision de sécurité. Aucun de ces tests ne valide un fournisseur S3 ou antivirus réel ; un smoke test staging contrôlé reste nécessaire.
