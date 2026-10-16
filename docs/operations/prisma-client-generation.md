# Génération du client Prisma — procédure reproductible (chantier 2C.34)

## Dépendance externe

`prisma generate` (CLI 6.19.3) vérifie la version du moteur au démarrage et
télécharge, si nécessaire, le binaire `schema-engine` depuis :

```
https://binaries.prisma.sh/all_commits/<commit>/debian-openssl-3.0.x/schema-engine.gz.sha256
```

Hôte requis : `binaries.prisma.sh` (HTTPS/443).

Sans réponse HTTP exploitable à cet hôte, le wrapper `scripts/prisma-generate.mjs`
bloque avant la génération (code 2) : c'est une dépendance externe. Il ne
simule jamais un succès. Le CLI Prisma peut utiliser un cache local, mais le
précontrôle actuel ne l'inspecte pas et reste bloquant hors réseau ; le chemin
reproductible supporté est donc un environnement autorisé vers cet hôte.

## Vérifier la disponibilité

```bash
npm run prisma:check-network
```

Sortie attendue en environnement avec réseau : `host=binaries.prisma.sh status=200 reachable=true`. La sonde suit les redirections HTTPS, accepte une réponse finale 2xx, et refuse les réponses HTTP 4xx/5xx, les refus réseau et les timeouts. Cette vérification de disponibilité n'est pas une preuve de génération.

## Générer le client

Environnement avec réseau (CI GitHub Actions, Vercel, poste développeur) :

```bash
npm run db:generate            # prisma generate (postinstall)
npm run verify:prisma-client    # contrôle du client généré
npm run test:router-load       # chargement des 125 routes
npm run api:typecheck          # types de l'API
```

Ou en une commande :

```bash
npm run db:generate:verified   # précontrôle réseau, génère, puis vérifie le vrai client
```

## Environnement sans réseau (ce sandbox)

1. `npm run prisma:check-network` → code 1, `reachable=false` (ECONNRESET).
2. `npm ci` (postinstall) → le précontrôle bloque avec code 2 ; `npm run db:generate` (appel direct du CLI) → code 1 si le téléchargement échoue.
3. Le client reste le stub factice ; `npm run verify:prisma-client` échoue comme attendu.
4. `npm run test:prisma-network` valide sans accès réseau les cas HTTP 2xx, redirection HTTPS, 4xx/5xx, refus et timeout ; cela ne simule ni ne valide la génération.

Ne pas contourner avec `PRISMA_SKIP_POSTINSTALL_GENERATE=true` en déploiement :
ce contournement est refusé par `prisma-generate.mjs` dans un contexte Vercel.

## Limite du cache local

Le précontrôle réseau ne vérifie pas la présence de `schema-engine` dans un
cache `PRISMA_ENGINES_CACHE_DIR` : en l'absence de réseau, le wrapper bloque
quand même avant `prisma generate`. Un cache local n'est donc pas un contournement
supporté par cette procédure à ce stade.

## Tests avec stub

Les tests `test:prisma-client` vérifient le comportement du contournement
(`PRISMA_SKIP_POSTINSTALL_GENERATE`). Ils continuent de fonctionner et ne
doivent pas être supprimés : ils couvrent le cas « client factice ».

## Preuves du blocage (chantier 2C.34)

- `npm run prisma:check-network` → `host=binaries.prisma.sh reachable=false error=ECONNRESET` (code 1).
- `npm run db:generate` → code de sortie 2, message de blocage réseau.
- `npm run verify:prisma-client` → échec (client = stub factice).
- `npm run test:router-load` → échec (118 routes DB).
- `npm run api:typecheck` → échec (propriétés manquantes sur le client stub).

Ces échecs sont attendus et ne sont pas des régressions du dépôt.
