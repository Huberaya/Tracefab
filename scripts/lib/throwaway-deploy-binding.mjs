/**
 * Contrat de liaison : `npm run db:deploy:throwaway` n'est protege que si
 * le corps du script npm est EXACTEMENT le wrapper garde.
 *
 * POURQUOI CE CONTRAT EXISTE
 *
 * K (politique des workflows) autorisait le NOM `db:deploy:throwaway` sans
 * lire le corps dans package.json. Un remplacement du corps par
 * `prisma migrate deploy` laissait K et le test sentinelle verts, alors que
 * la CI execute le script npm. La revue T1.4 a nomme cet ecart.
 *
 * CE QUE CE MODULE VERIFIE
 *
 * Une egalite de chaine, apres trim, avec le corps attendu. Rien d'autre.
 *
 * LIMITES ASSUMEES (volontaires, pas un parseur npm)
 *
 *   — `node ./scripts/db-deploy-throwaway.mjs` est refuse (pas le contrat) ;
 *   — un prefixe d'environnement dans le corps est refuse ;
 *   — des arguments supplementaires (`--schema`, `--url`) sont refuses ;
 *   — `npx`, `npm exec`, `yarn`, `pnpm` sont refuses ;
 *   — le contenu du fichier wrapper n'est pas hache ici : les tests
 *     sentinelle eprouvent son comportement.
 *
 * INVARIANT L (politique des workflows)
 *
 * Si un job `run:` appelle `db:deploy:throwaway` (ou le fichier wrapper),
 * la cle npm DOIT exister et son corps DOIT etre exactement ce contrat.
 * Une cle absente, renommee ou redirigee est un echec, pas un vert.
 */
export const THROWAWAY_NPM_SCRIPT = 'db:deploy:throwaway';
export const THROWAWAY_WRAPPER_REL = 'scripts/db-deploy-throwaway.mjs';
export const THROWAWAY_NPM_BODY = 'node scripts/db-deploy-throwaway.mjs';

export function throwawayNpmBodyIsWrapper(body) {
  return String(body ?? '').trim() === THROWAWAY_NPM_BODY;
}
