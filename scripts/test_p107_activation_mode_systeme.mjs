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
const lancer = (script, args, url, { sansConsentement = false } = {}) => new Promise((resoudre) => {
  const enfant = spawn(process.execPath, [join(RACINE, 'scripts', script), ...args], {
    cwd: RACINE,
    env: {
      ...process.env,
      DATABASE_ADMIN_URL: url,
      DATABASE_URL: url,
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

    try {
      /* --- mise en place : la chaine, puis ce qu'une migration ne peut pas faire --- */
      console.log('\n  mise en place');
      // La cible a deja ete classee et PROUVEE (OID + identite de cluster) par
      // `creerBaseEphemere` : la garde de `migrer_fidelement` n'a plus rien a
      // decider, et le consentement d'ecriture est explicite.
      const migration = await lancer('migrer_fidelement.mjs', [], base.url);
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
      ok((await tentativeEscalade(signerJetonSysteme({
        cle: cleActive.toString('hex'), expiration: Math.floor(Date.now() / 1000) + 60,
      }))).accepte, 'en mode permissif, le jeton signe est toujours accepte');
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
      await admin.end();
    }
  },
});

console.log(`\n  P10.7 — activation du mode strict systeme : ${assertions - echecs}/${assertions} assertions vertes`);
if (echecs > 0) console.log(`  ${echecs} echec(s)`);
process.exit(echecs === 0 ? 0 : 1);
