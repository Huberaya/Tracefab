#!/usr/bin/env node
/**
 * Contrôles H1.4 — aucune connexion Neon/production.
 *
 * Classes (jamais mélangées) :
 *   TEXTE        — motifs dans les fichiers
 *   COMPORTEMENT — processus wrapper lancé, sans SQL
 *   DECISION     — table Q5.A en JS + ordre WHEN du SQL (pas une exécution PG)
 *   POSTGRES     — parseur / requêtes : NOT RUN ici si psql absent
 *
 * Un test non exécuté n'incrémente pas les succès.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SQL = join(ROOT, 'docs/security/h1-4-diagnostic-lecture-seule.sql');
const WRAPPER = join(ROOT, 'scripts/run_h1_4_diagnostic_readonly.sh');
const ANCIEN = join(ROOT, 'docs/security/diagnostic-pre-migration-close-public-execute-gap.sql');
const ANCIEN_SHA =
  'a1e518967ff0fb62693b479acbaa34a85b8bbfb1eb3d2688a15ec5bc1c50c83e';
const CHANTIERS = join(ROOT, 'docs/experience/CHANTIERS-RESTANTS.md');
const MIG_1212 = join(
  ROOT,
  'prisma/migrations/20261012120000_close_public_execute_gap/migration.sql',
);

const SIGNATURES = [
  'public.tracefab_material_visible_via_product(uuid)',
  'public.tracefab_product_is_public(uuid)',
  'public.tracefab_material_is_public(uuid)',
  'public.tracefab_supplier_site_is_public(uuid)',
  'public.tracefab_public_brand(uuid)',
  'public.tracefab_public_context()',
];

const MIGRATIONS_Q5A = [
  '20261010120000_publication_explicite',
  '20261012120000_close_public_execute_gap',
  '20261014120000_close_global_default_function_execute',
  '20261014130000_revoke_public_schema_privileges',
  '20261014140000_remove_public_supplier_passport_share_token',
];

const IDS = ['Q1', 'Q1_GATE', 'Q2', 'Q3', 'Q4', 'Q5A', 'Q5B', 'Q5C', 'Q6'];

let passes = 0;
let echecs = 0;
let notRun = 0;
const ok = (classe, m) => {
  passes += 1;
  console.log(`  ok    [${classe}] ${m}`);
};
const ko = (classe, m) => {
  echecs += 1;
  console.log(`  ECHEC [${classe}] ${m}`);
};
const skip = (classe, m) => {
  notRun += 1;
  console.log(`  NOT RUN [${classe}] ${m}`);
};

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function markerIndex(hay, marker) {
  let from = 0;
  while (from < hay.length) {
    const i = hay.indexOf(marker, from);
    if (i < 0) return -1;
    const after = hay[i + marker.length];
    if (after === undefined || /[\s\r\n]/.test(after)) return i;
    from = i + marker.length;
  }
  return -1;
}

function extract(sql, id) {
  const start = `-- >>>H14:${id}`;
  const end = `-- <<<H14:${id}`;
  const i = markerIndex(sql, start);
  const j = markerIndex(sql, end);
  if (i < 0 || j < 0 || j <= i) return null;
  if (markerIndex(sql.slice(i + start.length), start) >= 0) return null;
  return sql.slice(i + start.length, j);
}

function statementsOf(block) {
  const stripped = stripComments(block);
  return stripped
    .split(';')
    .map((s) => s.replace(/\\gset\b/gi, ' ').replace(/\\[a-zA-Z?{}]+/g, ' ').trim())
    .filter(Boolean);
}

function firstKeyword(stmt) {
  const m = stmt.match(/^([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : '';
}

function valuesOrds(block) {
  const start = block.search(/\bVALUES\b/i);
  if (start < 0) return [];
  const rest = block.slice(start + 6);
  const endMatch = rest.search(/\)\s*(,|SELECT)\b/i);
  const body = endMatch >= 0 ? rest.slice(0, endMatch) : rest;
  return [...body.matchAll(/\(\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
}

function etatMigrationsCase(text) {
  const m = text.match(
    /CASE\s+WHEN\s+to_regclass\('public\._prisma_migrations'\) IS NULL THEN 'objet_absent'\s+WHEN has_table_privilege\('public\._prisma_migrations', 'SELECT'\) THEN 'lecture_ok'\s+ELSE 'refus_privilege'\s+END/i,
  );
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

/**
 * Table de décision Q5.A — miroir de l'ordre WHEN du SQL.
 * Ce n'est pas une exécution PostgreSQL.
 */
function classifyQ5A(histRows) {
  const n = histRows.length;
  if (n === 0) return 'absente';
  if (histRows.some((r) => r.rolled_back_at != null)) return 'annulee';
  if (histRows.some((r) => r.finished_at == null)) return 'incomplete';
  if (n === 1 && histRows[0].finished_at != null && histRows[0].rolled_back_at == null) {
    return 'terminee';
  }
  return 'incomplete';
}

const ECRITURES = [
  [/\bINSERT\s+INTO\b/i, 'INSERT'],
  [/\bUPDATE\s+[\w".]+\s+SET\b/i, 'UPDATE'],
  [/\bDELETE\s+FROM\b/i, 'DELETE'],
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|ROLE|POLICY|INDEX|FUNCTION|TRIGGER|SCHEMA|TYPE|TEMP|TEMPORARY)\b/i, 'CREATE'],
  [/\bDROP\s+(?:TABLE|ROLE|POLICY|FUNCTION|TRIGGER|SCHEMA|TYPE|DATABASE)\b/i, 'DROP'],
  [/\bALTER\s+(?:TABLE|ROLE|DEFAULT\s+PRIVILEGES|POLICY|FUNCTION)\b/i, 'ALTER'],
  [/\bGRANT\s+/i, 'GRANT'],
  [/\bREVOKE\s+/i, 'REVOKE'],
  [/\bTRUNCATE\b/i, 'TRUNCATE'],
  [/\bCOPY\s+/i, 'COPY'],
  [/\bVACUUM\b/i, 'VACUUM'],
  [/\bSET\s+SESSION\s+AUTHORIZATION\b/i, 'SET SESSION AUTHORIZATION'],
];

console.log('\n  A. fichiers préservés [TEXTE]\n');

if (!existsSync(SQL)) ko('TEXTE', 'artefact h1-4-diagnostic-lecture-seule.sql absent');
else ok('TEXTE', 'artefact SQL présent');
if (!existsSync(WRAPPER)) ko('TEXTE', 'wrapper absent');
else ok('TEXTE', 'wrapper présent');
if (!existsSync(ANCIEN)) ko('TEXTE', 'diagnostic local antérieur absent');
else {
  const got = sha256(readFileSync(ANCIEN));
  got === ANCIEN_SHA
    ? ok('TEXTE', 'diagnostic local antérieur inchangé (sha256)')
    : ko('TEXTE', `diagnostic local antérieur modifié (${got})`);
}
existsSync(CHANTIERS)
  ? ok('TEXTE', 'CHANTIERS-RESTANTS.md présent (non lu comme preuve H1)')
  : ko('TEXTE', 'CHANTIERS-RESTANTS.md absent');
existsSync(MIG_1212)
  ? ok('TEXTE', 'migration 1212 présente et non ouverte par ce test')
  : ko('TEXTE', 'migration 1212 absente du WT');

const sql = existsSync(SQL) ? readFileSync(SQL, 'utf8') : '';
const wrapper = existsSync(WRAPPER) ? readFileSync(WRAPPER, 'utf8') : '';
const modeOp = existsSync(join(ROOT, 'docs/security/h1-4-MODE-OPERATOIRE.md'))
  ? readFileSync(join(ROOT, 'docs/security/h1-4-MODE-OPERATOIRE.md'), 'utf8')
  : '';

console.log('\n  B. marqueurs d\'ouverture/fermeture [TEXTE]\n');

const blocs = {};
for (const id of IDS) {
  const opens = [...sql.matchAll(new RegExp(`-- >>>H14:${id}\\b`, 'g'))];
  const closes = [...sql.matchAll(new RegExp(`-- <<<H14:${id}\\b`, 'g'))];
  if (opens.length !== 1 || closes.length !== 1) {
    ko('TEXTE', `${id}: ${opens.length} ouverture(s), ${closes.length} fermeture(s)`);
    blocs[id] = null;
    continue;
  }
  const b = extract(sql, id);
  blocs[id] = b;
  b && b.trim()
    ? ok('TEXTE', `bloc ${id} apparié (${b.trim().length} octets)`)
    : ko('TEXTE', `bloc ${id} vide`);
}

console.log('\n  C. tuples VALUES [TEXTE — cardinalité source, pas PG]\n');

{
  const expect = { Q2: 6, Q3: 6, Q5A: 5, Q6: 4 };
  for (const [id, n] of Object.entries(expect)) {
    const ords = valuesOrds(blocs[id] || '');
    const okN = ords.length === n && ords.every((v, i) => v === i + 1);
    okN
      ? ok('TEXTE', `${id}: ${n} tuples VALUES ords 1..${n}`)
      : ko('TEXTE', `${id}: VALUES=${JSON.stringify(ords)}, attendu 1..${n}`);
  }
}

console.log('\n  D. instructions effectives [TEXTE]\n');

{
  const body = stripComments(sql);
  const interdits = [
    [/\\c(onnect)?\b/i, '\\connect'],
    [/\bSET\s+TRANSACTION\s+READ\s+WRITE\b/i, 'SET TRANSACTION READ WRITE'],
    [/\bSET\s+default_transaction_read_only\s*=\s*off\b/i, 'SET default_transaction_read_only = off'],
    [/\bnextval\s*\(/i, 'nextval('],
  ];
  for (const [re, nom] of interdits) {
    re.test(body)
      ? ko('TEXTE', `instruction inattendue : ${nom}`)
      : ok('TEXTE', `pas de ${nom} hors commentaires`);
  }
  /\bEXCEPTION\b/i.test(body) || /\bWHEN\s+undefined_table\b/i.test(body)
    ? ko('TEXTE', 'handler EXCEPTION qui pourrait masquer une erreur catalogue')
    : ok('TEXTE', 'pas de handler EXCEPTION (erreur catalogue ≠ absence)');
}

const meta = /\\(?:gset|if|endif|else|ir|i|c|connect|copy|watch|gexec)\b/i;
for (const id of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5A', 'Q5B', 'Q5C', 'Q6']) {
  const b = blocs[id];
  if (!b) continue;
  const stmts = statementsOf(b);
  if (stmts.length === 0) {
    ko('TEXTE', `${id}: aucune instruction extraite`);
    continue;
  }
  const badKw = [];
  const writes = [];
  for (const stmt of stmts) {
    const kw = firstKeyword(stmt);
    if (!['select', 'with'].includes(kw)) badKw.push(kw || '(vide)');
    for (const [re, nom] of ECRITURES) {
      if (re.test(stmt)) writes.push(nom);
    }
  }
  writes.length === 0
    ? ok('TEXTE', `${id}: pas d'écriture`)
    : ko('TEXTE', `${id}: écriture ${[...new Set(writes)].join(', ')}`);
  badKw.length === 0
    ? ok('TEXTE', `${id}: SELECT/WITH seulement`)
    : ko('TEXTE', `${id}: mot-clé hors lecture : ${[...new Set(badKw)].join(', ')}`);
}

{
  const body = stripComments(sql);
  /\bBEGIN\b/i.test(body) || /\bCOMMIT\b/i.test(body) || /\bROLLBACK\b/i.test(body)
    ? ko('TEXTE', 'le SQL ouvre/ferme la transaction (doit rester au wrapper)')
    : ok('TEXTE', 'le SQL ne commence ni ne ferme la transaction');
}

if (['Q1', 'Q2', 'Q3', 'Q4', 'Q5A', 'Q5B', 'Q5C', 'Q6'].some((id) => meta.test(blocs[id] || ''))) {
  ko('TEXTE', 'un bloc Qn collable contient une meta-commande psql');
} else {
  ok('TEXTE', 'blocs Q1–Q6 collables sans meta-commande psql');
}

console.log('\n  E. Q1 / Q1_GATE cohérents [TEXTE]\n');

{
  const c1 = etatMigrationsCase(blocs.Q1 || '');
  const cG = etatMigrationsCase(blocs.Q1_GATE || '');
  c1 && cG && c1 === cG
    ? ok('TEXTE', 'CASE etat _prisma_migrations identique Q1 et Q1_GATE')
    : ko('TEXTE', `CASE divergent Q1 vs Q1_GATE\n    Q1=${c1}\n    GATE=${cG}`);
  const gate = blocs.Q1_GATE || '';
  /WHEN to_regclass\('public\._prisma_migrations'\) IS NULL THEN 0/.test(gate)
    && /WHEN has_table_privilege\('public\._prisma_migrations', 'SELECT'\) THEN 1/.test(gate)
    ? ok('TEXTE', 'Q1_GATE 0/1 suit le même ordre WHEN (NULL puis privilege)')
    : ko('TEXTE', 'Q1_GATE 0/1 ne court-circuite pas comme Q1');
}

console.log('\n  F. Q2 Q3 Q4 Q5.C Q6 [TEXTE]\n');

{
  const b = blocs.Q2 || '';
  SIGNATURES.every((s) => b.includes(`'${s}'`))
    ? ok('TEXTE', 'Q2 : 6 signatures public.')
    : ko('TEXTE', 'Q2 signatures manquantes');
  /LEFT JOIN pg_proc/.test(b)
    ? ok('TEXTE', 'Q2 LEFT JOIN pg_proc')
    : ko('TEXTE', 'Q2 sans LEFT JOIN');
  /public\.tracefab_public_context\(\)',\s+false/.test(b)
    ? ok('TEXTE', 'Q2 n\'exige pas SECDEF sur public_context')
    : ko('TEXTE', 'Q2 secdef public_context ≠ false');
}

{
  const b = blocs.Q3 || '';
  /aclexplode\(COALESCE\(e\.proacl, acldefault\('f', e\.proowner\)\)\)/.test(b)
    && /a\.grantee = 0/.test(b)
    && /privilege_type = 'EXECUTE'/.test(b)
    ? ok('TEXTE', 'Q3 PUBLIC = aclexplode + grantee 0')
    : ko('TEXTE', 'Q3 mesure PUBLIC incorrecte');
  /has_function_privilege\s*\(\s*'public'/i.test(b)
    ? ko('TEXTE', 'Q3 has_function_privilege(\'public\')')
    : ok('TEXTE', 'Q3 sans has_function_privilege(\'public\')');
  /has_function_privilege\('tracefab_app'/.test(b) && /porteurs_acl_direct/.test(b)
    ? ok('TEXTE', 'Q3 ACL directe ≠ EXECUTE effectif')
    : ko('TEXTE', 'Q3 ne distingue pas ACL et héritage');
  /LEFT JOIN pg_proc/.test(b)
    ? ok('TEXTE', 'Q3 LEFT JOIN : 6 lignes si absence')
    : ko('TEXTE', 'Q3 sans LEFT JOIN');
}

{
  const b = blocs.Q4 || '';
  /pg_default_acl/.test(b) && /defaclnamespace = 0/.test(b)
    && !/WHERE\s+(?:r\.)?rolname\s*=\s*current_user/.test(b)
    && /synthese:/.test(b)
    ? ok('TEXTE', 'Q4 tous créateurs + synthèse, pas migrateur=session')
    : ko('TEXTE', 'Q4 incomplet');
}

{
  const c = blocs.Q5C || '';
  SIGNATURES.every((s) => c.includes(`to_regprocedure('${s}')`))
    && /statut_lecture/.test(c)
    && !/public\._prisma_migrations/.test(c)
    ? ok('TEXTE', 'Q5.C 6 to_regprocedure + statut_lecture, sans _prisma_migrations')
    : ko('TEXTE', 'Q5.C incomplet');
}

{
  const b = blocs.Q6 || '';
  const objets = [
    'table public._prisma_migrations',
    'fonction public.tracefab_material_visible_via_product(uuid)',
    'fonction public.tracefab_public_context()',
    'schema public',
  ];
  objets.every((o) => b.includes(`'${o}'`))
    && /'inconnu'::text AS migrateur_prisma/.test(b)
    ? ok('TEXTE', 'Q6 4 objets, migrateur inconnu')
    : ko('TEXTE', 'Q6 incomplet');
  const refusAvantAbsent = (kind) => {
    const iR = b.indexOf('THEN \'refus_privilege\'');
    const iA = b.indexOf('THEN \'objet_absent\'');
    return iR >= 0 && iA > iR;
  };
  refusAvantAbsent()
    ? ok('TEXTE', 'Q6 refus_privilege avant objet_absent (erreur ≠ absence)')
    : ko('TEXTE', 'Q6 pourrait classer un refus comme absence');
}

console.log('\n  G. porte Q5.A/B [TEXTE]\n');

{
  const iIf = sql.indexOf('\\if :tf_h14_mig_lecture_ok');
  const iA = sql.indexOf('-- >>>H14:Q5A');
  const iB = sql.indexOf('-- <<<H14:Q5B');
  const iEnd = sql.indexOf('\\endif', iB);
  iIf >= 0 && iA > iIf && iB > iA && iEnd > iB
    ? ok('TEXTE', 'Q5.A/B derrière \\if :tf_h14_mig_lecture_ok (chemin psql)')
    : ko('TEXTE', 'Q5.A/B non portés');
  const a = blocs.Q5A || '';
  MIGRATIONS_Q5A.every((n) => a.includes(`'${n}'`))
    && /applied_steps_count/.test(a)
    && /LEFT JOIN hist/.test(a)
    && !/\blogs\b/i.test(a)
    ? ok('TEXTE', 'Q5.A 5 noms, applied_steps_count, LEFT JOIN, pas logs')
    : ko('TEXTE', 'Q5.A structure incorrecte');
}

console.log('\n  H. table de décision Q5.A [DECISION — pas PG]\n');

{
  const a = blocs.Q5A || '';
  const whens = [...a.matchAll(/THEN '([^']+)'/g)].map((m) => m[1]);
  const attenduThen = ['absente', 'annulee', 'incomplete', 'terminee'];
  const elseIncomplet = /ELSE 'incomplete'/.test(a);
  JSON.stringify(whens) === JSON.stringify(attenduThen) && elseIncomplet
    ? ok('DECISION', 'ordre Q5.A : absente → annulee → incomplete → terminee, ELSE incomplete (doublons)')
    : ko('DECISION', `WHEN=${JSON.stringify(whens)} ELSE_incomplete=${elseIncomplet}`);

  const cas = [
    { nom: 'absente', rows: [], etat: 'absente' },
    { nom: 'terminee', rows: [{ finished_at: 't', rolled_back_at: null }], etat: 'terminee' },
    { nom: 'annulee', rows: [{ finished_at: 't', rolled_back_at: 'r' }], etat: 'annulee' },
    { nom: 'incomplete', rows: [{ finished_at: null, rolled_back_at: null }], etat: 'incomplete' },
    {
      nom: 'doublon deux terminees',
      rows: [
        { finished_at: 't1', rolled_back_at: null },
        { finished_at: 't2', rolled_back_at: null },
      ],
      etat: 'incomplete',
    },
    {
      nom: 'doublon dont une annulee',
      rows: [
        { finished_at: 't', rolled_back_at: null },
        { finished_at: 't', rolled_back_at: 'r' },
      ],
      etat: 'annulee',
    },
  ];
  for (const c of cas) {
    const got = classifyQ5A(c.rows);
    got === c.etat
      ? ok('DECISION', `Q5.A ${c.nom} → ${c.etat}`)
      : ko('DECISION', `Q5.A ${c.nom} → ${got}, attendu ${c.etat}`);
  }
  skip('POSTGRES', 'chemins Q5.A sur table _prisma_migrations réelle — psql requis');
}

console.log('\n  I. wrapper politique de cible [TEXTE + COMPORTEMENT]\n');

{
  /ON_ERROR_STOP=1/.test(wrapper)
    ? ok('TEXTE', 'wrapper ON_ERROR_STOP=1')
    : ko('TEXTE', 'wrapper sans ON_ERROR_STOP');
  /ROLLBACK implicite/.test(wrapper) || /avortee a la deconnexion/.test(wrapper)
    ? ok('TEXTE', 'wrapper documente l\'abort avant -c ROLLBACK')
    : ko('TEXTE', 'wrapper ne documente pas ON_ERROR_STOP vs ROLLBACK');
  /barriere/.test(wrapper) || /inviolable/.test(wrapper)
    ? ok('TEXTE', 'wrapper ne présente pas SET SESSION comme inviolable')
    : ko('TEXTE', 'wrapper omet la limite SET SESSION / superutilisateur');
  /TRACEFAB_H1_4_MODE/.test(wrapper) && /jetable/.test(wrapper) && /neon-manuel/.test(wrapper)
    ? ok('TEXTE', 'wrapper sépare jetable et neon-manuel')
    : ko('TEXTE', 'wrapper sans modes explicites');
  /PGSERVICE/.test(wrapper) && /PGHOSTADDR/.test(wrapper) && /PGOPTIONS/.test(wrapper)
    && /PGDATABASE/.test(wrapper) && /tracefab_test/.test(wrapper)
    ? ok('TEXTE', 'wrapper inspecte PGHOST/PGHOSTADDR/PGSERVICE/PGOPTIONS/PGDATABASE')
    : ko('TEXTE', 'wrapper n\'inspecte pas les variables libpq de cible');
  /hote Neon refuse/.test(wrapper) && /contexte de production/.test(wrapper)
    ? ok('TEXTE', 'wrapper refuse explicitement Neon et le contexte production')
    : ko('TEXTE', 'wrapper sans refus Neon/production explicite');
  /exec psql[\s\S]*--single-transaction/.test(wrapper)
    ? ko('TEXTE', 'wrapper passe --single-transaction à psql')
    : ok('TEXTE', 'wrapper sans --single-transaction');
  /exec psql[\s\S]{0,800}DATABASE_URL/.test(wrapper)
    ? ko('TEXTE', 'wrapper passe DATABASE_URL à psql')
    : ok('TEXTE', 'wrapper ne passe pas DATABASE_URL à psql');
  /DATABASE_URL\/DIRECT_URL ne doivent pas etre poses/.test(wrapper)
    ? ok('TEXTE', 'wrapper refuse si DATABASE_URL est pose')
    : ko('TEXTE', 'wrapper n\'interdit pas DATABASE_URL');
  /neon-manuel/.test(modeOp) && /jetable/.test(modeOp)
    && /commandes \*\*psql\*\*/.test(modeOp) || /commandes \*\*psql\*\*, pas du SQL/.test(modeOp)
    || /commandes \*\*psql\*\*/.test(modeOp)
    ? ok('TEXTE', 'MODE-OPERATOIRE sépare jetable / neon-manuel')
    : /neon-manuel/.test(modeOp) && /\\\\gset/.test(modeOp) || /gset/.test(modeOp)
      ? ok('TEXTE', 'MODE-OPERATOIRE documente gset/if comme psql')
      : ko('TEXTE', 'MODE-OPERATOIRE incomplet sur les deux modes');
}

function runWrapper(args, envExtra = {}) {
  const env = { ...process.env, ...envExtra };
  for (const k of [
    'TRACEFAB_H1_4_CONFIRM_READONLY',
    'TRACEFAB_H1_4_MODE',
    'TRACEFAB_H1_4_CIBLE',
    'PGHOST',
    'PGHOSTADDR',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGSYSCONFDIR',
    'PGOPTIONS',
  ]) {
    if (!(k in envExtra) && env[k] !== undefined && !(k in envExtra)) {
      /* keep process.env unless overridden */
    }
  }
  const clean = { ...process.env };
  for (const k of [
    'TRACEFAB_H1_4_CONFIRM_READONLY',
    'TRACEFAB_H1_4_MODE',
    'TRACEFAB_H1_4_CIBLE',
    'PGHOST',
    'PGHOSTADDR',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGSYSCONFDIR',
    'PGOPTIONS',
    'PGDATABASE',
    'NODE_ENV',
    'VERCEL_ENV',
    'DATABASE_URL',
    'DIRECT_URL',
  ]) {
    delete clean[k];
  }
  Object.assign(clean, envExtra);
  return spawnSync('bash', [WRAPPER, ...args], {
    encoding: 'utf8',
    env: clean,
    timeout: 8000,
  });
}

function leaked(out) {
  return /postgres:\/\//i.test(out) || /motdepasse/i.test(out) || /PGPASSWORD=/i.test(out);
}

{
  const r = runWrapper(['--self-check']);
  r.status === 0
    ? ok('COMPORTEMENT', `--self-check exit 0`)
    : ko('COMPORTEMENT', `--self-check exit ${r.status}`);
}

{
  const r = runWrapper([]);
  r.status === 2 && /Aucune connexion/.test(r.stderr || '')
    ? ok('COMPORTEMENT', 'sans MODE : exit 2, aucune connexion')
    : ko('COMPORTEMENT', `sans MODE exit ${r.status} ${(r.stderr || '').slice(0, 160)}`);
}

{
  const r = runWrapper(['postgres://neondb_owner:secret@ep-x.neon.tech/neondb']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  r.status === 2 && /Aucune connexion/.test(out) && !leaked(out)
    ? ok('COMPORTEMENT', 'URL en argument : exit 2, secret non imprimé')
    : ko('COMPORTEMENT', `URL arg exit ${r.status} leak=${leaked(out)}`);
}

{
  const r = runWrapper([], { TRACEFAB_H1_4_MODE: 'neon-manuel' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  r.status === 2 && /neon-manuel/.test(out) && /Aucune connexion|n'ouvre aucune connexion/.test(out)
    ? ok('COMPORTEMENT', 'neon-manuel : exit 2, aucune connexion')
    : ko('COMPORTEMENT', `neon-manuel exit ${r.status} ${out.slice(0, 180)}`);
}

{
  const r = runWrapper([], {
    TRACEFAB_H1_4_MODE: 'jetable',
    TRACEFAB_H1_4_CONFIRM_READONLY: 'oui',
    TRACEFAB_H1_4_CIBLE: 'locale',
    PGHOST: 'ep-secret-123456.eu-central-1.aws.neon.tech',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  r.status === 2 && /hote Neon refuse/.test(out) && !/ep-secret-123456/.test(out)
    ? ok('COMPORTEMENT', 'jetable + hôte Neon : refus explicite sans imprimer l\'hôte')
    : ko('COMPORTEMENT', `hôte Neon exit ${r.status} imprime_hote=${/ep-secret-123456/.test(out)} ${out.slice(0, 180)}`);
}

{
  const r = runWrapper([], {
    TRACEFAB_H1_4_MODE: 'jetable',
    TRACEFAB_H1_4_CONFIRM_READONLY: 'oui',
    TRACEFAB_H1_4_CIBLE: 'locale',
    PGHOST: '127.0.0.1',
    PGDATABASE: 'neondb',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  r.status === 2 && /nom de base non autorise/.test(out)
    ? ok('COMPORTEMENT', 'base autre que tracefab_test : refus')
    : ko('COMPORTEMENT', `mauvaise base exit ${r.status} ${out.slice(0, 160)}`);
}

{
  const r = runWrapper([], {
    TRACEFAB_H1_4_MODE: 'jetable',
    TRACEFAB_H1_4_CONFIRM_READONLY: 'oui',
    TRACEFAB_H1_4_CIBLE: 'locale',
    PGHOST: '127.0.0.1',
    PGDATABASE: 'tracefab_test',
    NODE_ENV: 'production',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  r.status === 2 && /contexte de production/.test(out)
    ? ok('COMPORTEMENT', 'NODE_ENV=production : refus')
    : ko('COMPORTEMENT', `production exit ${r.status} ${out.slice(0, 160)}`);
}

{
  const r = runWrapper([], {
    TRACEFAB_H1_4_MODE: 'jetable',
    TRACEFAB_H1_4_CONFIRM_READONLY: 'oui',
    TRACEFAB_H1_4_CIBLE: 'locale',
    PGHOST: '127.0.0.1',
    PGDATABASE: 'tracefab_test',
    PGSERVICE: 'prod',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  r.status === 2 && /ambigue/.test(out)
    ? ok('COMPORTEMENT', 'PGSERVICE : refus cible ambigue')
    : ko('COMPORTEMENT', `PGSERVICE exit ${r.status} ${out.slice(0, 160)}`);
}

{
  const r = runWrapper([], {
    TRACEFAB_H1_4_MODE: 'jetable',
    TRACEFAB_H1_4_CONFIRM_READONLY: 'oui',
    TRACEFAB_H1_4_CIBLE: 'locale',
    PGHOST: '127.0.0.1',
    PGDATABASE: 'tracefab_test',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  r.status === 2 && /psql absent/.test(out)
    ? ok('COMPORTEMENT', 'jetable local sans psql : NON EXECUTE exit 2')
    : ko('COMPORTEMENT', `jetable local exit ${r.status} ${out.slice(0, 180)}`);
}

{
  const r = runWrapper([], {
    TRACEFAB_H1_4_MODE: 'jetable',
    TRACEFAB_H1_4_CONFIRM_READONLY: 'oui',
    TRACEFAB_H1_4_CIBLE: 'locale',
    PGHOST: '127.0.0.1',
    PGDATABASE: 'tracefab_test',
    DATABASE_URL: 'postgresql://u:secret@ep-x.neon.tech/neondb',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  r.status === 2 && /DATABASE_URL/.test(out) && !leaked(out) && !/ep-x\.neon\.tech/.test(out)
    ? ok('COMPORTEMENT', 'DATABASE_URL pose : refus sans imprimer l\'URI')
    : ko('COMPORTEMENT', `DATABASE_URL exit ${r.status} leak=${leaked(out)} ${out.slice(0, 180)}`);
}

{
  const r = runWrapper([], {
    TRACEFAB_H1_4_MODE: 'jetable',
    TRACEFAB_H1_4_CONFIRM_READONLY: 'oui',
    TRACEFAB_H1_4_CIBLE: 'locale',
    PGHOST: '127.0.0.1',
    PGHOSTADDR: '8.8.8.8',
    PGDATABASE: 'tracefab_test',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  r.status === 2 && /PGHOSTADDR/.test(out) && !/8\.8\.8\.8/.test(out)
    ? ok('COMPORTEMENT', 'PGHOSTADDR non local : refus sans imprimer l\'adresse')
    : ko('COMPORTEMENT', `PGHOSTADDR exit ${r.status} ${out.slice(0, 160)}`);
}

{
  const ci = existsSync(join(ROOT, '.github/workflows/ci.yml'))
    ? readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    : '';
  /h14-lecture-seule:/.test(ci)
    ? ko('TEXTE', 'ci.yml contient encore h14-lecture-seule (H1.4 doit vivre dans le workflow dédié)')
    : ok('TEXTE', 'ci.yml sans job H1.4 (isolation du diff préexistant)');
  const wfPath = join(ROOT, '.github/workflows/h1-4-postgres.yml');
  const wf = existsSync(wfPath) ? readFileSync(wfPath, 'utf8') : '';
  wf.includes('h14-lecture-seule')
    && !/secrets\./.test(wf)
    && !/prepare_ci_db_role/.test(wf)
    && !/db:deploy/.test(wf)
    && !/db:seed/.test(wf)
    && /postgres:17/.test(wf)
    && /tracefab_test/.test(wf)
    && /test_h1_4_engine\.sh/.test(wf)
    && /postgresql-client/.test(wf)
    && /node-version: '20'/.test(wf)
    && /Artefacts H1.4 presents/.test(wf)
    && /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/.test(wf)
    && /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/.test(wf)
    ? ok('TEXTE', 'workflow dédié h1-4-postgres.yml : PG17, Node 20, artefacts, pas de secret/migrate')
    : ko('TEXTE', 'workflow dédié h1-4-postgres.yml absent ou non isolé');
  existsSync(join(ROOT, 'scripts/test_h1_4_engine.sh'))
    ? ok('TEXTE', 'scripts/test_h1_4_engine.sh présent')
    : ko('TEXTE', 'scripts/test_h1_4_engine.sh absent');
}

console.log('\n  J. PostgreSQL jetable\n');

{
  const psql = spawnSync('bash', ['-lc', 'command -v psql || true'], { encoding: 'utf8' });
  const postgres = spawnSync('bash', ['-lc', 'command -v postgres || true'], { encoding: 'utf8' });
  const hasPsql = Boolean((psql.stdout || '').trim());
  const hasPostgres = Boolean((postgres.stdout || '').trim());
  if (!hasPsql && !hasPostgres) {
    skip('POSTGRES', 'psql/postgres absents — engine.sh et parseur Q1–Q6 NON RUN');
    const eng = spawnSync('bash', [join(ROOT, 'scripts/test_h1_4_engine.sh'), '--preflight'], {
      encoding: 'utf8',
      env: { ...process.env, TRACEFAB_H1_4_MODE: 'jetable' },
      timeout: 5000,
    });
    eng.status === 2
      ? ok('COMPORTEMENT', 'engine --preflight sans env complet : exit 2')
      : ko('COMPORTEMENT', `engine --preflight exit ${eng.status}`);
  } else {
    const eng = spawnSync('bash', [join(ROOT, 'scripts/test_h1_4_engine.sh')], {
      encoding: 'utf8',
      timeout: 60000,
    });
    eng.status === 0
      ? ok('POSTGRES', 'engine.sh PASS sur PostgreSQL local')
      : ko('POSTGRES', `engine.sh exit ${eng.status} ${(eng.stderr || '').slice(0, 200)}`);
  }
}

console.log('\n  --------------------------------------------');
console.log(`  ${passes} PASS, ${echecs} FAIL, ${notRun} NOT RUN`);
console.log('  --------------------------------------------\n');

if (echecs > 0) process.exit(1);
process.exit(0);
