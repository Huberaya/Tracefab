#!/usr/bin/env node
/**
 * CHANTIER ADMIN 10 — §10 TASKS, MEETINGS, HISTORY dans la fiche prospect.
 *
 * CE QUI ÉTAIT MANQUANT
 *   La fiche entreprise n'avait que 6 onglets (overview, contacts, opportunity,
 *   activity, notes, emails) sur les 10 du §10. Manquaient TASKS, MEETINGS et
 *   HISTORY. La route ne servait ni `tasks` ni `meetings`.
 *
 * LE POINT QUI COMPTE
 *   Les réunions et les changements de stade écrivent dans `crm_activities`, les
 *   tâches N'ÉCRIVENT RIEN. Présenter la timeline comme « l'historique » ferait
 *   donc disparaître les tâches — alors que §14 promet que la conversion
 *   conserve l'intégralité de l'historique commercial. HISTORY est l'union des
 *   trois sources, chaque ligne portant sa provenance : c'est ce qui rend la
 *   promesse vérifiable à l'écran.
 *
 *   A.  crm-history.ts compile et n'importe rien ;
 *   B.  buildCompanyHistory — la fusion ;
 *   C.  ce qui n'est pas datable est ÉCARTÉ, jamais inventé ;
 *   D.  une troncature se déclare, elle ne se tait pas ;
 *   E.  le jumeau de la page ne diverge pas du serveur ;
 *   F.  la route sert tasks, meetings et history ;
 *   G.  i18n ;
 *   H.  l'interface — 9 onglets, chacun rendu.
 *
 *   npm run test:admin:chantier10
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
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
  if (!cond) throw new Error(d ?? 'attendu vrai');
}, l);

const run = (cmd, args, opts = {}) => import('node:child_process').then(({ spawn }) => new Promise((res, rej) => {
  const child = spawn(cmd, args, { cwd: root, ...opts });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (c) => (c === 0 ? res(out) : rej(new Error(out.slice(-600)))));
}));

/* -------------------------------------------------------------------------- */
console.log('\nA. crm-history.ts compile et reste pur');
/* -------------------------------------------------------------------------- */

await mkdir(at('.cache'), { recursive: true });
const outDir = await mkdtemp(at('.cache/admin10-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/crm-history.ts',
    '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('crm-history.ts compile');
} catch (e) {
  bad('crm-history.ts ne compile pas', e.message.slice(0, 400));
}

const H = await import(pathToFileURL(join(outDir, 'crm-history.js')).href);
const historySrc = await readFile(at('api/_lib/crm-history.ts'), 'utf8');
eq(/^import\s/m.test(historySrc), false,
  'crm-history.ts n\'importe rien : la fusion reste exécutable sans client Prisma');

/* -------------------------------------------------------------------------- */
console.log('\nB. buildCompanyHistory — la fusion des trois sources');
/* -------------------------------------------------------------------------- */

const { buildCompanyHistory, historyCounts } = H;

const activities = [
  { id: 'a1', type: 'created', summary: 'Prospect créé', actor_name: 'Fondateur',
    occurred_at: '2026-01-05T09:00:00.000Z' },
  { id: 'a2', type: 'status_change', summary: 'Stade : contacté', detail: 'nouveau → contacté',
    actor_name: 'Fondateur', occurred_at: '2026-01-09T14:30:00.000Z' },
];
const tasks = [
  { id: 't1', type: 'call', title: 'Appeler Camille', status: 'open',
    due_at: '2026-01-12T10:00:00.000Z', assignee_name: 'Fondateur' },
  { id: 't2', type: 'email', title: 'Qualifier Atlas', status: 'done',
    due_at: '2026-01-02T09:00:00.000Z', completed_at: '2026-01-03T12:00:00.000Z' },
];
const meetings = [
  { id: 'm1', subject: 'Démo DPP', mode: 'video', starts_at: '2026-01-20T10:00:00.000Z',
    ends_at: '2026-01-20T11:00:00.000Z', attendees: 'Camille Roux',
    outcome: 'Intéressée.', notes: 'Rappeler en février.' },
];

const merged = buildCompanyHistory({ activities, tasks, meetings });

eq(merged.entries.length, 5, 'les 5 enregistrements des 3 sources sont fusionnés');
eq(merged.truncated, false, 'aucune troncature déclarée quand aucune source n\'est coupée');

const bySource = (s) => merged.entries.filter((e) => e.source === s);
eq(bySource('activity').length, 2, 'les 2 activités sont présentes');
eq(bySource('task').length, 2, 'les 2 tâches sont présentes');
eq(bySource('meeting').length, 1, 'la réunion est présente');

/* L'ordre : descendant, du plus récent au plus ancien. */
const dates = merged.entries.map((e) => e.at);
eq(JSON.stringify(dates), JSON.stringify([...dates].sort().reverse()),
  'l\'historique est trié du plus récent au plus ancien');
eq(merged.entries[0].source, 'meeting', 'la réunion de janvier 2026 ouvre l\'historique');

/*
 * Le piège : une tâche accomplie doit être datée de son ACCOMPLISSEMENT, pas de
 * son échéance. Sinon une tâche faite en retard apparaît dans l'historique à une
 * date où rien ne s'est passé.
 */
const done = bySource('task').find((e) => e.key === 'task:t2');
eq(done.at, '2026-01-03T12:00:00.000Z',
  'une tâche accomplie est datée de son accomplissement, pas de son échéance');
eq(done.status, 'done', 'le statut de la tâche est conservé');

const open = bySource('task').find((e) => e.key === 'task:t1');
eq(open.at, '2026-01-12T10:00:00.000Z',
  'une tâche ouverte est datée de son échéance');

/* outcome et notes sont deux champs distincts en base : ils restent séparés. */
const mt = bySource('meeting')[0];
eq(mt.detail, 'Intéressée.\nRappeler en février.',
  'le compte rendu et les notes de réunion sont servis ensemble mais distincts');
eq(mt.actor, 'Camille Roux', 'les participants de la réunion sont servis');
eq(mt.kind, 'video', 'le mode de réunion est servi');

const counts = historyCounts(merged);
eq(counts.activity, 2, 'historyCounts — activités');
eq(counts.task, 2, 'historyCounts — tâches');
eq(counts.meeting, 1, 'historyCounts — réunions');

/* Deux lignes à la même seconde : l'ordre ne doit pas dépendre du moteur. */
const tie = buildCompanyHistory({
  activities: [
    { id: 'zz', type: 'note', summary: 'B', occurred_at: '2026-02-01T00:00:00.000Z' },
    { id: 'aa', type: 'note', summary: 'A', occurred_at: '2026-02-01T00:00:00.000Z' },
  ],
});
eq(tie.entries.map((e) => e.key).join(','), 'activity:aa,activity:zz',
  'à date égale, le départage est déterministe — l\'interface ne saute pas d\'un rendu à l\'autre');

/* Une entrée non tableau ne doit pas faire tomber la route. */
eq(buildCompanyHistory({}).entries.length, 0, 'une entrée absente donne un historique vide');
eq(buildCompanyHistory({ activities: 'pas un tableau', tasks: null, meetings: 42 }).entries.length, 0,
  'une entrée mal typée est ignorée, pas une exception');

/* -------------------------------------------------------------------------- */
console.log('\nC. Ce qui n\'est pas datable est écarté, jamais inventé');
/* -------------------------------------------------------------------------- */

const undatable = buildCompanyHistory({
  activities: [{ id: 'x1', type: 'note', summary: 'Sans date' }],
  tasks: [{ id: 'x2', type: 'call', title: 'Sans échéance ni création', status: 'open' }],
  meetings: [{ id: 'x3', subject: 'Date invalide', starts_at: 'ceci n\'est pas une date' }],
});
eq(undatable.entries.length, 0,
  'aucune ligne n\'est inventée pour un enregistrement sans date exploitable');

const partial = buildCompanyHistory({
  tasks: [{ id: 'x4', type: 'call', title: 'Créée sans échéance', status: 'open',
    created_at: '2026-03-01T08:00:00.000Z' }],
});
eq(partial.entries.length, 1, 'une tâche sans échéance retombe sur sa date de création');
eq(partial.entries[0].at, '2026-03-01T08:00:00.000Z', 'et c\'est bien cette date qui est servie');

const invalid = buildCompanyHistory({
  activities: [{ id: 'x5', type: 'note', summary: 'Date cassée', occurred_at: '2026-13-45' }],
});
eq(invalid.entries.length, 0, 'une date invalide n\'est pas convertie en époque ni en « maintenant »');

/* -------------------------------------------------------------------------- */
console.log('\nD. Une troncature se déclare');
/* -------------------------------------------------------------------------- */

eq(buildCompanyHistory({ activities, activitiesTruncated: true }).truncated, true,
  'une troncature d\'activités est déclarée');
eq(buildCompanyHistory({ tasks, tasksTruncated: true }).truncated, true,
  'une troncature de tâches est déclarée');
eq(buildCompanyHistory({ meetings, meetingsTruncated: true }).truncated, true,
  'une troncature de réunions est déclarée');
eq(buildCompanyHistory({ activities }).truncated, false,
  'sans borne atteinte, rien n\'est déclaré comme coupé');

/* -------------------------------------------------------------------------- */
console.log('\nE. Le jumeau de la page ne diverge pas du serveur');
/* -------------------------------------------------------------------------- */

const page = await readFile(at('admin/index.html'), 'utf8');
isTrue(/function mergeHistory\(/.test(page),
  'la page expose mergeHistory pour le mode démonstration');
isTrue(/test_admin_chantier10/.test(page),
  'la duplication est annoncée comme contrôlée par ce test, pas laissée silencieuse');

/* -------------------------------------------------------------------------- */
console.log('\nF. La route sert tasks, meetings et history');
/* -------------------------------------------------------------------------- */

const routeSrc = await readFile(at('api/_routes/admin/companies/[companyId].ts'), 'utf8');
isTrue(/crm_tasks:\s*\{/.test(routeSrc), 'la route lit crm_tasks');
isTrue(/crm_meetings:\s*\{/.test(routeSrc), 'la route lit crm_meetings');

/*
 * `tasks: company.crm_tasks` apparaît DEUX fois dans la route : une fois dans
 * l'appel à buildCompanyHistory, une fois dans la réponse. Une assertion globale
 * sur le fichier ne distingue pas les deux — retirer l'une des deux lignes
 * laisserait l'autre satisfaire le test. D'où l'ancrage sur chaque bloc : ce
 * sont deux défaillances différentes (un historique amputé / une réponse
 * amputée) et elles doivent tomber séparément.
 */
const callBlock = routeSrc.slice(
  routeSrc.indexOf('buildCompanyHistory({'),
  routeSrc.indexOf('});', routeSrc.indexOf('buildCompanyHistory({')),
);
const replyBlock = routeSrc.slice(
  routeSrc.indexOf('return json(res, 200, {'),
  routeSrc.indexOf('});', routeSrc.indexOf('return json(res, 200, {')),
);
isTrue(callBlock.length > 100, 'l\'appel à buildCompanyHistory a été isolé', `${callBlock.length} car.`);
isTrue(replyBlock.length > 100, 'le bloc de réponse a été isolé', `${replyBlock.length} car.`);

isTrue(/\bactivities:\s*company\.crm_activities/.test(callBlock),
  'la fusion reçoit les activités');
isTrue(/\btasks:\s*company\.crm_tasks/.test(callBlock),
  'la fusion reçoit les tâches — sans cela HISTORY les perdrait en silence');
isTrue(/\bmeetings:\s*company\.crm_meetings/.test(callBlock),
  'la fusion reçoit les réunions');

isTrue(/\btasks:\s*company\.crm_tasks/.test(replyBlock), 'la réponse sert `tasks`');
isTrue(/\bmeetings:\s*company\.crm_meetings/.test(replyBlock), 'la réponse sert `meetings`');
isTrue(/\bhistory,/.test(replyBlock), 'la réponse sert `history`');
isTrue(/buildCompanyHistory\(/.test(routeSrc), 'la fusion est faite par crm-history.ts, pas réécrite dans la route');
isTrue(/activitiesTruncated:\s*company\.crm_activities\.length >= ACTIVITY_LIMIT/.test(callBlock),
  'la borne d\'activités est comparée, pas supposée');
isTrue(/tasksTruncated:\s*company\.crm_tasks\.length >= TASK_LIMIT/.test(callBlock),
  'la borne de tâches est comparée');
isTrue(/meetingsTruncated:\s*company\.crm_meetings\.length >= MEETING_LIMIT/.test(callBlock),
  'la borne de réunions est comparée');
/* Les bornes doivent exister : une comparaison à une constante non définie
   vaudrait `undefined` et la troncature ne serait jamais déclarée. */
for (const c of ['ACTIVITY_LIMIT', 'TASK_LIMIT', 'MEETING_LIMIT']) {
  isTrue(new RegExp(`const ${c} = \\d+`).test(routeSrc), `${c} est définie par un nombre`);
}
/* `stage` reste interdit au PATCH : un mouvement de pipeline non journalisé
   rendrait l'historique faux — donc cet onglet mentirait. */
isTrue(/delete body\.stage/.test(routeSrc),
  'le PATCH refuse toujours `stage` : l\'historique ne peut pas être falsifié par la porte de côté');

/* -------------------------------------------------------------------------- */
console.log('\nG. i18n');
/* -------------------------------------------------------------------------- */

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
for (const l of LANGS) dicts[l] = JSON.parse(await readFile(at(`locales/${l}/admin.json`), 'utf8'));

const NEW_KEYS = [
  'company.tabTasks', 'company.tabMeetings', 'company.tabHistory', 'tasks.today',
  'history.sources', 'history.sourcesHint', 'history.sourceActivity',
  'history.sourceTask', 'history.sourceMeeting', 'history.truncated',
  'history.truncatedWhy', 'history.empty', 'history.emptyBody',
];
for (const l of LANGS) {
  const missing = NEW_KEYS.filter((k) => !dicts[l][k]);
  eq(missing.length, 0, `${l} : les 13 nouvelles clés sont présentes`, missing.join(', '));
}
for (const l of LANGS) {
  eq(Object.keys(dicts[l]).length, Object.keys(dicts.en).length,
    `${l} : même nombre de clés qu'en (${Object.keys(dicts.en).length})`);
  const onlyEn = Object.keys(dicts.en).filter((k) => !(k in dicts[l]));
  eq(onlyEn.length, 0, `${l} : aucun trou de traduction`, onlyEn.slice(0, 4).join(', '));
}
for (const l of LANGS) {
  isTrue(!/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(JSON.stringify(dicts[l])),
    `${l} : aucun caractère CJK`);
}
const untranslated = [];
for (const l of LANGS.filter((x) => x !== 'en')) {
  for (const k of Object.keys(dicts.en)) {
    if (dicts[l][k] === dicts.en[k] && /[a-z]/i.test(dicts.en[k]) && dicts.en[k].split(' ').length > 1) {
      untranslated.push(`${l}:${k}`);
    }
  }
}
eq(untranslated.length, 0, 'aucune entrée multilingue laissée en anglais', untranslated.slice(0, 4).join(', '));
/* L'explication de la troncature doit être lisible, pas un mot isolé. */
for (const l of LANGS) {
  isTrue(dicts[l]['history.truncatedWhy'].length > 40,
    `${l} : l'explication de la troncature n'est pas tronquée`);
}

/* -------------------------------------------------------------------------- */
console.log('\nH. L\'interface — 9 onglets, chacun rendu');
/* -------------------------------------------------------------------------- */

const stub = `<script>window.TracefabI18n = {
  isReady: true, init: async () => true, setLanguage: async () => true,
  t: (k) => window.__DICT[k] || k,
};</script>`;
const booted = (dict, lang) => page
  .replace('<script src="/i18n-core.js"></script>', stub)
  .replace('</head>', `<script>window.__DICT = ${JSON.stringify(dict)};
    localStorage.setItem('tracefab.lang', ${JSON.stringify(lang)});</script></head>`);

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(String(e?.message || e)));
virtualConsole.on('error', (...a) => pageErrors.push(a.join(' ')));

const dom = new JSDOM(booted(dicts.fr, 'fr'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://tracefab.example/admin/?demo', virtualConsole,
});
const { window } = dom;
const { document } = window;
const settle = () => new Promise((r) => setTimeout(r, 200));
await settle();
await settle();

const click = (el) => {
  if (!el) throw new Error('élément introuvable');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
/* #app et non document.body : body contient aussi le <script> inline, dont le
   source renferme les noms des entreprises de démonstration. */
const go = async (view) => {
  const btn = document.querySelector(`[data-view="${view}"]`);
  if (!btn) throw new Error(`aucun bouton de navigation pour « ${view} »`);
  click(btn);
  await settle();
  await settle();
  return document.getElementById('app').textContent || '';
};
const tabIds = () => [...document.querySelectorAll('[data-tab]')].map((b) => b.dataset.tab);
const openTab = async (id) => {
  click(document.querySelector(`[data-tab="${id}"]`));
  await settle();
  return document.getElementById('app').textContent || '';
};

/* d1 = Example Fashion Group : 2 tâches (t1 ouverte, t5 ouverte) et 1 réunion (m1). */
await go('prospects');
const openBtn = document.querySelector('[data-open="d1"]');
isTrue(Boolean(openBtn), 'la fiche d\'un prospect est ouvrable depuis la liste');
click(openBtn);
await settle();
await settle();

const EXPECTED_TABS = ['overview', 'contacts', 'opportunity', 'activity', 'notes',
  'tasks', 'emails', 'meetings', 'history'];
eq(JSON.stringify(tabIds()), JSON.stringify(EXPECTED_TABS),
  'les 9 onglets du §10 sont présents, dans l\'ordre du cahier des charges');

for (const b of document.querySelectorAll('[data-tab]')) {
  eq(b.getAttribute('role'), 'tab', `l'onglet ${b.dataset.tab} porte role="tab"`);
}
isTrue(document.querySelector('[data-tab="overview"]').getAttribute('aria-selected') === 'true',
  'l\'onglet actif est marqué aria-selected');

/* TASKS — les tâches n'écrivent pas dans crm_activities : c'est le seul endroit
   où elles sont visibles depuis la fiche. */
const tasksText = await openTab('tasks');
isTrue(tasksText.includes('Appeler Camille Roux'),
  'TASKS : la tâche ouverte de l\'entreprise s\'affiche');
isTrue(tasksText.includes('Suivre le pilote Example Fashion Group'),
  'TASKS : la seconde tâche s\'affiche');
isTrue(!tasksText.includes('Préparer la démo DPP pour Northwind'),
  'TASKS : les tâches d\'une AUTRE entreprise ne fuient pas dans cette fiche');
isTrue(!tasksText.includes('undefined'), 'TASKS : aucun undefined affiché');
isTrue(!tasksText.includes('taskType.'), 'TASKS : le type est traduit, pas servi comme clé brute');

/* MEETINGS */
const meetingsText = await openTab('meetings');
isTrue(meetingsText.includes('Démo ESPR / DPP readiness'),
  'MEETINGS : la réunion de l\'entreprise s\'affiche');
isTrue(meetingsText.includes('Google Meet'), 'MEETINGS : le lieu s\'affiche');
isTrue(meetingsText.includes('Camille Roux'), 'MEETINGS : les participants s\'affichent');
isTrue(meetingsText.includes('Rendez-vous à venir') || meetingsText.includes('À venir'),
  'MEETINGS : les réunions à venir sont distinguées des passées');
isTrue(!meetingsText.includes('meetMode.'), 'MEETINGS : le mode est traduit, pas servi comme clé brute');

/* HISTORY — l'union des sources */
const historyText = await openTab('history');
isTrue(historyText.includes('Sources'), 'HISTORY : le bloc des sources s\'affiche');
isTrue(historyText.includes('Démo ESPR / DPP readiness'),
  'HISTORY : la réunion figure dans l\'historique fusionné');
isTrue(historyText.includes('Appeler Camille Roux'),
  'HISTORY : la tâche figure dans l\'historique fusionné — c\'est la raison d\'être de l\'onglet');
isTrue(historyText.includes('Prospect créé'),
  'HISTORY : l\'activité figure dans l\'historique fusionné');
isTrue(!historyText.includes('history.'), 'HISTORY : aucune clé brute affichée');
isTrue(!historyText.includes('NaN'), 'HISTORY : aucun NaN affiché');

/* L'historique doit être plus complet que la timeline : sinon l'onglet est décoratif. */
const activityText = await openTab('activity');
isTrue(!activityText.includes('Appeler Camille Roux'),
  'ACTIVITY ne montre PAS les tâches — ce qui justifie HISTORY au lieu de le dupliquer');
isTrue(historyText.length > activityText.length,
  'HISTORY couvre strictement plus que la timeline');

/* Le compteur d'onglet doit refléter la fusion, pas une seule source :
   d1 porte 1 activité, 2 tâches (t1, t5) et 1 réunion (m1) → 4. */
const histTab = document.querySelector('[data-tab="history"]');
isTrue(/\(4\)/.test(histTab.textContent),
  'le compteur de l\'onglet HISTORY vaut le total fusionné (1 activité + 2 tâches + 1 réunion)',
  histTab.textContent);

/* Le mode démonstration doit se recalculer comme le serveur.
   `mergeHistory` vit dans l'IIFE de la page et n'est donc pas atteignable par
   window.eval : on extrait la fonction DU SOURCE LIVRÉ et on l'exécute ici.
   C'est bien le code embarqué qui est comparé, pas une copie du test. */
const start = page.indexOf('function mergeHistory(');
isTrue(start > 0, 'mergeHistory est présente dans le source livré');
let depth = 0;
let end = start;
for (; end < page.length; end += 1) {
  if (page[end] === '{') depth += 1;
  else if (page[end] === '}') { depth -= 1; if (depth === 0) { end += 1; break; } }
}
const mergeSrc = page.slice(start, end);
const mergeHistory = new Function(`${mergeSrc}; return mergeHistory;`)();
isTrue(mergeSrc.length > 400, 'la fonction extraite est complète, pas amputée',
  `${mergeSrc.length} caractères`);

const SAMPLE = {
  activities: [{ id: 'a1', type: 'note', summary: 'S', actor_name: 'X', occurred_at: '2026-05-04T08:00:00.000Z' }],
  tasks: [{ id: 't1', type: 'call', title: 'T', status: 'done',
    due_at: '2026-05-01T08:00:00.000Z', completed_at: '2026-05-02T08:00:00.000Z' },
  { id: 't2', type: 'follow_up', title: 'U', status: 'open',
    due_at: '2026-05-11T08:00:00.000Z', assignee_name: 'Y' }],
  meetings: [{ id: 'm1', subject: 'M', mode: 'video', starts_at: '2026-05-09T08:00:00.000Z',
    outcome: 'O', notes: 'N', attendees: 'A' }],
};
const twin = mergeHistory(SAMPLE.activities, SAMPLE.tasks, SAMPLE.meetings);
const server = buildCompanyHistory(SAMPLE).entries;
eq(JSON.stringify(twin), JSON.stringify(server),
  'mergeHistory (page) et buildCompanyHistory (serveur) produisent le même historique');
eq(twin.length, 4, 'l\'échantillon de comparaison porte bien sur les 4 enregistrements');

/* Y compris sur les cas limites : sans date, la page ne doit pas inventer. */
const twinEdge = mergeHistory(
  [{ id: 'x', type: 'note', summary: 'Sans date' }],
  [{ id: 'y', type: 'call', title: 'Sans rien', status: 'open' }],
  [{ id: 'z', subject: 'Cassée', starts_at: 'pas une date' }]);
eq(JSON.stringify(twinEdge),
  JSON.stringify(buildCompanyHistory({
    activities: [{ id: 'x', type: 'note', summary: 'Sans date' }],
    tasks: [{ id: 'y', type: 'call', title: 'Sans rien', status: 'open' }],
    meetings: [{ id: 'z', subject: 'Cassée', starts_at: 'pas une date' }],
  }).entries),
  'les deux implémentations écartent pareillement ce qui n\'est pas datable');

/* Une entreprise sans tâche ni réunion ne doit pas afficher un onglet cassé. */
await go('prospects');
const emptyBtn = [...document.querySelectorAll('[data-open]')]
  .find((b) => b.dataset.open === 'd4');
if (emptyBtn) {
  click(emptyBtn);
  await settle();
  await settle();
  const t4 = await openTab('tasks');
  isTrue(t4.includes('Aucune tâche') || t4.length > 0,
    'TASKS : une entreprise sans tâche affiche un état vide, pas un tableau cassé');
  const h4 = await openTab('history');
  isTrue(!h4.includes('undefined') && !h4.includes('NaN'),
    'HISTORY : aucun undefined ni NaN sur une entreprise sans réunion');
}

eq(pageErrors.length, 0, 'aucune erreur JavaScript pendant le rendu', pageErrors.slice(0, 3).join(' | '));

console.log(`\n${failures ? 'ÉCHEC' : 'SUCCÈS'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures ? 1 : 0);
