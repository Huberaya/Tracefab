#!/usr/bin/env node
/**
 * CHANTIER ADMIN 01 — console Admin : autorisation, CRM, isolation, routes, i18n.
 *
 * Ce test exécute les modules RÉELS compilés (`api/_lib/admin-access.ts`,
 * `api/_lib/crm.ts`) : il ne réimplémente pas leur logique.
 *
 *   A. le modèle d'autorisation Admin — qui entre, qui n'entre pas ;
 *   B. la logique CRM pure — funnel, validation, transitions ;
 *   C. l'isolation en base — RLS forcée, ancrage `platform`, journal append-only ;
 *   D. les routes — enregistrées, fichiers présents, ordre porteur ;
 *   E. l'interface — aucun libellé codé en dur, dictionnaires complets.
 *
 *   npm run test:admin:chantier01
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });

/* -------------------------------------------------------------------------- */
console.log('\nA. Compilation et exécution des modules réels');
/* -------------------------------------------------------------------------- */

await mkdir(at('.cache'), { recursive: true });
const outDir = await mkdtemp(at('.cache/admin01-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/crm-access.ts', 'api/_lib/crm.ts', '--outDir', outDir, '--target', 'ES2020',
    '--module', 'ESNext', '--moduleResolution', 'bundler', '--skipLibCheck',
    '--esModuleInterop', '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('crm-access.ts et crm.ts compilent');
} catch (e) {
  bad('crm-access.ts et crm.ts ne compilent pas', e.message.slice(0, 400));
}

/*
 * crm-access.ts n'importe rien : la règle d'autorisation s'exécute ici sans client
 * Prisma généré ni jeton Clerk. C'est précisément pourquoi elle a été isolée.
 */
const access = await import(pathToFileURL(join(outDir, 'crm-access.js')).href);
const crm = await import(pathToFileURL(join(outDir, 'crm.js')).href);

/* -------------------------------------------------------------------------- */
console.log('\nB. Qui a accès à la console Admin');
/* -------------------------------------------------------------------------- */

const org = (type, status = 'active') => ({ id: 'org-1', type, legal_name: 'X', display_name: null, status });
const mem = (role, organization, status = 'active') => ({ organization_id: organization.id, role, status, organizations: organization });

eq(access.selectPlatformAdminAccess([]), null, 'aucun membership → aucun accès');
eq(
  access.selectPlatformAdminAccess([mem('owner', org('brand'))]),
  null,
  'un owner d\'organisation BRAND n\'a pas accès — c\'est le cœur de la séparation',
);
eq(
  access.selectPlatformAdminAccess([mem('owner', org('supplier'))]),
  null,
  'un owner d\'organisation SUPPLIER n\'a pas accès',
);
eq(
  access.selectPlatformAdminAccess([mem('viewer', org('platform'))]),
  null,
  'un viewer de la plateforme n\'a pas accès',
);
eq(
  access.selectPlatformAdminAccess([mem('auditor', org('platform'))]),
  null,
  'un auditor de la plateforme n\'a pas accès',
);
eq(
  access.selectPlatformAdminAccess([mem('admin', org('platform'))])?.role,
  'admin',
  'un admin de la plateforme a accès',
);
eq(
  access.selectPlatformAdminAccess([mem('owner', org('platform'))])?.role,
  'owner',
  'un owner de la plateforme a accès',
);
eq(
  access.selectPlatformAdminAccess([mem('admin', org('platform')), mem('owner', org('platform'))])?.role,
  'owner',
  'owner l\'emporte sur admin',
);
eq(
  access.selectPlatformAdminAccess([mem('owner', org('platform'), 'invited')]),
  null,
  'un membership non actif ne donne pas accès',
);
eq(
  access.selectPlatformAdminAccess([mem('owner', org('platform', 'suspended'))]),
  null,
  'une organisation platform suspendue ne donne pas accès',
);
eq(
  access.selectPlatformAdminAccess([
    mem('owner', org('brand')),
    mem('admin', org('platform')),
  ])?.role,
  'admin',
  'un rôle brand à côté d\'un rôle platform ne change rien : seul platform compte',
);

/* -------------------------------------------------------------------------- */
console.log('\nC. Funnel : les compteurs sont cohérents entre eux');
/* -------------------------------------------------------------------------- */

const rows = [
  { stage: 'new' }, { stage: 'new' },
  { stage: 'qualified' }, { stage: 'to_contact' },
  { stage: 'contacted' },
  { stage: 'replied' },
  { stage: 'meeting' },
  { stage: 'demo' },
  { stage: 'pilot' },
  { stage: 'customer', estimated_value_eur: 5000 },
  { stage: 'lost' },
];
const d = crm.computeDashboard(rows);

eq(d.totalProspects, 11, '11 enregistrements au total');
eq(d.newProspects, 2, '2 nouveaux');
eq(d.toContact, 2, '2 à contacter (qualified + to_contact)');
eq(d.contacted, 6, '6 contactés — une démo implique d\'avoir été contacté');
eq(d.replies, 5, '5 réponses');
eq(d.meetings, 4, '4 rendez-vous');
eq(d.demos, 3, '3 démos');
eq(d.pilots, 2, '2 pilotes');
eq(d.customers, 1, '1 client');
eq(d.lost, 1, '1 perdu');

check(() => {
  const seq = [d.contacted, d.replies, d.meetings, d.demos, d.pilots, d.customers];
  for (let i = 1; i < seq.length; i += 1) {
    if (seq[i] > seq[i - 1]) throw new Error(`non monotone en position ${i}`);
  }
}, 'le funnel est monotone : chaque étape compte moins que la précédente');

eq(d.estimatedValueEur, 5000, 'la valeur estimée somme les lignes qui en portent une');
eq(d.conversionRate, 50, '1 gagné sur 2 tranchés → 50 %');

/* Aucune opportunité tranchée : la conversion n'est pas 0 %, elle n'est pas mesurée. */
eq(crm.computeDashboard([{ stage: 'new' }]).conversionRate, null,
  'rien de tranché → conversionRate null, pas 0');
eq(crm.computeDashboard([]).totalProspects, 0, 'base vide → 0 prospect');
eq(crm.computeDashboard([]).estimatedValueEur, 0, 'base vide → valeur 0');

const today = new Date('2026-10-08T12:00:00Z');
const due = crm.computeDashboard([
  { stage: 'contacted', next_contact_at: '2026-10-08T09:00:00Z' },
  { stage: 'customer', next_contact_at: '2026-10-08T09:00:00Z' },
  { stage: 'lost', next_contact_at: '2026-10-08T09:00:00Z' },
  { stage: 'new', next_contact_at: '2026-10-09T09:00:00Z' },
], today);
eq(due.dueToday, 1, 'un client et un perdu ne sont pas « à traiter aujourd\'hui »');

eq(Object.keys(d.byCountry).length, 1, 'les pays non renseignés tombent dans « unknown », pas dans l\'oubli');

/* -------------------------------------------------------------------------- */
console.log('\nD. Validation des saisies');
/* -------------------------------------------------------------------------- */

eq(crm.parseCompanyInput({ name: 'Acme' }).errors.length, 0, 'un nom suffit à créer une entreprise');
eq(crm.parseCompanyInput({}).errors[0], 'name_required', 'le nom est obligatoire');
eq(crm.parseCompanyInput({ name: '  ' }).errors[0], 'name_required', 'un nom vide est refusé');
check(() => {
  const r = crm.parseCompanyInput({ name: 'A', country_code: 'France' });
  if (!r.errors.includes('country_code_must_be_iso_3166_alpha2')) throw new Error(r.errors.join(','));
}, 'un pays en toutes lettres est refusé — sinon les stats par pays sont inutilisables');
eq(crm.parseCompanyInput({ name: 'A', country_code: 'fr' }).data.country_code, 'FR', 'le code pays est normalisé en majuscules');
check(() => {
  const r = crm.parseCompanyInput({ name: 'A', product_count: -3 });
  if (!r.errors.includes('product_count_must_be_a_non_negative_integer')) throw new Error(r.errors.join(','));
}, 'un nombre de produits négatif est refusé');
eq(crm.parseCompanyInput({ name: 'A' }).data.product_count, undefined,
  'un produit non renseigné reste absent — pas 0');
check(() => {
  const r = crm.parseCompanyInput({ name: 'A', stage: 'lost' });
  if (!r.errors.includes('lost_reason_required')) throw new Error(r.errors.join(','));
}, 'perdre un prospect sans raison est refusé');
eq(crm.parseCompanyInput({ name: 'A', stage: 'lost', lost_reason: 'Budget gelé' }).errors.length, 0,
  'une perte motivée est acceptée');
check(() => {
  const r = crm.parseCompanyInput({ name: 'A', stage: 'nonsense' });
  if (!r.errors.includes('stage_unknown')) throw new Error(r.errors.join(','));
}, 'une étape inconnue est refusée');
check(() => {
  const r = crm.parseCompanyInput({ name: 'A', next_contact_at: 'demain' });
  if (!r.errors.includes('next_contact_at_must_be_a_date')) throw new Error(r.errors.join(','));
}, 'une date invalide est refusée');

eq(crm.parseContactInput({ first_name: 'Ada' }).errors.length, 0, 'un prénom suffit pour un contact');
eq(crm.parseContactInput({}).errors[0], 'first_name_or_last_name_required', 'un contact sans nom est refusé');
check(() => {
  const r = crm.parseContactInput({ first_name: 'A', email: 'pas-un-email' });
  if (!r.errors.includes('email_invalid')) throw new Error(r.errors.join(','));
}, 'un email malformé est refusé');
eq(crm.parseContactInput({ first_name: 'A', email: 'Ada@Example.COM' }).data.email, 'ada@example.com',
  'l\'email est normalisé en minuscules — sinon les doublons passent');
check(() => {
  const r = crm.parseContactInput({ first_name: 'A', influence_level: 9 });
  if (!r.errors.includes('influence_level_must_be_between_0_and_5')) throw new Error(r.errors.join(','));
}, 'une influence hors bornes est refusée');

/* -------------------------------------------------------------------------- */
console.log('\nE. Transitions du pipeline');
/* -------------------------------------------------------------------------- */

eq(crm.canTransition('new', 'contacted', false).ok, true, 'avancer est permis');
eq(crm.canTransition('demo', 'new', false).ok, true, 'reculer est permis — un rendez-vous peut tomber à l\'eau');
eq(crm.canTransition('new', 'new', false).activity, null, 'rester sur place ne journalise rien');
eq(crm.canTransition('new', 'lost', false).ok, false, 'perdre sans raison est refusé');
eq(crm.canTransition('new', 'lost', true).activity, 'lost', 'perdre avec raison journalise « lost »');
eq(crm.canTransition('demo', 'customer', false).activity, 'conversion', 'gagner un client journalise « conversion »');
eq(crm.canTransition('demo', 'replied', false).activity, 'status_change', 'un mouvement ordinaire journalise « status_change »');
eq(crm.stageRank('lost'), -1, 'un perdu est classé avant toute étape du funnel');
eq(crm.stageRank('customer') > crm.stageRank('new'), true, 'client est plus avancé que nouveau');

/* -------------------------------------------------------------------------- */
console.log('\nF. Isolation en base : rien ne fuit vers les marques ou les fournisseurs');
/* -------------------------------------------------------------------------- */

const schema = await readFile(at('prisma/schema.prisma'), 'utf8');
const migration = await readFile(
  at('prisma/migrations/20261008120000_admin_command_center_crm/migration.sql'), 'utf8');

for (const table of ['crm_companies', 'crm_contacts', 'crm_activities']) {
  check(() => {
    if (!new RegExp(`model ${table} \\{`).test(schema)) throw new Error('absent du schéma');
  }, `${table} est déclaré dans le schéma Prisma`);
  check(() => {
    if (!migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) throw new Error('absent');
  }, `${table} est créé par la migration`);
  /* Tolérant aux espaces d'alignement : la migration aligne ses colonnes. */
  check(() => {
    if (!new RegExp(`ALTER TABLE ${table} +ENABLE ROW LEVEL SECURITY`).test(migration)) throw new Error('RLS absente');
  }, `${table} active la RLS`);
  check(() => {
    if (!new RegExp(`ALTER TABLE ${table} +FORCE ROW LEVEL SECURITY`).test(migration)) throw new Error('FORCE absent');
  }, `${table} FORCE la RLS — le propriétaire de la table y est soumis aussi`);
}

/* Chaque politique doit exiger l'appartenance à une organisation platform. */
const policies = migration.match(/CREATE POLICY (\w+)[\s\S]*?(?=\nDROP POLICY|\nCREATE POLICY|\n-- |$)/g) || [];
const unguarded = policies.filter((p) => !p.includes('tracefab_is_platform_org') && !/FOR INSERT[\s\S]*tracefab_is_platform_org/.test(p));
eq(unguarded.length, 0, `les ${policies.length} politiques exigent toutes tracefab_is_platform_org`,
  unguarded.map((p) => /CREATE POLICY (\w+)/.exec(p)?.[1]).join(', '));

check(() => {
  const fn = /CREATE OR REPLACE FUNCTION tracefab_is_platform_org[\s\S]*?\$\$;/.exec(migration)?.[0] || '';
  if (!fn.includes("o.type = 'platform'")) throw new Error("le type 'platform' n'est pas exigé");
  if (!fn.includes("o.status = 'active'")) throw new Error("le statut 'active' n'est pas exigé");
}, 'tracefab_is_platform_org exige type = platform ET status = active');

check(() => {
  if (!migration.includes('REVOKE UPDATE, DELETE ON crm_activities')) throw new Error('REVOKE absent');
}, 'crm_activities est en append-only : REVOKE UPDATE, DELETE');

check(() => {
  if (!migration.includes('CONSTRAINT crm_companies_org_name_key UNIQUE (platform_organization_id, name)')) throw new Error('contrainte absente');
}, 'unicité (organisation, nom) — un doublon de prospection est bloqué en base, pas seulement en interface');

check(() => {
  if (!migration.includes("CONSTRAINT crm_companies_lost_requires_reason CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)")) throw new Error('contrainte absente');
}, 'une perte sans raison est refusée par la base elle-même');

for (const table of ['crm_contacts', 'crm_activities']) {
  check(() => {
    if (!migration.includes(`${table}_platform_match`)) throw new Error('trigger absent');
  }, `${table} vérifie que sa ligne appartient à la même organisation que son entreprise`);
}

check(() => {
  if (!/platform_organization_id\s+String\s+@db\.Uuid/.test(schema)) throw new Error('colonne absente du schéma');
}, 'chaque table CRM porte platform_organization_id, ancre de la RLS');

/* -------------------------------------------------------------------------- */
console.log('\nG. Les routes sont enregistrées et l\'ordre est porteur');
/* -------------------------------------------------------------------------- */

const router = await readFile(at('api/index.ts'), 'utf8');
const guardSource = await readFile(at('api/_lib/crm-access.ts'), 'utf8');
const ROUTES = [
  ['admin/access', 'api/_routes/admin/access.ts'],
  ['admin/dashboard', 'api/_routes/admin/dashboard.ts'],
  ['admin/companies', 'api/_routes/admin/companies.ts'],
  ['admin/companies/[id]/activities', 'api/_routes/admin/companies/[companyId]/activities.ts'],
  ['admin/companies/[id]/stage', 'api/_routes/admin/companies/[companyId]/stage.ts'],
  ['admin/companies/[id]', 'api/_routes/admin/companies/[companyId].ts'],
  ['admin/contacts', 'api/_routes/admin/contacts.ts'],
  ['admin/contacts/[id]', 'api/_routes/admin/contacts/[contactId].ts'],
];
for (const [, file] of ROUTES) {
  check(() => {
    if (!existsSync(at(file))) throw new Error('fichier absent');
  }, `${file} existe`);
}
check(() => {
  /* Le routeur importe en chemin relatif (« ./_routes/... »), pas depuis api/. */
  const missing = ROUTES.filter(([, f]) => !router.includes(`./${f.replace(/^api\//, '').replace('.ts', '.js')}`));
  if (missing.length) throw new Error(missing.map((m) => m[1]).join(', '));
}, `les ${ROUTES.length} gestionnaires sont enregistrés dans le routeur`);

check(() => {
  const lines = router.split('\n');
  const idx = (needle) => lines.findIndex((l) => l.includes(needle));
  /* Dans le source, les barres des motifs sont échappées : admin\\/companies\\/… */
  const activities = idx('admin\\/companies\\/([^\\/]+)\\/activities');
  const stage = idx('admin\\/companies\\/([^\\/]+)\\/stage');
  const detail = lines.findIndex((l) => l.includes('admin\\/companies\\/([^\\/]+)$'));
  if (!(activities < detail && stage < detail)) {
    throw new Error(`activities=${activities} stage=${stage} detail=${detail}`);
  }
}, 'activities et stage précèdent companies/:id — sinon ce motif avale les deux');

check(() => {
  const guard = guardSource;
  if (!guard.includes("membership.organizations.type !== 'platform'")) throw new Error('contrôle absent');
  if (!guard.includes("ADMIN_ROLES.includes(role)")) throw new Error('contrôle de rôle absent');
}, 'la règle applicative exige les deux conditions, comme la RLS');

/* -------------------------------------------------------------------------- */
console.log('\nH. Interface : aucun libellé codé en dur, dictionnaires complets');
/* -------------------------------------------------------------------------- */

const html = await readFile(at('admin/index.html'), 'utf8');

check(() => {
  if (!html.includes('TracefabI18n.init({ scope: \'admin\'')) throw new Error('init absent');
  if (!html.includes('/i18n-core.js')) throw new Error('runtime absent');
}, 'la console charge le runtime i18n avec le scope « admin »');

check(() => {
  if (!html.includes("TracefabI18n ? window.TracefabI18n.t(key) : null")) throw new Error('shim absent');
}, 'une clé manquante renvoie la clé, jamais un blanc');

/* Libellés français codés en dur dans le rendu : le contenu métier doit venir des dictionnaires. */
const rendered = html.slice(html.indexOf('function shell()'));
const hardcoded = (rendered.match(/[\u00e0\u00e2\u00e7\u00e9\u00e8\u00ea\u00eb\u00ee\u00f4\u00f9\u00fb][a-zà-ÿ]{2,}/g) || [])
  .filter((w) => !/d[eé]monstration/i.test(w));
eq(hardcoded.length, 0, 'aucun libellé français codé en dur dans le rendu',
  [...new Set(hardcoded)].slice(0, 5).join(', '));

check(() => {
  if (!html.includes('common.demoBanner')) throw new Error('bandeau absent');
  if (!/state\.demo \?[\s\S]{0,220}demoBanner/.test(html)) throw new Error('bandeau non conditionnel');
}, 'le mode démonstration est signalé en permanence par un bandeau');

check(() => {
  if (!html.includes('common.notMeasured')) throw new Error('absent');
}, 'une mesure absente s\'affiche « non mesuré »');

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
for (const lang of LANGS) {
  dicts[lang] = JSON.parse(await readFile(at(`locales/${lang}/admin.json`), 'utf8'));
}
const keySets = LANGS.map((l) => Object.keys(dicts[l]).sort().join('|'));
check(() => {
  const distinct = new Set(keySets);
  if (distinct.size !== 1) throw new Error(`${distinct.size} jeux de clés différents`);
}, `les ${LANGS.length} dictionnaires admin.json portent exactement les mêmes clés (${Object.keys(dicts.en).length})`);

const untranslated = [];
for (const lang of LANGS.filter((l) => l !== 'en')) {
  for (const key of Object.keys(dicts.en)) {
    if (dicts[lang][key] === dicts.en[key] && /[a-z]/i.test(dicts.en[key]) && dicts.en[key].split(' ').length > 1) {
      untranslated.push(`${lang}:${key}`);
    }
  }
}
eq(untranslated.length, 0, 'aucune entrée multilingue laissée en anglais', untranslated.slice(0, 4).join(', '));

/* -------------------------------------------------------------------------- */
console.log('\nI. vercel.json sert la surface');
/* -------------------------------------------------------------------------- */

const vercel = JSON.parse(await readFile(at('vercel.json'), 'utf8'));
check(() => {
  const route = vercel.routes.find((r) => r.dest === '/admin/index.html');
  if (!route) throw new Error('aucune route');
  if (route.src !== '/admin(?:/)?') throw new Error(`src inattendu : ${route.src}`);
}, 'une route sert /admin');

await rm(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
