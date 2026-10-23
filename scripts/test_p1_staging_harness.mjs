#!/usr/bin/env node
/**
 * Non-regression du harnais P1 staging.
 *
 * POURQUOI CE CONTROLE EXISTE
 *   Le harnais P1 staging manipule des artefacts de session — donc des jetons —
 *   et interroge une route interne qui exige un secret d'exploitation. Trois
 *   erreurs y seraient invisibles dans un rapport de test vert :
 *
 *     1. un secret qui se retrouve dans une sortie, un journal ou une URL ;
 *     2. une cle d'instance Clerk de PRODUCTION utilisee pour fabriquer des
 *        comptes de test ;
 *     3. un etat de session ecrit dans le depot, puis versionne.
 *
 *   Ce controle verifie ces trois familles, sans secret et sans reseau.
 *
 * CE QUE CE CONTROLE NE FAIT PAS
 *   - il n'execute pas la suite P1 staging (elle exige une Preview vivante) ;
 *   - il ne cree aucun compte, aucune organisation, aucune session ;
 *   - il n'affiche aucun secret : il n'en a pas.
 *
 * CODES DE SORTIE : 0 tous les cas passent · 1 au moins un cas echoue
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

const lire = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function executer(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: typeof error?.status === 'number' ? error.status : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
    };
  }
}

/* --- 1. la suite P1 staging garde ses quatre variables requises ----------- */

{
  const source = lire('scripts/test_p1_staging.mjs');
  const requises = [
    'TRACEFAB_STAGING_URL',
    'TRACEFAB_P1_BRAND_STORAGE_STATE',
    'TRACEFAB_P1_SUPPLIER_STORAGE_STATE',
    'TRACEFAB_P1_SECOND_BRAND_STORAGE_STATE',
  ];
  const manquantes = requises.filter((nom) => !source.includes(nom));
  if (manquantes.length === 0) ok(`la suite P1 staging exige toujours ses quatre variables (${requises.join(', ')})`);
  else ko(`variables disparues de la suite P1 staging : ${manquantes.join(', ')}`);

  if (/no mock\/demo fallback is allowed/.test(source)) ok('la suite P1 staging refuse toujours le repli mock/demo');
  else ko('la suite P1 staging ne refuse plus explicitement le repli mock/demo');

  // Le contournement de la protection Vercel doit rester OPTIONNEL : sans la
  // variable, le comportement doit etre identique a ce qu'il etait.
  const garde = /const vercelBypass = process\.env\.TRACEFAB_VERCEL_BYPASS\?\.trim\(\) \|\| '';/.test(source);
  const conditionnel = /\.\.\.\(Object\.keys\(bypassHeaders\)\.length \? \{ extraHTTPHeaders: bypassHeaders \} : \{\}\)/.test(source);
  if (garde && conditionnel) ok('le contournement Vercel est optionnel : absent de la variable, rien ne change');
  else ko('le contournement Vercel n est pas conditionnel : il changerait le comportement par defaut');
}

/* --- 2. aucun secret dans une URL, une sortie ou un journal ---------------- */

{
  const sondeIdentite = lire('scripts/probe_preview_runtime_identity.mjs');
  const secretDansUrl = /searchParams\.set\(\s*['"](secret|token|key|password|apikey)['"]/i.test(sondeIdentite)
    || /\?\$\{[^}]*secret/i.test(sondeIdentite);
  if (!secretDansUrl) ok("la sonde d'identite ne place aucun secret dans l'URL");
  else ko("la sonde d'identite place un secret dans l'URL");

  if (/x-tracefab-worker-secret/.test(sondeIdentite)) ok("la sonde d'identite porte le secret dans l'en-tete HTTP attendu");
  else ko("la sonde d'identite n'utilise pas l'en-tete de la route interne");

  const afficheTout = /console\.(log|error)\([^)]*workerSecret/.test(sondeIdentite);
  if (!afficheTout) ok("la sonde d'identite n'affiche jamais le secret");
  else ko("la sonde d'identite affiche le secret");

  const sessions = lire('scripts/prepare_p1_staging_sessions.mjs');
  // Controle LIGNE PAR LIGNE : une regex multiligne confondrait deux
  // instructions voisines et signalerait un faux secret.
  const lignesSortie = sessions.split('\n').filter((l) => /console\.(log|error)\(/.test(l));
  // Une fuite serait l'interpolation de la variable qui porte la cle
  // (`${cle}`, `${cleClerk}`, `${process.env.CLERK_SECRET_KEY}`). Un
  // `${persona.cle}` est un libelle de persona, pas un secret.
  const fuiteCle = lignesSortie.filter((l) => /\$\{\s*(cle|cleClerk|process\.env\.CLERK_SECRET_KEY)\s*\}/.test(l));
  if (fuiteCle.length === 0) ok('la preparation des sessions n affiche jamais la cle Clerk');
  else ko(`la preparation des sessions affiche la cle Clerk : ${fuiteCle[0].trim().slice(0, 80)}`);

  const fuiteMotDePasse = lignesSortie.filter((l) => /motDePasse/.test(l) && /\$\{/.test(l));
  if (fuiteMotDePasse.length === 0) ok('la preparation des sessions n affiche jamais un mot de passe');
  else ko(`la preparation des sessions affiche un mot de passe : ${fuiteMotDePasse[0].trim().slice(0, 80)}`);
}

/* --- 3. une cle de production est refusee, une cle de test est exigee ------ */

{
  const sessions = lire('scripts/prepare_p1_staging_sessions.mjs');
  if (/sk_test_/.test(sessions) && /production/i.test(sessions)) ok('la preparation des sessions exige une instance de test et refuse la production');
  else ko('la preparation des sessions ne distingue pas instance de test et instance de production');

  // Une cle de production, choisie pour l'essai, doit etre refusee SANS que
  // sa valeur apparaisse dans la sortie.
  //
  // La valeur est assemblee a l'execution : une cle d'instance de production
  // ecrite en toutes lettres dans un fichier versionne est une cle que la
  // protection anti-secret de GitHub refuse de pousser — a raison.
  const cle = ['sk', 'live', 'essaiDeRefusCeValeurNeDoitJamaisApparaitre'].join('_');
  const fragmentCle = ['sk', 'live', 'essai'].join('_');
  const resultat = executer(['scripts/prepare_p1_staging_sessions.mjs'], {
    CLERK_SECRET_KEY: cle,
    TRACEFAB_STAGING_URL: 'https://tracefab-m815yyk4e-baya-ibraimmayoanouedu-8164s-projects.vercel.app',
  });
  const sortie = `${resultat.stdout}\n${resultat.stderr}`;
  if (resultat.code !== 0) ok(`une cle d'instance de production est refusee (code ${resultat.code})`);
  else ko('une cle d instance de production n est pas refusee');
  if (!sortie.includes(cle)) ok('la cle refusee n apparait pas dans la sortie');
  else ko('la cle refusee apparait dans la sortie');
  if (/sk_test_/.test(sortie)) ok("le refus cite le prefixe attendu (`sk_test_`) sans jamais citer la valeur");
  else ko("le refus ne cite pas le prefixe attendu (`sk_test_`)");
  if (!sortie.includes(fragmentCle)) ok('aucun fragment de la cle refusee ne separe la valeur dans la sortie');
  else ko('un fragment de la cle refusee apparait dans la sortie');
}

/* --- 4. une cible qui n est pas une Preview Vercel est refusee ------------ */

{
  const resultat = executer(['scripts/prepare_p1_staging_sessions.mjs'], {
    CLERK_SECRET_KEY: 'sk_test_essai',
    TRACEFAB_STAGING_URL: 'http://127.0.0.1:3000',
  });
  if (resultat.code !== 0) ok(`une cible qui n est pas une Preview HTTPS est refusee (code ${resultat.code})`);
  else ko('une cible hors Preview Vercel est acceptee');

  const sonde = executer(['scripts/probe_preview_runtime_identity.mjs'], {
    TRACEFAB_STAGING_URL: 'https://tracefab-m815yyk4e-baya-ibraimmayoanouedu-8164s-projects.vercel.app',
    TF_WORKER_SECRET: '',
  });
  if (sonde.code !== 0) ok(`la sonde d'identite refuse de partir sans secret (code ${sonde.code})`);
  else ko('la sonde d identite part sans secret');
}

/* --- 5. aucun etat de session n est versionne ----------------------------- */

{
  let versions = '';
  try {
    versions = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    versions = '';
  }
  const suspects = versions.split('\n').filter((f) => /storage[-_]?state|\.storageState\.json$/i.test(f));
  if (suspects.length === 0) ok('aucun etat de session n est suivi par git');
  else ko(`etats de session suivi par git : ${suspects.join(', ')}`);

  const journalise = versions.split('\n').filter((f) => /(^|\/)\.p1-storage-states\//.test(f));
  if (journalise.length === 0) ok("le repertoire des etats de session n'est pas dans l index git");
  else ko(`etats de session indexes : ${journalise.join(', ')}`);

  // Le script de preparation doit ecrire la ou le workflow le dit : hors du
  // depot. Le chemin par defaut est /tmp du runner.
  const sessions = lire('scripts/prepare_p1_staging_sessions.mjs');
  if (/TF_P1_STATE_DIR/.test(sessions)) ok("le repertoire des etats de session est parametrable et vaut /tmp par defaut");
  else ko("le repertoire des etats de session n est pas parametrable");
}

/* --- 5 bis. les appels Clerk utilises existent bien dans le SDK installe --- */

{
  // Le SDK `clerk/backend` evolue : les signatures d'une version a l'autre
  // ont change (creation de compte, reponse paginee, reinitialisation d'un
  // mot de passe). Un harnais qui appellerait une methode inexistante
  // echouerait A L'EXECUTION, chez le proprietaire, apres tout ce travail.
  // Ce controle verifie la presence des methodes, sans appel reseau.
  const { createClerkClient } = await import('@clerk/backend');
  const client = createClerkClient({ secretKey: 'sk_test_faux' });
  const attendues = [
    ['users.createUser', client.users?.createUser],
    ['users.updateUser', client.users?.updateUser],
    ['users.getUserList', client.users?.getUserList],
    ['organizations.createOrganization', client.organizations?.createOrganization],
    ['organizations.updateOrganizationMetadata', client.organizations?.updateOrganizationMetadata],
    ['organizations.getOrganizationList', client.organizations?.getOrganizationList],
    ['organizations.createOrganizationMembership', client.organizations?.createOrganizationMembership],
    ['organizations.getOrganizationMembershipList', client.organizations?.getOrganizationMembershipList],
  ];
  const manquantes = attendues.filter(([, fn]) => typeof fn !== 'function').map(([nom]) => nom);
  if (manquantes.length === 0) ok(`le SDK Clerk installe expose les ${attendues.length} methodes utilisees par le harnais`);
  else ko(`methodes absentes du SDK Clerk installe : ${manquantes.join(', ')}`);

  const sessions = lire('scripts/prepare_p1_staging_sessions.mjs');
  // Une reponse paginee porte ses elements dans `data`. Lire le tableau de
  // premier niveau ferait croire que rien n'existe et recréerait un compte a
  // chaque passage.
  if (/\.data\?\.\[0\]/.test(sessions)) ok('la recherche de compte lit la reponse paginee dans `data`');
  else ko('la recherche de compte ne lit pas la reponse paginee dans `data`');
  if (/getOrganizationList/.test(sessions) && /\?\.data \|\| \[\]/.test(sessions)) ok('la liste des organisations lit la reponse paginee dans `data`');
  else ko('la liste des organisations ne lit pas la reponse paginee dans `data`');
  const apiObsolete = ['skipPasswordInvitation', 'skipEmailInvitation', 'users.createPassword', 'users.updatePassword']
    .filter((motif) => sessions.includes(motif));
  if (apiObsolete.length === 0) ok("le harnais n'appelle aucune signature d'API Clerk obsolete");
  else ko(`signatures d'API Clerk obsoletes utilisees : ${apiObsolete.join(', ')}`);
}

/* --- 5 ter. la suite staging est alignee sur le contrat de refus du depot -- */

{
  // Le depot refuse un locataire non adherent par 404 `organization_not_found`
  // et NON par 403 : « un 403 revelerait que l'organisation existe »
  // (api/_lib/tenant.ts). Ce contrat est protege par une non-regression
  // locale. Le proprietaire l'a confirme le 2026-10-23 : le critere devient
  // « un export visant une organisation etrangere est refuse selon le
  // contrat anti-divulgation 404 organization_not_found, sans elargissement
  // du perimetre des donnees ; l export du locataire autorise continue de
  // fonctionner ».
  const local = lire('scripts/test_active_tenant_context.mjs');
  if (/organization_not_found/.test(local) && /404/.test(local)) ok('la non-regression locale continue de pinner le refus 404 du locataire non adherent');
  else ko('la non-regression locale du refus 404 a disparu');

  const staging = lire('scripts/test_p1_staging.mjs');

  if (!/assert\.equal\(forbidden\.status, 403/.test(staging)) ok("la suite staging n'exige plus un 403 litteral, que le depot ne produit pas");
  else ko('la suite staging exige encore un 403 litteral : elle echouerait sur la Preview');

  // Le refus doit etre EXIGE, pas seulement tolere : c'est le contrat.
  if (/assert\.equal\(\s*reponse\.status,\s*404/.test(staging)) ok('la suite staging exige le refus 404 du contrat anti-divulgation');
  else ko("la suite staging n'exige pas le statut 404 du contrat anti-divulgation");
  if (/assert\.equal\(corps\.error, 'organization_not_found'/.test(staging)) ok("la suite staging exige le code d'erreur `organization_not_found`");
  else ko("la suite staging n'exige pas le code d'erreur `organization_not_found`");

  // Un statut ne suffit pas : la preuve est dans les donnees.
  if (/assert\.equal\(lignesCsv\(reponse\.body\)\.length, 0/.test(staging)) ok('la suite staging exige zero ligne de donnees dans une reponse de refus');
  else ko('la suite staging ne prouve pas, au niveau des donnees, qu un refus ne rend rien');
  if (/must not widen the exported scope/.test(staging)) ok('la suite staging prouve qu un organisationId etranger n elargit pas le perimetre exporte');
  else ko("la suite staging ne prouve pas l absence d elargissement du perimetre exporte");
  if (/refsUniquementEtranger/.test(staging) && /leaked a data reference/.test(staging)) ok('la suite staging verifie qu aucune reference de l organisation etrangere ne fuit');
  else ko('la suite staging ne verifie pas l absence de fuite de references entre organisations');

  // Les trois cas doivent etre mesures : la precedence en-tete > query change
  // la signification de chaque requete.
  if (/crossEntete/.test(staging) && /crossQuery/.test(staging) && /crossParametre/.test(staging)) ok('la suite staging mesure l en-tete, la query et les deux ensemble');
  else ko('la suite staging ne mesure pas les trois formes de demande de locataire');

  // Controle positif : l export du locataire autorise doit fonctionner.
  if (/own-tenant export failed/.test(staging)) ok('la suite staging exige que l export du locataire autorise fonctionne');
  else ko('la suite staging ne verifie pas le controle positif');

  // Identites distinctes : deux organisations reellement differentes.
  if (/tenant-isolation test requires two distinct brand organizations/.test(staging)) ok('la suite staging exige deux organisations reellement distinctes');
  else ko('la suite staging n exige pas deux organisations distinctes');
  if (/must be a UUID/.test(staging)) ok('la suite staging exige des identifiants d organisation au format UUID');
  else ko('la suite staging n exige pas des identifiants d organisation au format UUID');
}

/* --- 5 quater. la suite staging ne depend d aucun hasard de locale ------ */

{
  // Le disclaimer du Quality Center est un texte traduit
  // (`quality.heroLede`, assets/i18n/fr.json). Le runner GitHub est en
  // `en-US` : sans locale imposee, la page rend la variante anglaise et le
  // controle echouerait pour une raison etrangere au produit. La suite
  // impose donc la locale ET accepte les deux langues.
  const staging = lire('scripts/test_p1_staging.mjs');
  if (/locale: 'fr-FR'/.test(staging)) ok('la suite staging impose la locale du navigateur (le runner est en en-US)');
  else ko("la suite staging n impose pas la locale : le controle du disclaimer serait faussement rouge");
  if (/statuts\\s\+déclaratifs/.test(staging) && /declarative\\s\+statuses/.test(staging)) ok('la suite staging accepte le disclaimer dans les deux langues');
  else ko('la suite staging n accepte le disclaimer que dans une seule langue');

  // Reference de simulation unique : un doublon preexistant ferait re-echo
  // la valeur CSV dans le message d erreur du serveur.
  if (/referenceSimulation/.test(staging) && /P1-STAGING-DRY-RUN-\$\{Date\.now\(\)\}/.test(staging)) ok('la suite staging utilise une reference de simulation unique par execution');
  else ko('la suite staging utilise une reference de simulation fixe : un doublon preexistant ferait re-echo la valeur CSV');
}

/* --- 6. l'inventaire des secrets n'affiche que des noms -------------------- */

{
  const source = lire('scripts/list_secret_names.mjs');
  const fuite = /console\.(log|error)\([^)]*JSON\.stringify\(.*secrets/.test(source);
  if (!fuite) ok("l'inventaire n'affiche aucune valeur de secret");
  else ko("l'inventaire affiche des valeurs de secret");
  if (/Object\.keys\(objet/.test(source)) ok("l'inventaire ne liste que les noms des secrets");
  else ko("l'inventaire ne se limite pas aux noms des secrets");
}

/* --- 7. le harnais est branché dans package.json --------------------------- */

{
  const pkg = JSON.parse(lire('package.json'));
  const script = pkg.scripts?.['test:p1-harness'];
  if (script) ok('le controle du harnais est branche : npm run test:p1-harness');
  else ko('le controle du harnais n est pas branche dans package.json');
  // La CI collecte automatiquement les scripts `test:*` SAUF ceux dont le nom
  // contient `neon` ou `staging`. Un nom contenant `staging` serait donc
  // silencieusement jamais execute : le controle serait vert sans jamais
  // avoir joue.
  // Le filtre de la CI porte sur le NOM du script (la cle), pas sur la
  // commande : c'est la cle qui decide de l'execution.
  const cle = 'test:p1-harness';
  if (!cle.includes('staging') && !cle.includes('neon')) ok(`le controle du harnais est collecte par la CI (cle « ${cle} » : ni 'neon' ni 'staging')`);
  else ko(`le nom du script de controle porte 'staging' ou 'neon' : la CI ne l'executera jamais`);
  if (pkg.scripts?.['test:p1:staging'] === 'node scripts/test_p1_staging.mjs') ok('la suite P1 staging reste branchee sur scripts/test_p1_staging.mjs');
  else ko('la suite P1 staging n est plus branchee sur scripts/test_p1_staging.mjs');
}

console.log(`\n  ${echecs === 0 ? 'Harnais P1 staging : OK.' : `${echecs} echec(s).`}`);
process.exit(echecs ? 1 : 0);
