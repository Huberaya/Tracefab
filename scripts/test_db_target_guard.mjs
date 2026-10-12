#!/usr/bin/env node
/**
 * Preuve de la garde de cible.
 *
 * Une garde qui n'a jamais refuse n'a jamais prouve qu'elle refusait quoi que
 * ce soit. Cette suite exerce les deux sens : ce qui doit passer passe, ce qui
 * doit etre refuse est refuse. Elle verifie aussi que rien de sensible ne
 * sort dans les messages.
 *
 * Aucune connexion n'est ouverte : la classification est une fonction pure.
 * Aucun test n'est pointe vers une base reelle, de production ou non.
 */
import { classifyTarget, describeTarget } from './lib/require-throwaway-db.mjs';

let echecs = 0;
let passes = 0;
const ok = (m) => { passes += 1; console.log(`  ok    ${m}`); };
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

const SECRET_PASSWORD = 'motdepasse_qui_ne_doit_jamais_sortir';
const SECRET_HOST = 'ep-secret-123456.eu-central-1.aws.neon.tech';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  for (const k of ['TRACEFAB_ALLOW_NONLOCAL_TEST_DB', 'TRACEFAB_TEST_DB_HOST_ALLOWLIST', 'TRACEFAB_TEST_DB_NAME_ALLOWLIST', 'VERCEL_ENV']) {
    if (!(k in vars)) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

console.log('\n  A. ce qui doit etre ACCEPTE');

withEnv({}, () => {
  const v = classifyTarget('postgresql://postgres:postgres@localhost:5432/tracefab_test');
  v.allowed && v.code === 'throwaway_local' ? ok('base jetable locale (localhost)') : ko(`localhost refuse (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('postgresql://u:p@127.0.0.1:5432/anything');
  v.allowed ? ok('base jetable locale (127.0.0.1)') : ko(`127.0.0.1 refuse (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('postgresql:///tracefab_test?host=/var/run/postgresql');
  v.allowed ? ok('base jetable locale (socket Unix)') : ko(`socket Unix refuse (${v.code})`);
});
withEnv({
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'test-db.internal.example',
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
}, () => {
  const v = classifyTarget('postgresql://u:p@test-db.internal.example:5432/tracefab_test');
  v.allowed && v.code === 'allowlisted_remote' ? ok('cible distante explicitement autorisee (3 declarations)') : ko(`cible distante autorisee refusee (${v.code})`);
});

withEnv({
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'test-db.internal.example',
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
}, () => {
  // L'hote effectif est celui du parametre, et il est declare : l'autorisation
  // doit donc fonctionner. Sans ce temoin, un durcissement trop large passerait
  // inapercu en refusant toute cible distante.
  const v = classifyTarget('postgresql://u:p@passerelle.example:5432/tracefab_test?host=test-db.internal.example');
  v.allowed && v.code === 'allowlisted_remote' ? ok('hote effectif declare par parametre : autorisation maintenue') : ko(`cible distante declaree refusee (${v.code})`);
});

console.log('\n  B. ce qui doit etre REFUSE');

withEnv({ VERCEL_ENV: 'production' }, () => {
  const v = classifyTarget('postgresql://postgres:postgres@localhost:5432/tracefab_test');
  !v.allowed && v.code === 'production_context' ? ok('refus en contexte de deploiement de production, meme en local') : ko(`contexte production accepte (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget(`postgresql://neondb_owner:${SECRET_PASSWORD}@${SECRET_HOST}/neondb`);
  !v.allowed ? ok('refus d un hote de base managee sans opt-in') : ko('hote manage refuse NON — il a ete accepte');
});
withEnv({
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'autre-hote.example',
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
}, () => {
  const v = classifyTarget(`postgresql://neondb_owner:${SECRET_PASSWORD}@${SECRET_HOST}/tracefab_test`);
  !v.allowed && v.code === 'managed_host' ? ok('hote manage refuse meme avec opt-in et autre liste blanche') : ko(`hote manage accepte (${v.code})`);
});
withEnv({}, () => {
  // Le pilote joint l'hote du parametre, pas celui de l'URL. Declarer
  // « localhost » dans l'autorite ne rend pas la cible locale.
  const v = classifyTarget(`postgresql://u:p@localhost:5432/tracefab_test?host=${SECRET_HOST}`);
  !v.allowed && v.code === 'managed_host' ? ok('contournement par ?host= vers un hote manage : refuse') : ko(`contournement par ?host= accepte (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('postgresql://u:p@127.0.0.1:5432/tracefab_test?host=db.entreprise.example');
  !v.allowed ? ok('contournement par ?host= vers un hote distant : refuse') : ko('contournement par ?host= distant accepte');
});
withEnv({
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'test-db.internal.example',
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
}, () => {
  const v = classifyTarget('postgresql://u:p@127.0.0.1:5432/tracefab_test?host=db.entreprise.example');
  !v.allowed && v.code === 'host_not_allowlisted' ? ok('hote effectif hors liste blanche : refuse malgre l opt-in') : ko(`hote effectif hors liste accepte (${v.code})`);
});
withEnv({
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: SECRET_HOST,
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
}, () => {
  // Cas le plus dangereux : quelqu'un declare la plateforme de production dans
  // la liste blanche pour « tester en preproduction ». La liste blanche ne doit
  // pas pouvoir rendre jetable un hote manage.
  const v = classifyTarget(`postgresql://neondb_owner:${SECRET_PASSWORD}@${SECRET_HOST}/tracefab_test`);
  !v.allowed && v.code === 'managed_host' ? ok('hote manage inscrit dans la liste blanche : refuse quand meme') : ko(`hote manage declare accepte (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('postgresql://u:p@db.entreprise.example:5432/tracefab_production');
  !v.allowed && v.code === 'production_name' ? ok('nom de base evoquant la production refuse') : ko(`nom de production accepte (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('postgresql://u:p@db.entreprise.example:5432/live');
  !v.allowed ? ok('nom de base « live » refuse') : ko(`nom « live » accepte (${v.code})`);
});
withEnv({
  TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
  TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'db.entreprise.example',
  TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
}, () => {
  const v = classifyTarget('postgresql://u:p@db.entreprise.example:5432/autre_base');
  !v.allowed && v.code === 'name_not_allowlisted' ? ok('nom de base hors liste blanche refuse') : ko(`nom hors liste accepte (${v.code})`);
});
withEnv({}, () => {
  const v = classifyTarget('ceci n est pas une url');
  !v.allowed && v.code === 'unparseable' ? ok('valeur non analysable refusee') : ko('valeur illisible acceptee');
});
withEnv({}, () => {
  const v = classifyTarget('');
  !v.allowed && v.code === 'missing' ? ok('valeur absente refusee') : ko('valeur vide acceptee');
});
withEnv({}, () => {
  const v = classifyTarget(undefined);
  !v.allowed && v.code === 'missing' ? ok('variable non definie refusee') : ko('variable non definie acceptee');
});


console.log('\n  D. parametres host=, sockets Unix, valeurs encodees, formes malformees');
{
  // --- ce qui doit etre accepte
  withEnv({}, () => {
    const v = classifyTarget('postgresql:///tracefab_test?host=%2Fvar%2Frun%2Fpostgresql');
    v.allowed && v.code === 'throwaway_local' ? ok('socket Unix encodee (%2F...) reconnue comme locale') : ko(`socket Unix encodee : ${v.code}`);
  });
  withEnv({}, () => {
    const v = classifyTarget('postgresql://u:p@[::1]:5432/tracefab_test');
    v.allowed ? ok('IPv6 litteral [::1] reconnu comme local') : ko(`[::1] refuse (${v.code})`);
  });
  withEnv({}, () => {
    const v = classifyTarget('postgresql://u:p@LOCALHOST:5432/tracefab_test');
    v.allowed ? ok('hote en majuscules (LOCALHOST) reconnu comme local') : ko(`LOCALHOST refuse (${v.code})`);
  });
  withEnv({}, () => {
    const v = classifyTarget('postgresql://u:p@localhost.:5432/tracefab_test');
    v.allowed ? ok('point final (localhost.) reconnu comme local') : ko(`localhost. refuse (${v.code})`);
  });
  withEnv({
    TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
    TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'hote.example',
    TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
  }, () => {
    // Valeur encodee qui DOIT passer : un refus ici serait un faux positif.
    const v = classifyTarget('postgresql://u:p@hote.example:5432/tracefab%5Ftest');
    v.allowed && v.code === 'allowlisted_remote' ? ok('nom de base encode (tracefab%5Ftest) decode et reconnu') : ko(`nom encode refuse (${v.code})`);
  });

  // --- ce qui doit etre refuse
  withEnv({}, () => {
    const v = classifyTarget('postgresql://u:p@localhost/db?host=%65p-xxx.eu-central-1.aws.neon.tech');
    !v.allowed && v.code === 'managed_host' ? ok('hote manage encode (%65p-...) : refuse') : ko(`hote manage encode accepte (${v.code})`);
  });
  withEnv({}, () => {
    const v = classifyTarget('postgresql://u:p@EP-XXX.EU-CENTRAL-1.AWS.NEON.TECH/db');
    !v.allowed && v.code === 'managed_host' ? ok('hote manage en majuscules : refuse') : ko(`hote manage majuscules accepte (${v.code})`);
  });
  withEnv({
    TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
    TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'ep-xxx.eu-central-1.aws.neon.tech.',
    TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'db',
  }, () => {
    // Point final + liste blanche : deux tours de passe-passe qui, combines,
    // suffisaient a faire accepter un hote manage avant ce durcissement.
    const v = classifyTarget('postgresql://u:p@ep-xxx.eu-central-1.aws.neon.tech./db');
    !v.allowed && v.code === 'managed_host' ? ok('hote manage avec point final, meme declare : refuse') : ko(`hote manage avec point final accepte (${v.code})`);
  });
  withEnv({
    TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
    TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'hote.example',
    TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'prod-duction',
  }, () => {
    const v = classifyTarget('postgresql://u:p@hote.example:5432/prod%2Dduction');
    !v.allowed && v.code === 'production_name' ? ok('nom de production encode (prod%2Dduction) : refuse') : ko(`nom de production encode accepte (${v.code})`);
  });
  withEnv({}, () => {
    const v = classifyTarget('mysql://u:p@localhost:3306/db');
    !v.allowed && v.code === 'scheme_not_supported' ? ok('protocole inattendu (mysql://) : refuse par defaut') : ko(`protocole inattendu accepte (${v.code})`);
  });
  withEnv({}, () => {
    const v = classifyTarget('localhost:5432/db');
    !v.allowed ? ok('URL sans schema : refusee') : ko('URL sans schema acceptee');
  });
  withEnv({}, () => {
    const v = classifyTarget('postgresql://u:p@2130706433/db');
    !v.allowed ? ok('loopback sous forme decimale : refusee (sens sur)') : ko('forme decimale acceptee');
  });
  withEnv({}, () => {
    const v = classifyTarget('postgresql://utilisateur:motdepasse@/db');
    !v.allowed ? ok('hote vide : refusee') : ko('hote vide accepte');
  });
  withEnv({}, () => {
    // `new URL()` jette avant meme d'arriver au controle de protocole : le code
    // est « unparseable ». Les deux codes sont des refus ; ce qui compte est
    // qu'aucune de ces formes ne soit acceptee.
    const v = classifyTarget('ceci-n-est-pas-une-url');
    !v.allowed && ['unparseable', 'scheme_not_supported'].includes(v.code)
      ? ok(`chaine sans schema : refusee (${v.code})`)
      : ko(`chaine illisible acceptee ou code inattendu : ${v.code}`);
  });
  withEnv({}, () => {
    const v = classifyTarget('   ');
    !v.allowed && v.code === 'missing' ? ok('valeur faite d espaces : refusee') : ko(`espaces acceptes (${v.code})`);
  });
}

console.log('\n  C. ce qui ne doit JAMAIS sortir dans un message');

withEnv({}, () => {
  const raw = `postgresql://neondb_owner:${SECRET_PASSWORD}@${SECRET_HOST}/neondb?sslmode=require`;
  const line = describeTarget('DATABASE_URL', classifyTarget(raw));
  const fuites = [
    ['mot de passe', line.includes(SECRET_PASSWORD)],
    ['hote', line.includes(SECRET_HOST)],
    ['chaine complete', line.includes('postgresql://')],
    ['identifiant', line.includes('neondb_owner')],
  ].filter(([, leaked]) => leaked);
  fuites.length === 0 ? ok('aucune fuite dans le rapport de refus') : ko(`fuite detectee : ${fuites.map(([n]) => n).join(', ')}`);
  line.includes('empreinte=') ? ok('le rapport publie une empreinte correable') : ko('pas d empreinte dans le rapport');
});

console.log(`\n  --------------------------------------------`);
console.log(`  ${passes} verifications passees, ${echecs} echec(s).`);
console.log(`  --------------------------------------------\n`);

if (echecs > 0) process.exit(1);
console.log('  La garde accepte ce qui est jetable et refuse tout le reste.\n');
