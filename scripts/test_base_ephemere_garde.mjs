#!/usr/bin/env node
/**
 * La garde des bases ephemere, PROUVEE — y compris par ses echecs.
 *
 * Ce test existe parce que la garde protege d'un effacement irreversible. Une
 * garde qu'on n'a jamais vue refuser ne protege de rien : chacun des controles
 * ci-dessous est donc double d'un TEMOIN qui montre que la propriete serait
 * fausse sans elle.
 *
 * CE QUI EST PROUVE
 *   1. les noms sont uniques, conformes (minuscules, [a-z0-9_]) et tiennent en
 *      63 OCTETS ;
 *   2. une base PREEXISTANTE portant le nom candidat n'est JAMAIS detruite :
 *      la garde prend un autre nom et la base homonyme garde ses donnees ;
 *   3. deux executions PARALLELES n'aboutissent pas a la meme base ;
 *   4. la destruction ne vise que l'OID cree : si le nom a ete recycle entre
 *      temps, la garde REFUSE de detruire ;
 *   5. la connexion de maintenance et la connexion de travail sont verifiees
 *      comme etant le MEME cluster (system_identifier identique) ;
 *   6. le nettoyage a lieu dans un `finally`, meme quand la suite echoue.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import {
  nomBaseEphemere,
  deriverUrl,
  creerBaseEphemere,
  avecBaseEphemere,
} from './lib/ephemeral-db.mjs';

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
  purpose: 'garde des bases ephemere — unicite, preuve de propriete, nettoyage',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;

async function maintenance() {
  const url = deriverUrl(urlProprietaire, 'postgres');
  const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await c.connect();
  return c;
}

async function existe(nom) {
  const c = await maintenance();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [nom]);
    return r.rowCount > 0;
  } finally {
    await c.end();
  }
}

async function oidDe(nom) {
  const c = await maintenance();
  try {
    const r = await c.query('SELECT oid FROM pg_database WHERE datname = $1', [nom]);
    return r.rows[0]?.oid ?? null;
  } finally {
    await c.end();
  }
}

/* --- 1. Generation des noms ----------------------------------------------- */
console.log("\n  A. Noms generes — unicite, conformite, limite en octets");

{
  const noms = new Set();
  for (let i = 0; i < 200; i += 1) noms.add(nomBaseEphemere('tf_test'));
  verifier('200 generations donnent 200 noms distincts', noms.size === 200, `${noms.size}`);

  const tous = [...noms];
  verifier(
    'aucun nom ne depasse 63 octets',
    tous.every((n) => Buffer.byteLength(n, 'utf8') <= 63),
    `max=${Math.max(...tous.map((n) => Buffer.byteLength(n, 'utf8')))} octets`,
  );
  verifier(
    'tous les noms sont des identifiants surs (minuscules, [a-z0-9_], sans tiret)',
    tous.every((n) => /^[a-z][a-z0-9_]*$/.test(n)),
    tous.find((n) => !/^[a-z][a-z0-9_]*$/.test(n)),
  );
  verifier(
    'aucun nom ne se termine par un separateur',
    tous.every((n) => !n.endsWith('_')),
  );

  // Un prefixe tres long doit etre tronque, pas rejete par PostgreSQL.
  const long = nomBaseEphemere('tf_' + 'x'.repeat(120));
  verifier(
    'un prefixe de 120 caracteres est tronque a 63 octets',
    Buffer.byteLength(long, 'utf8') <= 63 && /^[a-z][a-z0-9_]*$/.test(long),
    `${long} (${Buffer.byteLength(long, 'utf8')} octets)`,
  );
  // Un prefixe accentue compte en octets, pas en caracteres.
  const accentue = nomBaseEphemere('tf_' + 'é'.repeat(60));
  verifier(
    'un prefixe accentue reste sous 63 octets',
    Buffer.byteLength(accentue, 'utf8') <= 63,
    `${Buffer.byteLength(accentue, 'utf8')} octets`,
  );
}

/* --- 2. Une base homonyme n'est jamais detruite --------------------------- */
console.log("\n  B. Collision de nom — la base preexistante survit, avec ses donnees");

{
  const m = await maintenance();
  const homonyme = nomBaseEphemere('tf_collision');
  await m.query(`CREATE DATABASE "${homonyme}"`);
  await m.end();

  // On y depose une donnee metier, comme le ferait une base reelle.
  const urlVictime = deriverUrl(urlProprietaire, homonyme);
  const v = new pg.Client({ connectionString: urlVictime, ssl: sslDepuisUrl(urlVictime) });
  await v.connect();
  await v.query('CREATE TABLE preuve(id int primary key, libelle text)');
  await v.query("INSERT INTO preuve VALUES (1, 'ne doit pas disparaitre')");
  await v.end();

  // La garde est FORCEE de proposer ce nom : c'est exactement le scenario du
  // nom fixe. Elle doit refuser de le prendre, pas le detruire.
  let essais = 0;
  const base = await creerBaseEphemere({
    urlProprietaire,
    prefixe: 'tf_collision',
    generateurNom: () => {
      essais += 1;
      return essais === 1 ? homonyme : nomBaseEphemere('tf_collision_repli');
    },
  });

  verifier('la garde a change de nom au lieu de reutiliser l homonyme', base.nom !== homonyme, base.nom);
  verifier('elle a bien tente le nom occupe d abord', essais >= 2, `${essais} essais`);

  verifier('la base homonyme existe toujours', await existe(homonyme));

  // Et sa donnee est intacte : c'est la seule preuve qui compte.
  const v2 = new pg.Client({ connectionString: urlVictime, ssl: sslDepuisUrl(urlVictime) });
  await v2.connect();
  const d = await v2.query('SELECT libelle FROM preuve');
  await v2.end();
  verifier(
    'la donnee de la base homonyme est intacte',
    d.rowCount === 1 && d.rows[0].libelle === 'ne doit pas disparaitre',
    JSON.stringify(d.rows),
  );

  // TEMOIN : sans la garde, le `DROP ... IF EXISTS` du code d'origine detruit
  // bien cette base. On le montre, puis on la reconstitue.
  const tem = await maintenance();
  await tem.query(`DROP DATABASE IF EXISTS "${homonyme}"`);
  await tem.query(`CREATE DATABASE "${homonyme}"`);
  await tem.end();
  const v3 = new pg.Client({ connectionString: urlVictime, ssl: sslDepuisUrl(urlVictime) });
  await v3.connect();
  const apres = await v3.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name = 'preuve'`);
  await v3.end();
  verifier(
    'TEMOIN : un DROP IF EXISTS inconditionnel efface bien la base homonyme',
    apres.rows[0].n === 0,
    'la table preuve a disparu — c est le defaut corrige',
  );

  // La base creee par la garde est detruite proprement, pas l'homonyme.
  await base.fermer();
  verifier('la base creee par la garde est detruite par fermer()', !(await existe(base.nom)));
  verifier("l homonyme n a pas ete emporte par le nettoyage", await existe(homonyme));

  const fin = await maintenance();
  await fin.query(`DROP DATABASE IF EXISTS "${homonyme}"`);
  await fin.end();
}

/* --- 3. Executions paralleles -------------------------------------------- */
console.log("\n  C. Executions paralleles — aucune ne partage la base d une autre");

{
  // Les creations sont suivies au fur et a mesure : si l'une echoue, les autres
  // ne doivent pas rester derriere. Une fuite de base n'est pas un detail sur un
  // runner de CI, c'est de l'espace disque perdu a chaque execution.
  const creees = [];
  const creer = async (options) => {
    const b = await creerBaseEphemere(options);
    creees.push(b);
    return b;
  };
  let bases = [];
  try {
  bases = await Promise.all(
    Array.from({ length: 6 }, () => creer({ urlProprietaire, prefixe: 'tf_parallele' })),
  );
  const noms = new Set(bases.map((b) => b.nom));
  const oids = new Set(bases.map((b) => b.oid));
  verifier('6 creations simultanees donnent 6 bases distinctes', noms.size === 6, `${noms.size}`);
  verifier('et 6 OID distincts', oids.size === 6, `${oids.size}`);

  // Chacune est reellement joignable et est bien la sienne.
  const joignables = [];
  for (const b of bases) {
    const c = new pg.Client({ connectionString: b.url, ssl: sslDepuisUrl(b.url) });
    await c.connect();
    const r = await c.query('SELECT current_database() d, oid FROM pg_database WHERE datname = current_database()');
    joignables.push(String(r.rows[0].oid) === b.oid);
    await c.end();
  }
  verifier('chaque URL pointe bien sa propre base (OID verifie)', joignables.every(Boolean));

  // TEMOIN de collision reelle : deux CREATE concurrents sur le MEME nom.
  // La garde transforme le 42P04 en nouvel essai, jamais en suppression.
  const m = await maintenance();
  const nomForce = nomBaseEphemere('tf_collision_parallele');
  let tours = 0;
  const deux = await Promise.all([
    creer({
      urlProprietaire, prefixe: 'tf_collision_parallele',
      generateurNom: () => (tours += 1) === 1 ? nomForce : nomBaseEphemere('tf_repli_a'),
    }),
    creer({
      urlProprietaire, prefixe: 'tf_collision_parallele',
      generateurNom: () => (tours += 1) === 2 ? nomForce : nomBaseEphemere('tf_repli_b'),
    }),
  ]);
  verifier(
    'deux creations concurrentes du meme nom aboutissent a deux bases distinctes',
    deux[0].nom !== deux[1].nom,
    `${deux[0].nom} / ${deux[1].nom}`,
  );
  verifier('aucune des deux n a supprime l autre', await existe(deux[0].nom) && await existe(deux[1].nom));
  const compte = await m.query('SELECT count(*)::int n FROM pg_database WHERE datname = $1', [nomForce]);
  verifier('le nom force existe une seule fois au plus', compte.rows[0].n <= 1, `${compte.rows[0].n}`);
  await m.end();

  for (const b of bases) await b.fermer();
  for (const b of deux) await b.fermer();
  const restants = (await Promise.all([...noms].map(existe))).filter(Boolean).length;
  verifier('toutes les bases paralleles ont ete detruites', restants === 0, `${restants} restantes`);
  } finally {
    for (const b of creees) await b.fermer().catch(() => {});
  }
}

/* --- 4. Preuve de propriete : refus de detruire une base recyclee -------- */
console.log("\n  D. Propriete — une base dont l OID a change n est jamais detruite");

{
  const base = await creerBaseEphemere({ urlProprietaire, prefixe: 'tf_recycle' });
  const nom = base.nom;

  // On simule un recyclement : quelqu'un supprime la base et en recree une du
  // meme nom. L'OID change forcement.
  const m = await maintenance();
  await m.query(`DROP DATABASE "${nom}"`);
  await m.query(`CREATE DATABASE "${nom}"`);
  const nouvelOid = await oidDe(nom);
  await m.end();

  verifier('l OID a bien change apres recyclement', String(nouvelOid) !== base.oid, `${base.oid} -> ${nouvelOid}`);

  let refus = null;
  try {
    await base.fermer();
  } catch (e) {
    refus = e.message;
  }
  verifier('fermer() REFUSE de detruire une base dont l OID a change', refus !== null, refus ?? 'aucune erreur');
  verifier('et la base recyclee est toujours la', await existe(nom));

  const fin = await maintenance();
  await fin.query(`DROP DATABASE IF EXISTS "${nom}"`);
  await fin.end();
}

/* --- 5. Meme cluster ------------------------------------------------------ */
console.log("\n  E. Maintenance et travail — meme serveur, meme cluster");

{
  const base = await creerBaseEphemere({ urlProprietaire, prefixe: 'tf_cluster' });
  const urlM = deriverUrl(urlProprietaire, 'postgres');
  const cm = new pg.Client({ connectionString: urlM, ssl: sslDepuisUrl(urlM) });
  await cm.connect();
  const ct = new pg.Client({ connectionString: base.url, ssl: sslDepuisUrl(base.url) });
  await ct.connect();
  const q = `SELECT (SELECT system_identifier FROM pg_control_system()) sid,
                    inet_server_addr()::text a, inet_server_port() p, current_database() d`;
  const rm = (await cm.query(q)).rows[0];
  const rt = (await ct.query(q)).rows[0];
  await cm.end();
  await ct.end();

  verifier(
    'maintenance et travail rapportent le MEME system_identifier',
    String(rm.sid) === String(rt.sid),
    `${rm.sid} / ${rt.sid}`,
  );
  verifier('meme adresse et meme port', rm.a === rt.a && rm.p === rt.p, `${rm.a}:${rm.p} / ${rt.a}:${rt.p}`);
  verifier('la connexion de travail est bien dans la base creee', rt.d === base.nom, rt.d);
  verifier(
    'l identite publiee par la garde correspond a la mesure',
    base.identite.systemIdentifier === String(rt.sid),
  );
  verifier(
    'une base differente a le meme system_identifier : c est le cluster, pas la base, qui est compare',
    rm.d !== rt.d && String(rm.sid) === String(rt.sid),
    `${rm.d} vs ${rt.d}`,
  );
  await base.fermer();
}

/* --- 6. Nettoyage dans finally ------------------------------------------- */
console.log("\n  F. Nettoyage garanti — meme quand la suite echoue");

{
  let nomCree = null;
  let propage = null;
  try {
    await avecBaseEphemere({
      urlProprietaire,
      prefixe: 'tf_finally',
      executer: async (base) => {
        nomCree = base.nom;
        throw new Error('echec volontaire de la suite');
      },
    });
  } catch (e) {
    propage = e.message;
  }
  verifier("l echec de la suite est bien propage", propage === 'echec volontaire de la suite', propage);
  verifier('la base creee a ete detruite malgre l echec', nomCree !== null && !(await existe(nomCree)), nomCree);

  // Et en cas de succes, elle est detruite aussi.
  let nomSucces = null;
  const valeur = await avecBaseEphemere({
    urlProprietaire,
    prefixe: 'tf_finally_ok',
    executer: async (base) => { nomSucces = base.nom; return 42; },
  });
  verifier('la valeur de retour traverse la garde', valeur === 42, String(valeur));
  verifier('la base est detruite apres un succes', nomSucces !== null && !(await existe(nomSucces)), nomSucces);
}

/* --- 7. La cible est refusee avant toute creation ------------------------ */
console.log("\n  G. Refus en amont — aucune base n est creee sur une cible refusee");

{
  let erreur = null;
  try {
    await creerBaseEphemere({
      urlProprietaire: 'postgresql://postgres@db.example.neon.tech/prod',
      prefixe: 'tf_refus',
    });
  } catch (e) {
    erreur = e.message;
  }
  verifier(
    'un hote manage est refuse avant toute connexion',
    erreur !== null && /non autorisee|maintenance refusee/.test(erreur),
    erreur ?? 'aucune erreur',
  );
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' ; ')}`);
  process.exit(1);
}
console.log('  ok — la garde ne peut detruire que ce qu elle a cree.');
process.exit(0);
