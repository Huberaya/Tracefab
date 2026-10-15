/**
 * Remontee d'erreurs : ce que le journal doit permettre d'interroger.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Le 2026-10-09, la production a repondu `internal_error` avec un identifiant
 * de correlation. L'identifiant etait rendu au client, mais rien ne
 * permettait de savoir, dans le journal, si la panne venait d'un module de
 * route qui ne se charge pas ou d'un gestionnaire qui jette : les deux
 * produisent le meme 500, et les causes n'ont rien a voir.
 *
 * Ce test verrouille trois proprietes du canal de journalisation :
 *   1. l'etape de la panne est nommee (`module_load` / `handler`) ;
 *   2. le nom du module absent est extrait — c'est lui qui distingue un paquet
 *      deploye incomplet d'une erreur metier ;
 *   3. rien de sensible ne sort : ni chaine de connexion, ni jeton.
 *
 * Le canal est eprouve pour de vrai : `reportError` est appele, et c'est la
 * ligne reellement ecrite qui est relue.
 */
import { strict as assert } from 'node:assert';

process.env.TRACEFAB_ERROR_WEBHOOK_URL = '';

const { redact, reportError } = await import('../api/_lib/error-reporting.js');

let echecs = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const ko = (m: string) => { echecs += 1; console.log(`  ECHEC ${m}`); };

/** Capture la ligne ecrite par reportError, sans la laisser partir ailleurs. */
async function ligneJournalisee(): Promise<Record<string, any>> {
  const lignes: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lignes.push(args.map(String).join(' ')); };
  try {
    return { lignes };
  } finally {
    console.error = original;
  }
}

const lignes: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => { lignes.push(args.map(String).join(' ')); };
try {
  const manquant = Object.assign(new Error("Cannot find module '.prisma/client/default'"), {
    code: 'MODULE_NOT_FOUND',
  });
  await reportError(manquant, {
    route: '^/api/catalog/schemas$',
    method: 'GET',
    path: '/api/catalog/schemas',
    status: 500,
    phase: 'module_load',
  }, 'correlation-de-test');

  const fuite = new Error(
    'connexion refusee : postgresql://tracefab_app:motdepasse@ep-xxx.eu-central-1.aws.neon.tech/neondb quand Bearer sk_live_abcdef1234567890',
  );
  await reportError(fuite, { route: '^/api/health$', method: 'GET', path: '/api/health', phase: 'handler' }, 'correlation-deux');
} finally {
  console.error = originalError;
}

assert.equal(lignes.length, 2, `deux lignes attendues, ${lignes.length} ecrites`);

const premiere = JSON.parse(lignes[0]);
premiere.correlationId === 'correlation-de-test'
  ? ok('la ligne porte l identifiant de correlation rendu au client')
  : ko(`identifiant de correlation absent ou different : ${premiere.correlationId}`);
premiere.context?.phase === 'module_load'
  ? ok('l etape est nommee : module_load')
  : ko(`etape non nommee : ${JSON.stringify(premiere.context?.phase)}`);
premiere.error?.moduleSpecifier === '.prisma/client/default'
  ? ok('le module absent est nomme : .prisma/client/default')
  : ko(`module absent non extrait : ${JSON.stringify(premiere.error?.moduleSpecifier)}`);
premiere.error?.code === 'MODULE_NOT_FOUND'
  ? ok('le code d erreur est conserve (MODULE_NOT_FOUND)')
  : ko(`code d erreur absent : ${JSON.stringify(premiere.error?.code)}`);
typeof premiere.release !== 'undefined' && 'environment' in premiere
  ? ok('la ligne porte l environnement et la reference deployee')
  : ko('environnement ou reference deployee absents');

const seconde = JSON.parse(lignes[1]);
seconde.context?.phase === 'handler'
  ? ok('une erreur de gestionnaire est marquee handler')
  : ko(`etape du gestionnaire: ${JSON.stringify(seconde.context?.phase)}`);
const brut = lignes[1];
!brut.includes('motdepasse') && !brut.includes('sk_live_abcdef1234567890')
  ? ok('aucune chaine de connexion, aucun jeton dans la ligne ecrite')
  : ko('une valeur sensible figure dans la ligne ecrite');
!brut.includes('neon.tech')
  ? ok('aucun hote de base dans la ligne ecrite')
  : ko('un hote de base figure dans la ligne ecrite');

// Le caviardage ne doit pas abimer un message anodin : un journal qui
// remplace tout par « [caviarde] » ne sert plus a rien.
const anodin = 'timeout apres 3000 ms sur /api/catalog/schemas (3 tentatives)';
redact(anodin) === anodin
  ? ok('un message sans secret n est pas altere')
  : ko(`message anodin altere : ${redact(anodin)}`);
redact('postgresql://u:p@h/db').includes('u:p')
  ? ko('une chaine de connexion survit au caviardage')
  : ok('une chaine de connexion est caviardee');

lignes.every((l) => !l.includes('\n'))
  ? ok('une erreur = une ligne : le journal reste exploitable par un collecteur')
  : ko('une ligne de journal contient un saut de ligne');

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Remontee d erreurs : OK.' : `Remontee d erreurs : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
