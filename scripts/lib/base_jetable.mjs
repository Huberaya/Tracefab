/**
 * Remise a zero d'une base de test FIXE — sans jamais detruire ce qui n'est pas
 * a nous.
 *
 * POURQUOI CE MODULE
 *
 * Deux scripts d'integration (`scripts/audit_sql_privileges_catalog.sh` et
 * `scripts/test_migration_integration_34_36_41.sh`) portaient exactement le
 * defaut corrige sur les bases ephemeres le 29/10, et sur les roles le 30/10 :
 *
 *     psql -d postgres -c "DROP DATABASE IF EXISTS tracefab_test;"
 *     psql -d postgres -c "CREATE DATABASE tracefab_test OWNER postgres;"
 *
 * Le nom est FIXE et le `DROP` precede TOUT controle. Sur un poste de
 * developpement, une base `tracefab_test` qui contient 66 migrations, des
 * fixtures et deux jours de travail est donc detruite par un script dont le
 * seul contrat annonce est « je remets la base de test a zero ». Le preflight
 * du shell script ne protege pas : il declare la CIBLE jetable
 * (`TF_INTEGRATION_THROWAWAY=oui`), il ne prouve pas que CETTE base-la est
 * jetable.
 *
 * CE QUE CE MODULE GARANTIT
 *
 *   1. NOM AUTORISE, liste fermee : `tracefab_test` (le nom du depot) ou un nom
 *      `tf_*`. Un test ne peut donc pas viser autre chose par cette porte.
 *   2. CIBLE RECLASIEE ici, par `require-throwaway-db.mjs`, et non seulement
 *      par l'appelant : un script shell qui exporterait une URL distante est
 *      refuse, y compris s'il a oublie son propre preflight.
 *   3. DESTRUCTION SEULEMENT SI LA BASE EST A NOUS :
 *        — soit elle porte la MARQUE posee par ce module (`COMMENT ON DATABASE`) ;
 *        — soit elle est VIDE (aucune relation hors catalogues systeme), ce qui
 *          est le cas d'une base fraichement creee par le service PostgreSQL de
 *          la CI. Une base vide n'a rien a perdre, et elle est marquee en
 *          sortie, donc la fois suivante la preuve est explicite.
 *      Une base PREEXISTANTE qui contient la moindre table est CONSERVEE : le
 *      module refuse (sortie 2) sans avoir rien modifie.
 *   4. PREUVE D'OID : l'OID de la base est relu juste avant le `DROP`, et la
 *      destruction est refusee si ce n'est plus celui observe (base supprimee
 *      puis recreee entre-temps par quelqu'un d'autre).
 *   5. VERROU DE CLUSTER pendant la sequence : deux scripts d'integration
 *      lances en parallele sur le meme serveur ne peuvent pas se re-creer la
 *      base sous les pieds.
 *
 * CE QUE CE MODULE NE FAIT PAS
 *
 * Il ne supprime AUCUNE base dont il n'a pas prouve la nature. Le refus est le
 * comportement par defaut, et il est explicite (message + code de sortie 2).
 */
import pg from 'pg';
import { sslDepuisUrl } from './pg-ssl.mjs';
import { classifyTarget } from './require-throwaway-db.mjs';
import { avecVerrouDeCluster, deriverUrl, identiteServeur, verrouillerCluster } from './ephemeral-db.mjs';
import { enregistrerRessource } from './manifeste_jetable.mjs';

/** Marque posee sur la base : sa presence autorise la destruction. */
export const MARQUE = 'tracefab:base-jetable';

const BASE_MAINTENANCE = 'postgres';
const NOM_SIMPLE = /^[a-z][a-z0-9_]*$/;

export const EXIT_REFUS = 2;

/** Refus explicite : la base visee n'est pas prouvee jetable. Rien n'a ete fait. */
export class BaseJetableRefusee extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaseJetableRefusee';
    this.code = 'TF_BASE_REFUSEE';
    this.exitCode = EXIT_REFUS;
  }
}

function ident(nom) {
  if (!NOM_SIMPLE.test(nom)) throw new BaseJetableRefusee(`nom de base refuse : ${nom}`);
  return `"${nom}"`;
}

/** Liste fermee des noms que ce module accepte de manipuler. */
export function nomAutorise(nom) {
  return nom === 'tracefab_test' || /^tf_[a-z0-9_]+$/.test(nom);
}

async function ouvrir(url) {
  const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await client.connect();
  return client;
}

/**
 * Etat de la base vue du cluster : OID et marque.
 * Aucune donnee n'est publiee, seulement ces deux jetons.
 */
export async function etatBase(urlProprietaire, nom) {
  const urlMaintenance = deriverUrl(urlProprietaire, BASE_MAINTENANCE);
  const client = await ouvrir(urlMaintenance);
  try {
    const { rows } = await client.query(
      `SELECT d.oid, shobj_description(d.oid, 'pg_database') AS marque
         FROM pg_database d WHERE d.datname = $1`,
      [nom],
    );
    if (rows.length === 0) return null;
    return { oid: String(rows[0].oid), marque: rows[0].marque ?? null };
  } finally {
    await client.end();
  }
}

/**
 * La base est-elle vide de tout objet utilisateur ?
 *
 * Seules les relations sont comptees (`r`,`p`,`v`,`m`,`S`,`f`) hors catalogues
 * systeme : un schema `public` vide, une extension installee par le modele ne
 * font pas obstacle. Une seule table suffit a refuser.
 */
async function baseVide(urlProprietaire, nom) {
  const url = deriverUrl(urlProprietaire, nom);
  const verdict = classifyTarget(url);
  if (!verdict.allowed) {
    throw new BaseJetableRefusee(`connexion a ${nom} refusee (${verdict.code})`);
  }
  const client = await ouvrir(url);
  try {
    const { rows } = await client.query(`
      SELECT count(*)::int AS n
        FROM pg_class c
        JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
         AND nsp.nspname NOT IN ('pg_catalog', 'information_schema')
         AND nsp.nspname NOT LIKE 'pg\\_toast%'
         AND nsp.nspname NOT LIKE 'pg\\_temp%'`);
    return rows[0].n === 0;
  } finally {
    await client.end();
  }
}

/**
 * Remet la base a zero, ou refuse.
 *
 * @param {object} options
 * @param {string} options.urlProprietaire URL deja classee (proprietaire)
 * @param {string} [options.nom] `tracefab_test` ou `tf_*`
 * @returns {Promise<{nom: string, oidAvant: string|null, oidApres: string,
 *                    action: 'creee'|'recreee', adoption: string}>}
 */
export async function reinitialiserBaseJetable({ urlProprietaire, nom = 'tracefab_test' }) {
  if (!nomAutorise(nom)) {
    throw new BaseJetableRefusee(
      `nom de base hors liste fermee (${nom}) — seuls tracefab_test et tf_* sont acceptes`,
    );
  }
  const verdictSource = classifyTarget(urlProprietaire);
  if (!verdictSource.allowed) {
    throw new BaseJetableRefusee(`source non autorisee (${verdictSource.code}) — rien n'a ete modifie`);
  }
  const urlMaintenance = deriverUrl(urlProprietaire, BASE_MAINTENANCE);
  const verdictMaintenance = classifyTarget(urlMaintenance);
  if (!verdictMaintenance.allowed) {
    throw new BaseJetableRefusee(`maintenance refusee (${verdictMaintenance.code}) — rien n'a ete modifie`);
  }

  // Deux scripts d'integration en parallele ne doivent pas se recreer la base
  // sous les pieds : la sequence est serialisee sur le cluster.
  const verrou = await verrouillerCluster({ urlProprietaire });
  const admin = await ouvrir(urlMaintenance);
  try {
    // Identite du cluster relue AVANT toute ecriture : c'est elle qui sera
    // inscrite au manifeste avec l'OID, pour que la reprise apres SIGKILL
    // puisse prouver qu'elle s'adresse au bon serveur.
    const identiteCluster = await identiteServeur(admin);
    const avant = await etatBase(urlProprietaire, nom);
    let adoption;

    if (avant === null) {
      adoption = 'absente';
    } else if (avant.marque === MARQUE) {
      adoption = 'marquee';
    } else if (await baseVide(urlProprietaire, nom)) {
      // Base fraiche (service PostgreSQL de la CI, ou `CREATE DATABASE` nu) :
      // rien a perdre, et elle sera marquee juste apres.
      adoption = 'vide';
    } else {
      throw new BaseJetableRefusee(
        `la base ${nom} existe, ne porte pas la marque « ${MARQUE} » et contient des objets : `
        + 'elle est CONSERVEE. Renommez-la ou supprimez-la a la main si elle est bien jetable.',
      );
    }

    if (avant !== null) {
      // Preuve d'OID relue juste avant le DROP : si la base a ete supprimee et
      // recreee entre-temps, l'OID a change et on refuse.
      const justeAvant = await etatBase(urlProprietaire, nom);
      if (justeAvant === null || String(justeAvant.oid) !== String(avant.oid)) {
        throw new BaseJetableRefusee(
          `l OID de ${nom} a change pendant la sequence — destruction refusee`,
        );
      }
      await admin.query(`DROP DATABASE ${ident(nom)} WITH (FORCE)`);
    }

    // `OWNER CURRENT_USER` n'est pas accepte par CREATE DATABASE (le mot est lu
    // comme un nom de role) : le proprietaire est lu puis cite.
    const { rows: proprio } = await admin.query('SELECT current_user AS u');
    await admin.query(`CREATE DATABASE ${ident(nom)} OWNER ${ident(proprio[0].u)}`);
    await admin.query(`COMMENT ON DATABASE ${ident(nom)} IS '${MARQUE}'`);

    const apres = await etatBase(urlProprietaire, nom);
    if (apres === null || apres.marque !== MARQUE) {
      await admin.query(`DROP DATABASE IF EXISTS ${ident(nom)} WITH (FORCE)`);
      throw new Error(`base ${nom} creee sans marque verifiable — detruite, etat inattendu`);
    }

    // R4 (P10.2) — INSCRIPTION AU MANIFESTE.
    //
    // Avant, cette fonction creait une base `tf_*` SANS rien ecrire au
    // manifeste : `nettoyer_ressources_jetables` ne pouvait donc jamais la
    // reprendre, et une interruption en laissait une orpheline DEFINITIVE.
    // Mesure P10.1 : base `tf_p101_z` creee, manifeste vide, « aucun
    // enregistrement : rien a reprendre ».
    //
    // L'identite enregistree est le triplet que `nettoyer` exige : nom, OID
    // relu APRES creation, et `system_identifier` du cluster. Le `pid` est
    // ecrit aussi : `nettoyer` refuse desormais de detruire une ressource dont
    // le createur est encore vivant.
    //
    // ECHEC PARTIEL : si la trace ne peut pas etre ecrite, la base vient
    // d'etre creee et serait orpheline. On la DETRUIT donc immediatement
    // (fail-closed) plutot que de laisser une ressource non reprenable.
    const tracee = enregistrerRessource({
      genre: 'base',
      nom,
      oid: apres.oid,
      systemIdentifier: identiteCluster.systemIdentifier,
      createur: 'reinitialiser_base_jetable',
    });
    if (!tracee) {
      await admin.query(`DROP DATABASE IF EXISTS ${ident(nom)} WITH (FORCE)`);
      throw new Error(
        `base ${nom} creee mais NON inscrite au manifeste — detruite pour ne pas laisser `
        + 'une orpheline non reprenable (R4). Verifier TF_MANIFESTE et les droits du fichier.',
      );
    }

    return {
      nom,
      oidAvant: avant === null ? null : String(avant.oid),
      oidApres: String(apres.oid),
      action: avant === null ? 'creee' : 'recreee',
      adoption,
      tracee: true,
    };
  } finally {
    await admin.end();
    await verrou.relacher();
  }
}

/**
 * Detruit une base CREEE PAR L'APPELANT, et seulement celle-la.
 *
 * Sert aux tests : ils creent des bases `tf_*` et doivent prouver qu'ils les
 * rangent. La preuve est l'OID releve a la creation.
 */
export async function detruireBaseProuvee({ urlProprietaire, nom, oid, attenteMs }) {
  if (!/^tf_[a-z0-9_]+$/.test(nom)) {
    throw new BaseJetableRefusee(`destruction reservee aux bases tf_* (recu : ${nom})`);
  }
  const urlMaintenance = deriverUrl(urlProprietaire, BASE_MAINTENANCE);
  // R9 (30/10) : la destruction passe par la MEME section critique que la
  // remise a zero. Avant, ce chemin ne prenait aucun verrou : mesure de
  // reference, `DROP` execute en 119 ms pendant qu'une session tierce detenait
  // le verrou, avec `57P01` pour la session de travail concernee. Le verrou est
  // desormais obligatoire, et son absence fait REFUSER la destruction.
  return avecVerrouDeCluster({ urlProprietaire, urlMaintenance }, async () => {
    const admin = await ouvrir(urlMaintenance);
    try {
      const { rows } = await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [nom]);
      if (rows.length === 0) return false;
      if (String(rows[0].oid) !== String(oid)) {
        throw new BaseJetableRefusee(
          `la base ${nom} n a plus l OID cree (${oid}) — destruction refusee`,
        );
      }
      await admin.query(`DROP DATABASE ${ident(nom)} WITH (FORCE)`);
      return true;
    } finally {
      await admin.end();
    }
  }, attenteMs === undefined ? {} : { attenteMs });
}
