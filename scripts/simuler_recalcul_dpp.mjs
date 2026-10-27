#!/usr/bin/env node
/**
 * SIMULATION (lecture seule de fait) du recalcul DPP sur un parc reel.
 *
 * Objectif (phase C de la mission) : savoir, AVANT tout recalcul reel, ce que
 * le recalcul changerait — statuts, scores, revues, visibilite publique — et
 * prouver que rien n'a bouge.
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
 *     nommer explicitement la base qu'il vise (pas de "au cas ou") ;
 *   - n'affiche jamais l'URL de connexion, ni mot de passe, ni secret : seul
 *     l'hote (sans identifiants) est imprime ;
 *   - aucune ecriture hors transaction (pas de table de resultats, pas de
 *     fichier en base) ;
 *   - `statement_timeout` et `lock_timeout` courts : le script abandonne plutot
 *     que de bloquer une base vivante.
 *
 * USAGE
 *   DATABASE_URL=... TF_SIMULATION_CIBLE=ep-xxx.eu-central-1.aws.neon.tech \
 *     node scripts/simuler_recalcul_dpp.mjs [--sortie docs/...json]
 *
 * CODE DE SORTIE
 *   0 simulation jouee, base restauree ; 2 usage ; 3 cible refusee ;
 *   4 base non restauree (alerte) ; 1 erreur d'execution.
 */
import pg from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

const argSortie = process.argv.indexOf('--sortie');
const cheminSortie = argSortie > -1 ? process.argv[argSortie + 1] : null;

const client = new pg.Client({
  connectionString: url,
  ssl: /neon\.tech|sslmode=require/.test(url) ? { rejectUnauthorized: false } : false,
});

const PROFIL = { key: 'textile_readiness_mvp', version: '1.0' };

/** Etat complet, compare avant/apres et autour du rollback. */
async function etat() {
  const q = async (sql) => (await client.query(sql)).rows;
  const [recs, prods, evts, audits, verrous] = await Promise.all([
    q(`SELECT md5(coalesce(string_agg(id::text || ':' || readiness_status || ':'
        || coalesce(md5(input_fingerprint), '-') || ':'
        || coalesce(reviewed_at::text, '-') || ':'
        || coalesce(review_invalidation_reason, '-'), '|' ORDER BY id), '')) AS empreinte,
        count(*)::int AS n
       FROM dpp_records`),
    q(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(public_slug, '-') || ':'
        || updated_at::text, '|' ORDER BY id), '')) AS empreinte,
        count(*)::int AS n
       FROM tracefab_products`),
    q('SELECT count(*)::int AS n FROM dpp_lifecycle_events'),
    q("SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'dpp.%'"),
    q(`SELECT count(*)::int AS n FROM tracefab_products WHERE public_slug IS NOT NULL`),
  ]);
  return {
    dossiers: recs[0], produits: prods[0],
    evenements: evts[0].n, audits_dpp: audits[0].n, slugs_poses: verrous[0].n,
  };
}

const resume = (r) => ({
  statut: r.readiness_status,
  score: `${(r.source_snapshot?.requirement_results || []).filter((x) => x.met).length}`
    + `/${(r.source_snapshot?.requirement_results || []).length}`,
  revu_le: r.reviewed_at ? r.reviewed_at.toISOString() : null,
  revu_par: r.reviewed_by || null,
  empreinte_contenu: r.review_basis_fingerprint,
  revue_figee: r.reviewed_basis_fingerprint,
  invalide_le: r.review_invalidated_at ? r.review_invalidated_at.toISOString() : null,
  motif_invalidation: r.review_invalidation_reason || null,
});

await client.connect();
await client.query("SET statement_timeout = '120s'");
await client.query("SET lock_timeout = '10s'");

const avant = await etat();
console.log('Simulation du recalcul DPP — AUCUNE ECRITURE CONSERVEE');
console.log(`  cible           : ${hote}`);
console.log(`  dossiers        : ${avant.dossiers.n}`);
console.log(`  produits        : ${avant.produits.n}`);
console.log(`  slugs publics   : ${avant.slugs_poses}`);
console.log('');

// Perimetre : les dossiers DPP existants. Un recalcul reel ne serait lance que
// sur eux (creer un dossier est une autre decision, hors simulation).
// Le moteur exige un utilisateur porteur d'un role organisationnel autorise.
// La simulation emprunte donc, pour chaque dossier, un membre autorise de
// l'organisation MARQUE (jamais un compte humain choisi au hasard : on prend
// celui qui a deja servi au calcul, a defaut un membre actif autorise).
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

await client.query('BEGIN');
let resultats = [];
let erreur = null;
try {
  for (const d of dossiers) {
    if (!d.acteur_id) {
      resultats.push({
        produit_id: d.product_id, publie_avant: d.readiness_status === 'published',
        visible_avant: null, avant: null, apres: null, visible_apres: null,
        changements: [], non_simule: 'aucun acteur au role autorise dans l\'organisation marque',
      });
      continue;
    }
    // SET LOCAL : le contexte disparait avec le ROLLBACK.
    await client.query("SELECT set_config('tracefab.user_id', $1, true)", [d.acteur_id]);
    const avantUn = (await client.query('SELECT * FROM dpp_records WHERE id = $1', [d.dpp_id])).rows[0];
    // La visibilite doit etre lue AVANT le recalcul, sinon on mesure l'apres.
    const visibleAvant = (await client.query('SELECT tracefab_product_is_public($1) AS v', [d.product_id])).rows[0].v;
    const apresUn = (await client.query('SELECT * FROM tracefab_compute_dpp_readiness($1,$2,$3)',
      [d.product_id, d.cle || PROFIL.key, d.version || PROFIL.version])).rows[0];
    const visible = (await client.query('SELECT tracefab_product_is_public($1) AS v', [d.product_id])).rows[0].v;
    const slugApres = (await client.query('SELECT public_slug FROM tracefab_products WHERE id = $1', [d.product_id])).rows[0].public_slug;

    const a = resume(avantUn);
    const b = resume(apresUn);
    const changements = [];
    if (a.statut !== b.statut) changements.push(`statut ${a.statut} -> ${b.statut}`);
    if (a.score !== b.score) changements.push(`score ${a.score} -> ${b.score}`);
    if (a.revu_le && !b.revu_le) changements.push(`revue invalidee (${b.motif_invalidation || 'sans motif'})`);
    if (!a.revu_le && b.revu_le) changements.push('revue apparue');
    if (Boolean(d.public_slug) !== Boolean(slugApres)) {
      changements.push(slugApres ? 'slug pose' : 'slug efface (passeport retire du public)');
    }
    if (avantUn.readiness_status === 'published' && !visible) {
      changements.push('VISIBILITE PUBLIQUE PERDUE');
    }

    resultats.push({
      produit_id: d.product_id,
      publie_avant: avantUn.readiness_status === 'published',
      visible_avant: visibleAvant,
      avant: a, apres: b, visible_apres: visible, changements,
    });
  }
} catch (e) {
  erreur = e.message;
} finally {
  await client.query('ROLLBACK');
}

const apres = await etat();
const restauree = JSON.stringify(avant) === JSON.stringify(apres);

console.log('Produits dont le recalcul changerait quelque chose');
console.log('------------------------------------------------');
const changes = resultats.filter((r) => r.changements.length > 0);
if (changes.length === 0) console.log('  (aucun : le recalcul serait neutre sur ce parc)');
for (const r of changes) {
  console.log(`  ${r.produit_id}  ${r.changements.join(' ; ')}`);
}
console.log('');
const nonSimules = resultats.filter((r) => r.non_simule);
if (nonSimules.length) {
  console.log('  dossiers non simules (contexte insuffisant)');
  for (const r of nonSimules) console.log(`    ${r.produit_id}  ${r.non_simule}`);
}
console.log(`  dossiers examines : ${resultats.length - nonSimules.length}`);
console.log(`  dossiers modifies : ${changes.length}`);
console.log(`  revues invalidees : ${resultats.filter((r) => r.avant.revu_le && !r.apres.revu_le).length}`);
console.log(`  passeports masques: ${resultats.filter((r) => r.visible_avant && !r.visible_apres).length}`);
console.log('');
console.log('Verification post-rollback');
console.log('-------------------------');
console.log(`  ${restauree ? 'ok  ' : 'ECHEC'} base identique a l'instant d'avant`);
console.log(`       avant : ${JSON.stringify(avant)}`);
console.log(`       apres : ${JSON.stringify(apres)}`);
if (erreur) console.log(`  erreur pendant la simulation : ${erreur}`);

if (cheminSortie) {
  mkdirSync(dirname(cheminSortie), { recursive: true });
  writeFileSync(cheminSortie, JSON.stringify({
    genere_le: new Date().toISOString(),
    cible_hote: hote,
    mode: 'simulation avec rollback',
    etat_avant: avant, etat_apres_rollback: apres, base_restauree: restauree,
    erreur, resultats,
  }, null, 2));
  console.log(`  rapport JSON : ${cheminSortie}`);
}

await client.end();
if (!restauree) { console.error('ALERTE — la base ne correspond plus a l\'etat d\'avant simulation.'); process.exit(4); }
if (erreur) process.exit(1);
process.exit(0);
