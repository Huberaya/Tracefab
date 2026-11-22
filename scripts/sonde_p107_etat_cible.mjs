#!/usr/bin/env node
/**
 * P10.7 — LANCEUR DE LA SONDE DE LECTURE SEULE (identité du runtime et état cible).
 *
 * Le lanceur exécute les mesures dans une transaction READ ONLY, fait toujours
 * ROLLBACK, puis — SEULEMENT si aucune erreur ne s'est produite — prouve le
 * refus d'écriture dans une SECONDE transaction READ ONLY distincte.
 *
 * Verdicts techniques :
 *   ERREUR_SQL_INITIALE         une mesure a échoué ; SQLSTATE conservé ;
 *   TRANSACTION_ABORTEE         25P02, qui n'est JAMAIS un refus 25006 ;
 *   TENTATIVE_ECRITURE_REFUSEE  le CREATE TABLE de contrôle échoue en 25006 ;
 *   ECRITURE_VALIDEE            le CREATE TABLE a été accepté : ARRÊT ;
 *   ERREUR_TEST_LECTURE_SEULE   le contrôle n'a pas pu prouver 25006.
 *
 * Codes de sortie : 0 pas d'arrêt · 1 arrêt détecté · 2 mesure non exécutée
 * ou preuve technique invalide · 3 refus avant connexion.
 *
 * UTILISATION
 *   node scripts/sonde_p107_etat_cible.mjs --url "$TRACEFAB_LECTURE_URL"
 *   node scripts/sonde_p107_etat_cible.mjs --url … --json > mesure.json
 *   TF_P107_AUTORISER_HOTE_DISTANT=oui (obligatoire hors localhost)
 *
 * Le rôle attendu du runtime est un PARAMÈTRE (`--role-runtime`), jamais une
 * déduction : `DATABASE_URL` peut porter n'importe quel nom.
 */
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

export const CHEMIN_SONDE = 'docs/security/2026-11-02-p107-sonde-identite-et-etat-cible.sql';
const TABLE_CONTROLE = 'tracefab_readonly_probe';

const sectionDe = (titre) => titre?.match(/^([A-B]\d+)/)?.[1] ?? null;
const messageDe = (erreur) => String(erreur?.message ?? erreur).split('\n')[0].slice(0, 300);

/** Découpage PAR SECTION, puis contrôle statique avant toute connexion. */
export function decouperSonde(source) {
  const blocs = [];
  let courant = null;
  for (const ligne of source.split('\n')) {
    const titre = ligne.match(/^--\s*([A-B]\d+\.[^\n]*)$/);
    if (titre) {
      courant = { titre: titre[1].trim(), lignes: [] };
      blocs.push(courant);
    } else if (courant) {
      courant.lignes.push(ligne);
    }
  }
  const entrees = [];
  for (const bloc of blocs) {
    const sql = bloc.lignes.join('\n').replace(/--[^\n]*/g, '');
    for (const requete of sql.split(';').map((q) => q.trim()).filter(Boolean)) {
      entrees.push({ titre: bloc.titre, requete });
    }
  }
  return entrees;
}

const normaliserErreur = (erreur, phase, titre = null, index = null) => ({
  sqlstate: typeof erreur?.code === 'string' ? erreur.code : null,
  message: messageDe(erreur),
  phase,
  section: sectionDe(titre),
  requete_index: index === null ? null : index + 1,
});

async function rollback(client, phase) {
  try {
    await client.query('ROLLBACK');
    return { effectue: true, erreur: null };
  } catch (erreur) {
    return { effectue: false, erreur: normaliserErreur(erreur, phase) };
  }
}

/**
 * B1/B2/B3 et B7 ne peuvent pas être auto-protégés par un CASE : PostgreSQL
 * résoud les relations de toutes les branches pendant l'analyse. B0 mesure la
 * présence sans toucher aux données ; les sections impossibles sont alors
 * ignorées explicitement et le rapport rend un ARRÊT, pas un faux succès.
 */
function raisonSectionIgnoree(titre, presence) {
  if (!presence) return null;
  if (/^B[123]\./.test(titre) && presence.migrations_presentes === false) {
    return 'PUBLIC__PRISMA_MIGRATIONS_ABSENTE';
  }
  if (/^B7\./.test(titre)
      && (presence.cles_presentes === false || presence.politique_presente === false)) {
    return 'RELATIONS_HMAC_ABSENTES';
  }
  return null;
}

export async function executerMesures({ client, entrees }) {
  const sections = [];
  const sectionsIgnorees = [];
  let presence = null;
  let erreurInitiale = null;
  let phase = 'BEGIN_MESURES';
  let titreCourant = null;
  let indexCourant = null;

  try {
    await client.query('BEGIN');
    phase = 'SET_READ_ONLY_MESURES';
    await client.query('SET TRANSACTION READ ONLY');
    phase = 'MESURE';

    for (let index = 0; index < entrees.length; index += 1) {
      const { titre, requete } = entrees[index];
      const raison = raisonSectionIgnoree(titre, presence);
      if (raison) {
        const ignoree = { titre, lignes: [], ignoree: raison, requete_index: index + 1 };
        sections.push(ignoree);
        sectionsIgnorees.push({ section: sectionDe(titre), raison, requete_index: index + 1 });
        continue;
      }

      titreCourant = titre;
      indexCourant = index;
      const resultat = await client.query(requete);
      sections.push({ titre, lignes: resultat.rows, requete_index: index + 1 });
      if (/^B0\./.test(titre)) presence = resultat.rows[0] || null;
    }
  } catch (erreur) {
    // Le PREMIER échec est conservé. La boucle est interrompue immédiatement.
    erreurInitiale = normaliserErreur(erreur, phase, titreCourant, indexCourant);
  }

  const annulation = await rollback(client, 'ROLLBACK_MESURES');
  if (!erreurInitiale && annulation.erreur) erreurInitiale = annulation.erreur;

  return {
    sections,
    sectionsIgnorees,
    presence,
    erreurInitiale,
    rollbackEffectue: annulation.effectue,
    erreurRollback: annulation.erreur,
  };
}

/** Test d'écriture isolé : il ne partage jamais la transaction des mesures. */
export async function testerLectureSeule({ client }) {
  let phase = 'BEGIN_TEST_LECTURE_SEULE';
  let tentativeEffectuee = false;
  let ecritureValidee = false;
  let verdict = 'NON_EXECUTE';
  let erreur = null;

  try {
    await client.query('BEGIN');
    phase = 'SET_READ_ONLY_TEST_LECTURE_SEULE';
    await client.query('SET TRANSACTION READ ONLY');
    phase = 'CREATE_TABLE_TEST_LECTURE_SEULE';
    tentativeEffectuee = true;
    await client.query(`CREATE TABLE public.${TABLE_CONTROLE} (x integer)`);
    ecritureValidee = true;
    verdict = 'ECRITURE_VALIDEE';
  } catch (e) {
    erreur = normaliserErreur(e, phase);
    if (phase === 'CREATE_TABLE_TEST_LECTURE_SEULE' && erreur.sqlstate === '25006') {
      verdict = 'TENTATIVE_ECRITURE_REFUSEE';
    } else if (erreur.sqlstate === '25P02') {
      verdict = 'TRANSACTION_ABORTEE';
    } else {
      verdict = 'ERREUR_TEST_LECTURE_SEULE';
    }
  }

  const annulation = await rollback(client, 'ROLLBACK_TEST_LECTURE_SEULE');
  return {
    verdict,
    tentative_effectuee: tentativeEffectuee,
    ecriture_validee: ecritureValidee,
    sqlstate: erreur?.sqlstate ?? null,
    message: erreur?.message ?? null,
    phase: erreur?.phase ?? null,
    rollback_effectue: annulation.effectue,
    erreur_rollback: annulation.erreur,
  };
}

function construireRapport({ mesures, test, roleRuntime }) {
  const { sections, erreurInitiale } = mesures;
  const parTitre = (motif) => {
    const section = sections.find((s) => motif.test(s.titre));
    return section ? section.lignes : null;
  };
  const premiere = (motif) => (parTitre(motif) || [])[0] || null;

  const contexte = premiere(/A1\./);
  const presence = premiere(/B0\./);
  const membresPrivilegies = parTitre(/A3\./) || [];
  const prisesDeRole = parTitre(/A4\./) || [];
  const historique = premiere(/B1\./);
  const attendues = parTitre(/B2\./) || [];
  const propriete = parTitre(/B4\./) || [];
  const hygiene = premiere(/B5\./);
  const droits = premiere(/B6\./);
  const identiteMesuree = premiere(/B7\./);
  const porteeCle = premiere(/B8\./);

  // Si B7 a été ignoré, B0 fournit uniquement la présence. Les compteurs
  // restent NULL : une relation absente ou non lue n'est jamais un compteur 0.
  const identite = identiteMesuree || (presence ? {
    table_cles: presence.cles_presentes,
    table_politique: presence.politique_presente,
    fonction_verification: presence.fonction_verification_presente,
    mode_identite: presence.politique_presente ? 'NON_MESURE' : 'ABSENTE',
    cles_total: null,
    cles_actives: null,
  } : null);

  const arrets = [];
  if (!erreurInitiale) {
    if (!contexte) arrets.push('A1 : contexte illisible — aucune mesure exploitable');
    if (presence?.migrations_presentes === false) {
      arrets.push('B1 : public._prisma_migrations est absente — historique non mesurable');
    } else if (!historique) {
      arrets.push('B1 : historique des migrations illisible');
    }
    if (presence && (!presence.cles_presentes || !presence.politique_presente)) {
      arrets.push('B7 : une ou deux relations HMAC sont absentes — état de l identité non mesurable');
    }
    if (presence && !presence.fonction_verification_presente) {
      arrets.push('B7 : la fonction de vérification HMAC est absente');
    }

    const privilegiesAtteints = membresPrivilegies.filter((l) => l.atteint_un_role_privilegie === true);
    const runtimeMembre = privilegiesAtteints.filter((l) => l.role_de_depart === roleRuntime);
    if (runtimeMembre.length > 0) {
      arrets.push(`A3 : ${roleRuntime} ATTEINT un rôle privilégié (${runtimeMembre.map((l) => `${l.role_atteint}@${l.profondeur}`).join(', ')}) — appartenance privilégiée inattendue`);
    }
    const runtimePeutPrendre = prisesDeRole.filter((l) => l.role_de_connexion === roleRuntime && l.peut_prendre_ce_role);
    if (runtimePeutPrendre.length > 0) {
      arrets.push(`A4 : ${roleRuntime} peut prendre ${runtimePeutPrendre.map((l) => l.role_privilegie).join(', ')} — élévation possible`);
    }
    if (hygiene && Number(hygiene.definer_sans_search_path) > 0) {
      arrets.push(`B5 : ${hygiene.definer_sans_search_path} fonction(s) SECURITY DEFINER sans search_path figé`);
    }
    if (hygiene && Number(hygiene.executables_par_public) > 0) {
      arrets.push(`B5 : ${hygiene.executables_par_public} fonction(s) exécutable(s) par PUBLIC`);
    }
    if (porteeCle?.app_present === false) {
      arrets.push('B8 : le rôle tracefab_app est absent — portée de la clé non mesurable');
    }
    if (porteeCle && (porteeCle.app_lit_les_cles === true || porteeCle.app_ecrit_les_cles === true)) {
      arrets.push('B8 : le rôle du runtime lit ou écrit la table des clés — le HMAC ne protège plus rien');
    }
    if (historique && Number(historique.en_echec) > 0) {
      arrets.push(`B1 : ${historique.en_echec} migration(s) en échec dans le registre`);
    }
    if (attendues.some((a) => a.en_echec)) {
      arrets.push('B2 : une migration P10.5/P10.6 est en échec dans le registre');
    }
    if (droits && droits.migrator_superuser === true) {
      arrets.push('B6 : le rôle de migration est SUPERUSER hors fenêtre d élévation — état d exploitation anormal');
    }
  }

  return {
    schema: 'tracefab-p107-sonde-v1',
    mesuree_le: contexte?.mesuree_le ? new Date(contexte.mesuree_le).toISOString() : null,
    lecture_seule_prouvee: 'NON_PROUVEE',
    role_attendu_du_runtime: roleRuntime,
    erreur_initiale: erreurInitiale,
    rollback_mesures_effectue: mesures.rollbackEffectue,
    erreur_rollback_mesures: mesures.erreurRollback,
    test_lecture_seule: {
      verdict: test.verdict,
      tentative_effectuee: test.tentative_effectuee,
      ecriture_validee: test.ecriture_validee,
      sqlstate: test.sqlstate,
      message: test.message,
      phase: test.phase,
      rollback_effectue: test.rollback_effectue,
      erreur_rollback: test.erreur_rollback,
    },
    sections_ignorees: mesures.sectionsIgnorees,
    contexte: contexte ? {
      role_executant: contexte.role_executant,
      base: contexte.base,
      version_postgresql: contexte.version_postgresql,
      port_serveur: contexte.port_serveur,
      adresse_serveur_presente: contexte.adresse_serveur !== null,
    } : null,
    b0_relations: presence ? { ...presence } : null,
    a3_atteintes_totales: membresPrivilegies.length,
    a3_atteintes_privilegiees: membresPrivilegies.filter((l) => l.atteint_un_role_privilegie === true).length,
    a3_detail: membresPrivilegies.slice(0, 20),
    a4_prises_de_role: prisesDeRole.length,
    b1_historique: historique ? {
      terminees: Number(historique.terminees),
      en_echec: Number(historique.en_echec),
      annulees: Number(historique.annulees),
      derniere: historique.derniere_appliquee ? new Date(historique.derniere_appliquee).toISOString() : null,
    } : null,
    b2_migrations_p105_p106: attendues,
    b4_proprietaires: propriete.map((l) => ({ fonction: l.fonction, proprietaire: l.proprietaire, definer: l.security_definer, configuration: l.configuration })),
    b5_hygiene: hygiene ? {
      definer_total: Number(hygiene.definer_total),
      definer_sans_search_path: Number(hygiene.definer_sans_search_path),
      executables_par_public: Number(hygiene.executables_par_public),
      fonctions_publiques: Number(hygiene.fonctions_publiques),
    } : null,
    b6_droits_migration: droits ? { ...droits } : null,
    b7_identite: identite ? { ...identite } : null,
    b8_portee_de_la_cle: porteeCle ? { ...porteeCle } : null,
    arrets,
    verdict: arrets.length === 0 ? 'AUCUN_ARRET_DETECTE' : 'ARRET',
  };
}

export async function executerSonde({ client, entrees, roleRuntime = 'tracefab_app' }) {
  const mesures = await executerMesures({ client, entrees });
  const test = mesures.erreurInitiale ? {
    verdict: 'NON_EXECUTE_APRES_ERREUR_INITIALE',
    tentative_effectuee: false,
    ecriture_validee: false,
    sqlstate: null,
    message: null,
    phase: null,
    rollback_effectue: null,
    erreur_rollback: null,
  } : await testerLectureSeule({ client });

  const rapport = construireRapport({ mesures, test, roleRuntime });
  let codeSortie;

  if (mesures.erreurInitiale) {
    rapport.verdict = mesures.erreurInitiale.sqlstate === '25P02'
      ? 'TRANSACTION_ABORTEE'
      : 'ERREUR_SQL_INITIALE';
    codeSortie = 2;
  } else if (test.ecriture_validee) {
    rapport.verdict = 'ECRITURE_VALIDEE';
    codeSortie = 1;
  } else if (test.erreur_rollback) {
    rapport.verdict = 'ERREUR_ROLLBACK';
    codeSortie = 2;
  } else if (test.verdict === 'TENTATIVE_ECRITURE_REFUSEE' && test.sqlstate === '25006') {
    rapport.lecture_seule_prouvee = '25006';
    codeSortie = rapport.arrets.length === 0 ? 0 : 1;
  } else {
    rapport.verdict = test.verdict === 'TRANSACTION_ABORTEE'
      ? 'TRANSACTION_ABORTEE'
      : 'ERREUR_TEST_LECTURE_SEULE';
    codeSortie = 2;
  }

  if (test.ecriture_validee) rapport.lecture_seule_prouvee = 'ECRITURE_VALIDEE';
  return { rapport, codeSortie };
}

function afficherRapport(rapport) {
  if (rapport.erreur_initiale) {
    const e = rapport.erreur_initiale;
    console.error(`  NON EXECUTE — ${rapport.verdict} · SQLSTATE ${e.sqlstate || 'inconnu'} · ${e.message}`);
    console.error(`  première erreur : section=${e.section || 'transaction'} · phase=${e.phase} · requête=${e.requete_index ?? 'hors séquence'}`);
    console.error(`  ROLLBACK des mesures : ${rapport.rollback_mesures_effectue ? 'effectué' : 'EN ÉCHEC'} · CREATE TABLE : non tenté.`);
    return;
  }
  if (rapport.verdict === 'ECRITURE_VALIDEE') {
    console.error('  ARRET — ECRITURE_VALIDEE : le CREATE TABLE de contrôle a été accepté.');
    console.error(`  ROLLBACK du contrôle : ${rapport.test_lecture_seule.rollback_effectue ? 'effectué' : 'EN ÉCHEC'}. Ne pas utiliser cette sonde.`);
    return;
  }
  if (!['ARRET', 'AUCUN_ARRET_DETECTE'].includes(rapport.verdict)) {
    const t = rapport.test_lecture_seule;
    console.error(`  NON EXECUTE — ${rapport.verdict} · SQLSTATE ${t.sqlstate || 'inconnu'} · ${t.message || 'preuve de lecture seule invalide'}`);
    console.error('  25P02 n est pas 25006 : aucune transaction abortée n est présentée comme un refus d écriture.');
    return;
  }

  console.log('');
  console.log(`  Sonde P10.7 — ${rapport.mesuree_le || 'date illisible'} · lecture seule prouvée (${rapport.lecture_seule_prouvee})`);
  if (rapport.contexte) {
    console.log(`  contexte       : rôle=${rapport.contexte.role_executant} · base=${rapport.contexte.base} · ${rapport.contexte.version_postgresql}`);
  }
  if (rapport.b1_historique) {
    console.log(`  migrations     : ${rapport.b1_historique.terminees} terminée(s) · ${rapport.b1_historique.en_echec} en échec · ${rapport.b1_historique.annulees} annulée(s)`);
  }
  for (const a of rapport.b2_migrations_p105_p106) {
    console.log(`  migration      : ${a.nom} → ${a.appliquee ? 'appliquée' : a.en_echec ? 'EN ÉCHEC' : 'en attente'}`);
  }
  for (const p of rapport.b4_proprietaires) {
    console.log(`  propriétaire   : ${p.fonction} → ${p.proprietaire}${p.definer ? ' (SECURITY DEFINER)' : ''}`);
  }
  if (rapport.b5_hygiene) {
    console.log(`  hygiène        : ${rapport.b5_hygiene.definer_sans_search_path} DEFINER sans search_path · ${rapport.b5_hygiene.executables_par_public} exécutable(s) par PUBLIC`);
  }
  if (rapport.b7_identite) {
    console.log(`  identité       : ${rapport.b7_identite.mode_identite} · ${rapport.b7_identite.cles_actives ?? '?'} clé(s) active(s) sur ${rapport.b7_identite.cles_total ?? '?'}`);
  }
  console.log(`  appartenances  : ${rapport.a3_atteintes_privilegiees} atteinte(s) d un rôle privilégié (${rapport.a3_atteintes_totales} appartenance(s) mesurée(s) au total)`);
  console.log('');
  if (rapport.arrets.length === 0) {
    console.log('  AUCUN ARRÊT DÉTECTÉ par la sonde de catalogue.');
  } else {
    console.log(`  ${rapport.arrets.length} ARRÊT(S) — la mission impose de s arrêter et de documenter :`);
    for (const a of rapport.arrets) console.log(`    - ${a}`);
  }
  console.log('');
  console.log('  Rappel : cette sonde lit le CATALOGUE avec le rôle de l opérateur. Le rôle');
  console.log('  réellement utilisé par le runtime se mesure DEPUIS le runtime.');
}

export async function main(argv = process.argv, env = process.env) {
  const argument = (nom, defaut = null) => {
    const i = argv.indexOf(nom);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : defaut;
  };
  const url = (argument('--url') || env.TRACEFAB_LECTURE_URL || '').trim();
  const roleRuntime = argument('--role-runtime', 'tracefab_app');
  const sortieJson = argv.includes('--json');

  if (!url) {
    console.error('  NON EXECUTE — fournir --url <url de LECTURE> ou TRACEFAB_LECTURE_URL.');
    return 2;
  }

  let hote = '';
  try { hote = new URL(url).hostname; } catch { hote = ''; }
  const local = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote);
  if (!local && env.TF_P107_AUTORISER_HOTE_DISTANT !== 'oui') {
    console.error(`  REFUS — cible non locale (${hote || 'illisible'}).`);
    console.error('  Relancer avec TF_P107_AUTORISER_HOTE_DISTANT=oui après accord de l opérateur.');
    return 3;
  }

  const entrees = decouperSonde(readFileSync(CHEMIN_SONDE, 'utf8'));
  const nonSelect = entrees.filter((e) => !/^(select|with)\b/i.test(e.requete));
  if (nonSelect.length > 0) {
    console.error(`  REFUS STATIQUE — une instruction ne commence pas par SELECT/WITH : ${nonSelect[0].requete.slice(0, 60)}`);
    return 3;
  }

  const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-p107-sonde' });
  try {
    await client.connect();
  } catch (e) {
    console.error(`  NON EXECUTE — connexion refusée (${e.code || 'inconnu'}).`);
    return 2;
  }

  try {
    const { rapport, codeSortie } = await executerSonde({ client, entrees, roleRuntime });
    if (sortieJson) console.log(JSON.stringify(rapport, null, 2));
    else afficherRapport(rapport);
    return codeSortie;
  } finally {
    await client.end();
  }
}

const executionDirecte = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executionDirecte) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(`  NON EXECUTE — erreur interne du lanceur (${e.code || messageDe(e)}).`);
    process.exitCode = 2;
  }
}
