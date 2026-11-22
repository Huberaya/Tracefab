#!/usr/bin/env node
/**
 * Activation (et retour arriere) du mode STRICT de l'identite systeme.
 *
 * POURQUOI CETTE COMMANDE EXISTE, ET PAS UNE MIGRATION
 *
 * Une migration s'applique a TOUTES les bases, y compris celles qui n'ont pas
 * de secret — base jetable de CI, base ephemere d'une suite, base de
 * demonstration. Basculer en strict dans une migration rend donc la chaine
 * inapplicable partout ou la cle n'a pas ete provisionnee, et ce sont
 * exactement les environnements qui doivent rester utilisables. Mesure du
 * 2026-11-05 : `test:neon:privileges-role-app` est tombe en P0001 sur une base
 * neuve, et une chaine de migrations qui exige un secret pour s'appliquer n'est
 * plus une chaine de migrations.
 *
 * Le mode est donc un ETAT D'EXPLOITATION, comme le mode strict de l'identite
 * utilisateur (`strict`, laisse a `false` par `20261102120000`). La migration
 * installe le controle ; cette commande l'active.
 *
 * CE QU'ELLE NE FAIT PAS, ET C'EST LE PLUS IMPORTANT
 *
 *   - elle ne devine pas : chaque prerequis est LECTURE en base et rapporte,
 *     et un prerequis non tenu est un REFUS (code 3), pas un avertissement ;
 *   - elle ne bascule pas partiellemment : les treize operations sont verifiees
 *     gardees AVANT l'ecriture, et la postcondition est relue APRES — les deux
 *     dans la meme transaction, donc un echec ne laisse rien a moitie fait ;
 *   - elle ne touche a aucune cle, aucun privilege, aucune donnee metier ;
 *   - elle n'ecrit que sur une cible JETABLE, par le classifieur commun. Un
 *     environnement qui sert n'est pas une cible de script : c'est une decision
 *     d'operateur prise avec l'outil de deploiement de cet environnement, et
 *     l'ordre de deploiement est ecrit dans l'en-tete de 20261105120100.
 *     `--verifier` reste utilisable partout : il ne lit que.
 *
 * USAGE
 *   DATABASE_URL=... node scripts/activer_identite_systeme_stricte.mjs --verifier     (lecture seule)
 *   DATABASE_URL=... TF_ALLOW_WRITE=oui node scripts/activer_identite_systeme_stricte.mjs --activer
 *   DATABASE_URL=... TF_ALLOW_WRITE=oui node scripts/activer_identite_systeme_stricte.mjs --desactiver
 *
 * Sortie : 0 conforme · 1 ecart · 2 non execute · 3 refus.
 */
import process from 'node:process';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { classifyTarget, describeTarget } from './lib/require-throwaway-db.mjs';

// `--dry-run` est un alias de `--verifier` : la politique de routage des suites
// (scripts/test_destructive_suite_routing.mjs) exige qu'un outil d'ecriture hors
// chaine automatique porte un mode qui n'ecrit RIEN. L'alias n'est pas
// cosmetique : il rend la contrainte verifiable par lecture du source, et il
// evite qu'un operateur presse confonde « voir l'etat » et « changer l'etat ».
const MODES_LECTURE = ['--verifier', '--dry-run'];
const mode = process.argv.includes('--activer') ? 'activer'
  : process.argv.includes('--desactiver') ? 'desactiver'
    : process.argv.some((a) => MODES_LECTURE.includes(a)) ? 'verifier'
      : null;

if (mode === null) {
  console.error('  NON EXECUTE — choisir --verifier (ou --dry-run), --activer ou --desactiver.');
  process.exit(2);
}
if (mode !== 'verifier' && process.argv.some((a) => MODES_LECTURE.includes(a))) {
  console.error('  REFUS — --verifier et --activer/--desactiver sont exclusifs.');
  process.exit(3);
}

const variableCible = () => (process.env.DATABASE_ADMIN_URL || '').trim() ? 'DATABASE_ADMIN_URL' : 'DATABASE_URL';
const url = (process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL || '').trim();
if (!url) {
  console.error('  NON EXECUTE — DATABASE_ADMIN_URL (ou DATABASE_URL) est absente.');
  process.exit(2);
}

// Lecture seule : la garde de cible ne s'applique pas. C'est le meme partage que
// `provisionner_cle_identite.mjs --verifier`. Une ecriture, elle, exige une
// cible classable comme jetable ET un consentement explicite.
if (mode !== 'verifier') {
  const classification = classifyTarget(url);
  // `describeTarget` prend le NOM de la variable, pas sa valeur : il ne publie ni
  // hote, ni identifiant, ni mot de passe, seulement classe, base et empreinte.
  console.log(`  garde cible : ${describeTarget(variableCible(), classification)}`);
  if (!classification.allowed) {
    console.error(`  REFUS — ecriture refusee sur cette cible (${classification.code}) : ${classification.reason}.`);
    console.error('  Rien n a ete ecrit. Le basculement d un environnement qui sert est un acte');
    console.error('  d exploitation documente (en-tete de 20261105120100), pas une commande de script.');
    process.exit(3);
  }
  if (process.env.TF_ALLOW_WRITE !== 'oui') {
    console.error('  REFUS — basculer un mode est une ecriture. Relancer avec TF_ALLOW_WRITE=oui,');
    console.error('  ou en lecture seule avec --verifier.');
    process.exit(3);
  }
}

const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-p107-mode-systeme' });
await client.connect();

let echecs = 0;
const ok = (condition, libelle, detail = '') => {
  console.log(`  ${condition ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!condition) echecs += 1;
  return condition;
};

/** Les prerequis, lus et non supposes. Rend l'etat complet ou `null` si absent. */
const etat = async (executeur) => {
  const politique = (await executeur.query(
    `SELECT to_regclass('public.tracefab_identity_politique') IS NOT NULL AS a_politique`)).rows[0];
  if (!politique.a_politique) return null;
  const ligne = (await executeur.query(
    `SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton`)).rows[0];
  const cles = (await executeur.query(
    `SELECT count(*)::int AS n FROM public.tracefab_identity_cles WHERE actif`)).rows[0].n;
  const sonde = (await executeur.query(
    `SELECT * FROM public.tracefab_sec_probe_identite_systeme()`)).rows[0];
  return { strict: ligne?.systeme_strict, cles, sonde };
};

const afficher = (e) => {
  console.log(`  mode systeme strict ......... ${e.strict}`);
  console.log(`  cles actives ................ ${e.cles}`);
  console.log(`  operations gardees .......... ${e.sonde.operations_systeme_gardees}`);
  console.log(`  operations NON gardees ...... ${e.sonde.operations_systeme_non_gardees}`);
  console.log(`  runtime endosse le worker ... ${e.sonde.runtime_endosse_worker}`);
  console.log(`  runtime lit les cles ........ ${e.sonde.runtime_lit_les_cles}`);
};

try {
  if (mode === 'verifier') {
    const e = await etat(client);
    if (e === null) {
      console.error('  NON EXECUTE — 20261105120000 n est pas appliquee sur cette cible.');
      process.exit(2);
    }
    console.log('  ETAT (lecture seule)');
    afficher(e);
    // La verification ne juge pas : elle rapporte. Un environnement en mode
    // permissif est l'etat ATTENDU d'une base neuve, pas un ecart.
    process.exit(0);
  }

  console.log(`\n  ${mode === 'activer' ? 'ACTIVATION' : 'RETOUR ARRIERE'} du mode strict de l identite systeme\n`);

  await client.query('BEGIN');
  // Verrou de ligne : deux executions concurrentes ne peuvent pas se croiser et
  // laisser la politique dans un etat que ni l'une ni l'autre n'a voulu.
  const avant = (await client.query(
    `SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton FOR UPDATE`)).rows[0];
  if (avant === undefined) {
    throw new Error('politique d identite absente — 20261105120000 n a pas ete appliquee');
  }

  const e = await etat(client);
  afficher(e);

  if (mode === 'activer') {
    if (!ok(e.cles > 0, 'prerequis : au moins une cle d identite ACTIVE',
      `${e.cles} cle(s) — sans cle, basculer fermerait definitivement toute operation systeme`)) {
      throw new Error('prerequis non tenu');
    }
    if (!ok(e.sonde.operations_systeme_non_gardees === 0, 'prerequis : chaque operation systeme porte la garde d origine',
      `${e.sonde.operations_systeme_non_gardees} non gardee(s)`)) {
      throw new Error('prerequis non tenu');
    }
    if (!ok(e.sonde.runtime_lit_les_cles === false, 'prerequis : le runtime ne peut pas lire les cles',
      `lecture=${e.sonde.runtime_lit_les_cles}`)) {
      throw new Error('prerequis non tenu');
    }
    if (e.strict === true) {
      // Pas une erreur : rejouer doit etre sans effet, sinon un operateur qui
      // relance apres une coupure ne sait pas s'il a agi.
      console.log('  deja actif — aucune ecriture');
      await client.query('ROLLBACK');
      process.exit(echecs === 0 ? 0 : 1);
    }
  }

  await client.query(
    `UPDATE public.tracefab_identity_politique SET systeme_strict = $1, modifie_le = now() WHERE singleton`,
    [mode === 'activer']);
  const apres = (await client.query(
    `SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton`)).rows[0];
  ok(apres.systeme_strict === (mode === 'activer'), `postcondition : systeme_strict = ${mode === 'activer'}`, String(apres.systeme_strict));

  // La postcondition ne porte pas que sur la colonne : une politique qui dit
  // « strict » alors que les treize operations sont inexecutables serait une
  // panne declaree conforme. On relit la sonde DANS la transaction.
  const sondeApres = (await client.query(`SELECT * FROM public.tracefab_sec_probe_identite_systeme()`)).rows[0];
  ok(sondeApres.mode_systeme_strict === (mode === 'activer'), 'postcondition : la sonde rapporte le meme mode', String(sondeApres.mode_systeme_strict));

  if (echecs > 0) throw new Error('postcondition non tenue');
  await client.query('COMMIT');
  console.log(`\n  ${mode === 'activer' ? 'ACTIVE' : 'DESACTIVE'} — transaction validee`);
  console.log(`  retour arriere : node scripts/activer_identite_systeme_stricte.mjs --desactiver`);
} catch (erreur) {
  try { await client.query('ROLLBACK'); } catch { /* rien a defaire */ }
  console.error(`\n  REFUS — rien n a ete ecrit : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
  process.exit(echecs > 0 || /prerequis/.test(String(erreur)) ? 3 : 1);
} finally {
  await client.end();
}

process.exit(echecs === 0 ? 0 : 1);
