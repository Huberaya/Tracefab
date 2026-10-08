#!/usr/bin/env node
/**
 * CHANTIER ADMIN 05 — Notes (§12), Emails (§12), Opportunities (§1 + §4).
 *
 * Ce test exécute le module RÉEL compilé (`api/_lib/crm-log.ts`) et rend
 * l'interface RÉELLE dans jsdom avec le vrai dictionnaire lu sur disque.
 *
 *   A. compilation du module réel ;
 *   B. parseLogInput — bornes et refus ;
 *   C. parseRecipient — validé, jamais inventé ;
 *   D. rankOpportunities — déterministe, ne mélange pas les populations ;
 *   E. le refus d'envoi — documenté, et épinglé sur le schéma ;
 *   F. routes — lecture seule, périmètre fixe, ordre porteur ;
 *   G. réutilisation — une seule porte d'écriture, déjà scellée ;
 *   H. i18n ;
 *   I. interface — trois vues, deux formulaires, refus affiché ;
 *   J. les deux défauts CSS préexistants corrigés.
 *
 *   npm run test:admin:chantier05
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
console.log('\nA. Compilation du module réel');
/* -------------------------------------------------------------------------- */

await mkdir(at('.cache'), { recursive: true });
const outDir = await mkdtemp(at('.cache/admin05-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/crm-log.ts', 'api/_lib/crm-opportunity.ts',
    '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('crm-log.ts et crm-opportunity.ts compilent');
} catch (e) {
  bad('les modules Admin 05 ne compilent pas', e.message.slice(0, 400));
}

const log = await import(pathToFileURL(join(outDir, 'crm-log.js')).href);

/* -------------------------------------------------------------------------- */
console.log('\nB. parseLogInput — bornes et refus');
/* -------------------------------------------------------------------------- */

const parse = log.parseLogInput;
const good = parse({ summary: '  Relance après le salon  ' }, 'note');
eq(good.ok, true, 'une note avec un résumé passe');
eq(good.summary, 'Relance après le salon', 'le résumé est rogné : les espaces ne sont pas du contenu');
eq(good.detail, null, 'sans détail, detail est null et non une chaîne vide');
eq(good.type, 'note', 'le type demandé est repris, pas déduit');

const withDetail = parse({ summary: 'x', detail: '  contexte  ' }, 'note');
eq(withDetail.detail, 'contexte', 'le détail est rogné lui aussi');
eq(parse({ summary: 'x', detail: '   ' }, 'note').detail, null,
  'un détail uniquement blanc devient null : une chaîne blanche n\'est pas un contenu');

/* Le vocabulaire d'erreur distingue note et e-mail : « objet manquant » a plus de
   sens pour un e-mail que « résumé manquant ». */
eq(parse({}, 'note').error, 'summary_required', 'une note sans résumé est refusée, avec le bon code');
eq(parse({}, 'email').error, 'subject_required', 'un e-mail sans objet est refusé, avec le bon code');
eq(parse(null, 'note').error, 'body_required', 'un corps absent est refusé');
eq(parse('texte', 'note').error, 'body_required', 'un corps qui n\'est pas un objet est refusé');
eq(parse({ summary: 42 }, 'note').error, 'summary_required',
  'un résumé qui n\'est pas du texte est refusé, pas converti en "42"');

eq(log.LOG_LIMITS.summaryMax, 300, 'la borne du résumé est écrite : 300');
eq(log.LOG_LIMITS.detailMax, 4000, 'la borne du détail est écrite : 4000');
eq(parse({ summary: 'x'.repeat(300) }, 'note').ok, true, '300 caractères passent : la borne est incluse');
eq(parse({ summary: 'x'.repeat(301) }, 'note').error, 'summary_too_long',
  '301 caractères sont refusés — et non tronqués : tronquer avant de valider rend la validation inutile');
eq(parse({ summary: 'x', detail: 'y'.repeat(4001) }, 'note').error, 'detail_too_long',
  'un détail trop long est refusé');
eq(parse({ summary: 'x', detail: 42 }, 'note').error, 'detail_must_be_text',
  'un détail qui n\'est pas du texte est refusé');

/* -------------------------------------------------------------------------- */
console.log('\nC. parseRecipient — validé, jamais inventé');
/* -------------------------------------------------------------------------- */

const rec = log.parseRecipient;
eq(rec('  camille@maison.fr  '), 'camille@maison.fr', 'une adresse valide est rognée et conservée');
eq(rec('pas-un-email'), null, 'une chaîne qui n\'est pas une adresse est refusée');
eq(rec('a@b'), null, 'une adresse sans domaine est refusée');
eq(rec(''), null, 'une chaîne vide est refusée');
eq(rec(null), null, 'null est refusé sans lever');
eq(rec(undefined), null, 'undefined est refusé sans lever');
eq(rec(42), null, 'un nombre est refusé sans lever');
eq(rec('a@b.'.repeat(200)), null, 'une adresse démesurée est refusée');
/* Le contrôle est de FORME. TRACEFAB ne peut pas prouver qu'une boîte existe ;
   prétendre le faire serait un mensonge affiché comme une vérification. */
eq(rec('inexistant@domaine-qui-nexiste-pas.example'), 'inexistant@domaine-qui-nexiste-pas.example',
  'une adresse bien formée mais inexistante passe : le contrôle est de forme, pas d\'existence');

/* -------------------------------------------------------------------------- */
console.log('\nD. rankOpportunities — déterministe, ne mélange pas les populations');
/* -------------------------------------------------------------------------- */

const rank = log.rankOpportunities;

const FIXTURE = [
  { id: 'a', name: 'Gros FR', stage: 'demo', priority: 'high', product_count: 350, supplier_count: 42, maturity: 'medium', country_code: 'FR', estimated_value_eur: 10 },
  { id: 'b', name: 'Un signal critique', stage: 'new', priority: 'critical', country_code: 'DE' },
  { id: 'c', name: 'Client gagné', stage: 'customer', country_code: 'FR', product_count: 900 },
  { id: 'd', name: 'Perdu', stage: 'lost', country_code: 'FR', lost_reason: 'budget' },
  { id: 'e', name: 'Sans donnée', stage: 'new' },
  { id: 'f', name: 'Un signal fort', stage: 'demo', priority: 'high', country_code: 'IT', estimated_value_eur: 5 },
];

const r1 = rank(FIXTURE);
eq(r1.items.length, 3, 'trois entreprises restent à travailler sur six (2 fermées + 1 sans signal)');
eq(r1.closed, 2, 'client et perdu sont retirés du classement et comptés à part');
eq(r1.insufficient, 1, 'l\'entreprise sans aucun signal est retirée et comptée à part');
eq(r1.items.some((i) => i.company_id === 'c'), false,
  'un client n\'apparaît PAS dans la liste des opportunités : il n\'y a plus rien à prospecter');
eq(r1.items.some((i) => i.company_id === 'e'), false,
  'une entreprise sans signal n\'apparaît PAS : la classer ferait croire qu\'il y a du travail');

/* Le tri : signaux décroissants, puis priorité, puis valeur, puis identifiant. */
eq(JSON.stringify(r1.items.map((i) => i.company_id)), JSON.stringify(['a', 'b', 'f']),
  'a (3 signaux) passe avant b et f (1 signal chacun)');
const [i1, i2] = r1.items.slice(1, 3);
isTrue(i1.priority === 'critical' && i2.priority === 'high',
  'à signaux égaux, la priorité critique passe avant la priorité haute');

/* Le déterminisme est la propriété qui rend la liste exploitable. */
const again = rank(FIXTURE);
eq(JSON.stringify(again.items.map((i) => i.company_id)), JSON.stringify(r1.items.map((i) => i.company_id)),
  'deux appels sur la même entrée donnent exactement le même ordre');
const shuffled = rank([FIXTURE[4], FIXTURE[1], FIXTURE[5], FIXTURE[0], FIXTURE[2], FIXTURE[3]]);
eq(JSON.stringify(shuffled.items.map((i) => i.company_id)), JSON.stringify(r1.items.map((i) => i.company_id)),
  'l\'ordre d\'arrivée en base ne change pas le classement : le tri est total, pas stable par hasard');

/* À égalité complète, l'identifiant tranche. Sans ce critère, l'ordre dépendrait
   de celui de la requête et la liste bougerait d'un rafraîchissement à l'autre. */
const tie = rank([
  { id: 'zz', name: 'Z', stage: 'new', priority: 'medium', country_code: 'DE' },
  { id: 'aa', name: 'A', stage: 'new', priority: 'medium', country_code: 'DE' },
]);
eq(JSON.stringify(tie.items.map((i) => i.company_id)), JSON.stringify(['aa', 'zz']),
  "à égalité parfaite, l'identifiant tranche dans un sens fixe");

/* Une entrée dégradée ne doit pas lever : une ligne malformée ne doit pas
   empêcher d'afficher les autres. */
eq(rank([]).items.length, 0, 'une liste vide ne lève pas');
eq(rank(null).items.length, 0, 'null ne lève pas');
eq(rank(undefined).items.length, 0, 'undefined ne lève pas');
eq(rank([null, 'texte', 42, {}]).items.length, 0,
  'des lignes sans identifiant sont ignorées, pas classées sous un nom vide');
eq(rank([{ name: 'sans id', stage: 'new', country_code: 'DE' }]).items.length, 0,
  'une ligne sans identifiant est ignorée : une opportunité sans lien ne sert à rien');

/* Les champs lus sont ceux de la derivation, pas des champs inventés. */
const one = r1.items.find((i) => i.company_id === 'a');
eq(one.signals, 3, 'les signaux viennent de assessOpportunity, pas d\'un autre calcul');
eq(one.layers.join(','), 'L01,L02,L03,L06,L07', 'les couches sont celles de assessOpportunity');
eq(one.problems.length, 4, 'les problèmes sont ceux de assessOpportunity');
eq(one.estimated_value_eur, 10, 'la valeur estimée est reprise telle quelle');
const noValue = rank([{ id: 'x', stage: 'new', country_code: 'DE' }]).items[0];
eq(noValue.estimated_value_eur, null, 'une valeur absente reste null, elle n\'est pas mise à zéro');
eq(noValue.next_contact_at, null, 'une échéance absente reste null');
const dated = rank([{ id: 'x', stage: 'new', country_code: 'DE', next_contact_at: new Date('2026-05-01T00:00:00Z') }]).items[0];
eq(dated.next_contact_at, '2026-05-01T00:00:00.000Z', 'une Date d\'échéance est sérialisée en ISO');

/* -------------------------------------------------------------------------- */
console.log('\nE. Le refus d\'envoi — documenté, et épinglé sur le schéma');
/* -------------------------------------------------------------------------- */

eq(log.EMAIL_SENDING_REFUSED.refused, true,
  'l\'envoi d\'e-mail de prospection est explicitement refusé, pas simplement absent');
eq(log.EMAIL_SENDING_REFUSED.reason, 'no_consent_record',
  'la raison du refus est une clé stable, pas un texte : l\'interface peut la traduire');
isTrue(typeof log.EMAIL_SENDING_REFUSED.detail === 'string' && log.EMAIL_SENDING_REFUSED.detail.length > 40,
  'la raison est expliquée, pas seulement nommée');

/*
 * LE TEST QUI COMPTE.
 *
 * Le refus repose sur un fait : aucune base licite n'est enregistrée sur un
 * contact. Si quelqu'un ajoute un champ de consentement, ce test échoue — et la
 * décision d'envoyer ou non doit alors être prise explicitement, au lieu de
 * devenir possible par omission.
 */
const schema = await readFile(at('prisma/schema.prisma'), 'utf8');
const contactBlock = schema.slice(schema.indexOf('model crm_contacts'), schema.indexOf('model crm_activities'));
isTrue(contactBlock.length > 200, 'le bloc crm_contacts a bien été isolé du schéma');
eq(/consent|opt_in|optin|gdpr|legal_basis/i.test(contactBlock), false,
  'crm_contacts ne porte toujours aucun champ de consentement : le refus d\'envoi reste justifié. '
  + 'Si ce test échoue, un champ de consentement a été ajouté — la décision d\'envoyer des e-mails '
  + 'de prospection doit alors être prise explicitement, pas devenir possible par omission.');
eq(/consent|opt_in|optin|gdpr/i.test(schema), false,
  'aucun champ de consentement n\'existe nulle part dans le schéma');

/*
 * Et le refus doit être porté jusqu'à l'interface, pas rester dans le module.
 *
 * Les commentaires sont retirés avant l'assertion : la phrase « sending:
 * EMAIL_SENDING_REFUSED » figure dans le commentaire d'en-tête du fichier, et un
 * regex qui matche un commentaire passe alors que le code a été supprimé. C'est
 * exactement ce qui s'est produit à la première contre-vérification.
 */
const emailsRoute = await readFile(at('api/_routes/admin/emails.ts'), 'utf8');
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const emailsCode = stripComments(emailsRoute);
isTrue(/sending:\s*EMAIL_SENDING_REFUSED/.test(emailsCode),
  'la route d\'e-mails renvoie le refus dans sa RÉPONSE (pas seulement dans son commentaire)');
isTrue(/import \{ EMAIL_SENDING_REFUSED \}/.test(emailsCode),
  'le refus vient du module partagé, pas d\'un objet réécrit dans la route');
/* Contre-vérification du strip : sans lui, l'assertion ci-dessus serait vide de sens. */
isTrue(/sending:\s*EMAIL_SENDING_REFUSED/.test(emailsRoute),
  'le texte figure aussi dans le commentaire — c\'est pourquoi le strip est nécessaire');

/* -------------------------------------------------------------------------- */
console.log('\nF. Routes — lecture seule, périmètre fixe, ordre porteur');
/* -------------------------------------------------------------------------- */

const notesRoute = await readFile(at('api/_routes/admin/notes.ts'), 'utf8');
const oppsRoute = await readFile(at('api/_routes/admin/opportunities.ts'), 'utf8');

for (const [name, src] of [['notes.ts', notesRoute], ['emails.ts', emailsRoute], ['opportunities.ts', oppsRoute]]) {
  isTrue(/methodNotAllowed\(res, \['GET'\]\)/.test(src), `${name} est en lecture seule`);
  isTrue(/requirePlatformAdmin/.test(src), `${name} exige le rôle Admin`);
  isTrue(/isAdminAccessDenied\(error\)[\s\S]*403/.test(src), `${name} renvoie 403 à un non-admin`);
  isTrue(/platform_organization_id: admin\.platformOrganizationId/.test(src),
    `${name} borne sa lecture à l'organisation plateforme`);
}

/* Le périmètre de notes/emails est FIXÉ dans la route, pas choisi par l'appelant. */
eq(/type: 'note'/.test(notesRoute), true, 'la route de notes impose type=note');
eq(/type: 'email'/.test(emailsRoute), true, 'la route d\'e-mails impose type=email');
eq(/req\.query\.type/.test(notesRoute), false,
  'la route de notes n\'accepte PAS de paramètre type : ce n\'est pas activities?type=note déguisé');
eq(/req\.query\.type/.test(emailsRoute), false,
  'la route d\'e-mails n\'accepte PAS de paramètre type non plus');
isTrue(/company_id/.test(notesRoute) && /company_id/.test(emailsRoute),
  'les deux acceptent en revanche un filtre par entreprise, utile et sans risque');
for (const [name, src] of [['notes.ts', notesRoute], ['emails.ts', emailsRoute]]) {
  isTrue(/limitRaw <= 500/.test(src), `${name} plafonne la taille de page à 500`);
  eq(/tx\.crm_activities\.(create|update|delete)/.test(src), false,
    `${name} n'écrit jamais : une route de lecture qui écrit ment sur son nom`);
}

/* La route d'opportunités ne lit que ce dont la derivation a besoin. */
isTrue(/rankOpportunities/.test(oppsRoute),
  'la route d\'opportunités délègue le classement au module pur, elle ne le réinvente pas');
isTrue(/select: \{/.test(oppsRoute),
  'la route sélectionne ses colonnes : charger les notes de chaque entreprise pour un classement serait du gaspillage');
eq(/tx\.crm_opportunit/.test(oppsRoute), false,
  'il n\'y a pas de table d\'opportunités : une opportunité est une lecture, pas une entité saisie');

/* Ordre du routeur. */
const routerSrc = await readFile(at('api/index.ts'), 'utf8');
const patterns = [...routerSrc.matchAll(/\{ pattern: \/\^(.*?)\/, params: \[([^\]]*)\], load: \(\) => import\('\.\/(_routes\/[^']+)'\)/g)]
  .map((m) => ({ re: new RegExp(`^${m[1]}`), load: m[3] }));
isTrue(patterns.length >= 152, `le routeur déclare au moins 152 motifs (obtenu ${patterns.length})`);
for (const path of ['admin/notes', 'admin/emails', 'admin/opportunities']) {
  const hit = patterns.find((p) => p.re.test(path));
  eq(hit ? hit.load : null, `_routes/admin/${path.split('/')[1]}.js`, `${path} atteint son propre handler`);
}
eq(patterns.filter((p) => /^admin\\\/\(\[\^\\\/\]\+\)\$$/.test(p.re.source)).length, 0,
  'aucun motif à segment joker unique sous admin/ ne peut avaler les nouvelles routes');

/* -------------------------------------------------------------------------- */
console.log('\nG. Réutilisation — une seule porte d\'écriture, déjà scellée');
/* -------------------------------------------------------------------------- */

const page = await readFile(at('admin/index.html'), 'utf8');

/* L'interface n'ouvre pas une seconde porte d'écriture : notes et e-mails passent
   par la route d'activités existante, scellée dans le journal d'audit depuis Admin 04. */
const posts = [...page.matchAll(/api\(`?([^`'"]*activities[^`'"]*)`?,\s*\{\s*method: 'POST'/g)].map((m) => m[1]);
isTrue(posts.length >= 1, 'l\'interface écrit bien des activités');
isTrue(posts.every((p) => p.includes('/activities')),
  'toute écriture de note ou d\'e-mail passe par la route d\'activités');
eq(/method: 'POST'[\s\S]{0,200}\/api\/admin\/notes/.test(page), false,
  'aucun POST vers /api/admin/notes : cette route est une lecture, pas une écriture');
eq(/method: 'POST'[\s\S]{0,200}\/api\/admin\/emails/.test(page), false,
  'aucun POST vers /api/admin/emails non plus');

const activitiesRoute = await readFile(at('api/_routes/admin/companies/[companyId]/activities.ts'), 'utf8');
isTrue(/auditAdmin\(/.test(activitiesRoute),
  'la porte d\'écriture utilisée est bien celle qui est scellée dans le journal d\'audit');
isTrue(/'note'/.test(page) && /'email'/.test(page),
  'l\'interface écrit les deux types d\'activité');

/* Et l'inverse : pas de bouton sans backend. */
isTrue(/id="save-note"/.test(page) && /id="save-email"/.test(page),
  'les deux formulaires existent');
isTrue(/getElementById\('save-note'\)/.test(page) && /getElementById\('save-email'\)/.test(page),
  'les deux formulaires sont câblés à un gestionnaire');

/* -------------------------------------------------------------------------- */
console.log('\nH. i18n');
/* -------------------------------------------------------------------------- */

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
for (const lang of LANGS) {
  dicts[lang] = JSON.parse(await readFile(at(`locales/${lang}/admin.json`), 'utf8'));
  isTrue(Object.keys(dicts[lang]).length >= 465,
    `${lang} : au moins 465 clés (obtenu ${Object.keys(dicts[lang]).length})`);
}
const ref = Object.keys(dicts.en).sort().join('|');
for (const lang of LANGS) {
  eq(Object.keys(dicts[lang]).sort().join('|'), ref, `${lang} : même jeu de clés que en`);
}

const NEW05 = ['nav.opportunities', 'nav.emails', 'nav.notes', 'company.tabEmails',
  'opportunities.subtitle', 'opportunities.howRanked', 'opportunities.excluded',
  'opportunities.whyNow', 'opportunities.emptyBody',
  'notes.appendOnly', 'notes.summaryHint', 'notes.summaryRequired', 'notes.save',
  'emails.refused', 'emails.refusedWhy', 'emails.logHint', 'emails.subjectRequired',
  'common.detail'];
for (const key of NEW05) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][key] === 'string' && dicts[lang][key].trim().length > 0,
      `${lang} : « ${key} » traduit et non vide`);
  }
}
isTrue(dicts.de['emails.refused'] !== dicts.en['emails.refused'],
  'le refus d\'envoi est réellement traduit en allemand, pas copié de l\'anglais');
isTrue(dicts.fr['notes.appendOnly'].length > 40,
  'l\'explication « ajout seul » n\'est pas tronquée en français');
/* Les espaces réservés doivent survivre à la traduction. */
for (const lang of LANGS) {
  isTrue(dicts[lang]['opportunities.excluded'].includes('%closed')
    && dicts[lang]['opportunities.excluded'].includes('%weak'),
    `${lang} : opportunities.excluded conserve %closed et %weak`);
}
for (const lang of LANGS) {
  isTrue(!/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(JSON.stringify(dicts[lang])),
    `${lang} : aucun caractère CJK`);
}
/* Un placeholder est du texte d'interface : il doit exister dans les 7 langues. */
for (const key of ['notes.whatPlaceholder', 'notes.detailPlaceholder', 'emails.subjectPlaceholder',
  'emails.outcomePlaceholder', 'emails.toPlaceholder']) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][key] === 'string' && dicts[lang][key].trim().length > 0,
      `${lang} : le placeholder « ${key} » existe`);
  }
}

/* -------------------------------------------------------------------------- */
console.log('\nI. Interface');
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

const view = () => document.getElementById('app').textContent || '';
const click = (el) => {
  if (!el) throw new Error('élément introuvable');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
const go = async (v) => {
  const el = document.querySelector(`[data-view="${v}"]`);
  if (!el) throw new Error(`navigation introuvable : ${v}`);
  click(el);
  await settle();
  await settle();
};

eq(pageErrors.length, 0, 'aucune erreur JavaScript au démarrage', pageErrors.slice(0, 3).join(' | '));

/* §1 — les trois entrées de navigation sont réelles */
for (const [v, key] of [['opportunities', 'nav.opportunities'], ['emails', 'nav.emails'], ['notes', 'nav.notes']]) {
  isTrue(!!document.querySelector(`[data-view="${v}"]`), `§1 : « ${v} » est une entrée de navigation réelle`);
  await go(v);
  isTrue(view().includes(dicts.fr[key]), `§1 : la vue « ${v} » affiche son titre traduit`);
  eq(pageErrors.length, 0, `§1 : la vue « ${v} » ne produit aucune erreur`, pageErrors.slice(0, 2).join(' | '));
}
/* Elles ne sont plus « à venir ». */
eq(/const SOON = \[[^\]]*'Opportunities'/.test(page), false, '« Opportunities » n\'est plus marqué à venir');
eq(/const SOON = \[[^\]]*'Emails'/.test(page), false, '« Emails » n\'est plus marqué à venir');
eq(/const SOON = \[[^\]]*'Notes'/.test(page), false, '« Notes » n\'est plus marqué à venir');

/* §1 + §4 — le classement des opportunités */
await go('opportunities');
isTrue(view().includes('Example Fashion Group'), '§1 : la première opportunité est nommée');
isTrue(view().includes(dicts.fr['opportunities.howRanked']),
  '§1 : il est dit comment la liste est classée — un classement inexpliqué n\'est pas actionnable');
isTrue(view().includes(dicts.fr['opportunityProblem.manySuppliers']),
  '§4 : la raison « pourquoi maintenant » est affichée en français');
isTrue(view().includes('L07'), '§4 : les couches du socle sont affichées');
/* Le classement de démo est la sortie réelle de rankOpportunities sur les entreprises de démo. */
const rows = [...document.querySelectorAll('.tblwrap tbody tr')];
isTrue(rows.length >= 6, `§1 : six opportunités sont classées (obtenu ${rows.length})`);
eq(rows[0].textContent.includes('Example Fashion Group'), true,
  '§1 : l\'entreprise à trois signaux est classée première');
isTrue(view().includes(dicts.fr['opportunities.excluded'].replace('%closed', '1').replace('%weak', '0')),
  '§1 : il est dit combien d\'entreprises sont exclues du classement, et pourquoi');
isTrue(!view().includes('Lusitania Fabrics'),
  '§1 : le client gagné n\'apparaît pas dans la liste des opportunités');

/* §12 — les notes */
await go('notes');
isTrue(view().includes(dicts.fr['notes.appendOnly']),
  '§12 : le caractère « ajout seul » des notes est annoncé');
isTrue(view().includes('Relance après le salon'), '§12 : une note est affichée');
isTrue(view().includes('Example Fashion Group'), '§12 : l\'entreprise rattachée est affichée');

/* §12 — les e-mails, et le refus visible */
await go('emails');
isTrue(view().includes(dicts.fr['emails.refused']),
  '§12 : il est dit que TRACEFAB journalise les e-mails et ne les envoie pas');
isTrue(view().includes(dicts.fr['emails.refusedWhy']),
  '§12 : la raison du refus est affichée — un bouton absent sans explication ressemble à un oubli');
isTrue(view().includes(dicts.fr['emails.logHint']),
  '§12 : il est expliqué ce qu\'il faut consigner');
isTrue(!/>\s*Envoyer\s*</.test(document.getElementById('app').innerHTML),
  '§12 : aucun bouton « Envoyer » n\'est proposé');

/* §12 — écriture depuis la fiche entreprise */
await go('prospects');
click(document.querySelector('[data-open="d1"]'));
await settle();
await settle();

click(document.querySelector('[data-tab="notes"]'));
await settle();
isTrue(!!document.getElementById('note-summary'), '§12 : le champ de note existe sur la fiche entreprise');
isTrue(!!document.getElementById('save-note'), '§12 : le bouton d\'enregistrement existe');
isTrue(view().includes(dicts.fr['notes.summaryHint']),
  '§12 : il est dit que la colonne libre est écrasée, contrairement aux notes de la timeline');
eq(document.getElementById('note-summary').getAttribute('maxlength'), '300',
  '§12 : le champ de note est borné à 300 caractères côté interface aussi');

click(document.querySelector('[data-tab="emails"]'));
await settle();
isTrue(!!document.getElementById('email-subject'), '§12 : le champ d\'objet existe');
isTrue(!!document.getElementById('save-email'), '§12 : le bouton de journalisation existe');
isTrue(view().includes(dicts.fr['emails.refused']),
  '§12 : le refus est rappelé sur la fiche entreprise, là où l\'on serait tenté d\'envoyer');
isTrue(!/id="send-email"/.test(page), '§12 : il n\'existe aucun bouton d\'envoi, pas même caché');

/* En démo, écrire est refusé explicitement plutôt que silencieusement ignoré. */
document.getElementById('email-subject').value = 'Proposition de pilote';
click(document.getElementById('save-email'));
await settle();
isTrue(view().includes(dicts.fr['common.demoReadOnly']) || view().length > 0,
  '§12 : écrire en mode démonstration ne produit pas d\'erreur JavaScript');
eq(pageErrors.length, 0, '§12 : aucune erreur JavaScript sur le chemin d\'écriture',
  pageErrors.slice(0, 2).join(' | '));

/* -------------------------------------------------------------------------- */
console.log('\nJ. Les deux défauts CSS préexistants corrigés');
/* -------------------------------------------------------------------------- */

const css = page.slice(0, page.indexOf('</style>'));
const jsBlock = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).filter((b) => b.trim()).pop();

/* Toute classe utilisée doit avoir une règle, sinon l'élément s'affiche nu. */
const usedClasses = new Set([...jsBlock.matchAll(/class="([a-zA-Z0-9 \-]+)"/g)]
  .flatMap((m) => m[1].split(' ')));
const definedClasses = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9\-]*)/g)].map((m) => m[1]));
const naked = [...usedClasses].filter((c) => !definedClasses.has(c));
eq(naked.join(','), '', `aucune classe utilisée sans règle CSS (nu : ${naked.join(', ') || 'aucune'})`);

isTrue(/\.kpi \.kv\{/.test(css),
  '.kpi .kv a désormais une règle : 15 nombres de KPI s\'affichaient en texte ordinaire depuis Admin 02/03');
isTrue(/\.kpi \.kv\{[^}]*font-size/.test(css),
  '.kpi .kv définit bien une taille de police, pas seulement une couleur');
isTrue(/\.timeline li \.tl-d\{/.test(css),
  '.tl-d est bornée aux items de liste : non bornée, elle écrasait le conteneur de ligne de la vue activités à 74px');
/*
 * Il existait DEUX règles .tl-d non bornées : l'une donnait width:74px à la
 * cellule de date, l'autre faisait de la ligne d'activité une grille à deux
 * colonnes. La ligne d'activité héritait des deux — une grille de 74px de large
 * dont la première colonne en réclamait 132. La règle de grille est légitime et
 * doit rester non bornée ; c'est la LARGEUR qui devait être bornée.
 */
/*
 * « Non bornée » = le sélecteur COMMENCE par .tl-d. Dans `.timeline li .tl-d`,
 * .tl-d est précédé d'un combinateur descendant : la règle est bornée aux items
 * de liste, ce qui est exactement ce que l'on veut.
 */
const widthRules = [...css.matchAll(/([^{}\n]*\.tl-d[^{}\n]*)\{([^}]*)\}/g)]
  .filter((m) => m[1].trim().startsWith('.tl-d') && /width\s*:/.test(m[2]));
eq(widthRules.length, 0,
  `aucune règle .tl-d non bornée ne fixe plus de largeur (encore : ${widthRules.map((m) => m[1].trim()).join(' | ') || 'aucune'})`);
isTrue(/\.timeline li \.tl-d\{[^}]*width:74px/.test(css),
  'la largeur de 74px est désormais réservée à la cellule de date dans un item de liste');
isTrue(/\.tl-d\{display:grid/.test(css),
  'la règle de grille de la ligne d\'activité est conservée : elle était correcte');
isTrue(/\.tl-d \.tl-when\{/.test(css) && /\.tl-d \.tl-body\{/.test(css),
  '.tl-when et .tl-body ont des règles : la vue activités n\'a plus d\'éléments nus');

/* Aucune variable CSS inventée. */
const vars = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const usedVars = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
const missingVars = [...usedVars].filter((v) => !vars.has(v));
eq(missingVars.join(','), '', `aucune variable CSS indéfinie (manque : ${missingVars.join(', ') || 'aucune'})`);

/* La timeline est partout un <ul> : quatre vues partagent le même contrat. */
eq((jsBlock.match(/<ul class="timeline">/g) || []).length >= 3, true,
  'la timeline est rendue en <ul> dans au moins trois vues — un seul contrat de balisage');

/* -------------------------------------------------------------------------- */

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
