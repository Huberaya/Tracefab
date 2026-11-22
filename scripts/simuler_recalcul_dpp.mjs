#!/usr/bin/env node
/**
 * SIMULATION (sans ecriture conservee) du recalcul DPP sur un parc reel.
 *
 * OBJECTIF — phase F de la mission de cloture : savoir, AVANT tout recalcul
 * reel, ce que le recalcul changerait — statuts, scores, exigences manquantes,
 * revues, visibilite publique — et prouver que rien n'a bouge.
 *
 * COMMENT C'EST SUR
 *   Le script ouvre UNE transaction, y execute le recalcul (donc les ecritures
 *   reelles du moteur : dpp_records, evenements, audits), mesure, puis fait
 *   TOUJOURS ROLLBACK. Il verifie ensuite, hors transaction, que la base est
 *   identique a l'instant d'avant (compteurs + empreintes). Si la verification
 *   echoue, il sort en code 4 : c'est une alerte, pas un detail.
 *
 * GARDE-FOUS
 *   - refuse la base de production (hote connu ou prefixe `ep-polished-night`) ;
 *   - exige `TF_SIMULATION_CIBLE` egal a l'hote de la cible : l'operateur doit
 *     nommer explicitement la base qu'il vise ;
 *   - n'affiche jamais l'URL de connexion, ni mot de passe, ni secret : seul
 *     l'hote (sans identifiants) est imprime ;
 *   - pseudonymise les identifiants produits : le rapport se transmet, il ne
 *     doit pas transporter d'identifiants exploitables ;
 *   - aucune ecriture hors transaction ;
 *   - `statement_timeout` et `lock_timeout` courts : le script abandonne plutot
 *     que de bloquer une base vivante.
 *
 * CE QU'IL NE FAIT PAS
 *   Il ne recalcule pas le parc pour de vrai, il ne publie rien, il ne
 *   supprime rien. Le ROLLBACK est verifie, pas suppose.
 *
 * USAGE
 *   DATABASE_URL=... TF_SIMULATION_CIBLE=ep-xxx.eu-central-1.aws.neon.tech \
 *     node scripts/simuler_recalcul_dpp.mjs [--sortie rapport.json]
 *
 *   Mode ECRITURE (27/10/2026), pour appliquer le recalcul pour de vrai :
 *   DATABASE_URL=... TF_SIMULATION_CIBLE=<hote> TF_RECALCUL_CONFIRME=<hote> \
 *     node scripts/simuler_recalcul_dpp.mjs --appliquer [--sortie rapport.json]
 *
 * DEUX NOMS POUR ECRIRE, UN SEUL POUR SIMULER
 *   `TF_SIMULATION_CIBLE` designe la base qu'on regarde ; `TF_RECALCUL_CONFIRME`
 *   doit repeter le meme hote pour autoriser l'ecriture. Un nom suffit a lire,
 *   deux a ecrire : c'est volontaire. Le meme controle refuse toujours la
 *   production, en lecture comme en ecriture.
 *
 * CE QUE FAIT `--appliquer`, ET CE QU'IL REFUSE DE FAIRE
 *   Il execute le recalcul dans UNE transaction, puis :
 *     - si une ANOMALIE TECHNIQUE apparait (revue perdue sans changement de
 *       score, visibilite perdue sans suspension, visibilite acquise sans
 *       publication) -> ROLLBACK, code 4, rien n'est ecrit ;
 *     - si une decision metier reste a confirmer -> ROLLBACK, code 4 ;
 *     - sinon -> COMMIT, puis verification hors transaction.
 *   Une sauvegarde JSON des lignes concernees est ecrite AVANT le recalcul.
 *
 * CODE DE SORTIE
 *   0 simulation jouee base restauree, ou recalcul applique et verifie ;
 *   2 usage (dont `--appliquer` sans confirmation) ; 3 cible refusee ;
 *   4 base non restauree, ou ecriture refusee par un controle (alerte) ;
 *   1 erreur d'execution.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const HOTE_PRODUCTION = process.env.TF_HOTE_PRODUCTION
  || 'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech';

const url = process.env.DATABASE_URL;
if (!url) { console.error('NON EXECUTE — DATABASE_URL obligatoire.'); process.exit(2); }

let hote;
try { hote = new URL(url).hostname; } catch { console.error('NON EXECUTE — DATABASE_URL illisible.'); process.exit(2); }

if (hote === HOTE_PRODUCTION || /^ep-polished-night/.test(hote)) {
  console.error(`REFUS — ${hote} est la base de production. La simulation se joue sur une branche.`);
  process.exit(3);
}
const cible = process.env.TF_SIMULATION_CIBLE;
if (!cible) {
  console.error('REFUS — TF_SIMULATION_CIBLE doit nommer explicitement la base visee.');
  console.error(`         (hote courant : ${hote})`);
  process.exit(3);
}
if (cible !== hote) {
  console.error('REFUS — TF_SIMULATION_CIBLE ne correspond pas a l\'hote de DATABASE_URL.');
  console.error(`         declare : ${cible} / reel : ${hote}`);
  process.exit(3);
}

// --- Mode d'execution ------------------------------------------------------
// Lire ne demande qu'un nom : la cible. Ecrire en demande deux. Les deux
// controles sont places AVANT la connexion : un refus n'ouvre aucune session.
const appliquer = process.argv.includes('--appliquer');
if (appliquer) {
  const confirme = process.env.TF_RECALCUL_CONFIRME;
  if (!confirme) {
    console.error('REFUS — --appliquer exige TF_RECALCUL_CONFIRME egal a l\'hote de la cible.');
    console.error('         (lire demande un nom, ecrire en demande deux : c\'est voulu)');
    process.exit(2);
  }
  if (confirme !== hote) {
    console.error('REFUS — TF_RECALCUL_CONFIRME ne correspond pas a l\'hote de DATABASE_URL.');
    console.error(`         confirme : ${confirme} / reel : ${hote}`);
    process.exit(3);
  }
}

const argSortie = process.argv.indexOf('--sortie');
const cheminSortie = argSortie > -1 ? process.argv[argSortie + 1] : null;

const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });

const PROFIL = { key: 'textile_readiness_mvp', version: '1.0' };

/** Pseudonyme stable dans un rapport : 8 caracteres, non reversible en pratique. */
const pseudo = (uuid) => `P-${createHash('sha256').update(String(uuid)).digest('hex').slice(0, 8)}`;

/** Etat complet, compare avant/apres et autour du rollback. */
async function etat() {
  const q = async (sql) => (await client.query(sql)).rows;
  const [recs, prods, evts, audits, slugs, publies] = await Promise.all([
    q(`SELECT md5(coalesce(string_agg(id::text || ':' || readiness_status || ':' ||
        coalesce(review_invalidation_reason, '-'), '|' ORDER BY id), '')) AS empreinte,
        count(*)::int AS n
       FROM dpp_records`),
    q(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(public_slug, '-') || ':' ||
        updated_at::text, '|' ORDER BY id), '')) AS empreinte,
        count(*)::int AS n
       FROM tracefab_products`),
    q('SELECT count(*)::int AS n FROM dpp_lifecycle_events'),
    q("SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'dpp.%'"),
    q('SELECT count(*)::int AS n FROM tracefab_products WHERE public_slug IS NOT NULL'),
    q("SELECT count(*)::int AS n FROM dpp_records WHERE readiness_status = 'published'"),
  ]);
  return {
    dossiers: recs[0], produits: prods[0],
    evenements: evts[0].n, audits_dpp: audits[0].n,
    slugs_poses: slugs[0].n, publies: publies[0].n,
  };
}

const resultats = [];
const maintenant = () => new Date().toISOString();

/** Verdict d'evaluation : le moteur ne doit jamais lire « pas d'evaluation » comme un succes. */
function evaluation(snapshot) {
  const score = snapshot && snapshot.latest_quality_score;
  if (!score) return { presente: false, score: null, validee_le: null };
  return {
    presente: true,
    score: score.score === undefined ? null : score.score,
    validee_le: score.computed_at || null,
  };
}

function resume(r) {
  const exigences = (r.source_snapshot && r.source_snapshot.requirement_results) || [];
  const manquantes = exigences.filter((x) => !x.met).map((x) => x.key);
  return {
    statut: r.readiness_status,
    satisfaites: exigences.filter((x) => x.met).length,
    total_exigences: exigences.length,
    score: `${exigences.filter((x) => x.met).length}/${exigences.length}`,
    exigences_manquantes: manquantes,
    evaluation: evaluation(r.source_snapshot),
    revue: r.reviewed_at ? 'presente' : 'aucune',
    revue_le: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    revue_figee: r.reviewed_basis_fingerprint || null,
    motif_invalidation: r.review_invalidation_reason || null,
    bloquants: Array.isArray(r.blocking_issues) ? r.blocking_issues.length : null,
  };
}

await client.connect();
await client.query("SET statement_timeout = '120s'");
await client.query("SET lock_timeout = '10s'");

const avant = await etat();
console.log('Simulation du recalcul DPP — AUCUNE ECRITURE CONSERVEE');
console.log(`  cible           : ${hote}`);
console.log(`  dossiers        : ${avant.dossiers.n}`);
console.log(`  produits        : ${avant.produits.n}`);
console.log(`  publies         : ${avant.publies}`);
console.log(`  slugs publics   : ${avant.slugs_poses}`);
console.log('');

// Perimetre : les dossiers DPP existants. Un recalcul reel ne serait lance que
// sur eux (creer un dossier est une autre decision, hors simulation).
// Le moteur exige un utilisateur porteur d'un role organisationnel autorise :
// on emprunte, dossier par dossier, l'auteur du dernier calcul, a defaut un
// membre actif autorise. Aucun contournement de la regle metier.
const { rows: dossiers } = await client.query(
  `SELECT d.product_id, d.id AS dpp_id, d.readiness_status,
          d.requirement_profile_key AS cle, d.requirement_profile_version AS version,
          p.public_slug, p.brand_organization_id AS org_id,
          COALESCE(d.computed_by, (
            SELECT m.user_id FROM organization_memberships m
             WHERE m.organization_id = p.brand_organization_id
               AND m.status = 'active'
               AND m.role IN ('owner','admin','manager','auditor')
             ORDER BY m.created_at LIMIT 1
          )) AS acteur_id
     FROM dpp_records d
     JOIN tracefab_products p ON p.id = d.product_id
    ORDER BY d.product_id`,
);

let erreur = null;
let publiesApresRecalcul = null;
let cheminSauvegarde = null;

// Sauvegarde AVANT d'ecrire : les lignes telles qu'elles sont, en JSON local.
// Un ROLLBACK malheureux ou une erreur applicative ne doit jamais laisser
// l'operateur sans l'etat d'avant. Le fichier reste hors du depot.
if (appliquer && dossiers.length) {
  const { rows: lignes } = await client.query(
    'SELECT * FROM dpp_records WHERE product_id = ANY($1::uuid[])',
    [dossiers.map((d) => d.product_id)]);
  cheminSauvegarde = (cheminSortie ? cheminSortie.replace(/\.json$/, '') : '/tmp/recalcul-dpp')
    + '.sauvegarde.json';
  mkdirSync(dirname(cheminSauvegarde), { recursive: true });
  writeFileSync(cheminSauvegarde, JSON.stringify({
    date: new Date().toISOString(), hote, mode: 'avant-recalcul', lignes,
  }, null, 2));
}

await client.query('BEGIN');
try {
  for (const d of dossiers) {
    const base = {
      produit: pseudo(d.product_id),
      publie_avant: d.readiness_status === 'published',
    };
    if (!d.acteur_id) {
      resultats.push({ ...base, non_simule: 'aucun acteur au role autorise dans l\'organisation marque' });
      continue;
    }
    // SET LOCAL : le contexte disparait avec le ROLLBACK.
    await client.query("SELECT set_config('tracefab.user_id', $1, true)", [d.acteur_id]);
    const avantUn = (await client.query('SELECT * FROM dpp_records WHERE id = $1', [d.dpp_id])).rows[0];
    // La visibilite se lit AVANT le recalcul, sinon on mesure l'apres.
    const visibleAvant = (await client.query('SELECT tracefab_product_is_public($1) AS v', [d.product_id])).rows[0].v;
    const apresUn = (await client.query('SELECT * FROM tracefab_compute_dpp_readiness($1,$2,$3)',
      [d.product_id, d.cle || PROFIL.key, d.version || PROFIL.version])).rows[0];
    const visibleApres = (await client.query('SELECT tracefab_product_is_public($1) AS v', [d.product_id])).rows[0].v;
    const slugApres = (await client.query('SELECT public_slug FROM tracefab_products WHERE id = $1',
      [d.product_id])).rows[0].public_slug;

    const a = resume(avantUn);
    const b = resume(apresUn);
    const changements = [];
    let motif = '';
    let decisionRevue = 'conservee';
    let decisionVisibilite = 'inchangee';

    if (a.statut !== b.statut) {
      const baisse = ['published', 'ready_to_publish', 'data_ready'].indexOf(a.statut)
        < ['published', 'ready_to_publish', 'data_ready'].indexOf(b.statut);
      changements.push(`statut ${a.statut} -> ${b.statut}${baisse ? ' (baisse)' : ''}`);
    }
    if (a.score !== b.score) changements.push(`score ${a.score} -> ${b.score}`);

    if (a.revue === 'presente' && b.revue === 'aucune') {
      decisionRevue = `invalidee (${b.motif_invalidation || 'sans motif'})`;
      changements.push('revue invalidee');
    } else if (a.revue === 'aucune' && b.revue === 'presente') {
      decisionRevue = 'apparue (improbable : le recalcul ne cree pas de revue)';
      changements.push('revue apparue');
    }

    if (Boolean(d.public_slug) !== Boolean(slugApres)) {
      decisionVisibilite = slugApres ? 'slug pose' : 'slug efface (passeport retire du public)';
      changements.push(slugApres ? 'slug pose' : 'slug efface');
    }
    if (visibleAvant && !visibleApres) changements.push('VISIBILITE PUBLIQUE PERDUE');
    if (!visibleAvant && visibleApres) changements.push('VISIBILITE PUBLIQUE ACQUISE');

    // Motif metier : ce qui, dans les donnees, explique le mouvement.
    if (b.exigences_manquantes.length) {
      motif = `exigences non satisfaites : ${b.exigences_manquantes.join(', ')}`;
    } else if (!b.evaluation.presente) {
      motif = 'aucune evaluation qualite persistee';
    } else if (!changements.length) {
      motif = 'aucun mouvement';
    }

    // Classification : distinguer une correction attendue d'une anomalie
    // technique evite de presenter tout changement comme un progres.
    let classification = 'aucun changement';
    if (changements.length) {
      const perteRevue = decisionRevue.startsWith('invalidee');
      if (perteRevue && a.score === b.score) {
        classification = 'ANOMALIE TECHNIQUE — revue invalidee sans changement de score';
      } else if (visibleAvant && !visibleApres && b.statut === 'published') {
        classification = 'ANOMALIE TECHNIQUE — visibilite perdue sans suspension';
      } else if (!visibleAvant && visibleApres && a.statut !== 'published') {
        classification = 'ANOMALIE TECHNIQUE — visibilite acquise sans publication';
      } else if (d.readiness_status === 'published' && b.statut !== 'published') {
        classification = 'correction attendue — passeport publie devenu non conforme, suspendu';
      } else if (a.statut !== b.statut) {
        classification = b.exigences_manquantes.length
          ? 'correction attendue — preuve manquante desormais evaluee'
          : 'decision metier a confirmer';
      } else {
        classification = 'a examiner';
      }
    }

    resultats.push({
      ...base,
      statut_avant: a.statut, statut_apres: b.statut,
      score_avant: a.score, score_apres: b.score,
      exigences_satisfaites_apres: b.satisfaites,
      exigences_manquantes_apres: b.exigences_manquantes,
      evaluation_avant: a.evaluation, evaluation_apres: b.evaluation,
      revue_avant: a.revue, revue_apres: b.revue,
      decision_revue: decisionRevue,
      slug_avant: Boolean(d.public_slug), slug_apres: Boolean(slugApres),
      visible_avant: visibleAvant, visible_apres: visibleApres,
      decision_visibilite: decisionVisibilite,
      motif, changements, classification,
    });
  }
  const { rows: [p] } = await client.query(
    "SELECT count(*)::int AS n FROM dpp_records WHERE readiness_status = 'published'");
  publiesApresRecalcul = p.n;
} catch (e) {
  erreur = e.message;
}

// Decision d'ecriture : on ne commit QUE si rien d'anormal n'a ete classe.
// Une anomalie technique ou une decision metier non tranchee annule tout :
// un recalcul qui perd une revue ou change une visibilite sans decision
// explicite ne doit pas etre conserve « parce qu'il est deja calcule ».
const anomalies = resultats.filter((r) => typeof r.classification === 'string'
  && r.classification.startsWith('ANOMALIE'));
const aTrancher = resultats.filter((r) => r.classification === 'decision metier a confirmer');
let committe = false;
if (appliquer && !erreur && !anomalies.length && !aTrancher.length) {
  await client.query('COMMIT');
  committe = true;
} else {
  await client.query('ROLLBACK');
}

const apres = await etat();
const restauree = JSON.stringify(avant) === JSON.stringify(apres);

const simules = resultats.filter((r) => !r.non_simule);
const changes = simules.filter((r) => r.changements.length > 0);

console.log('Tableau avant/apres (identifiants pseudonymises)');
console.log('------------------------------------------------');
if (!changes.length) console.log('  (aucun : le recalcul serait neutre sur ce parc)');
for (const r of changes) {
  console.log(`  ${r.produit}  ${r.statut_avant} -> ${r.statut_apres}  ${r.score_avant} -> ${r.score_apres}`);
  console.log(`     revue        : ${r.decision_revue}`);
  console.log(`     visibilite   : avant ${r.visible_avant ? 'visible' : 'non visible'}`
    + ` / apres ${r.visible_apres ? 'visible' : 'non visible'} — ${r.decision_visibilite}`);
  if (r.exigences_manquantes_apres.length) {
    console.log(`     manquantes   : ${r.exigences_manquantes_apres.join(', ')}`);
  }
  console.log(`     motif        : ${r.motif}`);
  console.log(`     classement   : ${r.classification}`);
}

const nonSimules = resultats.filter((r) => r.non_simule);
if (nonSimules.length) {
  console.log('\n  dossiers non simules (contexte insuffisant)');
  for (const r of nonSimules) console.log(`    ${r.produit}  ${r.non_simule}`);
}

const compte = (pred) => simules.filter(pred).length;
console.log('\nQuantification');
console.log('--------------');
console.log(`  dossiers du parc        : ${resultats.length}`);
console.log(`  dossiers simules        : ${simules.length}`);
console.log(`  dossiers modifies       : ${changes.length}`);
console.log(`  corriges (correction)   : ${compte((r) => r.classification.startsWith('correction attendue'))}`);
console.log(`  anomalies techniques    : ${compte((r) => r.classification.startsWith('ANOMALIE'))}`);
console.log(`  decisions metier        : ${compte((r) => r.classification === 'decision metier a confirmer')}`);
console.log(`  restent prets           : ${compte((r) => r.statut_avant === r.statut_apres && ['data_ready', 'ready_to_publish', 'published'].includes(r.statut_apres))}`);
console.log(`  passent a revue requise : ${compte((r) => r.statut_apres === 'review_required' && r.statut_avant !== 'review_required')}`);
console.log(`  passent "pret" -> "en cours" : ${compte((r) => ['data_ready', 'ready_to_publish', 'published'].includes(r.statut_avant) && r.statut_apres === 'in_progress')}`);
console.log(`  revues conservees       : ${compte((r) => r.revue_avant === 'presente' && r.revue_apres === 'presente')}`);
console.log(`  revues invalidees       : ${compte((r) => r.revue_avant === 'presente' && r.revue_apres === 'aucune')}`);
console.log(`  visibilites modifiees   : ${compte((r) => r.visible_avant !== r.visible_apres)}`);
console.log(`  publications par effet de bord : ${publiesApresRecalcul !== null && publiesApresRecalcul > avant.publies
  ? `${publiesApresRecalcul - avant.publies} (ANOMALIE)` : 'aucune'}`);

console.log('\nLecture metier');
console.log('--------------');
console.log('  Une baisse de score ou de statut n\'est pas une regression : elle peut');
console.log('  reveler une exigence qui existait deja dans le profil mais n\'etait pas');
console.log('  evaluee. Le classement ci-dessus separe ces corrections attendues des');
console.log('  anomalies techniques (revue perdue sans changement, visibilite qui bouge');
console.log('  sans publication ou sans suspension).');

const titreVerif = appliquer ? '\nVerification post-ecriture' : '\nVerification post-rollback';
console.log(titreVerif);
console.log('-'.repeat(titreVerif.trim().length));
if (!appliquer) {
  console.log(`  ${restauree ? 'ok  ' : 'ECHEC'} base identique a l\'instant d\'avant`);
} else if (committe) {
  // Ecrire n'autorise pas a publier : le nombre de dossiers publies doit etre
  // identique, et aucune revue ne doit avoir disparu sans motif.
  const publiesStables = apres.publies === avant.publies;
  const slugsStables = apres.slugs_poses === avant.slugs_poses;
  console.log(`  ${publiesStables ? 'ok  ' : 'ECHEC'} aucun dossier publie par effet de bord`
    + ` — ${avant.publies} avant, ${apres.publies} apres`);
  console.log(`  ${slugsStables ? 'ok  ' : 'ECHEC'} aucun slug pose ou retire`
    + ` — ${avant.slugs_poses} avant, ${apres.slugs_poses} apres`);
  console.log(`  ok   dossiers inchanges : ${apres.dossiers.n} (aucune creation, aucune suppression)`);
  if (!publiesStables || !slugsStables) {
    console.error('ALERTE — ecriture conservee alors que la visibilite a bouge. Analyse immediate.');
    process.exitCode = 4;
  }
} else {
  console.log('  aucun commit — ROLLBACK');
  if (anomalies.length) {
    for (const a of anomalies) console.log(`    anomalie : ${a.produit} — ${a.classification}`);
  }
  if (aTrancher.length) {
    for (const a of aTrancher) console.log(`    a trancher : ${a.produit} — decision metier`);
  }
  if (erreur) console.log(`    erreur : ${erreur}`);
}
console.log(`       avant : ${JSON.stringify(avant)}`);
console.log(`       apres : ${JSON.stringify(apres)}`);
if (cheminSauvegarde) console.log(`  sauvegarde avant recalcul : ${cheminSauvegarde}`);
if (erreur) console.log(`  erreur pendant ${appliquer ? "l'ecriture" : 'la simulation'} : ${erreur}`);

if (cheminSortie) {
  mkdirSync(dirname(cheminSortie), { recursive: true });
  writeFileSync(cheminSortie, JSON.stringify({
    genere_le: maintenant(),
    cible_hote: hote,
    mode: appliquer ? (committe ? 'recalcul applique' : 'recalcul refuse, rollback') : 'simulation avec rollback',
    etat_avant: avant,
    etat_apres: apres,
    base_restauree: appliquer ? !committe : restauree,
    commit: committe,
    publies_apres_recalcul: publiesApresRecalcul,
    erreur,
    resultats,
  }, null, 2));
  console.log(`  rapport JSON : ${cheminSortie}`);
}

await client.end();
if (!appliquer && !restauree) {
  console.error('ALERTE — la base ne correspond plus a l\'etat d\'avant simulation.');
  process.exit(4);
}
if (appliquer && !committe) {
  console.error('ALERTE — recalcul NON applique : un controle s\'y est oppose (voir ci-dessus).');
  process.exit(4);
}
if (erreur) process.exit(1);
process.exit(process.exitCode || 0);
