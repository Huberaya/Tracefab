# Génération du client Prisma — procédure reproductible (chantier 2C.34)

## Dépendance externe

`prisma generate` (CLI 6.19.3) vérifie la version du moteur au démarrage et
télécharge, si nécessaire, le binaire `schema-engine` depuis :

```
https://binaries.prisma.sh/all_commits/<commit>/debian-openssl-3.0.x/schema-engine.gz.sha256
```

Hôte requis : `binaries.prisma.sh` (HTTPS/443).

Sans accès à cet hôte, la génération est **impossible** : ce n'est pas un bug
du dépôt, c'est une dépendance externe. Le script `scripts/prisma-generate.mjs`
détecte ce cas et sort avec le code 2 sans simuler de succès.

## Vérifier la disponibilité

```bash
npm run prisma:check-network
```

Sortie attendue en environnement avec réseau : `host=binaries.prisma.sh status=200 reachable=true`.

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
npm run db:generate:verified   # vérifie le réseau puis génère
```

## Environnement sans réseau (ce sandbox)

1. `npm run prisma:check-network` → `reachable=false` (ECONNRESET).
2. `npm run db:generate` → code de sortie 2, message de blocage.
3. Le client reste le stub factice ; `verify:prisma-client` échoue comme attendu.

Ne pas contourner avec `PRISMA_SKIP_POSTINSTALL_GENERATE=true` en déploiement :
ce contournement est refusé par `prisma-generate.mjs` dans un contexte Vercel.

## Cache local

Définir `PRISMA_ENGINES_CACHE_DIR` vers un dossier déjà rempli pour éviter le
téléchargement. Voir la documentation Prisma sur le cache des moteurs.

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
