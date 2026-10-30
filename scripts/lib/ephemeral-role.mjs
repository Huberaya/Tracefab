/**
 * Roles ephem eres : creer, prouver, detruire — sans jamais detruire autre chose.
 *
 * POURQUOI CE MODULE
 *
 * Les bases ephemeres ont recu une garde (scripts/lib/ephemeral-db.mjs) apres
 * la mesure du 29/10 : un nom FIXE et un `DROP ... IF EXISTS` avant `CREATE`
 * detruisaient une base preexistante, et la suite sortait verte. Les ROLES
 * portaient exactement le meme defaut, sans que personne ne l'ait regarde :
 *
 *     const SONDE = 'sonde_bypass_probe';
 *     await admin.query(`DROP ROLE IF EXISTS ${SONDE}`);   // <- avant tout controle
 *     await admin.query(`CREATE ROLE ${SONDE} ...`);
 *
 * `DROP ROLE` est meme plus dangereux qu'un `DROP DATABASE` : un role est un
 * objet de CLUSTER, pas de base. Il survit a toutes les bases et porte des
 * appartenances, des droits par defaut et la propriete d'objets.
 *
 * CE QUE CE MODULE GARANTIT
 *
 *   1. NOM UNIQUE par execution : prefixe + horodatage + alea, `[a-z0-9_]`,
 *      tronque a 63 OCTETS (limite PostgreSQL, comptee en octets).
 *   2. AUCUN `DROP` AVANT `CREATE` : le nom est verifie absent ; une collision
 *      (`42710`) fait tirer un autre nom, jamais supprimer.
 *   3. PREUVE DE PROPRIETE : l'OID du role est releve immediatement apres le
 *      `CREATE`. C'est le seul jeton qui autorise une destruction.
 *   4. DESTRUCTION RESERVEE : `fermer()` relit l'OID et REFUSE si le role porte
 *      un autre OID (recree entre-temps par quelqu'un d'autre).
 *   5. ARRET SANS SUPPRESSION : une creation qui echoue ne laisse rien derriere,
 *      et une preuve impossible interdit la suppression.
 *
 * Ce module ne decide pas de la cible : l'URL recue est deja classee par
 * `require-throwaway-db.mjs`, et elle est reclassifiee ici.
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './pg-ssl.mjs';
import { classifyTarget } from './require-throwaway-db.mjs';
import { deriverUrl } from './ephemeral-db.mjs';

/** Limite PostgreSQL : 63 octets pour un identifiant. */
const LONGUEUR_MAX_IDENTIFIANT = 63;
const BASE_MAINTENANCE = 'postgres';
const ESSAIS_NOM = 8;
const NOM_VALIDE = /^[a-z][a-z0-9_]*$/;

/**
 * Nom de role unique et conforme.
 *
 * Meme construction que pour les bases : triable dans un journal (horodatage)
 * ET unique entre deux executions simultanees (alea).
 */
export function nomRoleEphemere(prefixe = 'tf_role_sonde') {
  let base = String(prefixe)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[^a-z]+/, '');
  // Un prefixe qui ne commence pas par une lettre (accents, chiffres, ponctuation)
  // ne doit pas produire un identifiant invalide : on rétablit une initiale.
  if (!/^[a-z]/.test(base)) base = `tf_${base}`;
  const horodatage = Date.now().toString(36);
  const alea = crypto.randomBytes(6).toString('hex');
  let nom = `${base}_${horodatage}_${alea}`;
  while (Buffer.byteLength(nom, 'utf8') > LONGUEUR_MAX_IDENTIFIANT) {
    nom = nom.slice(0, -1);
  }
  nom = nom.replace(/_+$/, '');
  if (!NOM_VALIDE.test(nom)) {
    throw new Error(`nom de role ephemere invalide : ${nom}`);
  }
  return nom;
}

/** Identifiant SQL sur : le nom a ete valide par `nomRoleEphemere`. */
function ident(nom) {
  if (!NOM_VALIDE.test(nom)) throw new Error(`identifiant refuse : ${nom}`);
  return `"${nom}"`;
}

/** Litteral SQL : le mot de passe peut contenir n'importe quoi. */
function litteral(valeur) {
  return `'${String(valeur).replace(/'/g, "''")}'`;
}

/**
 * Attributs d'un role de sonde, traduits en SQL.
 *
 * On n'accepte pas de fragment SQL libre en entree : les attributs sont une
 * liste fermee, pour qu'aucun appelant ne puisse injecter de clause.
 */
function attributsSql({ login = false, motDePasse = null, bypassrls = false }) {
  const morceaux = [login ? 'LOGIN' : 'NOLOGIN'];
  if (login && motDePasse !== null) morceaux.push(`PASSWORD ${litteral(motDePasse)}`);
  morceaux.push('NOSUPERUSER', bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS', 'NOCREATEROLE', 'NOCREATEDB');
  return morceaux.join(' ');
}

async function ouvrir(url) {
  const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await client.connect();
  return client;
}

/**
 * Cree un role ephemere et prouve qu'il est bien le sien.
 *
 * @param {object} options
 * @param {string} options.urlProprietaire URL deja classee par la garde
 * @param {string} [options.prefixe] prefixe lisible dans le nom
 * @param {object} [options.attributs] voir `attributsSql`
 * @param {() => string} [options.generateurNom] injectable pour les controles
 *        negatifs : force une collision de nom sans jamais supprimer.
 * @returns {Promise<{nom, oid, fermer}>}
 */
export async function creerRoleEphemere({
  urlProprietaire,
  prefixe = 'tf_role_sonde',
  attributs = {},
  generateurNom = () => nomRoleEphemere(prefixe),
}) {
  const verdictSource = classifyTarget(urlProprietaire);
  if (!verdictSource.allowed) {
    throw new Error(`source non autorisee (${verdictSource.code}) : ${verdictSource.reason}`);
  }
  const urlMaintenance = deriverUrl(urlProprietaire, BASE_MAINTENANCE);
  const verdictMaintenance = classifyTarget(urlMaintenance);
  if (!verdictMaintenance.allowed) {
    throw new Error(`maintenance refusee (${verdictMaintenance.code}) : ${verdictMaintenance.reason}`);
  }

  const admin = await ouvrir(urlMaintenance);
  let nom = null;
  let oid = null;
  let cree = false;
  let nettoyageProuve = null;

  try {
    for (let essai = 0; essai < ESSAIS_NOM; essai += 1) {
      const candidat = generateurNom();
      // 2. Le nom doit etre ABSENT. `IF EXISTS`/`IF NOT EXISTS` n'existe pas
      // pour les roles dans le sens souhaite : la verification est explicite,
      // et elle interdit toute tentation de « nettoyer d'abord ».
      const occupe = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [candidat]);
      if (occupe.rowCount > 0) continue;
      try {
        await admin.query(`CREATE ROLE ${ident(candidat)} ${attributsSql(attributs)}`);
        nom = candidat;
        cree = true;
      } catch (e) {
        // Collision avec une execution parallele : le role a ete cree entre la
        // verification et le CREATE. On retire un nom, on ne supprime rien.
        if (e.code === '42710' || e.code === '23505') continue;
        throw e;
      }
      break;
    }

    if (!nom) {
      throw new Error(`aucun nom de role libre apres ${ESSAIS_NOM} essais — arret sans suppression`);
    }

    // 3. Preuve de propriete.
    const { rows } = await admin.query('SELECT oid FROM pg_roles WHERE rolname = $1', [nom]);
    oid = rows[0]?.oid;
    if (!oid) throw new Error('role cree introuvable dans pg_roles — arret sans suppression');

    nettoyageProuve = async () => {
      const nettoyeur = await ouvrir(urlMaintenance);
      try {
        const { rows: actuels } = await nettoyeur.query('SELECT oid FROM pg_roles WHERE rolname = $1', [nom]);
        if (String(actuels[0]?.oid) !== String(oid)) {
          throw new Error(`le role ${nom} n a plus l OID cree (${oid}) — destruction refusee`);
        }
        // Le role de sonde ne doit posseder aucun objet ; `DROP OWNED` neutralise
        // le cas ou une fixture lui en aurait donne, sans jamais viser un autre
        // role que celui dont l'OID vient d'etre verifie.
        await nettoyeur.query(`DROP OWNED BY ${ident(nom)}`).catch(() => {});
        await nettoyeur.query(`DROP ROLE ${ident(nom)}`);
      } finally {
        await nettoyeur.end();
      }
    };

    return {
      nom,
      oid: String(oid),
      /**
       * URL qui se connecte avec ce role.
       * `urlBase` permet de viser une autre base que celle du proprietaire
       * (typiquement la base ephemere) : le nom du role, lui, est toujours
       * celui qui vient d'etre prouve.
       */
      urlAvecRole(motDePasse, urlBase = urlProprietaire) {
        const u = new URL(urlBase);
        if (motDePasse !== null && motDePasse !== undefined) u.password = motDePasse;
        u.username = nom;
        return u.toString();
      },
      /** Detruit le role, UNIQUEMENT si l'OID est toujours celui qu'on a cree. */
      async fermer() {
        await nettoyageProuve();
        return true;
      },
    };
  } catch (erreur) {
    // Une verification a echoue : on ne detruit QUE si l'OID a deja ete prouve.
    if (nettoyageProuve) {
      try {
        await nettoyageProuve();
      } catch (eNettoyage) {
        throw new Error(`${erreur.message} — et le nettoyage a echoue : ${eNettoyage.message}`);
      }
    } else if (cree && nom) {
      throw new Error(
        `${erreur.message} — role ${nom} CREE mais NON PROUVE : destruction refusee `
        + '(suppression incertaine). A retirer manuellement.',
      );
    }
    throw erreur;
  } finally {
    await admin.end();
  }
}
