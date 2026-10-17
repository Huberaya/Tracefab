# Proxy Frontend API Clerk — Production Vercel

## URL et flux

L'instance Clerk Production doit utiliser cette URL de proxy :

```text
https://tracefab.vercel.app/__clerk
```

`vercel.json` fait correspondre `/__clerk/:path*` à la fonction Vercel existante `api/index.ts`, avant la route `/api/*`. Le proxy applicatif relaie les requêtes vers `https://frontend-api.clerk.dev` sans changer leur chemin ni leurs paramètres Clerk. Il transmet les en-têtes utiles et le corps, puis ajoute côté serveur les en-têtes requis par Clerk :

- `Clerk-Proxy-Url: https://tracefab.vercel.app/__clerk` ;
- `Clerk-Secret-Key: <CLERK_SECRET_KEY>` ;
- `X-Forwarded-For: <IP client Vercel>`.

Les en-têtes de saut HTTP sont retirés et les cookies/réponses Clerk sont retransmis. Les réponses du proxy ne sont pas mises en cache. Seule une clé secrète `sk_live_` permet d'activer cette route. La clé secrète n'est jamais incluse dans `/api/config`, le HTML ou le JavaScript du navigateur.

Les pages d'authentification lisent le `proxyUrl` public renvoyé par `/api/config` et l'appliquent à ClerkJS. Le proxy est annoncé uniquement avec une publishable key `pk_live_` et une secret key `sk_live_`. Les instances de développement `pk_test_` restent en connexion directe, puisque Clerk ne prend pas en charge le proxy FAPI pour les instances de développement.

## Configuration de production

1. Dans **Vercel → Project → Settings → Environment Variables**, vérifier que les variables Production sont celles de l'instance Clerk Production :
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` commence par `pk_live_` ;
   - `CLERK_SECRET_KEY` commence par `sk_live_` et reste une variable serveur ;
   - `TRACEFAB_AUTHORIZED_PARTIES` contient `https://tracefab.vercel.app`.
2. Déployer le code et vérifier d'abord que `https://tracefab.vercel.app/__clerk/...` atteint bien la fonction proxy.
3. Dans le **Clerk Dashboard**, sélectionner l'instance **Production**, ouvrir **Domains → Frontend API → Set proxy configuration** et renseigner exactement :

   ```text
   https://tracefab.vercel.app/__clerk
   ```

   Clerk recommande de vérifier le proxy avant de l'activer pour éviter une interruption d'authentification.
4. Exécuter le smoke test réel après le déploiement :

   ```bash
   TRACEFAB_CLERK_SMOKE_URL=https://tracefab.vercel.app npm run smoke:clerk-production
   ```

Le smoke test ne demande ni ne lit la secret key : il vérifie la configuration publique, le chargement du SDK Clerk dans un navigateur et une requête réelle sur le chemin `/__clerk/`.

## Contrôles locaux et CI

```bash
npm run test:clerk-proxy
npm run test:brand-console:browser
```

Ces tests vérifient le routage Vercel, le contrat public de `/api/config`, l'injection serveur du secret, le transfert IP/corps/cookies, la CSP, le démarrage Clerk du navigateur et l'absence de bascule automatique de la Brand Console en mode démo. Le mode démo reste accessible uniquement par choix explicite (`?demo=1`).
