#!/usr/bin/env node
/**
 * Preuve, HORS LIGNE, que le diagnostic de production se comporte comme annonce.
 *
 * Aucun paquet n'est installe, aucune requete ne part : `fetch` est remplace par
 * scripts/lib/fake-vercel-api.mjs, qui refuse tout ce qui ne vise pas
 * api.vercel.com et toute methode autre que GET.
 *
 * Sept proprietes sont verifiees :
 *   A. sans jeton                -> sortie 2, message explicite, aucun jeton affiche
 *   B. refus de l'API (403)      -> sortie 2, message explicite
 *   C. ligne trouvee             -> sortie 0, ligne affichee, secrets CAVIARDES
 *   D. aucune correspondance     -> sortie 1, et l'absence est presentee comme
 *                                   une absence, pas comme une preuve
 *   E. lecture seule             -> aucune requete non-GET dans le source, et
 *                                   le journal des requetes ne contient que des GET
 *   F. fuite dans un corps d'erreur -> le jeton reste masque
 *   G. aucune requete hors api.vercel.com
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'diagnose_production_incident.mjs');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const FAUSSE_API = join(ROOT, 'scripts', 'lib', 'fake-vercel-api.mjs');

const CORRELATION = 'fd30b689-f50f-44f0-a0dd-43e5e1e51f0e';
const JETON_FACTICE = 'vercel_faux_jeton_de_test_0123456789abcdef';
const CHAINE_FACTICE = 'postgresql://tracefab_app:motdepassefaux@ep-faux.eu-central-1.aws.neon.tech/neondb';

const dossier = mkdtempSync(join(tmpdir(), 'diag-incident-'));

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

const run = (fixture, { jeton = JETON_FACTICE, journal = true } = {}) => {
  const cheminFixture = join(dossier, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cheminFixture, JSON.stringify(fixture));
  const cheminJournal = join(dossier, `journal-${Math.random().toString(36).slice(2)}.json`);
  const env = { ...process.env, TF_FAKE_VERCEL: cheminFixture, TF_FAKE_JOURNAL: journal ? cheminJournal : '' };
  if (jeton === null) delete env.VERCEL_TOKEN; else env.VERCEL_TOKEN = jeton;
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(FAUSSE_API).href, SCRIPT], {
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  return {
    code: r.status,
    sortie: `${r.stdout || ''}${r.stderr || ''}`,
    journal: existsSync(cheminJournal) ? JSON.parse(readFileSync(cheminJournal, 'utf8')) : [],
  };
};

const METADONNEES = {
  id: 'dpl_FAUX6968252029',
  readyState: 'READY',
  target: 'production',
  createdAt: Date.UTC(2026, 9, 9, 12, 0, 0),
  url: 'tracefab-faux-6968252029.vercel.app',
  meta: { githubCommitSha: 'b0c976f1307aacbcbf4e4eec06dd8d97ef06008e' },
};
const ROUTE_META = '/v6/deployments/6968252029';
const ROUTE_EVENTS = '/v3/deployments/6968252029/events';

console.log('\n  A. sans jeton : arret net, aucun jeton ne peut fuir\n');
{
  const r = run({ [ROUTE_META]: { body: METADONNEES } }, { jeton: null });
  if (r.code === 2) ok('sortie 2 (le controle n a pas tourne, il ne passe pas)');
  else ko(`sortie ${r.code}, attendue 2`);
  if (/aucun jeton dans l environnement/.test(r.sortie)) ok('le motif est nomme, pas devine');
  else ko('le motif n est pas explicite');
}

console.log('\n  B. refus de l API (403) : arret net\n');
{
  const r = run({ [ROUTE_META]: { status: 403, texte: '{"error":{"message":"forbidden"}}' } });
  if (r.code === 2) ok('sortie 2');
  else ko(`sortie ${r.code}, attendue 2`);
  if (/refuse la lecture \(HTTP 403\)/.test(r.sortie)) ok('le refus est nomme avec son code');
  else ko('le refus n est pas nomme');
  if (!r.sortie.includes(JETON_FACTICE)) ok('le jeton n apparait pas dans la sortie');
  else ko('FUITE : le jeton apparait dans la sortie');
}

console.log('\n  C. ligne trouvee : affichee, et tout secret caviarde\n');
{
  const evenements = [
    JSON.stringify({ type: 'stdout', text: `build ok — commit b0c976f` }),
    JSON.stringify({
      type: 'stdout',
      text: `{"schema":"tracefab-error-report-v1","correlationId":"${CORRELATION}","error":{"message":"Cannot find module '.prisma/client/default'"}}`,
    }),
    JSON.stringify({ type: 'stdout', text: `jwt=${JETON_FACTICE} db=${CHAINE_FACTICE}` }),
  ].join('\n');
  const r = run({ [ROUTE_META]: { body: METADONNEES }, [ROUTE_EVENTS]: { texte: evenements } });
  if (r.code === 0) ok('sortie 0 : une correspondance a ete trouvee');
  else ko(`sortie ${r.code}, attendue 0`);
  if (r.sortie.includes(CORRELATION)) ok('la ligne porte bien l identifiant de correlation');
  else ko('la ligne n est pas affichee');
  if (/le paquet @prisma\/client est la/.test(r.sortie)) ok('le message est traduit en consequence');
  else ko('le message n est pas interprete');
  if (!r.sortie.includes(JETON_FACTICE)) ok('le jeton factice est masque');
  else ko('FUITE : jeton factice visible');
  if (!r.sortie.includes('motdepassefaux')) ok('la chaine de connexion est masquee');
  else ko('FUITE : chaine de connexion visible');
}

console.log('\n  D. aucune correspondance : l absence est dite, pas transformee en preuve\n');
{
  const r = run({
    [ROUTE_META]: { body: METADONNEES },
    [ROUTE_EVENTS]: { texte: JSON.stringify({ type: 'stdout', text: 'build ok' }) },
  });
  if (r.code === 1) ok('sortie 1 : le script a tourne et n a rien trouve');
  else ko(`sortie ${r.code}, attendue 1`);
  if (/ATTENDUE et ne contredit rien/.test(r.sortie)) ok('l absence est presentee comme attendue pour un journal de build');
  else ko('l absence risque d etre lue comme une preuve');
  if (/vercel logs/.test(r.sortie)) ok('la suite est indiquee : journaux d execution');
  else ko('aucune suite indiquee');
}

console.log('\n  E. lecture seule, prouvee et non promise\n');
{
  const interdits = SOURCE.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g) || [];
  if (interdits.length === 0) ok('aucune methode d ecriture dans le source');
  else ko(`methodes d ecriture trouvees : ${interdits.join(', ')}`);
  if (/method:\s*'GET'/.test(SOURCE)) ok('la seule methode construite est GET');
  else ko('la methode n est pas explicite');
  const r = run({
    [ROUTE_META]: { body: METADONNEES },
    [ROUTE_EVENTS]: { texte: JSON.stringify({ text: 'build ok' }) },
  });
  const methodes = [...new Set(r.journal.map((e) => e.methode))];
  if (methodes.length > 0 && methodes.every((m) => m === 'GET')) ok(`journal des requetes : ${methodes.join(', ')} seulement`);
  else ko(`journal des requetes inattendu : ${JSON.stringify(methodes)}`);
}

console.log('\n  F. jeton present dans un corps d erreur : masque quand meme\n');
{
  const r = run({ [ROUTE_META]: { status: 500, texte: `{"error":"token ${JETON_FACTICE} invalide"}` } });
  if (r.code === 2) ok('sortie 2');
  else ko(`sortie ${r.code}, attendue 2`);
  if (r.sortie.includes('<jeton masque>')) ok('le jeton est remplace par une marque');
  else ko('le jeton n est pas marque comme tel');
  if (!r.sortie.includes(JETON_FACTICE)) ok('la valeur ne fuit pas');
  else ko('FUITE : la valeur du jeton apparait');
}

console.log('\n  G. aucune requete hors api.vercel.com\n');
{
  const r = run({
    [ROUTE_META]: { body: METADONNEES },
    [ROUTE_EVENTS]: { texte: JSON.stringify({ text: 'build ok' }) },
  });
  const hotes = r.journal.map((e) => e.chemin);
  if (hotes.length >= 2) ok(`${hotes.length} requetes enregistrees, toutes interceptees (le journal ne retient ni jeton ni entete)`);
  else ko(`journal vide ou incomplet : ${JSON.stringify(r.journal)}`);

  // Preuve directe : sous interception, une requete vers un autre hote doit
  // ETRE REFUSEE. On la tente, et on exige l'erreur.
  const cheminFixture = join(dossier, 'fixture-hors-ligne.json');
  writeFileSync(cheminFixture, JSON.stringify({ [ROUTE_META]: { body: METADONNEES } }));
  const tentative = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(FAUSSE_API).href, '-e',
      "try { await fetch('https://exemple.invalid/'); console.log('PASSEE'); } catch (e) { console.log('REFUSEE ' + e.message); }"],
    { encoding: 'utf8', env: { ...process.env, TF_FAKE_VERCEL: cheminFixture }, timeout: 30000 },
  );
  if (/REFUSEE hors-ligne : requete refusee vers exemple\.invalid/.test(tentative.stdout || '')) {
    ok('une requete vers un autre hote est refusee, pas redirigee');
  } else {
    ko(`l interception n a pas refuse : ${JSON.stringify((tentative.stdout || '').slice(0, 200))}`);
  }

  // Et une methode d ecriture doit etre refusee, meme sur le bon hote.
  const ecriture = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(FAUSSE_API).href, '-e',
      "try { await fetch('https://api.vercel.com/v6/deployments/6968252029', {method:'POST'}); console.log('PASSEE'); } catch (e) { console.log('REFUSEE ' + e.message); }"],
    { encoding: 'utf8', env: { ...process.env, TF_FAKE_VERCEL: cheminFixture }, timeout: 30000 },
  );
  if (/REFUSEE hors-ligne : methode POST refusee/.test(ecriture.stdout || '')) {
    ok('une methode d ecriture est refusee par l interception elle-meme');
  } else {
    ko(`l interception a laisse passer une ecriture : ${JSON.stringify((ecriture.stdout || '').slice(0, 200))}`);
  }
}

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log('  Diagnostic de production — proprietes verifiees hors ligne.');
  console.log('  --------------------------------------------\n');
  process.exit(0);
}
console.log(`  ${echecs} echec(s).`);
console.log('  --------------------------------------------\n');
process.exit(1);
