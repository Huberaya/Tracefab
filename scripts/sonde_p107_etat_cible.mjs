#!/usr/bin/env node
/**
 * P10.7 — LANCEUR DE LA SONDE DE LECTURE SEULE (identité du runtime et état cible).
 *
 * POURQUOI CE LANCEUR EXISTE
 *
 * Un opérateur qui doit mesurer la production ne doit pas avoir à découper un
 * fichier SQL à la main, ni à interpréter une sortie de `psql` à 40 colonnes :
 * il doit obtenir des VERDICTS, et une liste d'ARRÊTS quand la mission P10.7 en
 * prévoit un. Ce script fait exactement cela, et rien d'autre :
 *
 *   - il exécute la sonde dans une transaction `READ ONLY`, puis `ROLLBACK` ;
 *   - il REFUSE de démarrer si le fichier contient une instruction qui ne
 *     commence pas par SELECT ou WITH (contrôle statique, avant connexion) ;
 *   - il tente une écriture dans la transaction pour prouver le refus (25006),
 *     et s'arrête si l'écriture passe ;
 *   - il ne lit aucun secret : aucune colonne de la sonde n'en contient, et le
 *     lanceur n'affiche que des noms de rôles, des compteurs et des versions ;
 *   - il rend un code de sortie exploitable : 0 pas d'arrêt · 1 arrêt détecté
 *     · 2 non exécuté · 3 refus (cible de production sans opt-in explicite).
 *
 * UTILISATION
 *   node scripts/sonde_p107_etat_cible.mjs --url "$TRACEFAB_LECTURE_URL"
 *   node scripts/sonde_p107_etat_cible.mjs --url … --json > mesure.json
 *   TF_P107_AUTORISER_HOTE_DISTANT=oui  (obligatoire hors localhost)
 *
 * Le rôle attendu du runtime est un PARAMÈTRE (`--role-runtime`), jamais une
 * déduction : `DATABASE_URL` peut porter n'importe quel nom.
 */
import process from 'node:process';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const CHEMIN_SONDE = 'docs/security/2026-11-02-p107-sonde-identite-et-etat-cible.sql';

const argument = (nom, defaut = null) => {
  const i = process.argv.indexOf(nom);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
};

const url = (argument('--url') || process.env.TRACEFAB_LECTURE_URL || '').trim();
const roleRuntime = argument('--role-runtime', 'tracefab_app');
const sortieJson = process.argv.includes('--json');

if (!url) {
  console.error('  NON EXECUTE — fournir --url <url de LECTURE> ou TRACEFAB_LECTURE_URL.');
  process.exit(2);
}

let hote = '';
try { hote = new URL(url).hostname; } catch { hote = ''; }
const local = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote);
if (!local && process.env.TF_P107_AUTORISER_HOTE_DISTANT !== 'oui') {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}).`);
  console.error('  Cette sonde ne lit rien de sensible, mais elle doit être lancée sciemment :');
  console.error('  relancer avec TF_P107_AUTORISER_HOTE_DISTANT=oui après accord de l opérateur.');
  process.exit(3);
}

/* --- découpage PAR SECTION, puis contrôle statique, avant toute connexion -- */
/*
 * Le découpage se fait sur les titres `-- B7. …` et non sur les premières
 * lettres de la requête : deux sections peuvent commencer par le même préfixe
 * (`SELECT to_regrole` et `SELECT to_regclass`, mesuré), et un appariement
 * approximatif attribuait alors le résultat de B7 à B6 — un rapport qui perd
 * une section est un rapport qui rassure à tort.
 */
const source = readFileSync(CHEMIN_SONDE, 'utf8');
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
const instructions = entrees.map((e) => e.requete);
const nonSelect = instructions.filter((q) => !/^(select|with)\b/i.test(q));
if (nonSelect.length > 0) {
  console.error(`  REFUS STATIQUE — une instruction ne commence pas par SELECT/WITH : ${nonSelect[0].slice(0, 60)}`);
  process.exit(3);
}

const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-p107-sonde' });
try {
  await client.connect();
} catch (e) {
  console.error(`  NON EXECUTE — connexion refusée (${e.code || 'inconnu'}).`);
  process.exit(2);
}

const sections = [];
let probleme = null;
let refusEcriture = null;
try {
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ ONLY');
  for (const { titre, requete } of entrees) {
    try {
      const r = await client.query(requete);
      sections.push({ titre, lignes: r.rows });
    } catch (e) {
      probleme = `${e.code} ${e.message.split('\n')[0].slice(0, 90)} (section ${titre.slice(0, 4)})`;
      break;
    }
  }
  // Preuve par le refus : une écriture DOIT échouer ici.
  try {
    await client.query('CREATE TABLE tracefab_readonly_probe (x int)');
    refusEcriture = 'ACCEPTEE';
    console.log('         UNE ECRITURE A REUSSI dans la transaction de la sonde');
  } catch (e) {
    refusEcriture = /read-only transaction/i.test(e.message) ? '25006' : `refus inattendu ${e.code}`;
  }
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}

if (refusEcriture !== '25006') {
  console.error(`  ARRET — la sonde a pu ÉCRIRE (${refusEcriture}). Ne pas s en servir.`);
  process.exit(1);
}
if (probleme) {
  console.error(`  NON EXECUTE — la sonde a échoué : ${probleme}`);
  process.exit(2);
}

/* --- lecture des résultats, par leur position dans le fichier ------------- */
const parTitre = (motif) => {
  const section = sections.find((s) => motif.test(s.titre));
  return section ? section.lignes : null;
};
const premiere = (motif) => (parTitre(motif) || [])[0] || null;

const contexte = premiere(/A1\./);
const membresPrivilegies = parTitre(/A3\./) || [];
const prisesDeRole = parTitre(/A4\./) || [];
const historique = premiere(/B1\./);
const attendues = parTitre(/B2\./) || [];
const propriete = parTitre(/B4\./) || [];
const hygiene = premiere(/B5\./);
const droits = premiere(/B6\./);
const identite = premiere(/B7\./);
const porteeCle = premiere(/B8\./);

const arrets = [];
if (!contexte) arrets.push('A1 : contexte illisible — aucune mesure exploitable');
if (!historique) arrets.push('B1 : historique des migrations illisible');

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

const rapport = {
  schema: 'tracefab-p107-sonde-v1',
  mesuree_le: contexte?.mesuree_le ? new Date(contexte.mesuree_le).toISOString() : null,
  lecture_seule_prouvee: refusEcriture,
  role_attendu_du_runtime: roleRuntime,
  contexte: contexte ? {
    role_executant: contexte.role_executant,
    base: contexte.base,
    version_postgresql: contexte.version_postgresql,
    port_serveur: contexte.port_serveur,
    adresse_serveur_presente: contexte.adresse_serveur !== null,
  } : null,
  a3_atteintes_totales: membresPrivilegies.length,
  a3_atteintes_privilegiees: privilegiesAtteints.length,
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

if (sortieJson) {
  console.log(JSON.stringify(rapport, null, 2));
} else {
  console.log('');
  console.log(`  Sonde P10.7 — ${rapport.mesuree_le || 'date illisible'} · lecture seule prouvée (${refusEcriture})`);
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
  if (arrets.length === 0) {
    console.log('  AUCUN ARRÊT DÉTECTÉ par la sonde de catalogue.');
  } else {
    console.log(`  ${arrets.length} ARRÊT(S) — la mission P10.7 impose de s arrêter et de documenter :`);
    for (const a of arrets) console.log(`    - ${a}`);
  }
  console.log('');
  console.log('  Rappel : cette sonde lit le CATALOGUE avec le rôle de l opérateur. Le rôle');
  console.log('  réellement utilisé par le runtime se mesure DEPUIS le runtime —');
  console.log('  `GET /api/internal/p2-readiness?identity=1` ou `node scripts/sonde_p107_runtime.mjs`.');
}

process.exit(arrets.length === 0 ? 0 : 1);
