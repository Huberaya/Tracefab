#!/usr/bin/env node
/**
 * P10.7 — Chantier B : materialiser des CHAINES DE MIGRATIONS CANDIDATES dans
 * un repertoire temporaire, les appliquer sur un PostgreSQL jetable (PGlite),
 * mesurer les collisions d'horodatage AVANT/APRES renommage de preparation,
 * verifier les empreintes du manifeste canonique et eprouver le rejeu du
 * RENOMMAGE de la migration #114 sur un etat deja migre.
 *
 * Aucune branche distante n'est modifiee : les migrations sont lues par
 * `git show <ref>:<chemin>` et ecrites dans un dossier /tmp detruit apres
 * l'epreuve. Les renommages ne s'appliquent QU'A cette copie.
 *
 * Prerequis : refs locales `refs/remotes/audit/prN` et
 * `refs/remotes/audit/pr114-nouveau` (voir le rapport final).
 * Sorties : 0 chaines eprouvees · 1 chaine ou verification en echec.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const ROOT = '/home/user/Tracefab';
const MAIN = '788df22019c0d2b39301678ecfbc43ac868561bf';
// #114 a avance le 2026-11-06 a 15:34:35Z, APRES la Phase 0 de cette mission.
// Les DEUX tetes sont eprouvees : la nouvelle est l'etat reel, l'ancienne sert
// de temoin de non-regression et de comparaison des collisions.
const TETES_114 = {
  actuelle: 'f0aeb51cb52ce778f7f9a5e857438603d81fa5ad',
  ancienne: '537bc310d0b6e857c4f74ec0017a130987b22497',
};
const REFS = {
  main: MAIN,
  '#108': 'refs/remotes/audit/pr108',
  '#109': 'refs/remotes/audit/pr109',
  '#110': 'refs/remotes/audit/pr110',
  '#111': 'refs/remotes/audit/pr111',
  '#112': 'refs/remotes/audit/pr112',
  '#113': 'HEAD',
  '#114': 'refs/remotes/audit/pr114-nouveau',
  '#114-ancien': 'refs/remotes/audit/pr114',
};
function migs(ref) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'prisma/migrations'], { encoding: 'utf8' });
  return [...new Set(out.split('\n').filter(l => l.endsWith('/migration.sql')).map(l => l.split('/')[2]))].sort();
}
function sql(ref, dir) {
  return execFileSync('git', ['show', `${ref}:prisma/migrations/${dir}/migration.sql`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}
function collect(refs) {
  const map = new Map();
  for (const r of refs) for (const d of migs(REFS[r])) if (!map.has(d)) map.set(d, r);
  return map;
}
const CORRECTIF_SQL = path.join(ROOT, 'docs', 'security', 'candidats',
  '2026-11-06-proprietaire-outbox-identite-systeme.sql');
const CORRECTIF_NOM = '20261106120300_outbox_owner_identite_systeme';
const MANIFESTE = path.join(ROOT, 'docs', 'security', '2026-11-06-p107-chaine-canonique.json');
// Sur la tete ACTUELLE de #114, la migration a deja ete renommee en amont
// (20261105120000 -> 20261106130000) : une seule collision reste a preparer.
const RENOMS_ACTUELLE = {
  '20261105180000_active_tenant_access_guards': '20261105180010_active_tenant_access_guards',
};
const RENOMS_ANCIENNE = {
  '20261105120000_identite_systeme_signee': '20261105120010_identite_systeme_signee',
  '20261105180000_active_tenant_access_guards': '20261105180010_active_tenant_access_guards',
};
const scenarios = [
  { nom: 'A_canonique_114_actuelle', refs: ['main', '#113', '#114'], correctif: true, renommer: {} },
  { nom: 'A2_canonique_114_ancienne', refs: ['main', '#113', '#114-ancien'], correctif: true, renommer: {} },
  { nom: 'B_etendue_110_112', refs: ['main', '#110', '#112', '#113', '#114'], correctif: true, renommer: RENOMS_ACTUELLE },
  { nom: 'B2_etendue_114_ancienne', refs: ['main', '#110', '#112', '#113', '#114-ancien'], correctif: true, renommer: RENOMS_ANCIENNE },
  { nom: 'C_114_seule', refs: ['main', '#114'], correctif: false, renommer: {} },
  { nom: 'D_111_114', refs: ['main', '#111', '#114'], correctif: false, renommer: {} },
];
const collisions = noms => {
  const h = new Map();
  for (const n of noms) { const t = n.slice(0, 14); h.set(t, (h.get(t) || 0) + 1); }
  return [...h.entries()].filter(([, n]) => n > 1).map(([t, n]) => ({ horodatage: t, n }));
};
const ROLES = `CREATE ROLE tracefab_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  CREATE ROLE tracefab_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  GRANT USAGE ON SCHEMA public TO tracefab_app;`;
const nouvelleBase = async () => {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } }); await db.waitReady;
  await db.exec(ROLES);
  return db;
};

const resultats = [];
const textesCanoniques = new Map();
for (const sc of scenarios) {
  const map = collect(sc.refs);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p107-chain-'));
  const ordered = [...map.entries()].map(([d, r]) => ({ src: d, dst: sc.renommer[d] || d, ref: r }))
    .sort((a, b) => a.dst.localeCompare(b.dst));
  if (sc.correctif) ordered.push({ src: '(correctif candidat)', dst: CORRECTIF_NOM, ref: 'local' });
  for (const o of ordered) {
    fs.mkdirSync(path.join(temp, o.dst), { recursive: true });
    const texte = o.ref === 'local' ? fs.readFileSync(CORRECTIF_SQL, 'utf8') : sql(REFS[o.ref], o.src);
    fs.writeFileSync(path.join(temp, o.dst, 'migration.sql'), texte);
  }
  const avant = collisions(ordered.map(o => o.src === '(correctif candidat)' ? o.dst : o.src));
  const apres = collisions(ordered.map(o => o.dst));
  const db = await nouvelleBase();
  let echec = null, appliquees = 0, secdef = null;
  for (const o of ordered) {
    try { await db.exec(fs.readFileSync(path.join(temp, o.dst, 'migration.sql'), 'utf8')); appliquees++; }
    catch (e) { echec = `${o.dst} <- ${o.ref} : ${String(e.message).slice(0, 260)}`; break; }
  }
  if (!echec) {
    try { secdef = (await db.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef`)).rows[0].n; } catch { }
    if (sc.nom === 'A_canonique_114_actuelle') for (const o of ordered) textesCanoniques.set(o.dst, fs.readFileSync(path.join(temp, o.dst, 'migration.sql'), 'utf8'));
  }
  const r = {
    chaine: sc.nom, refs: sc.refs, correctif: sc.correctif,
    renommages: Object.keys(sc.renommer), total: ordered.length, appliquees,
    collisions_avant_renommage: avant, collisions_apres_renommage: apres, secdef, echec,
    noms: ordered.map(o => o.dst),
  };
  resultats.push(r);
  console.log(`${sc.nom.padEnd(28)} total=${String(ordered.length).padStart(3)} appliquees=${String(appliquees).padStart(3)} `
    + `collisions=${avant.length}->${apres.length} secdef=${secdef} ${echec ? 'ECHEC: ' + echec : 'OK'}`);
  await db.close(); fs.rmSync(temp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Verification du manifeste canonique : chaque empreinte est recalculee sur le
// CONTENU REELLEMENT APPLIQUE, pas sur une copie figee dans le manifeste.
// ---------------------------------------------------------------------------
let verifVertes = 0, verifRouges = 0;
const manifeste = JSON.parse(fs.readFileSync(MANIFESTE, 'utf8'));
const parNom = new Map(manifeste.entrees.map(e => [e.nom, e]));
for (const [nom, texte] of textesCanoniques) {
  const e = parNom.get(nom);
  const attendu = crypto.createHash('sha256').update(texte).digest('hex');
  if (e && e.sha256 === attendu) verifVertes++;
  else { verifRouges++; console.error(`  ECHEC empreinte manifeste : ${nom}`); }
}
if (manifeste.total === textesCanoniques.size) verifVertes++; else { verifRouges++; console.error('  ECHEC nombre d’entrees du manifeste'); }
if (manifeste.pr114_head === TETES_114.actuelle) verifVertes++; else { verifRouges++; console.error('  ECHEC tete #114 du manifeste'); }
console.log(`\nVerification du manifeste canonique : ${verifVertes} conformes, ${verifRouges} ecart(s).`);

// ---------------------------------------------------------------------------
// E. REJEU DU RENOMMAGE #114 SUR UN ETAT DEJA MIGRE.
// Le 06/11 a 09:30Z une Preview a deploye l'ancienne tete 537bc31 : son
// journal Prisma contient le NOM 20261105120000_identite_systeme_signee.
// La nouvelle tete attend 20261106130000_identite_systeme_signee. On simule
// ce journal sur une base jetable et on mesure ce que Prisma rejouerait.
// ---------------------------------------------------------------------------
const baseHistorique = collect(['main', '#113']);
const chaineHistorique = [...baseHistorique.entries()]
  .map(([d, r]) => ({ nom: d, ref: r, texte: sql(REFS[r], d) }))
  .sort((a, b) => a.nom.localeCompare(b.nom));
const ancien114 = { nom: '20261105120000_identite_systeme_signee', texte: sql(REFS['#114-ancien'], '20261105120000_identite_systeme_signee') };
const nouveau114 = { nom: '20261106130000_identite_systeme_signee', texte: sql(REFS['#114'], '20261106130000_identite_systeme_signee') };
const dbR = await nouvelleBase();
let erreurChaineHistorique = null;
for (const o of [...chaineHistorique, ancien114]) {
  try { await dbR.exec(o.texte); } catch (e) { erreurChaineHistorique = `${o.nom}: ${e.message.slice(0, 200)}`; break; }
}
await dbR.exec(`CREATE TABLE IF NOT EXISTS public."_prisma_migrations" (
  id TEXT PRIMARY KEY, checksum TEXT NOT NULL, finished_at TIMESTAMPTZ,
  migration_name TEXT NOT NULL UNIQUE, logs TEXT, rolled_back_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_steps_count INTEGER NOT NULL DEFAULT 1)`);
const journal = [...chaineHistorique.map(o => o.nom), ancien114.nom];
for (const n of journal) await dbR.query(`INSERT INTO public."_prisma_migrations"(id,checksum,migration_name,finished_at) VALUES ($1,$2,$3,now())`, [crypto.randomUUID(), crypto.createHash('sha256').update(n).digest('hex'), n]);
let reapplication = null;
try { await dbR.exec(nouveau114.texte); reapplication = 'SQL REUSSI (idempotent)'; }
catch (e) { reapplication = `SQL ECHEC : ${e.message.slice(0, 240)}`; }
// Prisma enregistre le nom de la migration APRES son application reussie.
// On modelise cette ecriture pour mesurer l'etat final du journal, pas seulement
// l'etat intermediaire ou un seul nom serait present.
if (reapplication === 'SQL REUSSI (idempotent)') {
  await dbR.query(`INSERT INTO public."_prisma_migrations"(id,checksum,migration_name,finished_at) VALUES ($1,$2,$3,now())`,
    [crypto.randomUUID(), crypto.createHash('sha256').update(nouveau114.texte).digest('hex'), nouveau114.nom]);
}
const etat = (await dbR.query(`SELECT
  (SELECT count(*)::int FROM public."_prisma_migrations" WHERE migration_name LIKE '%identite_systeme_signee') noms_distincts,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='tracefab_identite_systeme_jeton_valide') fonction_verif,
  (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='tracefab_identity_politique' AND column_name='systeme_strict') colonne_mode`)).rows[0];
const rejeu = {
  scenario: 'E_rejeu_renommage_114',
  environnement: 'PGlite / PostgreSQL 18.6 jetable, journal _prisma_migrations SIMULE',
  tete_ancienne: TETES_114.ancienne, tete_actuelle: TETES_114.actuelle,
  migrations_avant: journal.length, erreur_chaine_historique: erreurChaineHistorique,
  nom_attendu_par_la_nouvelle_chaine: nouveau114.nom,
  nom_deja_applique: ancien114.nom,
  reapplication, ...etat,
  interpretation: 'Le SQL est idempotent (CREATE OR REPLACE / IF NOT EXISTS), mais Prisma enregistre alors le NOUVEAU nom : le journal finit avec DEUX noms distincts pour les MEMES objets (ancien + nouveau), donc deux checksums pour une seule definition. Aucune conclusion de compatibilite ne peut etre tiree sans lecture du journal REEL de la Preview (BLOCKED). Ce scenario est une MODELISATION locale, pas une mesure distante.',
};
console.log(`\n${rejeu.scenario} : chaine historique ${journal.length}/${journal.length}, ${reapplication}, `
  + `noms_distincts=${etat.noms_distincts} fonction_verif=${etat.fonction_verif} colonne_mode=${etat.colonne_mode}`);
await dbR.close();

const artefact = path.join(ROOT, 'docs', 'security', '2026-11-06-p107-chaines-canoniques.json');
fs.writeFileSync(artefact, JSON.stringify({
  schema: 'tracefab-p107-chaines-v2', date: new Date().toISOString(),
  environnement: 'PGlite / PostgreSQL 18.6 jetable local',
  tetes_114: TETES_114,
  avertissement: 'Aucune preuve Neon, Preview ou Production. Lectures par git show, aucune branche distante modifiee.',
  collisions_historiques_acceptees: ['20261006120000', '20261006200000', '20261006220000', '20261017120000'],
  verification_manifeste: { conformes: verifVertes, ecarts: verifRouges },
  chaines: resultats, rejeu_renommage_114: rejeu,
}, null, 2));
console.log(`\nArtefact : ${artefact}`);
process.exit(resultats.some(r => r.echec) || verifRouges > 0 || erreurChaineHistorique ? 1 : 0);
