#!/usr/bin/env node
/**
 * P10.7 — l'ACTIVATION du mode strict systeme, eprouvee dans les deux sens.
 *
 * POURQUOI CETTE SUITE EXISTE
 *
 * Le basculement a ete sorti de la chaine de migrations (voir l'en-tete de
 * `20261105120100_operations_systeme_hors_runtime`) parce qu'une migration qui
 * exige un secret pour s'appliquer casse toute base neuve. Le refus doit donc
 * vivre AILLEURS, et etre mesure la ou il vit : dans l'outil d'exploitation.
 *
 * Une suite qui ne verifierait que « l'activation reussit » ne prouverait rien :
 * une commande qui ecrit `true` sans rien controler passerait ce test. Cette
 * suite mesure donc les trois choses qui font la difference entre un outil et un
 * interrupteur :
 *
 *   A. L'ACTIVATION FERME REELLEMENT. Base jetable neuve, application installee
 *      dans la forme de production — ce qui ne peut pas l'etre par migration l'est
 *      ici, explicitement — puis, sous le role applicatif : operation systeme
 *      SANS jeton = refusee (42501), et l'adhesion de l'escalade n'est PAS ecrite.
 *   B. L'ACTIVATION REFUSE QUAND ELLE DOIT. Sans cle active : refus code 3,
 *      rien d'ecrit, mode inchange. Avec une operation non gardee : refus code 3.
 *      C'est la difference entre « l'outil a echoue » et « l'outil n'a pas pu ».
 *   C. LE RETOUR ARRIERE RESTAURE L'ETAT. `--desactiver` ramene le mode a false,
 *      et un jeton signe reste accepte dans les deux modes : le retour arriere ne
 *      casse pas le chemin legitime, il rouvre seulement l'ancien. C'est ce qui
 *      rend la bascule reversible, donc decidable.
 *
 * CE QUE CETTE SUITE NE FAIT PAS
 *
 *   - elle ne bascule AUCUN environnement qui sert : la seule cible est une base
 *     jetable creee ici, detruite dans un `finally`, avec preuve d'OID ;
 *   - elle ne lit ni n'affiche aucune cle d'environnement : les cles qu'elle
 *     utilise sont tirees au hasard pour la duree de l'execution ;
 *   - elle ne rejoue pas les treize operations : c'est le role de
 *     `test:p107:identite-systeme`, qui le fait sur la base de la suite ;
 *     ici, un refus et un temoin positif suffisent a prouver le mode.
 *
 * Env : DATABASE_URL (administration, base JETABLE), TF_APP_PASSWORD.
 * Sortie : 0 conforme · 1 regression · 2 non execute.
 */
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { deriverUrl, verrouillerCluster, avecBaseEphemere } from './lib/ephemeral-db.mjs';
import { signerJetonSysteme } from './lib/identite_systeme_test.mjs';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
const urlAdmin = (process.env.DATABASE_URL || '').trim();
const motDePasseApp = (process.env.TF_APP_PASSWORD || '').trim();

if (!urlAdmin || !motDePasseApp) {
  console.error('  NON EXECUTE — DATABASE_URL et TF_APP_PASSWORD sont requises.');
  process.exit(2);
}

let assertions = 0;
let echecs = 0;
const ok = (condition, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${condition ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!condition) echecs += 1;
};

/**
 * Lance une commande du depot sur la base jetable et rend sa sortie.
 *
 * On passe par un processus, et non par un import : c'est la COMMANDE que
 * l'operateur executera, avec ses codes de sortie. Un import testerait une
 * fonction, pas l'outil.
 */
const lancer = (script, args, url, { sansConsentement = false, adminUrl = null } = {}) => new Promise((resoudre) => {
  const enfant = spawn(process.execPath, [join(RACINE, 'scripts', script), ...args], {
    cwd: RACINE,
    env: {
      ...process.env,
      DATABASE_ADMIN_URL: url,
      DATABASE_URL: url,
      // `TF_ADMIN_URL` est retiree par defaut : une suite qui mesure un refus
      // ne doit pas heriter silencieusement d'une identite administrative. La
      // seule etape qui en a besoin (la chaine de migrations) la recoit
      // explicitement.
      ...(adminUrl ? { TF_ADMIN_URL: adminUrl } : { TF_ADMIN_URL: '' }),
      ...(sansConsentement ? {} : { TF_ALLOW_WRITE: 'oui' }),
      // Le lanceur de suite herite de la garde de cible : on lui donne une cible
      // locale jetable, deja reclassifiee par `creerBaseEphemere`.
      TF_APP_PASSWORD: motDePasseApp,
    },
  });
  let sortie = '';
  enfant.stdout.on('data', (d) => { sortie += d; });
  enfant.stderr.on('data', (d) => { sortie += d; });
  enfant.on('close', (code) => resoudre({ code, sortie }));
});

await avecBaseEphemere({
  urlProprietaire: urlAdmin,
  prefixe: 'tf_p107_mode',
  executer: async (base) => {
    console.log(`  base jetable : ${base.nom} (oid ${base.oid})`);

    const admin = new pg.Client({ connectionString: base.url, ssl: sslDepuisUrl(base.url), application_name: 'p107-mode-admin' });
    await admin.connect();

    // Le role applicatif est cree AVANT les migrations, comme en exploitation,
    // et par le script ETABLI : un `CREATE ROLE` ecrit ici donnerait un role au
    // bon nom mais pas aux bonnes ACL, et la suite mesurerait autre chose que
    // ce que le depot installe.
    //
    // Le role est un objet de CLUSTER, partage avec les autres suites : le
    // provisioning se fait donc sous le verrou de cluster, puis on le RELACHE
    // avant `migrer_fidelement.mjs` (un verrou consultatif n'est pas
    // reentrant ; le garder ferait attendre la chaine jusqu'au delai).
    let verrou = null;
    try {
      verrou = await verrouillerCluster({ urlProprietaire: base.url });
      const role = await lancer('bootstrap_app_role.mjs', [], base.url);
      if (role.code !== 0) {
        console.log(role.sortie.split('\n').slice(-5).join('\n'));
        throw new Error(`provisioning du role applicatif en echec (code ${role.code})`);
      }
    } finally {
      if (verrou) await verrou.relacher();
    }

    // TOPOLOGIE DE LA CHAINE — mesuree le 2026-11-12.
    //
    // `migrer_fidelement.mjs` exige, depuis P10.7, une identite de migration
    // NON superutilisatrice et une session d'administration DISTINCTE
    // (`TF_ADMIN_URL`) : la migration 20261028120100 fait porter les fonctions
    // systeme par `tracefab_worker`, ce qui exige un bail SET/INHERIT accorde
    // par un administrateur. Lancer la chaine sous `postgres` ne peut donc pas
    // reussir : le role n'a pas besoin d'elevation, mais les six fonctions
    // appartiennent a `tracefab_worker` et il ne peut pas endosser ce role.
    //
    // Le banc est donc monte comme la CI et comme `test:p106:rejouabilite-chaine` :
    // grantor `postgres`, administrateur CREATEROLE sans SUPERUSER, migrateur
    // CREATEROLE/BYPASSRLS sans SUPERUSER. Les mots de passe sont tires au
    // hasard pour la duree de l'execution et ne sont jamais affiches.
    //
    // Les deux roles du banc portent un suffixe aleatoire : ce sont des objets
    // de CLUSTER, et deux executions concurrentes (ou une execution interrompue)
    // ne doivent ni se heurter a un homonyme ni laisser derriere elles un role
    // fictif. Les noms sont supprimes dans le `finally` ci-dessous.
    //
    // Le role MIGRATEUR ne peut pas porter un nom quelconque : le runner
    // n'accorde le bail temporaire worker qu'a `tracefab_migrator`
    // (`migrer_fidelement.mjs`, garde fermee). Ce nom est donc impose. Comme le
    // role est un objet de CLUSTER, il peut preexister — c'est le cas en CI, ou
    // `prepare_ci_migration_roles.mjs` le cree avant la chaine avec un mot de
    // passe tire au hasard et JAMAIS publie. Aucune suite ne peut donc s'y
    // connecter sans le reapprovisionner.
    //
    // Ce fichier le fait donc, sous trois conditions qui rendent l'operation
    // inoffensive : (a) le role preexistant doit respecter le contrat du role de
    // migration (LOGIN, NOSUPERUSER, CREATEROLE, BYPASSRLS, NOCREATEDB,
    // NOREPLICATION) — sinon la suite refuse sans rien toucher, et ses
    // ATTRIBUTS ne sont jamais modifies ; (b) le mot de passe est tire au hasard
    // pour la duree de l'execution ; (c) la cible est une base jetable deja
    // classee. Ce n'est pas un contournement de la garde de cible : c'est la
    // seule facon d'obtenir une session sous l'identite que la chaine exige.
    const suffixe = randomBytes(4).toString('hex');
    const roleAdmin = `tf_p107_admin_${suffixe}`;
    const roleMigrateur = 'tracefab_migrator';
    const roleMigrateurExistant = (await admin.query(
      `SELECT rolcanlogin, rolsuper, rolcreaterole, rolbypassrls, rolinherit, rolcreatedb, rolreplication
         FROM pg_catalog.pg_roles WHERE rolname = $1`, [roleMigrateur])).rows[0];
    // Contrat aligne sur les deux bancs du depot (`prepare_ci_migration_roles.mjs`
    // cree le migrateur INHERIT, `test:p106:rejouabilite-chaine` le cree
    // NOINHERIT : les deux sont acceptes, la chaine ne depend pas de cet
    // attribut). Ce qui est refuse, c'est un role PRIVILEGIE ou connectable hors
    // contrat : la suite ne modifie jamais les attributs d'un role existant.
    if (roleMigrateurExistant
        && !(roleMigrateurExistant.rolcanlogin && !roleMigrateurExistant.rolsuper
             && roleMigrateurExistant.rolcreaterole && roleMigrateurExistant.rolbypassrls
             && !roleMigrateurExistant.rolcreatedb && !roleMigrateurExistant.rolreplication)) {
      await admin.end();
      throw new Error(`role de banc ${roleMigrateur} preexistant hors contrat (LOGIN/NOSUPERUSER/CREATEROLE/BYPASSRLS/NOCREATEDB attendu) : la suite ne le modifie pas`);
    }
    const mdpAdmin = randomBytes(32).toString('hex');
    const mdpMigrateur = randomBytes(32).toString('hex');
    let urlMigrateur = null;
    let urlAdministrateur = null;
    {
      let verrou = null;
      let connecte = false;
      try {
        verrou = await verrouillerCluster({ urlProprietaire: base.url });
        await admin.query(
          `CREATE ROLE ${roleAdmin} LOGIN PASSWORD '${mdpAdmin}' CREATEROLE BYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOREPLICATION`,
        );
        if (roleMigrateurExistant) {
          // Réapprovisionnement du mot de passe SEUL : les attributs ont ete
          // verifies ci-dessus, et aucun n'est modifie.
          await admin.query(`ALTER ROLE ${roleMigrateur} LOGIN PASSWORD '${mdpMigrateur}'`);
        } else {
          await admin.query(
            `CREATE ROLE ${roleMigrateur} LOGIN PASSWORD '${mdpMigrateur}' CREATEROLE BYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOREPLICATION`,
          );
        }
        // Le grantor est `postgres` (la session de la base jetable), distinct de
        // l'administrateur : ADMIN est ainsi transmissible sans donner SET ni
        // INHERIT a l'administrateur. C'est ce qui evite « ADMIN option cannot
        // be granted back to your own grantor ».
        await admin.query(`GRANT ${roleMigrateur} TO ${roleAdmin} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
        // `tracefab_worker` est un objet de CLUSTER. Il peut donc preexister a
        // cette execution (autre suite du meme banc, execution precedente). Dans
        // ce cas son grantor n'est pas l'administrateur fraichement cree, qui
        // n'en detient alors aucune option : `migrer_fidelement` refuse, a juste
        // titre, de fournir un bail qu'il ne peut pas accorder. On delegue donc
        // ADMIN depuis la session d'administration du cluster — ADMIN SEUL, sans
        // SET ni INHERIT, comme `prepare_ci_migration_roles.mjs` le fait pour
        // `tracefab_migrator`.
        await admin.query(`
          DO $worker$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
              EXECUTE 'CREATE ROLE tracefab_worker NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION';
            END IF;
          END
          $worker$`);
        await admin.query(`GRANT tracefab_worker TO ${roleAdmin} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
        connecte = true;
      } finally {
        if (verrou) await verrou.relacher();
      }
      if (connecte) {
        // Meme prerequis administratif que la CI et que les autres bancs : le
        // role de migration est proprietaire du schema public (la premiere
        // migration pose `COMMENT ON SCHEMA`, qui exige cette propriete) et
        // dispose de CREATE sur la base jetable. Aucun SUPERUSER.
        await admin.query(`GRANT CREATE ON DATABASE ${base.nom} TO ${roleMigrateur}`);
        await admin.query(`ALTER SCHEMA public OWNER TO ${roleMigrateur}`);
        const avecIdentite = (identite, mdp) => {
          const u = new URL(base.url);
          u.username = identite;
          u.password = mdp;
          return u.toString();
        };
        urlAdministrateur = avecIdentite(roleAdmin, mdpAdmin);
        urlMigrateur = avecIdentite(roleMigrateur, mdpMigrateur);
      }
    }

    try {
      /* --- mise en place : la chaine, puis ce qu'une migration ne peut pas faire --- */
      console.log('\n  mise en place');
      // La cible a deja ete classee et PROUVEE (OID + identite de cluster) par
      // `creerBaseEphemere` : la garde de `migrer_fidelement` n'a plus rien a
      // decider, et le consentement d'ecriture est explicite.
      const migration = urlMigrateur
        ? await lancer('migrer_fidelement.mjs', [], urlMigrateur, { adminUrl: urlAdministrateur })
        : { code: 1, sortie: 'topologie de migration non montee' };
      ok(migration.code === 0, 'la chaine complete s applique SANS aucune cle (c est le point de la correction)',
        migration.code === 0 ? 'code 0' : `code ${migration.code}`);
      if (migration.code !== 0) {
        console.log(migration.sortie.split('\n').slice(-8).join('\n'));
        return;
      }

      const apresChaine = (await admin.query(
        `SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton`)).rows[0];
      ok(apresChaine?.systeme_strict === false,
        'une base neuve sort en mode PERMISSIF (la migration n active rien)', String(apresChaine?.systeme_strict));

      // Provisionner une cle est une ecriture d'operateur : c'est exactement ce
      // que cette suite doit eprouver, donc elle le fait, comme un operateur.
      const cleActive = randomBytes(32);
      await admin.query(
        `INSERT INTO public.tracefab_identity_cles (version, secret, actif) VALUES (90001, $1, true)`,
        [cleActive]);

      const urlApp = deriverUrl(base.url, base.nom).replace(/\/\/[^@]*@/, `//tracefab_app:${encodeURIComponent(motDePasseApp)}@`);
      const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp), application_name: 'p107-mode-runtime' });
      await app.connect();

      /** Une operation systeme qui ecrit : si elle passe, l'escalade est ouverte. */
      const tentativeEscalade = async (jeton) => {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('tracefab.identity_systeme', $1, true)`, [jeton ?? '']);
          await app.query(`SELECT set_config('tracefab.identity', '', true)`);
          // Un appel qui aboutit SE TERMINE par COMMIT : c'est ce qui rend la
          // mesure sans ambiguite — soit l'ecriture est refusee, soit elle est
          // validee. Un ROLLBACK systematique prouverait seulement que la
          // fonction a ete appelee.
          await app.query(`SELECT public.tracefab_sync_clerk_organization('org_p107_mode', 'l', 'd', 'brand'::organization_type)`);
          await app.query('COMMIT');
          return { accepte: true };
        } catch (erreur) {
          try { await app.query('ROLLBACK'); } catch { /* rien a defaire */ }
          return { accepte: false, code: erreur.code, message: String(erreur.message).split('\n')[0] };
        }
      };

      const compterOrganisations = async () => (await admin.query(
        `SELECT count(*)::int AS n FROM organizations WHERE clerk_organization_id = 'org_p107_mode'`)).rows[0].n;

      /* --- A. l'activation ferme reellement --------------------------------- */
      console.log('\n  A. activation, puis mesure de la fermeture');

      // AVANT : en mode permissif l'operation doit PASSER sans jeton. Sans ce
      // temoin, un « refus » constate apres activation pourrait venir de
      // n'importe quoi d'autre — un role sans EXECUTE, une fonction absente.
      const avant = await tentativeEscalade(null);
      ok(avant.accepte, 'temoin : en mode PERMISSIF, l operation passe SANS jeton (le defaut est bien la)',
        avant.accepte ? 'ACCEPTEE' : `refusee ${avant.code}`);
      const organisationsAvant = await compterOrganisations();
      ok(organisationsAvant === 1, 'temoin : l appel permissif a bien ecrit une organisation',
        `${organisationsAvant} ligne(s)`);
      await admin.query(`DELETE FROM organizations WHERE clerk_organization_id = 'org_p107_mode'`);

      const activation = await lancer('activer_identite_systeme_stricte.mjs', ['--activer'], base.url);
      ok(activation.code === 0, 'activation : code 0', `code ${activation.code}`);
      if (activation.code !== 0) console.log(activation.sortie.split('\n').slice(-8).join('\n'));

      const mode = (await admin.query(
        `SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton`)).rows[0].systeme_strict;
      ok(mode === true, 'activation : le mode est pose en base', String(mode));

      const apres = await tentativeEscalade(null);
      ok(!apres.accepte && apres.code === '42501',
        'APRES activation : la meme operation SANS jeton est refusee en 42501',
        apres.accepte ? 'ACCEPTEE — la faille est ouverte' : apres.code);
      ok(await compterOrganisations() === 0, 'APRES activation : aucune organisation ecrite',
        `${await compterOrganisations()} ligne(s)`);

      // PREREQUIS ADMINISTRATIF DE LA VERIFICATION SIGNEE — EXACTEMENT celui que
      // `scripts/provisionner_roles_db.mjs` documente depuis le 02/11, dans la
      // forme mesurable ici.
      //
      // `pgcrypto` est cree par la PREMIERE migration (`CREATE EXTENSION IF NOT
      // EXISTS`), donc dans la transaction de celle-ci, donc avec l'identite qui
      // applique la chaine : le role de migration est proprietaire de
      // l'EXTENSION, mais PAS des fonctions qu'elle installe — mesure du
      // 2026-11-12, `pg_get_userbyid(proowner)` rend `postgres` pour
      // `hmac(bytea,bytea,text)` et pour `hmac(text,text,text)`.
      //
      // Consequence : la migration de durcissement du 02/11 n'a pas pu retirer
      // l'EXECUTE de `hmac` a PUBLIC (elle ne possede pas la fonction), et le
      // proprietaire du verificateur SECURITY DEFINER — le role de migration —
      // ne peut plus l'appeler. Mesure : « 42501 permission denied for function
      // hmac » sur le chemin LEGITIME, dans les DEUX modes. Une base ou le
      // chemin legitime est casse ne mesure pas la fermeture du mode strict :
      // elle mesure une panne.
      //
      // Le STRICT necessaire au proprietaire du verificateur, et rien de plus.
      // Aucun droit n'est accorde au runtime : `tracefab_app` reste sans EXECUTE
      // sur l'extension. Meme prerequis, et meme assertion, que le bootstrap de
      // la CI (`scripts/prepare_ci_migration_roles.mjs`).
      await admin.query('REVOKE EXECUTE ON FUNCTION public.hmac(bytea, bytea, text) FROM PUBLIC');
      await admin.query(`GRANT EXECUTE ON FUNCTION public.hmac(bytea, bytea, text) TO ${roleMigrateur}`);
      ok((await admin.query(
        `SELECT pg_catalog.has_function_privilege($1, 'public.hmac(bytea,bytea,text)', 'EXECUTE') AS mig,
                pg_catalog.has_function_privilege('tracefab_app', 'public.hmac(bytea,bytea,text)', 'EXECUTE') AS app`,
        [roleMigrateur])).rows[0].mig === true,
        'prerequis : le proprietaire du verificateur peut appeler hmac');
      ok((await admin.query(
        `SELECT pg_catalog.has_function_privilege('tracefab_app', 'public.hmac(bytea,bytea,text)', 'EXECUTE') AS app`)).rows[0].app === false,
        'prerequis : le runtime N obtient PAS EXECUTE sur hmac');

      const jeton = signerJetonSysteme({ cle: cleActive.toString('hex'), expiration: Math.floor(Date.now() / 1000) + 60 });
      const legitime = await tentativeEscalade(jeton);
      ok(legitime.accepte,
        'APRES activation : le chemin LEGITIME (jeton systeme signe) fonctionne toujours',
        legitime.accepte ? 'ACCEPTEE' : `refusee ${legitime.code} ${legitime.message ?? ''}`);
      await admin.query(`DELETE FROM organizations WHERE clerk_organization_id = 'org_p107_mode'`);

      /* --- B. l'activation refuse quand elle doit --------------------------- */
      console.log('\n  B. prerequis : l outil refuse plutot que de produire une panne');

      await admin.query(`UPDATE public.tracefab_identity_cles SET actif = false`);
      await lancer('activer_identite_systeme_stricte.mjs', ['--desactiver'], base.url);
      const sansCle = await lancer('activer_identite_systeme_stricte.mjs', ['--activer'], base.url);
      ok(sansCle.code === 3, 'sans cle active : refus code 3', `code ${sansCle.code}`);
      ok(/prerequis : au moins une cle d identite ACTIVE/.test(sansCle.sortie),
        'le refus NOMME le prerequis manquant');
      const modeInchange = (await admin.query(
        `SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton`)).rows[0].systeme_strict;
      ok(modeInchange === false, 'sans cle active : le mode n a PAS ete modifie', String(modeInchange));
      await admin.query(`UPDATE public.tracefab_identity_cles SET actif = true`);

      // Une operation non gardee : l'outil doit voir la sonde, pas la supposer.
      // On retire la garde d'UNE fonction, dans la base jetable seulement, et on
      // la remet ensuite : c'est un controle negatif local, pas une modification
      // du depot.
      const definition = (await admin.query(
        `SELECT pg_get_functiondef('public.tracefab_archive_clerk_organization(text)'::regprocedure) AS d`)).rows[0].d;
      const sansGarde = definition.replace(/IF NOT public\.tracefab_identite_systeme\(\) THEN[\s\S]*?END IF;/,
        'IF false THEN RAISE EXCEPTION \'controle_negatif\'; END IF;');
      ok(sansGarde !== definition, 'controle negatif : la garde a pu etre retiree de la definition');
      await admin.query(sansGarde);
      const nonGarde = (await admin.query(`SELECT * FROM public.tracefab_sec_probe_identite_systeme()`)).rows[0];
      ok(nonGarde.operations_systeme_non_gardees === 1,
        'controle negatif : la sonde voit l operation non gardee', `${nonGarde.operations_systeme_non_gardees}`);
      const refusGarde = await lancer('activer_identite_systeme_stricte.mjs', ['--activer'], base.url);
      ok(refusGarde.code === 3, 'operation non gardee : refus code 3', `code ${refusGarde.code}`);
      ok(/chaque operation systeme porte la garde d origine/.test(refusGarde.sortie),
        'le refus NOMME le prerequis « garde d origine »');
      await admin.query(definition);
      ok((await admin.query(`SELECT * FROM public.tracefab_sec_probe_identite_systeme()`)).rows[0]
        .operations_systeme_non_gardees === 0, 'controle negatif : la garde est restauree');

      /* --- C. le retour arriere restaure l'etat ------------------------------ */
      console.log('\n  C. retour arriere');

      const activation2 = await lancer('activer_identite_systeme_stricte.mjs', ['--activer'], base.url);
      ok(activation2.code === 0, 'activation apres restauration : code 0', `code ${activation2.code}`);
      const desactivation = await lancer('activer_identite_systeme_stricte.mjs', ['--desactiver'], base.url);
      ok(desactivation.code === 0, 'desactivation : code 0', `code ${desactivation.code}`);
      ok((await admin.query(`SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton`))
        .rows[0].systeme_strict === false, 'desactivation : le mode est revenu a false');

      // Le retour arriere ne doit pas casser le chemin legitime : un jeton signe
      // reste accepte AVANT comme APRES la bascule. C'est la propriete qui rend
      // la decision reversible sans risque d'interruption.
      const jetonLegitime = await tentativeEscalade(signerJetonSysteme({
        cle: cleActive.toString('hex'), expiration: Math.floor(Date.now() / 1000) + 60,
      }));
      if (!jetonLegitime.accepte) console.log('  DIAG legitime:', jetonLegitime.code, jetonLegitime.message);
      ok(jetonLegitime.accepte, 'en mode permissif, le jeton signe est toujours accepte');
      await admin.query(`DELETE FROM organizations WHERE clerk_organization_id = 'org_p107_mode'`);

      // Idempotence : rejouer la desactivation ne doit pas produire d'erreur, et
      // doit dire qu'il n'y avait rien a faire.
      const rejoue = await lancer('activer_identite_systeme_stricte.mjs', ['--desactiver'], base.url);
      ok(rejoue.code === 0, 'desactivation rejouee : code 0', `code ${rejoue.code}`);

      // Et la verification en lecture seule rapporte l'etat, sans ecrire.
      const verif = await lancer('activer_identite_systeme_stricte.mjs', ['--verifier'], base.url, { sansConsentement: true });
      ok(verif.code === 0 && /mode systeme strict \.+ false/.test(verif.sortie),
        'verification : elle rapporte le mode sans ecrire');

      await app.end();
    } finally {
      // Les deux roles du banc sont des objets de CLUSTER : sans ce nettoyage,
      // chaque execution laisserait deux roles derriere elle. Le nom porte un
      // suffixe aleatoire, donc une suppression qui echoue (role encore
      // proprietaire d'un objet, execution concurrente) ne peut pas atteindre
      // autre chose que ce que cette execution a cree.
      // L'administrateur est TOUJOURS cree par cette suite : il est supprime.
      // `tracefab_migrator` n'est supprime que si cette suite l'a cree : un role
      // preexistant (CI) ne lui appartient pas, et le detruire casserait le banc
      // pour les suites suivantes du meme job.
      const rolesACreer = roleMigrateurExistant ? [roleAdmin] : [roleAdmin, roleMigrateur];
      for (const role of rolesACreer) {
        try {
          await admin.query(`DROP OWNED BY ${role} CASCADE`);
          await admin.query(`DROP ROLE IF EXISTS ${role}`);
        } catch (e) {
          console.log(`  remarque : role de banc ${role} non supprime — ${String(e.message).split('\n')[0]}`);
        }
      }
      await admin.end();
    }
  },
});

console.log(`\n  P10.7 — activation du mode strict systeme : ${assertions - echecs}/${assertions} assertions vertes`);
if (echecs > 0) console.log(`  ${echecs} echec(s)`);
process.exit(echecs === 0 ? 0 : 1);
