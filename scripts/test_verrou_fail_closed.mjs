#!/usr/bin/env node
/**
 * R5 — `--verrou-cluster` est FAIL-CLOSED.
 *
 * CE QUI ETAIT FAUX
 *
 * `scripts/run-db-suite.mjs` prenait le verrou puis, s'il n'y arrivait pas,
 * imprimait un AVERTISSEMENT et lancait quand meme la suite :
 *
 *     catch (e) {
 *       console.error(`  AVERTISSEMENT — verrou de cluster non pris (${...})`);
 *     }
 *
 * Un verrou « demande » mais facultatif n'est pas un verrou : exactement ce que
 * le verrou existe pour empecher — deux suites qui modifient `pg_authid` en
 * parallele (`XX000 tuple concurrently updated`, mesure du 30/10) — restait
 * possible. En outre `pg_advisory_lock` ATTENDAIT sans limite une session
 * concurrente : un blocage indefini n'est pas un comportement de garde non plus.
 *
 * CE QUE CE TEST PROUVE
 *
 *   A. verrou DEJA DETENU par une autre session : le lanceur echoue (code 3)
 *      apres une attente BORNEE, et la suite n'est PAS lancee (temoin absent) ;
 *   B. ECHEC DE CONNEXION (port ferme) : code 3, aucune suite lancee ;
 *   C. IMPORT INDISPONIBLE (garde absente du disque) : code 3, pas de
 *      contournement silencieux ;
 *   D. INTERRUPTION (SIGTERM) : l'enfant est arrete, le verrou est libere ;
 *   E. DEVERROUILLAGE : apres succes, apres echec de l'enfant, et apres
 *      interruption, aucun verrou ne reste (`pg_locks`) ;
 *   F. AUCUN CHEMIN NE CONTOURNE LE VERROU DEMANDE : controle statique — le
 *      verrou est demande avant le `spawn`, et la branche d'echec sort avant.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as dormir } from 'node:timers/promises';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { deriverUrl, verrouillerCluster } from './lib/ephemeral-db.mjs';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
const CLE = 738241901;
const EXIT_VERROU = 3;

let vertes = 0;
let rouges = 0;
const echecs = [];
function verifier(etiquette, ok, detail) {
  if (ok) {
    vertes += 1;
    console.log(`    ok    ${etiquette}`);
  } else {
    rouges += 1;
    echecs.push(etiquette);
    console.log(`    ECHEC ${etiquette}${detail ? ` — observé : ${detail}` : ''}`);
  }
}

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: 'verrou de cluster fail-closed',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;
const urlMaintenance = deriverUrl(urlProprietaire, 'postgres');

async function adm() {
  const c = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
  await c.connect();
  return c;
}

/** Combien de sessions detiennent le verrou, vu d'une AUTRE session. */
async function detenteurs() {
  const c = await adm();
  try {
    const { rows } = await c.query(
      'SELECT count(*)::int n FROM pg_locks WHERE locktype = $1 AND objid = $2 AND granted',
      ['advisory', CLE],
    );
    return rows[0].n;
  } finally {
    await c.end();
  }
}

const TEMOIN = join(RACINE, 'scripts', `.tf_temoin_r5_${process.pid}.txt`);
const temoinExiste = () => {
  const r = spawnSync(process.execPath, ['-e', `require('fs').existsSync(${JSON.stringify(TEMOIN)}) && process.exit(0) || process.exit(1)`]);
  return r.status === 0;
};

/** Suite temoin : elle ECRIT un fichier, preuve qu'elle a bien demarre. */
const SUITE_TEMOIN = join(RACINE, 'scripts', `.tf_suite_r5_${process.pid}.mjs`);

const { writeFileSync, rmSync, existsSync } = await import('node:fs');
writeFileSync(SUITE_TEMOIN, `import { writeFileSync } from 'node:fs';\n`
  + `writeFileSync(${JSON.stringify(TEMOIN)}, 'lance');\n`
  + `const duree = Number.parseInt(process.env.TF_DUREE_TEMOIN || '0', 10);\n`
  + `if (duree > 0) await new Promise((r) => setTimeout(r, duree));\n`
  // Le code de sortie est lu a l EXECUTION : la suite est ecrite une fois, et
  // chaque lancement doit pouvoir imposer le sien (`TF_CODE_TEMOIN`).
  + `process.exit(Number.parseInt(process.env.TF_CODE_TEMOIN || '0', 10));\n`, 'utf8');

function lancerLanceur(args, env = {}) {
  const r = spawnSync(process.execPath,
    [join(RACINE, 'scripts/run-db-suite.mjs'), ...args],
    { cwd: RACINE, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, sortie: `${r.stdout || ''}${r.stderr || ''}` };
}

function nettoyerTemoin() {
  if (existsSync(TEMOIN)) rmSync(TEMOIN, { force: true });
}

try {
  /* ======================================================================== *
   * A. Verrou deja detenu : attente bornee puis echec, suite NON lancee
   * ======================================================================== */

  console.log('\n  A. verrou deja detenu — attente bornee, echec, aucune suite lancee');

  {
    nettoyerTemoin();
    const verrou = await verrouillerCluster({ urlProprietaire });
    try {
      verifier('le verrou est bien detenu par une autre session', (await detenteurs()) === 1,
        `${await detenteurs()} detenteur(s)`);
      const debut = Date.now();
      const r = lancerLanceur(['--verrou-cluster', SUITE_TEMOIN],
        { TF_VERROU_ATTENTE_MS: '400' });
      const duree = Date.now() - debut;
      verifier(`echec avec le code ${EXIT_VERROU}`, r.code === EXIT_VERROU, `exit=${r.code}`);
      verifier('l attente est bornee (moins de 10 s)', duree < 10000, `${duree} ms`);
      verifier('la suite n a PAS ete lancee (temoin absent)', !temoinExiste(), 'temoin present');
      verifier('le message dit que le verrou n est pas acquis',
        /verrou NON ACQUIS/.test(r.sortie), r.sortie.trim().split('\n').slice(-3).join(' | '));
    } finally {
      await verrou.relacher();
    }
    verifier('apres liberation, plus aucun detenteur', (await detenteurs()) === 0, `${await detenteurs()}`);
  }

  /* ======================================================================== *
   * B. Echec de connexion
   * ======================================================================== */

  console.log('\n  B. connexion impossible — echec, aucune suite lancee');

  {
    nettoyerTemoin();
    const r = lancerLanceur(['--verrou-cluster', SUITE_TEMOIN], {
      DATABASE_URL: 'postgresql://postgres@127.0.0.1:55499/tracefab_test',
      TF_VERROU_ATTENTE_MS: '500',
    });
    verifier(`echec avec le code ${EXIT_VERROU}`, r.code === EXIT_VERROU, `exit=${r.code}`);
    verifier('la suite n a PAS ete lancee (temoin absent)', !temoinExiste(), 'temoin present');
    verifier('aucune chaine de connexion dans la sortie',
      !/postgres(ql)?:\/\//.test(r.sortie), 'URL affichee');
  }

  /* ======================================================================== *
   * C. Import indisponible : pas de contournement silencieux
   * ======================================================================== */

  console.log('\n  C. garde absente du disque — echec, pas de poursuite');

  {
    // Le lanceur est copie dans un repertoire isole, SANS `lib/`. Le code dit
    // explicitement que dans ce cas le verrou ne peut pas etre pris : il doit
    // donc refuser de continuer (c'etait exactement le chemin qui, avant,
    // imprimait un avertissement et lancait la suite).
    const isole = join(RACINE, 'scripts', `.tf_isole_r5_${process.pid}`);
    const { mkdirSync, copyFileSync } = await import('node:fs');
    rmSync(isole, { recursive: true, force: true });
    mkdirSync(join(isole, 'lib'), { recursive: true });
    copyFileSync(join(RACINE, 'scripts/run-db-suite.mjs'), join(isole, 'run-db-suite.mjs'));
    // On copie tout SAUF la garde de verrou : c'est precisement le cas ou le
    // lanceur pourrait « continuer quand meme ». Les autres modules sont la
    // pour que l'echec porte bien sur le verrou et non sur une resolution de
    // module anterieure.
    for (const mod of ['require-throwaway-db.mjs', 'choose-suite-loader.mjs']) {
      copyFileSync(join(RACINE, 'scripts/lib', mod), join(isole, 'lib', mod));
    }
    nettoyerTemoin();
    const r = spawnSync(process.execPath, [join(isole, 'run-db-suite.mjs'), '--verrou-cluster', SUITE_TEMOIN],
      { cwd: RACINE, encoding: 'utf8', env: { ...process.env, TF_VERROU_ATTENTE_MS: '300' } });
    verifier(`echec avec le code ${EXIT_VERROU}`, r.status === EXIT_VERROU, `exit=${r.status}`);
    verifier('la suite n a PAS ete lancee (temoin absent)', !temoinExiste(), 'temoin present');
    rmSync(isole, { recursive: true, force: true });
  }

  /* ======================================================================== *
   * D. Interruption : enfant arrete, verrou libere
   * ======================================================================== */

  console.log('\n  D. interruption (SIGTERM) — enfant arrete, verrou libere');

  {
    nettoyerTemoin();
    const enfant = spawn(process.execPath,
      [join(RACINE, 'scripts/run-db-suite.mjs'), '--verrou-cluster', SUITE_TEMOIN],
      {
        cwd: RACINE,
        // La suite temoin reste vivante : sans cela le verrou serait rendu en
        // ~200 ms et l'observation deviendrait une course.
        env: { ...process.env, TF_CODE_TEMOIN: '0', TF_DUREE_TEMOIN: '4000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const fin = new Promise((r) => enfant.on('exit', (c, s) => r({ c, s })));
    let sortie = '';
    enfant.stdout.on('data', (d) => { sortie += String(d); });
    enfant.stderr.on('data', (d) => { sortie += String(d); });

    // On attend que le verrou soit reellement pris par le lanceur.
    let pris = 0;
    for (let i = 0; i < 100 && pris === 0; i += 1) {
      pris = await detenteurs();
      if (pris === 0) await dormir(50);
    }
    verifier('le lanceur detient le verrou avant l interruption', pris === 1,
      `${pris} detenteur(s) · sortie: ${sortie.trim().split('\n').slice(-2).join(' | ')}`);

    enfant.kill('SIGTERM');
    const code = await fin;
    verifier('le lanceur sort en 143 (SIGTERM)', code.c === 143 || code.s === 'SIGTERM',
      `code=${code.c} signal=${code.s}`);

    for (let i = 0; i < 40 && (await detenteurs()) !== 0; i += 1) await dormir(50);
    verifier('apres interruption, plus aucun verrou orphelin', (await detenteurs()) === 0,
      `${await detenteurs()} detenteur(s)`);
  }

  /* ======================================================================== *
   * E. Deverrouillage apres succes et apres echec de l'enfant
   * ======================================================================== */

  console.log('\n  E. deverrouillage apres succes et apres echec de l enfant');

  {
    nettoyerTemoin();
    const r = lancerLanceur(['--verrou-cluster', SUITE_TEMOIN], { TF_CODE_TEMOIN: '0', TF_VERROU_ATTENTE_MS: '5000' });
    verifier('succes : code 0 et suite lancee', r.code === 0 && temoinExiste(), `exit=${r.code}`);
    verifier('succes : verrou libere', (await detenteurs()) === 0, `${await detenteurs()}`);
    verifier('succes : le message confirme la prise du verrou',
      /verrou de cluster : pris/.test(r.sortie), 'message absent');

    nettoyerTemoin();
    const e = lancerLanceur(['--verrou-cluster', SUITE_TEMOIN], { TF_CODE_TEMOIN: '7', TF_VERROU_ATTENTE_MS: '5000' });
    verifier('echec de l enfant : le code de l enfant est propage (7)', e.code === 7, `exit=${e.code}`);
    verifier('echec de l enfant : verrou libere', (await detenteurs()) === 0, `${await detenteurs()}`);

    // Sans l'option, le verrou n'est PAS pris (le contraire serait un abus).
    nettoyerTemoin();
    const libre = lancerLanceur([SUITE_TEMOIN], { TF_CODE_TEMOIN: '0' });
    verifier('sans --verrou-cluster : aucun verrou pris, suite lancee',
      libre.code === 0 && temoinExiste() && (await detenteurs()) === 0,
      `exit=${libre.code}, detenteurs=${await detenteurs()}`);
  }

  /* ======================================================================== *
   * F. Aucun chemin ne contourne le verrou demande
   * ======================================================================== */

  console.log('\n  F. aucun chemin ne contourne le verrou demande');

  {
    const source = readFileSync(join(RACINE, 'scripts/run-db-suite.mjs'), 'utf8');
    const iVerrou = source.indexOf('verrouillerCluster(');
    const iSpawn = source.indexOf('const child = spawn(');
    const iExit = source.indexOf('process.exit(EXIT_VERROU)');
    verifier('le verrou est demande AVANT le spawn', iVerrou > 0 && iVerrou < iSpawn,
      `verrou@${iVerrou} spawn@${iSpawn}`);
    verifier('la branche d echec sort AVANT le spawn', iExit > 0 && iExit < iSpawn,
      `exit@${iExit} spawn@${iSpawn}`);
    verifier('plus aucun AVERTISSEMENT de verrou non pris',
      !/AVERTISSEMENT — verrou/.test(source), 'avertissement encore present');
    verifier('l attente est bornee (attenteMs transmis)',
      /attenteMs:\s*ATTENTE_VERROU_MS/.test(source), 'attente non bornee');
    verifier('SIGINT et SIGTERM sont traites',
      /'SIGINT'/.test(source) && /'SIGTERM'/.test(source), 'signaux non traites');

    // Les chemins qui DEMANDENT le verrou ne peuvent pas le contourner : la
    // seule porte est l'option, et elle est traitee avant tout lancement.
    const shell = ['scripts/audit_sql_privileges_catalog.sh', 'scripts/test_migration_integration_34_36_41.sh']
      .map((f) => readFileSync(join(RACINE, f), 'utf8'));
    verifier('les scripts shell passent tous par le lanceur verrouille',
      shell.every((s) => /run-db-suite\.mjs --verrou-cluster scripts\/prepare_ci_db_role\.mjs/.test(s)),
      'un script appelle le provisioning sans verrou');
  }
} finally {
  nettoyerTemoin();
  rmSync(SUITE_TEMOIN, { force: true });
  rmSync(join(RACINE, 'scripts', `.tf_isole_r5_${process.pid}`), { recursive: true, force: true });
}

console.log('\n  G. le test range ses fixtures');
verifier('temoin supprime', !existsSync(TEMOIN), TEMOIN);
verifier('suite temoin supprimee', !existsSync(SUITE_TEMOIN), SUITE_TEMOIN);
verifier('aucun verrou residuel', (await detenteurs()) === 0, `${await detenteurs()}`);

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — un verrou demande est un verrou obtenu, sinon rien ne demarre.\n');
process.exit(0);
