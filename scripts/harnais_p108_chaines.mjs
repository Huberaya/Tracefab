#!/usr/bin/env node
/**
 * P10.8 — Phase A : reconciliation des migrations sur PostgreSQL 17.11 REEL.
 *
 * Cinq scenarios appliques depuis une BASE VIERGE, plus deux scenarios temoins
 * pour la collision historique #111 / ancienne #114. Chaque scenario consigne
 * le nombre de migrations appliquees, la premiere migration en echec, les
 * empreintes sha256 et l'empreinte globale de la chaine.
 *
 * Prerequis : refs locales d'audit + serveur PostgreSQL 17.11 jetable
 * (scripts/p108_pg17_demarrer.sh), ou le service postgres:17 de CI.
 * Sortie : docs/security/2026-11-07-p108-chaine-migrations.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  REFS, CORRECTIF_NOM, CORRECTIF_CHEMIN, composer, collisions, migrations,
  sqlMigration, sha256, baseVierge, appliquer, connecter,
} from './lib/p108_pg17.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

// Garde de cible : le harnais ne doit JAMAIS etre pointe vers une base
// distante. Sans variable, la cible par defaut est le cluster JETABLE local.
process.env.TF_P108_PG_URL ||= 'postgresql://postgres@127.0.0.1:55432/postgres';
requireThrowawayDb({ variables: ['TF_P108_PG_URL'], purpose: 'harnais P10.8 — PostgreSQL 17.11 jetable' });

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'docs/security/2026-11-07-p108-chaine-migrations.json');

const CORRECTIF_TEXTE = fs.readFileSync(path.join(ROOT, CORRECTIF_CHEMIN), 'utf8');
const correctif = { nom: CORRECTIF_NOM, ref: 'HEAD (migration corrective P10.8)', texte: CORRECTIF_TEXTE };

const scenarios = [
  { nom: 'S1_114_seule', refs: ['main', '#114'] },
  { nom: 'S2_111_seule', refs: ['main', '#111'] },
  { nom: 'S3_111_et_114', refs: ['main', '#111', '#114'] },
  { nom: 'S4_complet_avec_113', refs: ['main', '#113', '#114'] },
  { nom: 'S5_canonique_definitive', refs: ['main', '#113', '#114'], extras: [correctif] },
  { nom: 'T1_111_et_ancienne_114', refs: ['main', '#111', '#114-ancien'] },
  { nom: 'T2_110_112_113_114', refs: ['main', '#110', '#112', '#113', '#114'], extras: [correctif] },
];

function nomsDifferents() {
  const refs = ['main', '#110', '#111', '#112', '#113', '#114', '#114-ancien'];
  const parNom = new Map();
  for (const r of refs) {
    for (const d of migrations(REFS[r])) {
      const s = sha256(sqlMigration(REFS[r], d));
      if (!parNom.has(d)) parNom.set(d, new Map());
      parNom.get(d).set(r, s);
    }
  }
  return [...parNom.entries()]
    .filter(([, m]) => new Set(m.values()).size > 1)
    .map(([nom, m]) => ({ nom, empreintes: Object.fromEntries(m) }))
    .sort((a, b) => a.nom.localeCompare(b.nom));
}
function renommages() {
  const a = migrations(REFS['#114-ancien']).filter(d => !migrations(REFS['#114']).includes(d));
  const b = migrations(REFS['#114']).filter(d => !migrations(REFS['#114-ancien']).includes(d));
  return { ref_ancienne: '537bc310d0b6e857c4f74ec0017a130987b22497',
    ref_actuelle: 'f0aeb51cb52ce778f7f9a5e857438603d81fa5ad',
    disparus: a, apparus: b,
    meme_contenu: a.length === 1 && b.length === 1
      ? sha256(sqlMigration(REFS['#114-ancien'], a[0])) === sha256(sqlMigration(REFS['#114'], b[0])) ? null : 'contenu modifie en plus du renommage'
      : null };
}

const resultats = [];
for (const sc of scenarios) {
  const entrees = composer(sc.refs, sc.extras || []);
  const cols = collisions(entrees);
  const dbName = `p108_${sc.nom.toLowerCase()}`.slice(0, 60);
  let admin = null;
  let appliquees = [], echec = null, version = null, secdef = null, rls = null;
  try {
    admin = await baseVierge(dbName);
    version = (await admin.query('select version() v')).rows[0].v;
    const a = await appliquer(admin, entrees);
    appliquees = a.appliquees; echec = a.echec;
    if (!echec) {
      secdef = (await admin.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prosecdef`)).rows[0].n;
      rls = (await admin.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity`)).rows[0].n;
    }
  } catch (e) { echec = { nom: '(harnais)', ref: '-', sqlstate: e.code || null, message: String(e.message).slice(0, 400) }; }
  finally { if (admin) await admin.end().catch(() => {}); }
  const empreinteChaine = sha256(entrees.map(e => `${e.nom}:${sha256(e.texte)}`).join('\n'));
  const r = {
    scenario: sc.nom, refs: sc.refs, totale: entrees.length,
    appliquees: appliquees.length, migrations_echouees: echec ? [echec] : [],
    collisions: cols, empreinte_chaine: empreinteChaine,
    version_postgresql: version, secdef, tables_force_rls: rls,
    migrations: entrees.map(e => ({ nom: e.nom, ref: e.ref, sha256: sha256(e.texte) })),
  };
  resultats.push(r);
  console.log(`${sc.nom.padEnd(24)} total=${String(entrees.length).padStart(3)} appliquees=${String(appliquees.length).padStart(3)} `
    + `collisions=${cols.length} secdef=${secdef} ${echec ? 'ECHEC ' + echec.nom + ' ' + echec.sqlstate : 'OK'}`);
}

const nomsDiff = nomsDifferents();
const ren = renommages();
const can = resultats.find(r => r.scenario === 'S5_canonique_definitive');
const artefact = {
  schema: 'tracefab-p108-chaine-migrations-v1',
  date: new Date().toISOString(),
  environnement: 'PostgreSQL 17.11 REEL, base jetable locale (aucune base distante)',
  version_postgresql_mesuree: resultats.find(r => r.version_postgresql)?.version_postgresql,
  methode: 'DROP DATABASE / CREATE DATABASE / CREATE EXTENSION / application sequentielle par une connexion d administration du cluster jetable',
  collisions_historiques_acceptees: ['20261006120000', '20261006200000', '20261006220000', '20261017120000'],
  noms_identiques_contenus_differents: nomsDiff,
  renommages_entre_commits: ren,
  scenarios: resultats,
  chaine_canonique: {
    nom: 'S5_canonique_definitive',
    total: can?.totale, appliquees: can?.appliquees,
    collisions_nouvelles: [],
    empreinte: can?.empreinte_chaine,
    ordre: 'main(69) + #113(2) + #114(1, tete f0aeb51) + corrective P10.8(1) = 73',
  },
};
// Collision nouvelle = toute collision hors des quatre paires historiques acceptees.
artefact.chaine_canonique.collisions_nouvelles = (can?.collisions || [])
  .filter(c => !['20261006120000', '20261006200000', '20261006220000', '20261017120000'].includes(c.horodatage));
fs.writeFileSync(OUT, JSON.stringify(artefact, null, 2));
console.log(`\nArtefact : ${OUT}`);
console.log(`Noms identiques / contenus differents : ${nomsDiff.length} · renommage : ${ren.disparus[0]} -> ${ren.apparus[0]}`);
process.exit(resultats.some(r => r.migrations_echouees.length) ? 1 : 0);
