#!/usr/bin/env node
/**
 * GARDE-FOUS DU RECALCUL REEL — `scripts/simuler_recalcul_dpp.mjs --appliquer`.
 *
 * POURQUOI CE BANC EXISTE
 *   Le 27/10/2026, la simulation a montre qu'un dossier passait de 9/9 a 8/13.
 *   Appliquer ce recalcul est une ECRITURE sur une base vivante. Les controles
 *   qui l'entourent (refus de la production, cible nommee, confirmation
 *   distincte avant d'ecrire) ne valent que s'ils sont eprouves : un controle
 *   qui laisse passer un `--appliquer` mal nomme ne protege rien.
 *
 * CE QUI EST EPROUVE — sans ouvrir aucune connexion
 *   1. aucune cible          -> 3 (le nom de la cible manque)
 *   2. hote de production    -> 3
 *   3. cible non nommee      -> 3
 *   4. `--appliquer` sans confirmation -> 2
 *   5. confirmation differente de l'hote -> 3
 *   6. simulation sans confirmation     -> passe les gardes (echoue plus loin,
 *      faute de base : c'est la preuve que lire ne demande qu'un nom)
 *
 * Les cas 1 a 5 sortent AVANT toute connexion reseau : aucun besoin de base.
 * Le cas 6 utilise une URL locale inexistante et exige que l'echec survienne
 * APRES les gardes (code 1 ou erreur de connexion), jamais un code 2 ou 3.
 *
 * Sortie : 0 si tous les cas passent, 1 sinon.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'simuler_recalcul_dpp.mjs');
const PROD = 'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech';
const HOTE = 'ep-validation-test.example.neon.tech';

let echecs = 0;
const joue = (titre, { args = [], env = {} }, attendu) => {
  const base = {
    PATH: process.env.PATH,
    // On ne transmet NI DATABASE_URL NI les variables du shell courant : seul
    // ce que le cas declare doit exister.
    HOME: process.env.HOME,
    ...env,
  };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: base, encoding: 'utf8' });
  const code = r.status;
  const ok = attendu.includes(code);
  if (!ok) echecs += 1;
  const dernier = (r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop() || '(rien)';
  console.log(`  ${ok ? 'ok    ' : 'ECHEC '} ${titre} — attendu ${attendu.join('/')}, obtenu ${code}`);
  if (!ok) console.log(`         dernier message : ${dernier.slice(0, 160)}`);
  return r;
};

console.log('\nGarde-fous du recalcul reel\n---------------------------');

joue('1. aucune cible', {}, [2]);
joue('2. hote de production refuse',
  { env: { DATABASE_URL: `postgresql://u:p@${PROD}/neondb`, TF_SIMULATION_CIBLE: PROD } }, [3]);
joue('3. cible non nommee',
  { env: { DATABASE_URL: `postgresql://u:p@${HOTE}/neondb` } }, [3]);
joue('4. --appliquer sans confirmation',
  { args: ['--appliquer'], env: { DATABASE_URL: `postgresql://u:p@${HOTE}/neondb`, TF_SIMULATION_CIBLE: HOTE } }, [2]);
joue('5. confirmation differente de l\'hote',
  {
    args: ['--appliquer'],
    env: {
      DATABASE_URL: `postgresql://u:p@${HOTE}/neondb`,
      TF_SIMULATION_CIBLE: HOTE,
      TF_RECALCUL_CONFIRME: 'ep-autre.example.neon.tech',
    },
  }, [3]);

// Cas 6 : lire ne demande qu'un nom. La base n'existe pas, donc l'echec doit
// venir de la connexion — code 1 — et surtout PAS d'un refus de garde (2/3).
const r6 = joue('6. simulation sans confirmation : les gardes laissent passer',
  { env: { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/neondb', TF_SIMULATION_CIBLE: '127.0.0.1' } },
  [1]);
if ([2, 3].includes(r6.status)) {
  console.log('         NOTE : refus de garde alors que le cas doit passer — garde trop stricte.');
}

console.log(`\n${echecs ? 'ECHEC' : 'OK'} — ${echecs} cas en echec sur 6.`
  + (echecs ? '' : ' Aucun --appliquer ne franchit les gardes sans deux noms concordants.'));
process.exit(echecs ? 1 : 0);
