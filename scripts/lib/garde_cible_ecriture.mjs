/**
 * Garde de cible pour les scripts qui ECRIVENT hors du lanceur commun.
 *
 * POURQUOI CE MODULE
 *
 * Trois scripts DPP ecrivent en base et sont invoques DIRECTEMENT par
 * `package.json`, donc sans passer par `scripts/run-db-suite.mjs` (et sans sa
 * garde de cible) :
 *
 *     npm run test:dpp:role-applicatif   -> scripts/test_dpp_role_applicatif.mjs
 *     npm run test:dpp:branche           -> scripts/valider_branche_dpp.mjs
 *     npm run db:mesure-dpp              -> scripts/mesure_effet_migrations_dpp.mjs
 *
 * Chacun portait sa propre LISTE NOIRE : un seul nom d'hote de production,
 * ecrit en dur, surchargeable par `TF_HOTE_PRODUCTION` :
 *
 *     const HOTE_PRODUCTION = process.env.TF_HOTE_PRODUCTION || 'ep-polished-…';
 *     if (hote === HOTE_PRODUCTION || /^ep-polished-night/.test(hote)) refus;
 *
 * Une liste noire est un refus par defaut inverse : tout ce qui n'a pas ete
 * prevu est ACCEPTE. Une base Neon d'une autre branche, un autre projet, un
 * `host=` dans la chaine de connexion, une base locale qui n'est pas de test :
 * autant de cibles que ces scripts acceptaient, tout en ecrivant des lignes.
 * Le reste du depot applique pourtant, depuis le 2026-10-10, un classifieur
 * unique (`require-throwaway-db.mjs`) dont la regle est : REFUS PAR DEFAUT.
 *
 * Ce module remplace les trois listes noires par ce classifieur, et ajoute les
 * trois controles qui manquaient :
 *
 *   1. CONTRADICTION entre variables : si `DATABASE_URL` et `TF_RLS_APP_URL`
 *      sont tous deux fournis, les deux sont classes et doivent designer la
 *      MEME base. Une cible jetable d'un cote et une cible refuse de l'autre
 *      suffit a tout arreter : un script ne doit pas ecrire la ou il ne lit
 *      pas, ni lire la ou il n'ecrit pas.
 *   2. IDENTITE DE CLUSTER : `TF_SYSID_ATTENDU` (facultatif) permet d'exiger un
 *      `system_identifier` precis — celui du cluster jetable que l'on vient de
 *      creer. Une base jetable sur un AUTRE cluster (une autre instance, un
 *      autre port) est alors refusee. Si l'identite ne peut pas etre lue alors
 *      que l'exigence est posee, on refuse : une verite non etablie n'est pas
 *      une autorisation.
 *   3. `TF_HOTE_PRODUCTION` n'est plus lu : une variable d'environnement qui
 *      deplace la frontiere de securite est une porte. Le classifieur refuse
 *      deja tout hote manage (`*.neon.tech`, `*.supabase.*`, `*.rds.*`, …),
 *      quelle que soit la declaration.
 *
 * CE QUI N'EST JAMAIS AFFICHE : ni URL, ni hote, ni identifiant, ni mot de
 * passe. Seulement la classification, le nom de base et une empreinte tronquee
 * — ceux que `describeTarget()` publie deja.
 *
 * CODES DE SORTIE (identiques aux scripts qu'il remplace)
 *   2  non execute : variable obligatoire absente (un test qui ne tourne pas
 *      n'est pas un test qui passe) ;
 *   3  cible refusee : rien n'a ete ecrit, la garde s'arrete AVANT la moindre
 *      connexion d'ecriture.
 */
import pg from 'pg';
import { sslDepuisUrl } from './pg-ssl.mjs';
import { classifyTarget, describeTarget } from './require-throwaway-db.mjs';
import { identiteServeur } from './ephemeral-db.mjs';

export const EXIT_NON_EXECUTE = 2;
export const EXIT_CIBLE_REFUSEE = 3;

/** Refus leve par la garde : l'appelant peut le transformer en sortie 3. */
export class CibleRefusee extends Error {
  constructor(message, details = [], exitCode = EXIT_CIBLE_REFUSEE) {
    super(message);
    this.name = 'CibleRefusee';
    this.code = 'TF_CIBLE_REFUSEE';
    this.exitCode = exitCode;
    this.details = details;
  }
}

function valeur(variable) {
  return (process.env[variable] || '').trim();
}

/**
 * Classifie une ou plusieurs variables et rend un verdict unique.
 * Ne sort pas du processus : utilisable par les tests de la garde.
 *
 * @param {object} options
 * @param {string[]} [options.variables] variables de connexion a verifier
 * @param {string} [options.requise] celle qui doit etre presente
 * @returns {{ok: boolean, code: string, raison: string, lines: string[],
 *            principales: object}}
 */
export function classerCibles({ variables = ['DATABASE_URL'], requise = null } = {}) {
  const obligatoire = requise ?? variables[0];
  const presentes = variables.filter((v) => valeur(v) !== '');

  if (!valeur(obligatoire)) {
    return {
      ok: false,
      code: 'missing',
      raison: `${obligatoire} absent`,
      lines: [],
      principales: null,
    };
  }

  const verdicts = presentes.map((variable) => ({
    variable,
    verdict: classifyTarget(valeur(variable)),
  }));

  const lines = verdicts.map(({ variable, verdict }) => describeTarget(variable, verdict));
  const refusees = verdicts.filter(({ verdict }) => !verdict.allowed);
  if (refusees.length > 0) {
    return {
      ok: false,
      code: refusees[0].verdict.code,
      raison: `cible refusee pour ${refusees.map((r) => r.variable).join(', ')}`,
      lines,
      principales: verdicts[0].verdict,
    };
  }

  // 1. Contradiction : deux variables concordantes de classification mais qui
  //    ne nomment pas la meme base. Le pilote joindrait deux bases distinctes.
  const bases = [...new Set(verdicts.map(({ verdict }) => verdict.database))];
  if (bases.length > 1) {
    return {
      ok: false,
      code: 'contradictory_variables',
      raison: `les variables designent ${bases.length} bases differentes (${bases.join(', ')})`,
      lines,
      principales: verdicts[0].verdict,
    };
  }

  return { ok: true, code: 'allowed', raison: 'cible classée jetable', lines, principales: verdicts[0].verdict };
}

/**
 * Lit l'identite du cluster. Rend `null` si elle n'est pas lisible (role sans
 * droit sur `pg_control_system()`, connexion impossible) — jamais une exception
 * qui ferait passer un refus pour une panne.
 */
async function lireIdentite(url) {
  const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  try {
    await client.connect();
    return await identiteServeur(client);
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Verifie l'identite de cluster exigee, si `TF_SYSID_ATTENDU` est pose.
 * @returns {Promise<{ok: boolean, code: string, raison: string, identite: object|null}>}
 */
export async function verifierIdentiteCluster({ url, attendu = process.env.TF_SYSID_ATTENDU } = {}) {
  if (!attendu) return { ok: true, code: 'non_exige', raison: 'aucune identite exigee', identite: null };
  const identite = await lireIdentite(url);
  if (identite === null) {
    return {
      ok: false,
      code: 'identity_unreadable',
      raison: 'identite de cluster exigee mais illisible — refus (une verite non etablie n est pas une autorisation)',
      identite: null,
    };
  }
  if (String(identite.systemIdentifier) !== String(attendu)) {
    return {
      ok: false,
      code: 'unexpected_cluster',
      raison: `identite de cluster inattendue (mesuree ${identite.systemIdentifier}, exigee ${attendu})`,
      identite,
    };
  }
  return { ok: true, code: 'identity_ok', raison: `identite ${identite.systemIdentifier} conforme`, identite };
}

/**
 * Applique la garde et SORT du processus en cas de refus — avant toute
 * connexion d'ecriture.
 *
 * @param {object} options
 * @param {string[]} [options.variables]
 * @param {string} [options.requise]
 * @param {string} [options.purpose]
 * @param {string} [options.attenduSysid]
 * @param {boolean} [options.exitOnFailure]
 * @returns {Promise<{variable: string, url: string, verdict: object, identite: object|null}>}
 */
export async function exigerCibleEcriture({
  variables = ['DATABASE_URL'],
  requise = null,
  purpose = 'script qui ecrit en base',
  attenduSysid = process.env.TF_SYSID_ATTENDU,
  exitOnFailure = true,
} = {}) {
  const verdict = classerCibles({ variables, requise });
  const obligatoire = requise ?? variables[0];

  const echouer = (code, entete, lignes) => {
    // `exitCode` porte le code de sortie dans les deux modes : 2 = non execute
    // (variable absente), 3 = cible refusee. Un appelant qui capture la levee
    // doit pouvoir distinguer les deux, comme le processus le ferait.
    if (exitOnFailure) {
      console.error(`\n  REFUS — ${purpose}`);
      console.error(`  ${entete}`);
      for (const ligne of lignes) console.error(`  ${ligne}`);
      console.error('  Aucune ecriture n a ete effectuee : la garde precede la connexion.');
      console.error(`  Aucun secret ni chaine de connexion n a ete affiche : sortie ${code}.\n`);
      process.exit(code);
    }
    throw new CibleRefusee(entete, lignes, code);
  };

  if (!verdict.ok) {
    echouer(verdict.code === 'missing' ? EXIT_NON_EXECUTE : EXIT_CIBLE_REFUSEE,
      verdict.raison, verdict.lines);
  }

  const identite = await verifierIdentiteCluster({ url: valeur(obligatoire), attendu: attenduSysid });
  if (!identite.ok) {
    echouer(EXIT_CIBLE_REFUSEE, identite.raison, verdict.lines);
  }

  for (const ligne of verdict.lines) console.log(`  garde cible : ${ligne}`);
  if (identite.identite) {
    console.log(`  garde cluster : identite ${identite.identite.systemIdentifier}`
      + ` · ${identite.identite.adresse}:${identite.identite.port}`
      + `${attenduSysid ? ' (exigee)' : ' (non exigee)'}`);
  }

  return {
    variable: obligatoire,
    url: valeur(obligatoire),
    verdict: verdict.principales,
    identite: identite.identite,
  };
}
