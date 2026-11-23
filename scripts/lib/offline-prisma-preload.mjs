/**
 * Précharge un VRAI client Prisma pour les suites qui tournent hors ligne.
 *
 * `npm run db:generate:offline` produit le client officiel avec le moteur
 * WASM de Prisma. Sous Node, ce moteur exige un adaptateur de pilote ; les
 * modules de l'API construisent leur client au chargement, sans adaptateur.
 * Le résultat n'est pas une assertion fausse : c'est une rejection non gérée
 * qui tue le processus APRÈS que le test a fini.
 *
 * Ce module est chargé par `--import` (NODE_OPTIONS) UNIQUEMENT quand
 * `TF_OFFLINE_PRISMA_PRELOAD=1` est posé explicitement. Il utilise le point
 * d'injection officiel de `api/_lib/prisma.ts` (`globalThis.tracefabPrisma`)
 * et le helper du dépôt `scripts/lib/test_prisma_client.mjs`. Aucune doublure
 * de client, aucune modification de gestionnaire, aucune assertion affaiblie :
 * le client injecté est le client Prisma généré, connecté à la cible
 * `DATABASE_URL` par l'adaptateur pg officiel.
 *
 * Sans la variable, ce module ne fait absolument rien — y compris si un
 * environnement de production le chargeait par inadvertance.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ACTIVE = process.env.TF_OFFLINE_PRISMA_PRELOAD === '1';
const ROOT = resolve(new URL('../..', import.meta.url).pathname);

if (ACTIVE && process.env.DATABASE_URL) {
  const { createTestPrisma, injectPrismaSingleton } = await import(
    pathToFileURL(resolve(ROOT, 'scripts/lib/test_prisma_client.mjs')).href
  );
  const client = await createTestPrisma(process.env.DATABASE_URL);
  injectPrismaSingleton(client);
  // Le client reste ouvert pendant toute la suite ; le processus de test se
  // termine sans laisser de connexion pendante. Aucune requête métier n'est
  // émise ici : createTestPrisma ne fait que son SELECT 1 de vérification.
}
