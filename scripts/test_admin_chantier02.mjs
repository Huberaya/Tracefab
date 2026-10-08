#!/usr/bin/env node
/**
 * CHANTIER ADMIN 02 — tâches/TODAY, activités, rendez-vous, pilotes, conversion, analytics.
 *
 * Ce test exécute le module RÉEL compilé (`api/_lib/crm.ts`) et rend l'interface
 * RÉELLE (`admin/index.html`) dans jsdom avec le vrai dictionnaire lu sur disque.
 * Aucune logique n'est réimplémentée ici.
 *
 *   A. compilation et exécution du module réel ;
 *   B. la journée commerciale — TODAY inclut le retard ;
 *   C. validation des saisies — tâches, rendez-vous, pilotes ;
 *   D. conversion et analytics — rien d'inventé sur un échantillon vide ;
 *   E. isolation en base — RLS forcée, trigger tolérant au NULL ;
 *   F. routes — enregistrées, ordre porteur, 403 plutôt que 401 ;
 *   G. i18n — 7 langues, jeux de clés identiques ;
 *   H. interface — les six modules rendent réellement.
 *
 *   npm run test:admin:chantier02
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from 'jsdom';

const { JSDOM, VirtualConsole } = pkg;

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => join(root, p);
let checks = 0;
let failures = 0;
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const bad = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d ?? 'assertion failed'}`); };
const check = (fn, label) => {
  try { fn(); ok(label); } catch (e) { bad(label, e?.message); }
};
const eq = (a, e, l) => check(() => {
  if (a !== e) throw new Error(`attendu ${JSON.stringify(e)}, obtenu ${JSON.stringify(a)}`);
}, l);
const isTrue = (cond, l, d) => check(() => {
  if (!cond) throw new Error(d || 'condition fausse');
}, l);

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });

/* -------------------------------------------------------------------------- */
console.log('\nA. Compilation et exécution du module réel');
/* -------------------------------------------------------------------------- */

await mkdir(at('.cache'), { recursive: true });
const outDir = await mkdtemp(at('.cache/admin02-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/crm.ts', '--outDir', outDir, '--target', 'ES2020',
    '--module', 'ESNext', '--moduleResolution', 'bundler', '--skipLibCheck',
    '--esModuleInterop', '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('api/_lib/crm.ts compile');
} catch (e) {
  bad('api/_lib/crm.ts ne compile pas', e.message.slice(0, 400));
}

const crm = await import(pathToFileURL(join(outDir, 'crm.js')).href);

/* -------------------------------------------------------------------------- */
console.log('\nB. La journée commerciale (TODAY)');
/* -------------------------------------------------------------------------- */

const day = (offset, hour = 10) => {
  const d = new Date(2026, 9, 8);
  d.setDate(d.getDate() + offset);
  d.setHours(hour, 0, 0, 0);
  return d;
};
const REF = new Date(2026, 9, 8, 12, 0, 0);

eq(crm.taskBucket({ status: 'open', due_at: day(0) }, REF), 'today', 'échéance du jour → today');
eq(crm.taskBucket({ status: 'open', due_at: day(-3) }, REF), 'overdue', 'échéance passée → overdue');
eq(crm.taskBucket({ status: 'open', due_at: day(4) }, REF), 'upcoming', 'échéance future → upcoming');
eq(crm.taskBucket({ status: 'open', due_at: null }, REF), 'undated', 'sans échéance → undated');
eq(crm.taskBucket({ status: 'open', due_at: 'ceci n\'est pas une date' }, REF), 'undated',
  'date illisible → undated, pas une exception');
eq(crm.taskBucket({ status: 'done', due_at: day(-9) }, REF), 'closed', 'faite → closed même en retard');
eq(crm.taskBucket({ status: 'cancelled', due_at: day(2) }, REF), 'closed', 'annulée → closed');

/*
 * Le point qui compte : une tâche en retard dont l'échéance tombe aujourd'hui
 * est EN RETARD. Un commercial qui verrait « aujourd'hui » se croirait à l'heure.
 */
const lateToday = day(0, 7);
eq(crm.taskBucket({ status: 'open', due_at: lateToday }, new Date(2026, 9, 8, 20, 0, 0)), 'today',
  'à 20 h, une échéance de 7 h le même jour reste « today » (le retard est au jour près)');
eq(crm.taskBucket({ status: 'open', due_at: day(-1, 23) }, REF), 'overdue',
  'hier 23 h est en retard même si c\'était il y a 13 heures');

const today = crm.computeToday([
  { status: 'open', due_at: day(0) },
  { status: 'open', due_at: day(0, 8) },
  { status: 'open', due_at: day(-2) },
  { status: 'open', due_at: day(5) },
  { status: 'open', due_at: null },
  { status: 'done', due_at: day(-1) },
], REF);
eq(today.today, 2, 'computeToday : 2 tâches du jour');
eq(today.overdue, 1, 'computeToday : 1 en retard');
eq(today.actionable, 3, 'computeToday : actionable = today + retard, jamais seul');
eq(today.open, 5, 'computeToday : 5 ouvertes');
eq(today.closed, 1, 'computeToday : 1 fermée');
eq(today.total, 6, 'computeToday : total = lignes reçues, rien d\'ajouté');
eq(crm.computeToday([], REF).actionable, 0, 'computeToday vide → 0, pas null ni NaN');

/* -------------------------------------------------------------------------- */
console.log('\nC. Validation des saisies');
/* -------------------------------------------------------------------------- */

isTrue(crm.parseTaskInput({}).errors.includes('title_required'), 'une tâche sans titre est refusée');
isTrue(crm.parseTaskInput({ title: 'Relancer' }).errors.length === 0, 'une tâche avec un seul titre est acceptée');
isTrue(crm.parseTaskInput({ title: 'x', type: 'telepathie' }).errors.includes('task_type_unknown'),
  'un type de tâche inventé est refusé');
isTrue(crm.parseTaskInput({ title: 'x', priority: 'urgentissime' }).errors.includes('priority_unknown'),
  'une priorité inventée est refusée');
isTrue(crm.parseTaskInput({ title: 'x', due_at: 'demain' }).errors.includes('due_at_must_be_a_date'),
  'une échéance illisible est refusée');

for (const type of crm.TASK_TYPES) {
  isTrue(crm.parseTaskInput({ title: 'x', type }).errors.length === 0, `type de tâche accepté : ${type}`);
}
eq(crm.TASK_TYPES.length, 8, '8 types de tâche (appel, e-mail, relance, démo×2, proposition, pilote, autre)');

const meeting = crm.parseMeetingInput({ subject: 'Démo DPP', starts_at: '2026-10-12T10:00:00Z' });
eq(meeting.errors.length, 0, 'un rendez-vous daté est accepté');
isTrue(crm.parseMeetingInput({ subject: 'x' }).errors.includes('starts_at_required'),
  'un rendez-vous sans heure de début est refusé');
isTrue(crm.parseMeetingInput({ subject: 'x', starts_at: '2026-10-12T12:00:00Z', ends_at: '2026-10-12T11:00:00Z' })
  .errors.includes('ends_at_must_be_after_starts_at'),
'un rendez-vous qui finit avant de commencer est refusé');
isTrue(crm.parseMeetingInput({ subject: 'x', starts_at: '2026-10-12T10:00:00Z', ends_at: '2026-10-12T10:00:00Z' })
  .errors.includes('ends_at_must_be_after_starts_at'),
'un rendez-vous de durée nulle est refusé');
isTrue(crm.parseMeetingInput({ subject: 'x', starts_at: '2026-10-12T10:00:00Z', mode: 'télépathie' })
  .errors.includes('meeting_mode_unknown'), 'un mode de rendez-vous inventé est refusé');

const pilot = crm.parsePilotInput({ data_completeness_pct: 84, evidence_coverage_pct: 72, dpp_readiness_pct: 69 });
eq(pilot.errors.length, 0, 'les trois indicateurs d\'un pilote sont acceptés entre 0 et 100');
isTrue(crm.parsePilotInput({ data_completeness_pct: 140 }).errors.includes('data_completeness_pct_must_be_between_0_and_100'),
  'une complétude de 140 % est refusée');
isTrue(crm.parsePilotInput({ dpp_readiness_pct: -5 }).errors.includes('dpp_readiness_pct_must_be_between_0_and_100'),
  'une préparation DPP négative est refusée');
isTrue(crm.parsePilotInput({ progress_pct: 62.5 }).errors.includes('progress_pct_must_be_between_0_and_100'),
  'une progression fractionnaire est refusée — le modèle stocke un entier');
isTrue(crm.parsePilotInput({ starts_at: '2026-03-01T00:00:00Z', ends_at: '2026-01-01T00:00:00Z' })
  .errors.includes('ends_at_must_be_after_starts_at'), 'un pilote qui se termine avant de commencer est refusé');
isTrue(crm.parsePilotInput({ status: 'en_cours' }).errors.includes('pilot_status_unknown'),
  'un statut de pilote inventé est refusé');

/* -------------------------------------------------------------------------- */
console.log('\nD. Conversion et analytics');
/* -------------------------------------------------------------------------- */

eq(crm.canConvert({ stage: 'customer' }).ok, false, 'une entreprise déjà cliente ne peut pas être reconvertie');
eq(crm.canConvert({ stage: 'customer' }).error, 'already_a_customer', 'motif explicite, pas un refus muet');
eq(crm.canConvert({ stage: 'pilot' }).ok, true, 'un pilote est convertible');
eq(crm.canConvert({ stage: 'new' }).ok, true, 'même une entreprise neuve est convertible');

eq(crm.daysToConvert({ created_at: '2026-01-01T00:00:00Z', converted_at: '2026-01-31T00:00:00Z' }), 30,
  '30 jours entre création et conversion');
eq(crm.daysToConvert({ created_at: null, converted_at: '2026-01-31T00:00:00Z' }), null,
  'sans date de création : null, pas 0');
eq(crm.daysToConvert({ created_at: '2026-05-01T00:00:00Z', converted_at: '2026-01-01T00:00:00Z' }), null,
  'une conversion antérieure à la création est refusée');

const empty = crm.computeAnalytics([]);
eq(empty.total, 0, 'analytics vide : total 0');
/*
 * Aucune moyenne sur un échantillon vide. Un « 0 jour » laisserait croire à une
 * conversion instantanée mesurée alors qu'il n'y a rien à mesurer.
 */
eq(empty.avgDaysToConvert, null, 'durée moyenne sur échantillon vide → null, jamais 0');
eq(empty.conversionsMeasured, 0, 'aucune conversion mesurée');

const rows = [
  { stage: 'new', country_code: 'FR', source: 'Inbound' },
  { stage: 'qualified', country_code: 'FR', source: 'Inbound' },
  { stage: 'customer', country_code: 'DE', source: 'Referral',
    created_at: '2026-01-01T00:00:00Z', converted_at: '2026-01-31T00:00:00Z' },
  { stage: 'customer', country_code: 'DE', source: 'Referral',
    created_at: '2026-02-01T00:00:00Z', converted_at: '2026-03-03T00:00:00Z' },
  { stage: 'lost', country_code: 'IT', source: 'Event' },
];
const an = crm.computeAnalytics(rows);
eq(an.total, 5, 'analytics : 5 entreprises comptées');
eq(an.customers, 2, 'analytics : 2 clients gagnés');
eq(an.lost, 1, 'analytics : 1 perdu');
eq(an.byCountry.FR.total, 2, 'prospects par pays : FR = 2');
eq(an.byCountry.DE.customers, 2, 'conversion par pays : DE = 2 clients');
eq(an.byCountry.DE.conversionRate, 100, 'taux DE = 100 %');
eq(an.byCountry.FR.conversionRate, null,
  'aucune décision sur FR → taux null, jamais 0 % affiché');
eq(an.byCountry.IT.lost, 1, 'perte enregistrée par pays');
eq(an.bySource.Referral.conversionRate, 100, 'conversion par source : Referral = 100 %');
eq(an.bySource.Inbound.conversionRate, null, 'source sans décision → null');
eq(an.byStage.new, 1, 'répartition par étape : une seule ligne à l\'étape new');
eq(an.avgDaysToConvert, 30, 'durée moyenne = 30 jours sur 2 conversions de 30 jours');
eq(an.conversionsMeasured, 2, '2 conversions réellement mesurées');

const undated = crm.computeAnalytics([
  { stage: 'customer', country_code: 'FR', created_at: null, converted_at: null },
]);
eq(undated.customers, 1, 'le client est compté…');
eq(undated.avgDaysToConvert, null, '…mais sans dates il ne pèse pas sur la moyenne');
eq(undated.conversionsMeasured, 0, 'et il n\'est pas présenté comme mesuré');

/* -------------------------------------------------------------------------- */
console.log('\nE. Isolation en base');
/* -------------------------------------------------------------------------- */

const migration = await readFile(
  at('prisma/migrations/20261008140000_admin_command_center_operations/migration.sql'), 'utf8',
);
for (const table of ['crm_tasks', 'crm_meetings', 'crm_pilots']) {
  isTrue(migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} : table créée`);
  /* Tolérant aux espaces : la migration aligne ses colonnes. */
  isTrue(new RegExp(`${table} +ENABLE ROW LEVEL SECURITY`).test(migration), `${table} : RLS activée`);
  isTrue(new RegExp(`${table} +FORCE ROW LEVEL SECURITY`).test(migration),
    `${table} : RLS FORCÉE — sans elle, le propriétaire de table contourne les politiques`);
  isTrue(new RegExp(`${table}.*platform_organization_id`).test(migration),
    `${table} : ancrée sur platform_organization_id`);
  isTrue(migration.includes(`ON ${table}`) || new RegExp(`TO ${table}`).test(migration),
    `${table} : politique RLS définie`);
}

/*
 * Le trigger du Chantier 01 levait sur company_id NULL. Or crm_tasks.company_id
 * est nullable : sans la version tolérante, créer une tâche sans entreprise
 * échouerait en base alors que l'API l'accepte.
 */
isTrue(/CREATE OR REPLACE FUNCTION tracefab_crm_company_matches_platform\(\)/.test(migration),
  'le trigger de cohérence d\'organisation est redéfini');
isTrue(/IF NEW\.company_id IS NULL THEN\s+RETURN NEW;/.test(migration),
  'le trigger laisse passer company_id NULL — sinon une tâche sans entreprise est refusée en base');
isTrue(migration.includes('crm company % does not exist'),
  'le trigger refuse toujours une entreprise inexistante');
isTrue(migration.includes('crm row organization does not match its company'),
  'le trigger refuse toujours le re-parentage vers une autre plateforme');

/* Chantier 07 : linked_organization_id faisait doublon avec organization_id
   (chantier 06). Une seule colonne subsiste — voir la migration A06. */
eq(/linked_organization_id/.test(migration.replace(/\/\*[\s\S]*?\*\//g, '')), false,
  'linked_organization_id a disparu du code de la migration — plus de doublon');
isTrue(/stage <> 'customer' OR converted_at IS NOT NULL/.test(migration),
  'un client sans converted_at est refusé en base — c\'est ce qui rend la durée de conversion mesurable');
for (const col of ['converted_at', 'converted_value_eur']) {
  isTrue(migration.includes(`ADD COLUMN IF NOT EXISTS ${col}`),
    `crm_companies.${col} ajoutée — la conversion n\'ajoute pas de table, donc rien n\'est déplacé`);
}
for (const e of ['crm_task_type', 'crm_task_status', 'crm_meeting_mode', 'crm_pilot_status']) {
  isTrue(migration.includes(`CREATE TYPE ${e}`), `enum ${e} créé`);
}

const schema = await readFile(at('prisma/schema.prisma'), 'utf8');
/* Seuil, pas égalité stricte : l'intention est « rien du Chantier 02 n'a été
   perdu », pas « le total est figé ». Un chantier suivant ajoute des modèles. */
isTrue((schema.match(/^model /gm) || []).length >= 50,
  'schema.prisma : au moins 50 modèles', `${(schema.match(/^model /gm) || []).length} modèles`);
isTrue((schema.match(/^enum /gm) || []).length >= 36,
  'schema.prisma : au moins 36 enums', `${(schema.match(/^enum /gm) || []).length} enums`);
isTrue(/model crm_pilots \{[\s\S]*?company_id\s+String\s+@unique/.test(schema),
  'un pilote par entreprise (company_id @unique)');

/* -------------------------------------------------------------------------- */
console.log('\nF. Routes');
/* -------------------------------------------------------------------------- */

const router = await readFile(at('api/index.ts'), 'utf8');
const lines = router.split('\n');
const lineOf = (needle) => lines.findIndex((l) => l.includes(needle));

const EXPECTED = [
  ['admin/tasks.js', '^admin\\/tasks$'],
  ['admin/tasks/[taskId].js', '^admin\\/tasks\\/([^\\/]+)$'],
  ['admin/meetings.js', '^admin\\/meetings$'],
  ['admin/meetings/[meetingId].js', '^admin\\/meetings\\/([^\\/]+)$'],
  ['admin/pilots.js', '^admin\\/pilots$'],
  ['admin/pilots/[pilotId].js', '^admin\\/pilots\\/([^\\/]+)$'],
  ['admin/activities.js', '^admin\\/activities$'],
  ['admin/analytics.js', '^admin\\/analytics$'],
];
for (const [, pattern] of EXPECTED) {
  isTrue(router.includes(pattern), `motif enregistré : ${pattern}`);
}
isTrue((router.match(/pattern: \/\^/g) || []).length >= 142,
  'le routeur compte au moins 142 motifs (134 + les 8 du Chantier 02)',
  `${(router.match(/pattern: \/\^/g) || []).length} motifs`);

for (const [file, pattern] of EXPECTED) {
  const routeLine = lineOf(pattern);
  const importLine = lines.findIndex((l) => l.includes(file));
  isTrue(routeLine >= 0 && importLine >= 0 && routeLine === importLine,
    `${file} : le motif et l'import sont sur la même ligne`);
}
isTrue(lineOf('^admin\\/tasks$') < lineOf('^admin\\/tasks\\/([^\\/]+)$'),
  'la collection tasks précède l\'élément tasks/:id');
isTrue(lineOf('^admin\\/meetings$') < lineOf('^admin\\/meetings\\/([^\\/]+)$'),
  'la collection meetings précède l\'élément meetings/:id');
isTrue(lineOf('^admin\\/pilots$') < lineOf('^admin\\/pilots\\/([^\\/]+)$'),
  'la collection pilots précède l\'élément pilots/:id');
/* Porteur : si /companies/([^/]+) passait avant /activities, il avalerait la timeline. */
isTrue(lineOf('^admin\\/companies\\/([^\\/]+)\\/activities$') < lineOf('^admin\\/companies\\/([^\\/]+)$'),
  'l\'ordre porteur du Chantier 01 n\'a pas été cassé');

const HANDLERS = [
  'api/_routes/admin/tasks.ts',
  'api/_routes/admin/tasks/[taskId].ts',
  'api/_routes/admin/meetings.ts',
  'api/_routes/admin/meetings/[meetingId].ts',
  'api/_routes/admin/pilots.ts',
  'api/_routes/admin/pilots/[pilotId].ts',
  'api/_routes/admin/activities.ts',
  'api/_routes/admin/analytics.ts',
];
for (const file of HANDLERS) {
  const src = await readFile(at(file), 'utf8');
  isTrue(src.includes('requirePlatformAdmin(req)'), `${file} : exige le rôle Admin`);
  isTrue(src.includes('isAdminAccessDenied(error)') && src.includes('403'),
    `${file} : un utilisateur authentisé non Admin reçoit 403, pas 401`);
  isTrue(src.includes('withTracefabUserContext'), `${file} : passe par le contexte RLS`);
  isTrue(src.includes('admin.platformOrganizationId'), `${file} : filtre sur l'organisation plateforme`);
}

/* L'API accepte une tâche sans entreprise ; la base doit faire pareil. */
const tasksHandler = await readFile(at('api/_routes/admin/tasks.ts'), 'utf8');
isTrue(!tasksHandler.includes('company_id_required'),
  'POST /api/admin/tasks n\'exige pas d\'entreprise — cohérent avec company_id nullable');
const pilotsHandler = await readFile(at('api/_routes/admin/pilots.ts'), 'utf8');
isTrue(pilotsHandler.includes('company_id_required'),
  'POST /api/admin/pilots exige une entreprise — un pilote sans compte n\'a pas de sens');

/* Les pourcentages d'un pilote sont déclarés, pas mesurés. */
isTrue(pilotsHandler.includes("measurement: 'declared'"),
  'GET /api/admin/pilots annonce measurement: declared');
const pilotItem = await readFile(at('api/_routes/admin/pilots/[pilotId].ts'), 'utf8');
isTrue(pilotItem.includes("measurement: 'declared'"),
  'GET /api/admin/pilots/:id annonce aussi measurement: declared');

/* §14 : la conversion écrit converted_at, sinon la contrainte CHECK la refuse. */
const stageHandler = await readFile(at('api/_routes/admin/companies/[companyId]/stage.ts'), 'utf8');
isTrue(stageHandler.includes("converted_at: stage === 'customer' ? new Date() : null"),
  'la conversion écrit converted_at — sans lui le CHECK en base rejette l\'update');
isTrue(stageHandler.includes('canConvert'), 'la conversion passe par canConvert');
isTrue(stageHandler.includes('organization_id'), 'la conversion peut relier un vrai espace TRACEFAB');
isTrue(/parseOrganizationId/.test(stageHandler),
  'le lien est validé comme UUID : le .slice(0, 64) envoyait une chaîne quelconque dans une colonne UUID');

/* -------------------------------------------------------------------------- */
console.log('\nG. Internationalisation');
/* -------------------------------------------------------------------------- */

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
for (const lang of LANGS) {
  dicts[lang] = JSON.parse(await readFile(at(`locales/${lang}/admin.json`), 'utf8'));
  isTrue(Object.keys(dicts[lang]).length >= 271,
    `${lang}/admin.json : au moins 271 clés`, `${Object.keys(dicts[lang]).length} clés`);
}
const enKeys = Object.keys(dicts.en).sort().join('|');
for (const lang of LANGS.slice(1)) {
  eq(Object.keys(dicts[lang]).sort().join('|'), enKeys, `${lang} : même jeu de clés qu'en`);
}
for (const key of ['tasks.actionable', 'tasks.overdue', 'activities.subtitle', 'meetings.new',
  'pilots.dppReadiness', 'customers.historyNote', 'analytics.avgDays', 'nav.tasks',
  'taskType.follow_pilot', 'meetMode.video', 'pilotStatus.abandoned']) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][key] === 'string' && dicts[lang][key].trim().length > 0,
      `${lang} : ${key} traduit et non vide`);
  }
}
/* Le français ne doit pas être une copie de l'anglais. */
isTrue(dicts.fr['tasks.actionable'] !== dicts.en['tasks.actionable'], 'tasks.actionable est réellement traduit en français');
isTrue(dicts.de['analytics.avgDays'] !== dicts.en['analytics.avgDays'], 'analytics.avgDays est réellement traduit en allemand');

/* -------------------------------------------------------------------------- */
console.log('\nH. Les six modules rendent réellement');
/* -------------------------------------------------------------------------- */

const html = await readFile(at('admin/index.html'), 'utf8');
const frDict = JSON.parse(await readFile(at('locales/fr/admin.json'), 'utf8'));

/*
 * Le chargeur i18n est remplacé par un stub, mais le DICTIONNAIRE est le vrai,
 * lu sur disque. Les libellés affichés sont donc ceux de la production.
 */
const stub = `<script>window.TracefabI18n = {
  isReady: true,
  init: async () => true,
  setLanguage: async () => true,
  t: (k) => window.__DICT[k] || k,
};</script>`;
const booted = (dict, lang) => html
  .replace('<script src="/i18n-core.js"></script>', stub)
  .replace('</head>', `<script>window.__DICT = ${JSON.stringify(dict)};
    localStorage.setItem('tracefab.lang', ${JSON.stringify(lang)});</script></head>`);

const virtualConsole = new VirtualConsole();
const pageErrors = [];
virtualConsole.on('jsdomError', (e) => pageErrors.push(String(e?.message || e)));
virtualConsole.on('error', (...a) => pageErrors.push(a.join(' ')));

const dom = new JSDOM(booted(frDict, 'fr'), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.example/admin/?demo',
  virtualConsole,
});
const { window } = dom;
const { document } = window;
const settle = () => new Promise((r) => setTimeout(r, 200));
await settle();
await settle();

const go = async (view) => {
  const btn = document.querySelector(`[data-view="${view}"]`);
  if (!btn) throw new Error(`aucun bouton de navigation pour « ${view} »`);
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  await settle();
  /* #app et non document.body : body contient aussi le <script> inline, dont le
     source renferme « Premier échange », « NaN », « undefined » et les noms des
     entreprises de démonstration. Lire body faisait passer ou échouer les
     assertions pour de mauvaises raisons. */
  return document.getElementById('app').textContent || '';
};

eq(pageErrors.length, 0, 'aucune erreur JavaScript au démarrage', pageErrors.slice(0, 3).join(' | '));

/* La navigation annonce les six modules — et ne les liste plus comme « à venir ». */
for (const view of ['tasks', 'activities', 'meetings', 'pilots', 'customers', 'analytics']) {
  isTrue(Boolean(document.querySelector(`[data-view="${view}"]`)),
    `la navigation expose « ${view} »`);
}
const soonButtons = [...document.querySelectorAll('button.nav.soon')].map((b) => b.textContent.trim());
for (const built of ['Tasks', 'Activities', 'Meetings', 'Pilots', 'Customers', 'Analytics']) {
  isTrue(!soonButtons.includes(built), `« ${built} » n'est plus annoncé comme à venir`);
}

/* Tâches */
const tasksText = await go('tasks');
isTrue(tasksText.includes('À traiter aujourd\'hui'),
  'TODAY : la carte d\'entrée annonce « À traiter aujourd\'hui », pas simplement « aujourd\'hui »');
isTrue(tasksText.includes('En retard'), 'TODAY : le retard est affiché séparément');
isTrue(tasksText.includes('Appeler le prospect'), 'TODAY : les types de tâche sont traduits');
isTrue(tasksText.includes('Example Fashion Group'), 'TODAY : la tâche porte son entreprise');
isTrue(tasksText.includes('Marquer faite'), 'TODAY : une tâche ouverte peut être marquée faite');
const overdue = [...document.querySelectorAll('.mono.late')].map((e) => e.textContent);
isTrue(overdue.length > 0, 'TODAY : une échéance en retard est visuellement signalée', overdue.join(','));
const todayKpi = [...document.querySelectorAll('[data-tscope="today"] .kv')].map((e) => e.textContent.trim())[0];
eq(todayKpi, '3', 'TODAY : 3 à traiter = 2 du jour + 1 en retard');
const overdueKpi = [...document.querySelectorAll('[data-tscope="overdue"] .kv')].map((e) => e.textContent.trim())[0];
eq(overdueKpi, '1', 'TODAY : le compteur « en retard » vaut 1');
const todayBtn = document.querySelector('[data-tscope="today"]');
todayBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle();
isTrue((document.getElementById('app').textContent || '').includes('Préparer la démo DPP pour Northwind'),
  'le filtre TODAY inclut la tâche en retard — pas seulement l\'échéance du jour');
await go('tasks');
const allBtn = document.querySelector('[data-tscope="all"]');
allBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle();
const allText = document.getElementById('app').textContent || '';
isTrue(allText.includes('Qualifier Atlas Apparel'),
  'le filtre « toutes » montre aussi les tâches terminées');
isTrue(allText.includes('Rouvrir'), 'TODAY : une tâche faite peut être rouverte dans la portée « toutes »');

/* Activités */
const actText = await go('activities');
isTrue(actText.includes('Converti en client : Lusitania Fabrics'), 'ACTIVITÉS : la timeline montre la conversion');
isTrue(actText.includes('ajout seul'), 'ACTIVITÉS : le journal annonce être en ajout seul');
isTrue(actText.includes('Founder'), 'ACTIVITÉS : chaque entrée porte son auteur');
isTrue(document.querySelectorAll('.tl-d').length >= 5, 'ACTIVITÉS : la timeline a au moins 5 entrées');
const typeFilter = document.getElementById('f-activity');
isTrue(Boolean(typeFilter), 'ACTIVITÉS : un filtre par type existe');
typeFilter.value = 'conversion';
typeFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle();
eq(document.querySelectorAll('.tl-d').length, 1, 'ACTIVITÉS : filtrer sur « conversion » ne laisse qu\'une entrée');

/* Rendez-vous */
const meetText = await go('meetings');
isTrue(meetText.includes('Démo ESPR / DPP readiness'), 'RENDEZ-VOUS : le rendez-vous à venir s\'affiche');
isTrue(meetText.includes('Google Meet'), 'RENDEZ-VOUS : le lieu est affiché');
isTrue(!meetText.includes('Premier échange'),
  'RENDEZ-VOUS : la vue par défaut n\'affiche pas les rendez-vous passés');
const pastBtn = document.querySelector('[data-mscope="past"]');
pastBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle();
isTrue((document.getElementById('app').textContent || '').includes('Premier échange'),
  'RENDEZ-VOUS : le filtre « passés » montre l\'historique');
isTrue((document.getElementById('app').textContent || '').includes('demande une démonstration'),
  'RENDEZ-VOUS : l\'issue du rendez-vous passé est conservée');

/* Pilotes */
const pilotText = await go('pilots');
isTrue(pilotText.includes('Example Fashion Group'), 'PILOTES : l\'entreprise du pilote s\'affiche');
isTrue(pilotText.includes('84%'), 'PILOTES : la complétude des données s\'affiche');
isTrue(pilotText.includes('72%'), 'PILOTES : la couverture des preuves s\'affiche');
isTrue(pilotText.includes('69%'), 'PILOTES : la préparation DPP s\'affiche');
isTrue(pilotText.includes('déclarés par l\'équipe commerciale'),
  'PILOTES : l\'interface dit que ces chiffres sont DÉCLARÉS, pas mesurés');
isTrue(pilotText.includes('certificats de teinture'), 'PILOTES : les problèmes rencontrés sont consignés');
const meterWidths = [...document.querySelectorAll('.meterbar i')].map((i) => i.style.width);
isTrue(meterWidths.includes('84%') && meterWidths.includes('72%') && meterWidths.includes('69%'),
  'PILOTES : les barres reflètent les valeurs réelles, pas une barre pleine par défaut', meterWidths.join(','));

/* Clients */
const custText = await go('customers');
isTrue(custText.includes('Lusitania Fabrics'), 'CLIENTS : le client gagné s\'affiche');
isTrue(custText.includes('ne déplace rien'), 'CLIENTS : la conservation de l\'historique est annoncée');
/* toLocaleString('fr-FR') sépare les milliers par U+202F (espace fine insécable),
   pas par un espace ordinaire : comparer à un littéral '40 000' échouait à tort. */
const normSpaces = (txt) => txt.replace(/[\u00a0\u202f\u2009]/g, ' ');
isTrue(normSpaces(custText).includes('€40 000'),
  'CLIENTS : la valeur convertie est affichée en euros', normSpaces(custText).match(/€[\d ]+/g)?.join(' '));
isTrue(!custText.includes('Example Fashion Group'),
  'CLIENTS : un pilote n\'est pas présenté comme un client');
const histBtn = document.querySelector('[data-open="d7"]');
isTrue(Boolean(histBtn), 'CLIENTS : le client reste ouvrable — l\'historique est accessible, pas perdu');

/* Analytics */
const anText = await go('analytics');
isTrue(anText.includes('Prospects par pays'), 'ANALYTICS : la répartition par pays s\'affiche');
isTrue(anText.includes('Conversion par source'), 'ANALYTICS : la conversion par source s\'affiche');
isTrue(anText.includes('Pipeline par étape'), 'ANALYTICS : la répartition par étape s\'affiche');
isTrue(anText.includes('Non mesuré'),
  'ANALYTICS : la durée moyenne affiche « Non mesuré », jamais un 0 inventé');
isTrue(!anText.includes('NaN'), 'ANALYTICS : aucun NaN affiché');
isTrue(!anText.includes('undefined'), 'ANALYTICS : aucun undefined affiché');
const frRow = [...document.querySelectorAll('.arow')].find((r) => r.textContent.includes('FR'));
isTrue(Boolean(frRow), 'ANALYTICS : la ligne FR existe');
isTrue(frRow && frRow.querySelector('.arate').textContent.includes('Non mesuré'),
  'ANALYTICS : un pays sans décision affiche « Non mesuré », pas 0 %');
const ptRow = [...document.querySelectorAll('.arow')].find((r) => r.textContent.includes('PT'));
isTrue(ptRow && ptRow.querySelector('.arate').textContent.includes('100'),
  'ANALYTICS : un pays avec une conversion affiche son taux réel');

await window.close();

/*
 * Preuve d'internationalisation par le rendu, pas par le source.
 *
 * Chercher un mot anglais dans le source donne des faux positifs : `function
 * viewMeetings()` contient « Meetings » sans être un libellé. On recharge donc la
 * même page avec le dictionnaire ALLEMAND : si un libellé était codé en dur, il
 * resterait en anglais au lieu de basculer.
 */
const deDict = JSON.parse(await readFile(at('locales/de/admin.json'), 'utf8'));
const domDe = new JSDOM(booted(deDict, 'de'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://tracefab.example/admin/?demo', virtualConsole: new VirtualConsole(),
});
const wDe = domDe.window;
await settle();
await settle();
const goDe = async (view) => {
  wDe.document.querySelector(`[data-view="${view}"]`)
    .dispatchEvent(new wDe.MouseEvent('click', { bubbles: true }));
  await settle();
  await settle();
  return wDe.document.getElementById('app').textContent || '';
};

const deTasks = await goDe('tasks');
isTrue(deTasks.includes('Heute zu erledigen'), 'DE : la carte TODAY bascule en allemand');
isTrue(deTasks.includes('Überfällig'), 'DE : « Overdue » devient « Überfällig »');
isTrue(!deTasks.includes('Overdue') && !deTasks.includes('To handle today'),
  'DE : aucun libellé anglais ne subsiste dans la vue tâches');
isTrue(deTasks.includes('Prospect anrufen'), 'DE : les types de tâche basculent en allemand');
const deNav = wDe.document.querySelector('.side').textContent || '';
isTrue(deNav.includes('Aufgaben') && deNav.includes('Analysen') && deNav.includes('Kunden'),
  'DE : la navigation bascule en allemand');
isTrue(!deNav.includes('Analytics'), 'DE : « Analytics » n\'est pas codé en dur dans la navigation');
const dePilot = await goDe('pilots');
isTrue(dePilot.includes('DPP-Bereitschaft'), 'DE : l\'indicateur DPP bascule en allemand');
isTrue(dePilot.includes('Vertriebsteam angegeben'), 'DE : l\'avertissement « déclaré, non mesuré » bascule aussi');
const deAn = await goDe('analytics');
isTrue(deAn.includes('nicht gemessen'), 'DE : « not measured » devient « nicht gemessen »');
await wDe.close();

/* -------------------------------------------------------------------------- */
console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications\n`);
process.exit(failures === 0 ? 0 : 1);
