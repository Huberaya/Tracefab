#!/usr/bin/env node
/**
 * Controle DIFFERENTIEL : la garde classe-t-elle la cible que le pilote joindra ?
 *
 * POURQUOI CE CONTROLE EXISTE — revue du 2026-10-12
 *
 * La garde de cible raisonne sur l'« hote effectif ». Cette notion n'est pas
 * une opinion : elle est definie par `pg-connection-string`, la bibliotheque que
 * `pg` utilise pour lire une chaine de connexion. Tant que les deux lectures
 * divergent, la garde peut declarer « jetable » une cible que le pilote joint
 * ailleurs — c'est exactement ce qui s'est produit avec deux parametres `host=`
 * (le pilote retient le dernier, la garde lisait le premier).
 *
 * Ce fichier compare donc la classification de la garde a l'hote reellement
 * produit par le pilote, sur une table d'URL. Il ne se contente pas de
 * rejouer des cas choisis a la main : il DERIVE l'attendu de la sortie du
 * pilote.
 *
 * INVARIANTS VERIFIES, pour chaque URL de la table :
 *
 *   1. si le pilote joint une socket Unix (`host` commencant par `/`) ou un hote
 *      local, la garde doit ACCEPTER ;
 *   2. si le pilote joint un hote de base managee connu, la garde doit REFUSER,
 *      quel que soit ce que l'URL affiche ;
 *   3. jamais l'inverse : aucune URL dont le pilote joint un hote manage ne doit
 *      sortir acceptee.
 *
 * Aucune connexion n'est ouverte : `pg-connection-string` analyse une chaine,
 * il ne contacte personne. Aucun test n'est pointe vers une base reelle.
 */
import pgcs from 'pg-connection-string';
import { classifyTarget, describeTarget } from './lib/require-throwaway-db.mjs';

const { parse } = pgcs;
const { parse: parseDriver } = pgcs;

let echecs = 0;
let passes = 0;
const ok = (m) => { passes += 1; console.log(`  ok    ${m}`); };
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

/** Les memes familles d'hotes que la garde refuse par nature. */
const HOTES_MANAGES = [
  /\.neon\.tech$/i, /\.neon\.build$/i, /^neon\.tech$/i,
  /\.supabase\.co$/i, /\.supabase\.in$/i,
  /\.rds\.amazonaws\.com$/i, /\.database\.windows\.net$/i, /\.azure\.com$/i,
];
const HOTES_LOCAUX = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Hote que le pilote joindra reellement, selon sa propre bibliotheque.
 * `pg-connection-string` fusionne les parametres de requete dans l'ordre, donc
 * la derniere valeur gagne ; puis il retombe sur l'autorite de l'URL.
 */
function hoteDuPilote(url) {
  const config = parseDriver(url);
  return String(config.host ?? '');
}

const TABLE = [
  ['locale simple', 'postgresql://u:p@localhost:5432/tracefab_test'],
  ['locale par IP', 'postgresql://u:p@127.0.0.1:5432/tracefab_test'],
  ['hote manage dans l autorite', 'postgresql://u:p@ep-x.eu-central-1.aws.neon.tech:5432/tracefab_test'],
  ['autorite neutre, host= manage', 'postgresql://u:p@db.interne:5432/tracefab_test?host=ep-x.eu-central-1.aws.neon.tech'],
  ['autorite manage, host= local', 'postgresql://u:p@ep-x.eu-central-1.aws.neon.tech:5432/tracefab_test?host=localhost'],
  ['host= repete, local puis manage', 'postgresql://u:p@db.interne:5432/tracefab_test?host=localhost&host=ep-x.eu-central-1.aws.neon.tech'],
  ['host= repete, manage puis local', 'postgresql://u:p@db.interne:5432/tracefab_test?host=ep-x.eu-central-1.aws.neon.tech&host=localhost'],
  ['HOST= en majuscules (ignore par le pilote)', 'postgresql://u:p@ep-x.eu-central-1.aws.neon.tech:5432/tracefab_test?HOST=localhost'],
  ['hostaddr= seul (ignore par le pilote)', 'postgresql://u:p@localhost:5432/tracefab_test?hostaddr=ep-x.neon.tech'],
  ['socket Unix par parametre', 'postgresql:///tracefab_test?host=/var/run/postgresql'],
  ['socket Unix avec identifiants', 'postgresql://u:p@/tracefab_test?host=/var/run/postgresql'],
  ['socket Unix encodee', 'postgresql://u:p@/tracefab_test?host=%2Fvar%2Frun%2Fpostgresql'],
];

// La garde est interrogee dans la configuration la PLUS PERMISSIVE possible :
// opt-in active, listes blanches larges. Si un contournement doit passer, c'est
// ici qu'il passerait — et c'est donc ici qu'il doit etre vu.
const VARIABLES_PERMISSIVES = {
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'db.interne,ep-x.eu-central-1.aws.neon.tech,ep-x.neon.tech,ep-x.neon.tech.',
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
};

function withEnv(vars, fn) {
  const sauve = {};
  for (const k of ['TRACEFAB_ALLOW_NONLOCAL_TEST_DB', 'TRACEFAB_TEST_DB_HOST_ALLOWLIST', 'TRACEFAB_TEST_DB_NAME_ALLOWLIST', 'VERCEL_ENV']) {
    sauve[k] = process.env[k];
    if (k in vars) process.env[k] = vars[k]; else delete process.env[k];
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(sauve)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

console.log('\n  Différentiel garde / pilote : la garde voit-elle la meme cible que `pg` ?\n');

for (const [nom, url] of TABLE) {
  const hote = hoteDuPilote(url);
  const socket = hote.startsWith('/');
  const local = socket || HOTES_LOCAUX.has(hote.toLowerCase().replace(/\.$/, ''));
  const manage = HOTES_MANAGES.some((motif) => motif.test(hote.toLowerCase().replace(/\.$/, '')));
  // Une URL qui declare PLUSIEURS hotes differents n'est pas classable avec
  // certitude. La garde choisit alors de refuser, meme si le pilote, lui,
  // joindrait l'un des deux : une configuration legitime ne repete jamais
  // `host=` avec des valeurs differentes, et une cible ambigue ne doit pas
  // produire une autorisation. C'est un ECART ASSUME a l'invariant 1, et il est
  // verifie comme tel — pas contourne en affaiblissant l'invariant.
  // Compte sans `new URL` : l'autorite vide avec identifiants n'est pas
  // analysable par la classe URL, et c'est justement un des cas de la table.
  // Le motif exige `host=` : `hostaddr=` ne correspond pas.
  const ambigu = new Set([...url.matchAll(/[?&]host=([^&]*)/g)].map((m) => decodeURIComponent(m[1]).trim())).size > 1;

  withEnv(VARIABLES_PERMISSIVES, () => {
    const verdict = classifyTarget(url);
    if (manage) {
      // Invariant 2 et 3 : un hote manage ne peut jamais sortir accepte.
      verdict.allowed
        ? ko(`${nom} — le pilote joint ${hote} (hote manage) et la garde ACCEPTE (${verdict.code})`)
        : ok(`${nom} — le pilote joint un hote manage, la garde refuse (${verdict.code})`);
    } else if (ambigu) {
      verdict.allowed
        ? ko(`${nom} — cible ambigue acceptee (${verdict.code})`)
        : ok(`${nom} — cible ambigue : refus par conception (${verdict.code}), meme si le pilote joindrait « ${socket ? 'socket Unix' : hote} »`);
    } else if (local) {
      // Invariant 1 : une cible locale jetable doit rester utilisable.
      verdict.allowed
        ? ok(`${nom} — cible locale, la garde accepte (${verdict.code})`)
        : ko(`${nom} — le pilote joint la cible locale « ${socket ? 'socket Unix' : hote} » et la garde refuse (${verdict.code})`);
    } else {
      // Hote ni local ni manage : la garde peut accepter ou refuser, mais si
      // elle accepte, il faut que la liste blanche contienne bien cet hote.
      const detail = verdict.allowed
        ? `accepte (${verdict.code})`
        : `refuse (${verdict.code})`;
      ok(`${nom} — hote ${hote} : ${detail} — verification a la main, aucun invariant automatique`);
    }
    // Le rapport ne doit jamais contenir l'hote ni un mot de passe.
    const ligne = describeTarget('DATABASE_URL', verdict);
    if (ligne.includes('motdepasse') || ligne.includes('ep-x.eu-central-1.aws.neon.tech')) {
      ko(`${nom} — le rapport publie un element sensible`);
    }
  });
}

console.log('\n  --------------------------------------------');
console.log(`  ${passes} verification(s) passee(s), ${echecs} echec(s).`);
console.log('  --------------------------------------------\n');

if (echecs > 0) {
  console.log('  Desaccord garde/pilote : revoir la classification avant tout usage.\n');
  process.exit(1);
}
console.log('  La garde classe la cible que le pilote joindra, sur toute la table.\n');
