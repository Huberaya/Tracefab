/**
 * Modèle d'accès des routes — le registre unique.
 *
 * POURQUOI CE MODULE EXISTE
 *   Le classement « route publique / authentifiée / worker / webhook » existait
 *   déjà, mais uniquement dans `scripts/test_cross_tenant.mjs`. Le limiteur de
 *   débit, lui, devinait la nature d'une requête à partir de ses EN-TÊTES. Deux
 *   lecteurs pour une même question, et c'est le second qui décidait du budget :
 *
 *       if (carriesCredentials(req)) return 'credentialed';   // 600 / 60 s
 *       if (estUneRouteWallet(path)) return 'wallet';         //  20 / 60 s
 *
 *   L'ordre faisait tout. Un client qui ajoutait `Authorization: x` à un appel
 *   vers une route Wallet obtenait le budget `credentialed`, soit 20 → 600 par
 *   minute : trente fois plus de signatures cryptographiques pour un seul
 *   en-tête. Sur une écriture anonyme (`public-write`, 10 / 300 s), le même
 *   en-tête donnait 600 / 60 s.
 *
 *   La nature d'une route est une propriété de la route, pas de la requête. Ce
 *   module la déclare une fois ; le test d'isolation et le limiteur la lisent
 *   tous les deux.
 *
 * FORMAT
 *   `.mjs` et non `.ts` : ce fichier est importé à la fois par l'API
 *   (TypeScript, `allowJs: true`) et par `scripts/test_cross_tenant.mjs`
 *   (`node` seul, sans tsx). Un `.ts` obligerait le test à passer par tsx.
 */

/**
 * Les cinq modèles d'accès. `needs` liste les gardes que le fichier de route
 * doit contenir ; c'est ce que vérifie test:cross-tenant.
 */
export const ACCESS_MODELS = {
  // Données d'un locataire : la chaîne complète est obligatoire.
  TENANT: { needs: ['requireClerkUser', 'withTracefabUserContext'] },
  // Surface publique assumée : passeport consommateur, wallets, santé, config.
  PUBLIC: { needs: [] },
  // Tâches de fond déclenchées par un worker : secret partagé obligatoire.
  WORKER: { needs: ['workerAuthorized', 'cronAuthorized'] },
  // Webhook externe : la signature de l'émetteur fait foi.
  WEBHOOK: { needs: ['verifyClerkWebhook', 'Webhook', 'svix'] },
  // Référentiel sans donnée de locataire : facteurs PEF, catalogues, règles.
  REFERENCE: { needs: [] },
};

/**
 * Classement explicite des routes non-TENANT. Tout le reste est TENANT.
 * Chaque entrée porte sa justification : une exemption sans raison écrite est
 * une faille qui attend son heure.
 */
export const CLASSIFIED = {
  'webhooks/clerk': ['WEBHOOK', 'Signature Clerk ; cree les comptes, ne lit aucun locataire.'],
  'passport/[tokenOrSlug]': ['PUBLIC', 'Passeport partage par jeton opaque ; le jeton est le controle d acces.'],
  'passport/[tokenOrSlug]/request-access': ['PUBLIC', 'Demande d acces depuis un passeport partage, avant toute authentification.'],
  'pef/factors': ['REFERENCE', 'Facteurs d impact PEF, identiques pour tous.'],
  'dpp/[gtin]': ['PUBLIC', 'Passeport numerique public : c est sa raison d etre.'],
  'dpp/[gtin]/google-wallet': ['PUBLIC', 'Carte wallet derivee du passeport public.'],
  'dpp/[gtin]/apple-wallet': ['PUBLIC', 'Carte wallet derivee du passeport public.'],
  'products/[productId]/wallet/apple': ['PUBLIC', 'Carte wallet adressee par identifiant produit public.'],
  'products/[productId]/wallet/google': ['PUBLIC', 'Carte wallet adressee par identifiant produit public.'],
  'health': ['PUBLIC', 'Sonde de disponibilite, aucune donnee metier.'],
  'config': ['PUBLIC', 'Configuration client publique (cles publiables).'],
  'catalog/schemas': ['REFERENCE', 'Schemas de donnees du produit, communs a tous les locataires.'],
  'catalog/questionnaires': ['REFERENCE', 'Modeles de questionnaires standards.'],
  'catalog/certification-standards': ['REFERENCE', 'Referentiel de certifications (GOTS, OEKO-TEX...).'],
  'green-claims/rules': ['REFERENCE', 'Regles reglementaires d allegations environnementales.'],
  'gs1/digital-link/[gtin]': ['PUBLIC', 'Resolution GS1 Digital Link, norme publique.'],
  'questionnaires': ['REFERENCE', 'Catalogue de questionnaires, sans requete locataire.'],
  'questionnaires/[questionnaireKey]': ['REFERENCE', 'Detail d un questionnaire de catalogue.'],
  'internal/notification-outbox/health': ['WORKER', 'Sonde de la file de notifications.'],
  'internal/notification-outbox/process': ['WORKER', 'Vide la file ; declenche par cron.'],
  'internal/notification-outbox/reminders': ['WORKER', 'Programme les relances ; declenche par cron.'],
  'internal/notification-outbox/schedule': ['WORKER', 'Planifie la file ; declenche par cron.'],
  'internal/p2/readiness': ['WORKER', 'Diagnostic d infrastructure reserve a l exploitation.'],
};

/* Chemins compilés une fois : `[param]` devient un segment quelconque. */
const COMPILED = Object.entries(CLASSIFIED).map(([key, [model]]) => ({
  key,
  model,
  re: new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\[[^\\\]]+\\\]/g, '[^/]+')}$`),
}));

/**
 * Modèle d'accès d'un chemin de requête réel.
 *
 * Le classement le plus spécifique l'emporte : `dpp/[gtin]/apple-wallet` doit
 * gagner sur `dpp/[gtin]`, sinon une carte Wallet hériterait du budget d'une
 * lecture publique. À spécificité égale, le plus long gagne — un tri
 * déterministe, pas l'ordre d'un objet.
 *
 * Une route absente du registre est TENANT : c'est le choix par défaut du test
 * d'isolation, et c'est le seul sûr. Une route nouvelle non classée obtient
 * donc le budget le plus contraint, pas le plus large.
 *
 * @param {string} path chemin sans `/api/` ni query string
 * @returns {'TENANT'|'PUBLIC'|'WORKER'|'WEBHOOK'|'REFERENCE'}
 */
export function accessModelFor(path) {
  const clean = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '');
  let best = null;
  for (const entry of COMPILED) {
    if (!entry.re.test(clean)) continue;
    if (!best || entry.key.length > best.key.length) best = entry;
  }
  return best ? best.model : 'TENANT';
}
