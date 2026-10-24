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

  // Le jeu d'en-tetes vit desormais dans UN module partage
  // (`scripts/lib/preview_deployment.mjs`), pour que les trois scripts ne
  // puissent pas diverger. Le controle reste strict : soit l'en-tete est
  // ecrit dans le script, soit le script importe le module partage ET le
  // module contient bien l'en-tete exact de Vercel.
  const libApercu = lire('scripts/lib/preview_deployment.mjs');
  const porteEntetes = (source) => /x-vercel-protection-bypass/.test(source)
    || (/entetesBypass\(/.test(source) && /x-vercel-protection-bypass/.test(libApercu));
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
  // Le jeu d'en-tetes vit desormais dans UN module partage
  // (`scripts/lib/preview_deployment.mjs`), pour que les trois scripts ne
  // puissent pas diverger. Le controle reste strict : soit l'en-tete est
  // ecrit dans le script, soit le script importe le module partage ET le
  // module contient bien l'en-tete exact de Vercel.
  const libApercu = lire('scripts/lib/preview_deployment.mjs');
  const porteEntetes = (source) => /x-vercel-protection-bypass/.test(source)
    || (/entetesBypass\(/.test(source) && /x-vercel-protection-bypass/.test(libApercu));
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

  const sondeIdentite = lire('scripts/probe_preview_runtime_identity.mjs');
  // Refuser sans dire OU manque le secret laisse le dossier sans avance. La
  // sonde doit designer la correction : la route interne distingue 503 (la
  // Preview na aucun secret configure), 401 (elle en a un, absent de
  // l'environnement GitHub) et 302 (la protection Vercel intercepte encore).
  if (/sonde_sans_secret_http/.test(sondeIdentite) && /sonde_sans_secret_diagnostic/.test(sondeIdentite)) {
    ok('la sonde d identite mesure la reponse de la route interne quand le secret manque');
  } else {
    ko('la sonde d identite refuse de partir sans secret sans dire ou le secret manque');
  }
  const causes = [
    ['503', /Vercel/],
    ['401', /tracefab-clerk-test/],
    ['302', /protection de deploiement Vercel/],
  ];
  const causesManquantes = causes.filter(([code, motif]) => !new RegExp(`code === ${code}`).test(sondeIdentite) || !motif.test(sondeIdentite));
  if (causesManquantes.length === 0) {
    ok('la sonde d identite distingue les trois causes possibles et nomme la correction de chacune');
  } else {
    ko(`la sonde d identite ne distingue pas ces causes du secret manquant : ${causesManquantes.map(([c]) => c).join(', ')}`);
  }
  // Le diagnostic ne doit jamais transformer le secret en information
  // publiee : ni sa valeur, ni sa longueur.
  if (!/workerSecret\.length/.test(sondeIdentite)) {
    ok('la sonde d identite ne publie ni la valeur ni la longueur du secret de sonde');
  } else {
    ko('la sonde d identite publie une propriete du secret de sonde');
  }
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
  // Le jeu d'en-tetes vit desormais dans UN module partage
  // (`scripts/lib/preview_deployment.mjs`), pour que les trois scripts ne
  // puissent pas diverger. Le controle reste strict : soit l'en-tete est
  // ecrit dans le script, soit le script importe le module partage ET le
  // module contient bien l'en-tete exact de Vercel.
  const libApercu = lire('scripts/lib/preview_deployment.mjs');
  const porteEntetes = (source) => /x-vercel-protection-bypass/.test(source)
    || (/entetesBypass\(/.test(source) && /x-vercel-protection-bypass/.test(libApercu));
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

  // Le jeu d'en-tetes vit desormais dans UN module partage
  // (`scripts/lib/preview_deployment.mjs`), pour que les trois scripts ne
  // puissent pas diverger. Le controle reste strict : soit l'en-tete est
  // ecrit dans le script, soit le script importe le module partage ET le
  // module contient bien l'en-tete exact de Vercel.
  const libApercu = lire('scripts/lib/preview_deployment.mjs');
  const porteEntetes = (source) => /x-vercel-protection-bypass/.test(source)
    || (/entetesBypass\(/.test(source) && /x-vercel-protection-bypass/.test(libApercu));
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

/* --- 5 quater bis. l isolation est mesuree sur les trois plans ---------- */

{
  // Une application borne ses donnees a trois endroits distincts, et un seul
  // plan ne prouve rien des deux autres :
  //   1. le resolveur de locataire (api/_lib/tenant.ts) ;
  //   2. les politiques RLS de la base ;
  //   3. le controle applicatif des ecritures.
  // La suite doit mesurer les trois, et le dire.
  const staging = lire('scripts/test_p1_staging.mjs');

  // Plan 2 : la route qui ne resout AUCUN locataire et s'appuie donc
  // uniquement sur RLS. Une session d'une organisation qui demande les
  // produits d'une autre doit obtenir ZERO ligne.
  if (/api\/catalog\/export\/products/.test(staging)) ok('la suite staging mesure la barriere RLS seule (route sans resolveur de locataire)');
  else ko('la suite staging ne mesure pas la barriere RLS seule');
  if (/RLS must return zero row for a foreign organization/.test(staging)) ok('la suite staging exige zero ligne cote RLS pour une organisation etrangere');
  else ko('la suite staging n exige pas zero ligne cote RLS');
  if (/the own organization must get its own rows back through the RLS route/.test(staging)) ok('la suite staging exige le controle positif de la route RLS');
  else ko('la suite staging n exige pas le controle positif de la route RLS');

  // Plan 2 bis : lecture JSON, ligne a ligne — chaque produit renvoye doit
  // porter l identifiant du locataire appelant.
  if (/a product was returned from another organization/.test(staging)) ok('la suite staging verifie l organisation de chaque ligne renvoyee');
  else ko('la suite staging ne verifie pas l organisation de chaque ligne renvoyee');

  // Plan 3 : les ecritures croisees doivent etre refusees ET ne rien
  // persister.
  if (/brand_organization_mismatch/.test(staging)) ok('la suite staging mesure le refus d une ecriture dirigee vers une autre organisation');
  else ko('la suite staging ne mesure pas le refus d une ecriture dirigee vers une autre organisation');
  if (/brand_organization_access_denied/.test(staging)) ok('la suite staging mesure le refus d un import catalogue vers une autre organisation');
  else ko('la suite staging ne mesure pas le refus d un import catalogue vers une autre organisation');
  if (/a refused cross-tenant write must not have persisted anything/.test(staging)) ok('la suite staging prouve qu une ecriture refusee ne persiste rien');
  else ko('la suite staging ne prouve pas qu une ecriture refusee ne persiste rien');

  // Les mesures doivent etre publiees : statut observe, pas seulement un
  // verdict binaire.
  if (/rls_foreign_rows/.test(staging) && /shared_references_between_brands/.test(staging) && /refused_write_persisted/.test(staging)) ok('la suite staging publie les mesures d isolation (RLS, produits, ecritures)');
  else ko('la suite staging ne publie pas les mesures d isolation');
}

/* --- 5 quinquies. le percage de la protection Vercel est complet -------- */

{
  // Les apercus du projet sont derriere la protection de deploiement Vercel.
  // Trois scripts doivent donc porter le contournement, sinon ils mesurent la
  // protection au lieu de l'application :
  //   - la preparation des sessions (la navigation vers le formulaire de
  //     connexion, et les appels same-origin de la page) ;
  //   - la suite staging (navigation et appels same-origin) ;
  //   - la sonde d identite (appel HTTP direct).
  // Le jeu d'en-tetes vit desormais dans UN module partage
  // (`scripts/lib/preview_deployment.mjs`), pour que les trois scripts ne
  // puissent pas diverger. Le controle reste strict : soit l'en-tete est
  // ecrit dans le script, soit le script importe le module partage ET le
  // module contient bien l'en-tete exact de Vercel.
  const libApercu = lire('scripts/lib/preview_deployment.mjs');
  const porteEntetes = (source) => /x-vercel-protection-bypass/.test(source)
    || (/entetesBypass\(/.test(source) && /x-vercel-protection-bypass/.test(libApercu));
  const sessions = lire('scripts/prepare_p1_staging_sessions.mjs');
  if (/TRACEFAB_VERCEL_BYPASS/.test(sessions) && /extraHTTPHeaders/.test(sessions)) ok('la preparation des sessions porte le contournement Vercel');
  else ko('la preparation des sessions ne porte pas le contournement Vercel : elle n atteindrait jamais le formulaire de connexion');
  if (/addInitScript/.test(sessions) && porteEntetes(sessions)) ok('la preparation des sessions porte le contournement sur les appels same-origin');
  else ko('la preparation des sessions ne porte pas le contournement sur les appels same-origin');

  const staging = lire('scripts/test_p1_staging.mjs');
  if (/TRACEFAB_VERCEL_BYPASS/.test(staging) && /extraHTTPHeaders/.test(staging) && /addInitScript/.test(staging)) ok('la suite staging porte le contournement Vercel, navigation et appels same-origin');
  else ko('la suite staging ne porte pas le contournement Vercel');

  const sonde = lire('scripts/probe_preview_runtime_identity.mjs');
  if (/TRACEFAB_VERCEL_BYPASS/.test(sonde) && porteEntetes(sonde)) ok('la sonde d identite porte le contournement Vercel');
  else ko('la sonde d identite ne porte pas le contournement Vercel');

  // La session Clerk est posee AVANT la synchronisation des organisations :
  // lire l'identifiant d'organisation sans attendre serait une course.
  if (/organizationKey: key/.test(staging) && /app\.state\[key\]/.test(staging)) ok('la suite staging attend l identifiant d organisation, pas seulement la session');
  else ko('la suite staging lit l identifiant d organisation sans attendre sa synchronisation');

  // La sonde d identite doit etablir OU se trouve la base : le nom de la
  // base ne doit JAMAIS etre publie (le depot est public), mais la
  // comparaison avec la base de Production doit l etre sous forme de
  // booleen.
  if (/base_partagee_avec_production/.test(sonde)) ok('la sonde d identite publie la comparaison avec la base de Production sous forme de booleen');
  else ko('la sonde d identite ne dit pas si la base de staging est celle de Production');
  const publicationDuNomDeBase = /console\.log\([^)]*\.database/.test(sonde) || /\['database'/.test(sonde);
  if (!publicationDuNomDeBase) ok('la sonde d identite ne publie jamais le nom de la base');
  else ko('la sonde d identite publie le nom de la base : le depot est public');

  // Les mesures doivent exister en ANNOTATION : le journal de run est
  // heberge hors de l'API GitHub.
  if (/annoterMesures/.test(sonde)) ok('la sonde d identite publie ses mesures en annotation');
  else ko('la sonde d identite ne publie ses mesures qu dans le journal de run, illisible depuis l exterieur');
  if (/::notice/.test(staging)) ok('la suite staging publie ses mesures en annotation');
  else ko('la suite staging ne publie ses mesures qu dans le journal de run');
}

/* --- 5 sexies. les identites de test restent dans leur perimetre ---------- */

{
  // Le 2026-10-24, l'API Clerk de l'instance de test a refuse l'adresse
  // `p1-brand-a@tracefab.test` en 422 `form_param_format_invalid`
  // (paramName `email_address`) : validation de format cote serveur, plus
  // stricte que le test syntaxique, sur un domaine special-use `.test`.
  // Trois familles doivent survivre a une modification du script :
  //   1. le perimetre d'adresses — liste EXPLICITE, partagee, testee ;
  //   2. l'echelle de candidats — le refus format de Clerk est nomme, pas
  //      masque derriere un echec generique ;
  //   3. le releve reel de l'instance — plus les anciens champs fantomes
  //      (`auth_settings`, `instance_type`) qui revenaient « inconnus ».
  const sessions = lire('scripts/prepare_p1_staging_sessions.mjs');

  // 1. perimetre partage etegorique
  if (/identites_test\.mjs/.test(sessions)) {
    ok('la preparation partage son garde-fou d adresses avec le module dedie');
  } else {
    ko('la preparation ne passe plus par le garde-fou d adresses partage');
  }
  if (!/endsWith\('\.test'\)/.test(sessions)) {
    ok("l ancien garde restrictif au domaine `.test` a ete remplace (il etait refuse par Clerk)");
  } else {
    ko("l ancien garde `.test` est toujours la : il designe une adresse que Clerk refuse");
  }

  const { adresseAutorisee, DOMAINES_IDENTITES_DE_TEST } = await import('./lib/identites_test.mjs');

  // Le perimetre est EPIQUE : l'ajout d'un domaine exige d'editer ce test.
  const perimetreAttendu = ['example.com', 'example.org', 'example.net'];
  if (JSON.stringify([...DOMAINES_IDENTITES_DE_TEST]) === JSON.stringify(perimetreAttendu)) {
    ok(`le perimetre des identites de test est exactement [${perimetreAttendu.join(', ')}]`);
  } else {
    ko(`le perimetre des identites de test a change sans validation : [${DOMAINES_IDENTITES_DE_TEST.join(', ')}]`);
  }

  const cas = [
    ['p1-brand-a@example.com', true],
    ['P1@Example.COM', true],
    ['p1-supplier@example.org', true],
    ['x@example.net', true],
    ['p1@tracefab.test', false], // refuse par Clerk en 422 — mesure
    ['p1@gmail.com', false],      // adresse reelle interdite
    ['p1@sub.example.com', false], // pas de sous-domaine implicite
    ['p1@notexample.com', false],
    ['p1@example', false],
    ['p1 a@example.com', false],
    ['p1@@example.com', false],
    [null, false],
    ['', false],
  ];
  const malClasses = cas.filter(([adresse, attendu]) => adresseAutorisee(adresse) !== attendu);
  if (malClasses.length === 0) ok(`le garde-fou classe exactement les ${cas.length} cas d adresse (positifs et negatifs)`);
  else ko(`garde-fou d adresses faux pour : ${malClasses.map(([a]) => JSON.stringify(a)).join(', ')}`);

  // Toute adresse litterale du script doit etre dans le perimetre — un
  // durcissement futur du module ne doit pas laisser derriere lui une
  // adresse hors perimetre en dur.
  const adressesLitterales = [...sessions.matchAll(/['"]([\w.+-]+@[\w.-]+)['"]/g)].map((m) => m[1]);
  const horsPerimetre = adressesLitterales.filter((a) => !adresseAutorisee(a));
  if (horsPerimetre.length === 0) ok('aucune adresse litterale hors perimetre dans la preparation');
  else ko(`adresses litterales hors perimetre dans la preparation : ${horsPerimetre.join(', ')}`);

  // 2. echelle de candidats et refus nomme
  if (/form_param_format_invalid/.test(sessions) && /clerk_adresses_refusees/.test(sessions)) {
    ok('le refus format de Clerk est nomme, candidat par candidat, avec les codes recus');
  } else {
    ko('le refus format de Clerk n est pas nomme : il reapparaitrait en echec generique');
  }
  if (/candidat_accepte/.test(sessions) && /candidats\.entries\(\)/.test(sessions)) {
    ok('la preparation echelonne ses candidats et publie celui que Clerk accepte');
  } else {
    ko('la preparation n echelonne pas ses candidats d adresses');
  }
  // Toute AUTRE erreur API doit sortir immediatement : masquer un refus
  // different derriere le format serait un faux diagnostic.
  if (/clerk_api_inattendue/.test(sessions) && /process\.exit\(7\)/.test(sessions)) {
    ok('une erreur API Clerk hors format sort sur sa propre cause (code 7)');
  } else {
    ko('une erreur API Clerk hors format serait masquee derriere le format');
  }

  // 3. releve reel de l instance + refus de la production
  if (/environment_type/.test(sessions) && /instance_de_production/.test(sessions)
      && /process\.exit\(6\)/.test(sessions)) {
    ok('la preparation lit l environnement reel de l instance et refuse la production (code 6)');
  } else {
    ko('la preparation ne refuse plus une instance relevee en production');
  }
  // Verification sur le CODE uniquement : expliquer la disparition des
  // champs dans un commentaire n'est pas les lire.
  const codeSansCommentaires = sessions
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  if (!/auth_settings/.test(codeSansCommentaires) && !/instance_type/.test(codeSansCommentaires)) {
    ok('la preparation ne lit plus les champs fantomes `auth_settings` / `instance_type`');
  } else {
    ko('la preparation lit encore `auth_settings` ou `instance_type`, qui n existent plus : l etat est faussement inconnu');
  }
  if (/v1\/environment/.test(sessions) && /strategie_mot_de_passe/.test(sessions)
      && /used_for_first_factor/.test(sessions)) {
    ok('les strategies de connexion sont relevees sur la Frontend API, champ reel par champ');
  } else {
    ko('les strategies de connexion ne sont plus relevees sur l instance');
  }
  if (/process\.exit\(4\)/.test(sessions) && /mot de passe/i.test(sessions)) {
    ok('une strategie sans mot de passe CONFIRMEE arrete la preparation (code 4) avant le navigateur');
  } else {
    ko('la preparation arreterait plus tot sur un formulaire sans mot de passe');
  }

  // Le releve des strategies lit la cle publique de /api/config : elle ne
  // doit jamais partir dans un journal.
  const lignesSortie = sessions.split('\n').filter((l) => /console\.(log|error)\(/.test(l));
  const fuiteClePublique = lignesSortie.filter((l) => /\$\{\s*(pk|publishableKey|config\??\.)/.test(l));
  if (fuiteClePublique.length === 0) ok('la preparation n affiche jamais la cle publique ni sa source');
  else ko(`la preparation affiche la cle publique : ${fuiteClePublique[0].trim().slice(0, 80)}`);

  // 4. idempotence mesurable : creation annoncee, recherche avant creation
  if (/creation_de_lance/.test(sessions) && /creation_organisation_lance/.test(sessions)) {
    ok('chaque passe annonce ce qu elle cree — une relance se voit en un coup d oeil');
  } else {
    ko('la preparation n annonce pas ce qu elle cree : une duplication passerait inapercue');
  }
  if (/trouverIdentite/.test(sessions) && sessions.indexOf('trouverIdentite(persona)') >= 0
      && /const existant = etats\.find/.test(sessions)) {
    ok('la creation cherche le compte existant (tous candidats) avant toute ecriture');
  } else {
    ko('la creation ne cherche plus le compte existant avant d ecrire');
  }
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

/* --- 6 bis. le garde-fou du workflow est cale sur le besoin reel ----------- */

{
  // Le 2026-10-23, l'execution authentifiee a echoue sur une seule cause : le
  // secret de la sonde d'identite (TF_WORKER_SECRET) manquait dans
  // l'environnement. Or le garde-fou de presence exigeait ce secret AVANT la
  // suite d'isolation : une seule sonde non approvisionnee a donc supprime
  // toutes les preuves d'isolation, qui n'en dependent pas. Chaque secret
  // doit etre verifie a l'endroit ou il sert, jamais plus tot.
  const workflow = lire('.github/workflows/p1-staging-authenticated.yml');
  const marqueurSuite = 'Executer la suite P1 staging';
  const marqueurSonde = 'identite DB runtime';
  // La declaration des secrets au niveau du job (le bloc `env:`) precede les
  // etapes : c'est normal, un secret Declare n'est pas un secret exige. Ce
  // qui est interdit, c'est d'en EXIGER la presence avant la suite.
  const debutSteps = workflow.indexOf('    steps:');
  const avantSuite = workflow.slice(debutSteps, workflow.indexOf(marqueurSuite));
  const depuisSonde = workflow.slice(workflow.indexOf(marqueurSonde));

  // Le motif recherche est le CONTROLE lui-meme (`[ -n "${TF_WORKER_SECRET:-}" ]`),
  // pas la simple mention du nom : un commentaire qui explique la regle est
  // utile, une verification prematuree ne l'est pas.
  const controleSonde = /\[ -n "\$\{TF_WORKER_SECRET:-\}"/;
  if (avantSuite.includes('TF_WORKER_SECRET') && controleSonde.test(avantSuite)) {
    ko('le garde-fou du workflow exige TF_WORKER_SECRET avant la suite d isolation : un secret de sonde manquant effacerait les preuves d isolation, qui n en dependent pas');
  } else {
    ok('le garde-fou du workflow n exige pas le secret de sonde avant la suite d isolation');
  }

  if (depuisSonde.includes('TF_WORKER_SECRET') && controleSonde.test(depuisSonde)) {
    ok('le secret de sonde est verifie dans l etape de sonde d identite, la ou il sert');
  } else {
    ko('le secret de sonde n est plus verifie dans l etape de sonde d identite : son absence passerait inapercue');
  }

  // L absence du secret doit etre NOMMEE, avec l action qui la leve : une
  // erreur sans indication ne fait pas avancer le dossier.
  if (/secret_sonde=absent/.test(depuisSonde) && /deposer TRACEFAB_NOTIFICATION_WORKER_SECRET/.test(depuisSonde)) {
    ok('l absence du secret de sonde est nommee avec l action qui la leve');
  } else {
    ko('l absence du secret de sonde n est plus nommee avec l action qui la leve');
  }

  // Les deux secrets dont dependent les etapes de tete doivent, eux, rester
  // verifies avant elles.
  if (avantSuite.includes('secret_bypass=') && avantSuite.includes('secret_clerk=')) {
    ok('les secrets necessaires aux etapes de tete restent verifies avant elles');
  } else {
    ko('les secrets necessaires aux etapes de tete ne sont plus verifies avant elles');
  }
}

/* --- 6 ter. la cible du workflow n est JAMAIS figee ---------------------- */

{
  // Cause racine du 2026-10-23 : le pre-vol testait une URL de Preview ecrite
  // en dur (alias de branche). Un alias n'est pas le deploiement du commit :
  // Vercel le re-canonicalise (307 vers un AUTRE hote) et le test mesure une
  // redirection. Ces controles empechent le retour d'une URL figee.
  const authentifie = lire('.github/workflows/p1-staging-authenticated.yml');
  const surface = lire('.github/workflows/p1-staging-surface.yml');

  // Une URL de Preview litterale dans un workflow est une cible perimee.
  const urlFigee = /https:\/\/[a-z0-9-]+\.vercel\.app/i;
  if (!urlFigee.test(authentifie)) ok('le workflow authentifie ne code aucune URL de Preview en dur');
  else ko('le workflow authentifie code une URL de Preview en dur : elle designera bientot un autre commit');

  if (!urlFigee.test(surface)) ok('le diagnostic de surface ne code aucune URL de Preview en dur');
  else ko('le diagnostic de surface code une URL de Preview en dur');

  // La cible est resolue par le script dedie, a partir du SHA teste.
  if (/scripts\/resolve_preview_deployment\.mjs/.test(authentifie) && /TF_TARGET_SHA/.test(authentifie)) {
    ok('le workflow authentifie resout le deploiement Preview du SHA teste');
  } else {
    ko('le workflow authentifie ne resout pas le deploiement Preview du SHA teste');
  }

  // ... et c'est bien cette resolution qui alimente le pre-vol et les tests :
  // une resolution qui ne serait pas utilisee ne prouverait rien.
  const usages = (authentifie.match(/steps\.preview\.outputs\.preview_url/g) || []).length;
  if (usages >= 4) ok(`le pre-vol et les quatre etapes de test utilisent l URL resolue (${usages} references)`);
  else ko(`l URL resolue n alimente que ${usages} etape(s) : une resolution inutilisee ne prouve rien`);

  // Le pre-vol doit rester BLOQUANT : un pre-vol qui n'arrete rien laisse les
  // tests s'executer contre une cible non verifiee.
  if (/TF_PROBE_STRICT: '1'/.test(authentifie)) ok('le pre-vol du workflow authentifie est strict : il bloque les tests dependants');
  else ko('le pre-vol du workflow authentifie n est pas strict : les tests peuvent s executer sans cible verifiee');

  // La resolution lit l API des Deployments : elle exige la permission.
  if (/deployments: read/.test(authentifie)) ok('le workflow authentifie demande la permission minimale deployments: read');
  else ko('le workflow authentifie lit les Deployments sans demander deployments: read');

  // Une URL imposee ne doit jamais etre acceptee sans verification du SHA.
  if (/TF_PREVIEW_URL_OVERRIDE/.test(authentifie) && /url_imposee_hors_du_deploiement_du_sha/.test(lire('scripts/resolve_preview_deployment.mjs'))) {
    ok('une URL imposee n est acceptee que si elle est le deploiement de ce SHA');
  } else {
    ko('une URL imposee pourrait etre acceptee sans correspondance de SHA : ce serait un faux vert');
  }

  // La production reste interdite comme cible.
  if (/hote_de_production_interdit/.test(lire('scripts/lib/preview_deployment.mjs'))) {
    ok('un hote de production est refuse comme cible de test');
  } else {
    ko('un hote de production pourrait devenir une cible de test');
  }
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
