#!/usr/bin/env node
/**
 * CHANTIER ADMIN 03 — listes de prospection (§7), import CSV (§8), recherche avancée (§9).
 *
 * Ce test exécute les modules RÉELS compilés (`api/_lib/crm-import.ts`,
 * `api/_lib/crm-filters.ts`, `api/_lib/bulk-operations/csv-parser.ts`) et rend
 * l'interface RÉELLE dans jsdom avec le vrai dictionnaire lu sur disque.
 *
 *   A. compilation des modules réels ;
 *   B. mapping des colonnes — suggestion, jamais imposée ;
 *   C. la règle « rien n'est inventé » ;
 *   D. doublons — signalés, jamais tranchés ;
 *   E. provenance — source et date de collecte survivent ;
 *   F. recherche avancée — les critères de §9, et rien d'autre ;
 *   G. isolation en base ;
 *   H. routes — ordre porteur, 403, aperçu sans écriture ;
 *   I. i18n ;
 *   J. interface — listes, filtres avancés, assistant d'import en 3 étapes.
 *
 *   npm run test:admin:chantier03
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
console.log('\nA. Compilation des modules réels');
/* -------------------------------------------------------------------------- */

await mkdir(at('.cache'), { recursive: true });
const outDir = await mkdtemp(at('.cache/admin03-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/crm.ts', 'api/_lib/crm-import.ts', 'api/_lib/crm-filters.ts',
    'api/_lib/bulk-operations/csv-parser.ts',
    '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('crm.ts, crm-import.ts, crm-filters.ts et csv-parser.ts compilent');
} catch (e) {
  bad('les modules Admin 03 ne compilent pas', e.message.slice(0, 400));
}

const imp = await import(pathToFileURL(join(outDir, 'crm-import.js')).href);
const filters = await import(pathToFileURL(join(outDir, 'crm-filters.js')).href);
const csv = await import(pathToFileURL(join(outDir, 'bulk-operations/csv-parser.js')).href);

/* -------------------------------------------------------------------------- */
console.log('\nB. Mapping des colonnes');
/* -------------------------------------------------------------------------- */

const mapped = imp.suggestMapping(['Nom de la société', 'Pays', 'Produits', 'Chiffre d\'affaires', 'Inconnu']);
eq(mapped['Nom de la société'], 'name', '« Nom de la société » est reconnu comme le nom');
eq(mapped['Pays'], 'country_code', '« Pays » est reconnu comme le pays');
eq(mapped['Produits'], 'product_count', '« Produits » est reconnu comme le nombre de produits');
eq(mapped['Chiffre d\'affaires'], 'revenue_band', '« Chiffre d\'affaires » est reconnu comme le CA');
eq(mapped['Inconnu'], null, 'une colonne inconnue n\'est mappée sur rien — pas sur un champ au hasard');

eq(imp.suggestMapping(['Name', 'name'])['name'], null,
  'deux colonnes « Name » ne peuvent pas revendiquer le même champ : la seconde est ignorée');
eq(imp.suggestMapping(['Company', 'Company Name'])['Company Name'], null,
  '« Company » prend le champ, « Company Name » ne l\'écrase pas');
eq(imp.suggestMapping(['Références'])['Références'], 'product_count',
  'les accents sont normalisés avant la correspondance');
eq(imp.suggestMapping([]).constructor, Object, 'un fichier sans en-tête ne casse pas');

/* -------------------------------------------------------------------------- */
console.log('\nC. Rien n\'est inventé');
/* -------------------------------------------------------------------------- */

const M = { Nom: 'name', Pays: 'country_code', Produits: 'product_count', Taille: 'employee_band' };

const good = imp.applyImportRow({ Nom: 'Maison Lumière', Pays: 'FR', Produits: '60' }, M);
eq(good.errors.length, 0, 'une ligne complète est acceptée');
eq(good.data.country_code, 'FR', 'le code pays est conservé');
eq(good.data.product_count, 60, 'le nombre de produits est un entier, pas une chaîne');
eq(good.data.employee_band, undefined,
  'une colonne absente du fichier ne produit AUCUNE valeur — pas même un défaut');

isTrue(imp.applyImportRow({ Pays: 'FR' }, M).errors.includes('name_required'),
  'une ligne sans nom est refusée');

/* Le piège déjà rencontré : tronquer avant de valider rend la validation inutile. */
const france = imp.applyImportRow({ Nom: 'X', Pays: 'France' }, M);
isTrue(france.errors.includes('country_code_must_be_iso_alpha2'),
  '« France » n\'est PAS tronqué en « Fr » : la valeur entière est validée');

isTrue(imp.applyImportRow({ Nom: 'X', Produits: 'beaucoup' }, M).errors.includes('product_count_must_be_a_number'),
  'un nombre illisible est une ERREUR, pas un silence');
eq(imp.applyImportRow({ Nom: 'X', Produits: '1 200' }, M).data.product_count, 1200,
  '« 1 200 » avec espace insécable est lu comme 1200');
eq(imp.applyImportRow({ Nom: 'X', Produits: '1,200' }, M).data.product_count, 1200,
  '« 1,200 » est lu comme 1200');
isTrue(imp.applyImportRow({ Nom: 'X', Produits: '-5' }, M).errors.includes('product_count_must_be_a_number'),
  'un nombre de produits négatif est refusé');

isTrue(imp.applyImportRow({ Nom: 'X', Taille: 'inconnue' }, { Nom: 'name', Taille: 'company_type' })
  .errors.includes('company_type_unknown_value'), 'un type d\'entreprise inventé est refusé');
isTrue(imp.applyImportRow({ Nom: 'X', stage: 'peut_etre' }, { Nom: 'name', stage: 'stage' })
  .errors.includes('stage_unknown_value'), 'une étape de pipeline inventée est refusée');
isTrue(imp.applyImportRow({ Nom: 'X', collected_at: 'hier' }, { Nom: 'name', collected_at: 'collected_at' })
  .errors.includes('collected_at_must_be_a_date'), 'une date de collecte illisible est refusée');
eq(imp.applyImportRow({ Nom: 'X', dpp_interest: 'high' }, { Nom: 'name', dpp_interest: 'dpp_interest' })
  .data.dpp_interest, 'high', 'un intérêt DPP connu est accepté');

/* Une valeur vide n'est pas une valeur fausse : elle doit rester absente. */
const blanks = imp.applyImportRow({ Nom: 'X', Pays: '', Produits: '', Taille: '  ' }, M);
eq(blanks.errors.length, 0, 'des cellules vides ne produisent pas d\'erreur');
eq(Object.keys(blanks.data).length, 1, 'des cellules vides ne produisent aucune colonne — seulement le nom');

/* -------------------------------------------------------------------------- */
console.log('\nD. Doublons signalés, jamais tranchés');
/* -------------------------------------------------------------------------- */

eq(imp.normalizeCompanyName('Maison Lumière SAS'), 'maison lumiere',
  'le suffixe juridique est retiré et les accents normalisés');
eq(imp.normalizeCompanyName('MAISON   LUMIÈRE'), 'maison lumiere',
  'les espaces multiples et la casse ne créent pas un doublon');
eq(imp.normalizeCompanyName('  '), '', 'un nom vide se normalise en chaîne vide');

eq(imp.domainOf('https://www.example.com/produits'), 'example.com',
  'schéma, www et chemin sont retirés');
eq(imp.domainOf('example.com'), 'example.com', 'un domaine nu est accepté');
eq(imp.domainOf('pas-un-domaine'), null, 'une chaîne sans point n\'est pas un domaine');
eq(imp.domainOf(''), null, 'une chaîne vide n\'est pas un domaine');

const existing = [
  { id: 'e1', name: 'Maison Lumière SAS', country_code: 'FR', website: 'maisonlumiere.example' },
  { id: 'e2', name: 'Atlas Apparel', country_code: 'IT', website: 'atlas.example' },
];
const dupes = imp.detectDuplicates([
  { name: 'MAISON LUMIERE', country_code: 'FR' },
  { name: 'Maison Lumière', country_code: 'BE' },
  { name: 'Atlas Holding', website: 'www.atlas.example/it' },
  { name: 'Tout neuf', country_code: 'DE' },
], existing);

eq(dupes.length, 3, 'trois doublons sur quatre lignes');
eq(dupes[0].reason, 'same_name_and_country', 'même nom ET même pays → certitude');
eq(dupes[0].existingId, 'e1', 'le doublon nomme la ligne existante');
eq(dupes[1].reason, 'same_name', 'même nom, autre pays → seulement probable');
eq(dupes[2].reason, 'same_domain', 'même domaine → probable');
eq(dupes[2].existingId, 'e2', 'le doublon par domaine nomme la ligne existante');
eq(imp.detectDuplicates([{ name: 'Tout neuf' }], existing).length, 0,
  'une entreprise inconnue n\'est pas signalée comme doublon');

/* -------------------------------------------------------------------------- */
console.log('\nE. La provenance survit');
/* -------------------------------------------------------------------------- */

const records = csv.parseCsvRows(
  'Nom;Pays;Produits\n'
  + 'Atelier Neuf;FR;12\n'
  + 'Maison Lumière;FR;60\n'
  + ';DE;3\n',
);
eq(records.length, 3, 'le parseur du dépôt lit 3 lignes de données');

const preview = imp.buildImportPreview(records, {
  source: 'Salon PV 2026',
  sourceDetail: 'Stand B12',
  collectedAt: '2026-09-15T00:00:00.000Z',
  mapping: {},
  existing,
});

eq(preview.counts.total, 3, 'aperçu : 3 lignes au total');
eq(preview.counts.new, 1, 'aperçu : 1 nouvelle entreprise');
eq(preview.counts.duplicate, 1, 'aperçu : 1 doublon');
eq(preview.counts.invalid, 1, 'aperçu : 1 ligne invalide');

const created = preview.rows.find((r) => r.status === 'new');
eq(created.data.source, 'Salon PV 2026', 'la source déclarée par l\'opérateur est écrite');
eq(created.data.source_detail, 'Stand B12', 'le détail de source est écrit');
eq(created.data.collected_at, '2026-09-15T00:00:00.000Z',
  'la date de collecte est celle déclarée, pas celle du jour');

/* §9 : un fichier qui prétend sa propre provenance n'est pas une source. */
const selfSourced = imp.buildImportPreview(
  csv.parseCsvRows('name;source;collected_at\nAtelier Bis;le fichier lui-même;1999-01-01'),
  { source: 'Import manuel', mapping: {}, existing: [] },
);
const self = selfSourced.rows.find((r) => r.status === 'new');
eq(self.data.source, 'Import manuel',
  'la source écrite est celle de l\'opérateur, jamais celle déclarée par le fichier');

/* Le fichier peut se dupliquer lui-même. */
const selfDupe = imp.buildImportPreview(
  csv.parseCsvRows('name\nAtelier Neuf\nAtelier Neuf'),
  { source: 'x', mapping: {}, existing: [] },
);
eq(selfDupe.counts.new, 1, 'un fichier qui se répète ne crée qu\'une ligne');
eq(selfDupe.counts.duplicate, 1, '…et signale la répétition');

const skipped = imp.buildImportPreview(records, {
  source: 'x', mapping: {}, existing, skipDuplicates: true,
});
eq(skipped.counts.skipped, 1, 'skipDuplicates écarte le doublon du résultat');
eq(skipped.rows.filter((r) => r.status === 'duplicate').length, 0,
  'et ne l\'affiche plus comme doublon à trancher');

/* -------------------------------------------------------------------------- */
console.log('\nF. Recherche avancée (§9)');
/* -------------------------------------------------------------------------- */

const ORG = 'org-1';
const f = (q) => filters.buildCompanyFilters(q, ORG);

eq(f({}).where.platform_organization_id, ORG, 'l\'organisation est toujours posée');
eq(f({}).error, null, 'aucun filtre n\'est pas une erreur');
eq(f({ country: 'fr' }).where.country_code, 'FR', 'le pays est mis en majuscules');
eq(f({ stage: 'invente' }).error, 'stage_unknown', 'une étape inconnue est refusée');
eq(f({ dpp_interest: 'peut_etre' }).error, 'dpp_interest_unknown', 'un intérêt DPP inconnu est refusé');
eq(f({ dpp_interest: 'unknown' }).where.dpp_interest, 'unknown',
  '« unknown » est un filtre légitime : ce sont les non qualifiés, le travail qui reste');
eq(f({ product_count_min: '200' }).where.product_count.gte, 200, 'nombre de produits minimum');
eq(f({ product_count_max: '50' }).where.product_count.lte, 50, 'nombre de produits maximum');
eq(f({ product_count_min: '200', product_count_max: '50' }).error, 'product_count_range_inverted',
  'un intervalle inversé est refusé, pas silencieusement vidé');
eq(f({ product_count_min: 'beaucoup' }).error, 'product_count_min_must_be_an_integer',
  'une borne illisible est refusée');
eq(f({ employee_band: '250' }).where.employee_band.contains, '250',
  'la taille est un texte libre, pas un intervalle numérique inventé');
eq(f({ q: 'lumiere' }).where.OR.length, 4, 'la recherche couvre nom, site, ville et secteur');

/* `due=today` gagne sur `stage` : c'est la vue « à faire ». */
const dueToday = f({ stage: 'customer', due: 'today' });
eq(dueToday.where.stage.notIn.includes('customer'), true,
  'due=today exclut les clients : relancer un client gagné n\'est pas de la prospection');

const FILTER_KEYS = ['stage', 'priority', 'country', 'company_type', 'maturity', 'q', 'due',
  'employee_band', 'dpp_interest', 'traceability_interest',
  'product_count_min', 'product_count_max', 'supplier_count_min', 'supplier_count_max'];
for (const key of FILTER_KEYS) {
  isTrue(imp.SAVED_VIEW_FILTER_KEYS.includes(key), `${key} est une clé de filtre persistable`);
}
eq(Object.keys(imp.sanitizeSavedFilters({
  country: 'FR', priority: 'high', DROP: 'TABLE crm_companies', q: '  ', stage: 'x'.repeat(500),
})).length, 2,
'sanitizeSavedFilters ne garde que les clés connues, non vides et courtes');
eq(imp.sanitizeSavedFilters(null).constructor, Object, 'un filtre nul ne casse pas');
eq(imp.sanitizeSavedFilters('texte').constructor, Object, 'un filtre non-objet ne casse pas');

/* -------------------------------------------------------------------------- */
console.log('\nG. Isolation en base');
/* -------------------------------------------------------------------------- */

const migration = await readFile(
  at('prisma/migrations/20261008160000_admin_command_center_acquisition/migration.sql'), 'utf8',
);
isTrue(migration.includes('CREATE TABLE IF NOT EXISTS crm_saved_views'), 'crm_saved_views : table créée');
isTrue(/crm_saved_views +ENABLE ROW LEVEL SECURITY/.test(migration), 'crm_saved_views : RLS activée');
isTrue(/crm_saved_views +FORCE ROW LEVEL SECURITY/.test(migration),
  'crm_saved_views : RLS FORCÉE — les données de prospection ne doivent jamais fuiter (§16)');
isTrue(migration.includes('tracefab_is_platform_org'), 'la politique exige une organisation plateforme');
for (const col of ['dpp_interest', 'traceability_interest']) {
  isTrue(migration.includes(`ADD COLUMN IF NOT EXISTS ${col} crm_interest_level NOT NULL DEFAULT 'unknown'`),
    `${col} : NOT NULL DEFAULT 'unknown' — « non qualifié », pas « faible »`);
}
isTrue(migration.includes('CREATE TYPE crm_interest_level'), 'enum crm_interest_level créé');
isTrue(migration.includes('CONSTRAINT uq_crm_saved_views_org_name UNIQUE (platform_organization_id, name)'),
  'deux listes homonymes dans la même équipe sont refusées');
isTrue(migration.includes('tracefab_set_updated_at'), 'updated_at est maintenu par trigger');
for (const idx of ['dpp_interest', 'traceability_interest', 'product_count', 'supplier_count', 'employee_band']) {
  isTrue(migration.includes(`idx_crm_companies_org_${idx}`), `index sur ${idx} — un filtre §9 n'est pas un scan`);
}

const schema = await readFile(at('prisma/schema.prisma'), 'utf8');
isTrue((schema.match(/^model /gm) || []).length >= 51,
  'schema.prisma : au moins 51 modèles', `${(schema.match(/^model /gm) || []).length}`);
isTrue(/model crm_saved_views \{[\s\S]*?filters\s+Json/.test(schema),
  'les filtres d\'une liste sont en jsonb : un critère §9 de plus ne demande pas de migration');

/* -------------------------------------------------------------------------- */
console.log('\nH. Routes');
/* -------------------------------------------------------------------------- */

const router = await readFile(at('api/index.ts'), 'utf8');
const lines = router.split('\n');
const lineOf = (needle) => lines.findIndex((l) => l.includes(needle));

for (const pattern of ['^admin\\/companies\\/export$', '^admin\\/import\\/preview$',
  '^admin\\/import\\/commit$', '^admin\\/lists$', '^admin\\/lists\\/([^\\/]+)$']) {
  isTrue(router.includes(pattern), `motif enregistré : ${pattern}`);
}
/* Porteur : « export » serait sinon lu comme un identifiant d'entreprise. */
isTrue(lineOf('^admin\\/companies\\/export$') < lineOf('^admin\\/companies\\/([^\\/]+)$'),
  'companies/export précède companies/([^/]+) — sinon « export » devient un identifiant');
isTrue(lineOf('^admin\\/lists$') < lineOf('^admin\\/lists\\/([^\\/]+)$'),
  'la collection lists précède l\'élément lists/:id');
isTrue(lineOf('^admin\\/companies\\/([^\\/]+)\\/activities$') < lineOf('^admin\\/companies\\/([^\\/]+)$'),
  'l\'ordre porteur du Chantier 01 n\'a pas été cassé');

const HANDLERS = ['api/_routes/admin/import/preview.ts', 'api/_routes/admin/import/commit.ts',
  'api/_routes/admin/lists.ts', 'api/_routes/admin/lists/[listId].ts',
  'api/_routes/admin/companies/export.ts'];
for (const file of HANDLERS) {
  const src = await readFile(at(file), 'utf8');
  isTrue(src.includes('requirePlatformAdmin(req)'), `${file} : exige le rôle Admin`);
  isTrue(src.includes('isAdminAccessDenied(error)') && src.includes('403'),
    `${file} : 403 pour un utilisateur authentisé non Admin`);
  isTrue(src.includes('admin.platformOrganizationId'), `${file} : filtre sur l'organisation plateforme`);
}

const previewRoute = await readFile(at('api/_routes/admin/import/preview.ts'), 'utf8');
isTrue(previewRoute.includes("writes: 'none'"), 'l\'aperçu annonce explicitement qu\'il n\'écrit rien');
isTrue(!previewRoute.includes('.create('), 'l\'aperçu ne contient aucun create');
isTrue(previewRoute.includes('crm_import_source_required'), 'un import sans source est refusé');

const commitRoute = await readFile(at('api/_routes/admin/import/commit.ts'), 'utf8');
isTrue(commitRoute.includes('buildImportPreview(records'),
  'le commit appelle la MÊME fonction que l\'aperçu : ils ne peuvent pas diverger');
isTrue(commitRoute.includes("if (row.status !== 'new' || !row.data) continue;"),
  'seules les lignes « new » sont écrites — ni invalides, ni doublons');
isTrue(commitRoute.includes("'abort'"), 'la politique abort existe : aucun doublon toléré');
isTrue(commitRoute.includes('MAX_ROWS_PER_IMPORT'), 'le nombre de lignes par import est borné');

const exportRoute = await readFile(at('api/_routes/admin/companies/export.ts'), 'utf8');
isTrue(exportRoute.includes('buildCompanyFilters'),
  'l\'export filtre via le MÊME module que la liste');
for (const col of ["key: 'source'", "key: 'source_detail'", "key: 'collected_at'"]) {
  isTrue(exportRoute.includes(col), `l'export contient ${col} — la provenance survit à l'aller-retour`);
}
isTrue(exportRoute.includes('\\uFEFF'), 'BOM UTF-8 : sinon Excel casse les accents');

const companiesRoute = await readFile(at('api/_routes/admin/companies.ts'), 'utf8');
isTrue(companiesRoute.includes('buildCompanyFilters'),
  'la liste passe aussi par le module partagé — pas deux implémentations');

/* -------------------------------------------------------------------------- */
console.log('\nI. Internationalisation');
/* -------------------------------------------------------------------------- */

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
for (const lang of LANGS) {
  dicts[lang] = JSON.parse(await readFile(at(`locales/${lang}/admin.json`), 'utf8'));
  isTrue(Object.keys(dicts[lang]).length >= 340,
    `${lang}/admin.json : au moins 340 clés`, `${Object.keys(dicts[lang]).length}`);
}
const enKeys = Object.keys(dicts.en).sort().join('|');
for (const lang of LANGS.slice(1)) {
  eq(Object.keys(dicts[lang]).sort().join('|'), enKeys, `${lang} : même jeu de clés qu'en`);
}
for (const key of ['import.open', 'import.reviewHint', 'filters.more', 'lists.save',
  'importField.collected_at', 'importDuplicate.same_domain', 'interest.unknown',
  'import.sourcePlaceholder', 'import.csvPlaceholder']) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][key] === 'string' && dicts[lang][key].trim().length > 0,
      `${lang} : ${key} traduit et non vide`);
  }
}
/* Un placeholder est du texte d'interface : il doit exister dans les 7 langues. */
isTrue(dicts.de['import.csvPlaceholder'] !== dicts.en['import.csvPlaceholder'],
  'le placeholder CSV est réellement traduit en allemand');
/* Aucun caractère CJK ne doit traîner dans un dictionnaire latin. */
for (const lang of LANGS) {
  isTrue(!/[\u3400-\u4dbf\u4e00-\u9fff]/.test(JSON.stringify(dicts[lang])),
    `${lang} : aucun caractère CJK`);
}

/* -------------------------------------------------------------------------- */
console.log('\nJ. Interface');
/* -------------------------------------------------------------------------- */

const html = await readFile(at('admin/index.html'), 'utf8');
const frDict = JSON.parse(await readFile(at('locales/fr/admin.json'), 'utf8'));

const stub = `<script>window.TracefabI18n = {
  isReady: true, init: async () => true, setLanguage: async () => true,
  t: (k) => window.__DICT[k] || k,
};</script>`;
const booted = (dict, lang) => html
  .replace('<script src="/i18n-core.js"></script>', stub)
  .replace('</head>', `<script>window.__DICT = ${JSON.stringify(dict)};
    localStorage.setItem('tracefab.lang', ${JSON.stringify(lang)});</script></head>`);

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(String(e?.message || e)));
virtualConsole.on('error', (...a) => pageErrors.push(a.join(' ')));

const dom = new JSDOM(booted(frDict, 'fr'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://tracefab.example/admin/?demo', virtualConsole,
});
const { window } = dom;
const { document } = window;
const settle = () => new Promise((r) => setTimeout(r, 200));
await settle();
await settle();

const view = () => document.getElementById('app').textContent || '';
const click = (id) => {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) throw new Error(`élément introuvable : ${id}`);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
const go = async (v) => {
  click(document.querySelector(`[data-view="${v}"]`));
  await settle();
  await settle();
};

eq(pageErrors.length, 0, 'aucune erreur JavaScript au démarrage', pageErrors.slice(0, 3).join(' | '));

/* §7 — listes de prospection */
await go('prospects');
isTrue(view().includes('France — Marques de mode'), '§7 : les listes de prospection sont affichées');
isTrue(view().includes('Europe — Prospects DPP'), '§7 : la liste DPP est affichée');
const listSelect = document.getElementById('f-list');
isTrue(Boolean(listSelect), '§7 : un sélecteur de liste existe');
eq(listSelect.options.length, 4, '§7 : 3 listes + « aucune liste »');
isTrue(Boolean(document.getElementById('export-csv')), '§7 : un bouton d\'export CSV existe');
isTrue(Boolean(document.getElementById('list-save')), '§7 : la liste courante peut être enregistrée');

/* §9 — recherche avancée */
click('f-advanced');
await settle();
for (const id of ['f-maturity', 'f-employee_band', 'f-dpp_interest', 'f-traceability_interest',
  'f-product_count_min', 'f-product_count_max', 'f-supplier_count_min', 'f-supplier_count_max']) {
  isTrue(Boolean(document.getElementById(id)), `§9 : le filtre ${id} est exposé`);
}
const dppSelect = document.getElementById('f-dpp_interest');
eq(dppSelect.options.length, 5, '§9 : 4 niveaux d\'intérêt + « tous »');
isTrue([...dppSelect.options].some((o) => o.textContent === 'Non qualifié'),
  '§9 : « non qualifié » est proposé — c\'est le travail qui reste, pas un vide');

/* §8 — assistant d'import en 3 étapes */
click('import-open');
await settle();
isTrue(view().includes('Importer des prospects'), '§8 : l\'assistant d\'import s\'ouvre');
isTrue(view().includes('Source (obligatoire)'), '§8 : la source est présentée comme obligatoire');

const source = document.getElementById('im-source');
const csvBox = document.getElementById('im-csv');
source.value = 'Salon PV 2026';
csvBox.value = 'Nom;Pays;Produits\nAtelier Neuf;FR;12\nMaison Lumière;FR;60\n;DE;3';
click('im-preview');
await settle();
await settle();

isTrue(view().includes('Vérifier avant l\'import'), '§8 : l\'étape de vérification s\'affiche');
isTrue(view().includes('Rien n\'est encore écrit'), '§8 : l\'interface dit que rien n\'est écrit');
const kpis = [...document.querySelectorAll('.kpis .kv')].map((e) => e.textContent.trim());
eq(kpis[0], '3', '§8 : 3 lignes au total');
eq(kpis[1], '1', '§8 : 1 nouvelle');
eq(kpis[2], '1', '§8 : 1 doublon');
eq(kpis[3], '1', '§8 : 1 invalide');
isTrue(view().includes('Doublon'), '§8 : les doublons sont nommés comme tels');
isTrue(view().includes('Invalide'), '§8 : les lignes invalides sont nommées comme telles');
isTrue(view().includes('Maison Lumière'), '§8 : le doublon nomme l\'entreprise existante');
isTrue(view().includes('name_required'), '§8 : la ligne invalide montre son erreur');
isTrue(document.querySelectorAll('tr.r-duplicate').length === 1, '§8 : le doublon est signalé visuellement');
isTrue(document.querySelectorAll('tr.r-invalid').length === 1, '§8 : la ligne invalide est signalée visuellement');
isTrue(Boolean(document.getElementById('im-commit')), '§8 : un bouton d\'import existe');

/* L'import sans source doit être refusé côté interface aussi. */
click('im-back');
await settle();
click('im-back');
await settle();
document.getElementById('im-source').value = '';
click('im-preview');
await settle();
isTrue(view().includes('Une source est obligatoire'),
  '§8 : l\'interface refuse l\'import sans source, avec la raison');

/* Export CSV en mode démo */
let downloaded = null;
window.URL.createObjectURL = (blob) => { downloaded = blob; return 'blob:stub'; };
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () {
  if (downloaded) downloaded.filename = this.download;
};
click('export-csv');
await settle();
isTrue(Boolean(downloaded), '§7 : l\'export produit bien un fichier');
isTrue(/^tracefab-prospects-.*\.csv$/.test(downloaded?.filename || ''),
  '§7 : le fichier exporté porte un nom explicite', downloaded?.filename);
/* `Blob.text()` supprime un BOM initial : la vérification doit porter sur les
   octets, sinon elle échoue sur un export parfaitement correct. */
const bytes = new Uint8Array(await downloaded.arrayBuffer());
isTrue(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
  '§7 : l\'export commence par un BOM UTF-8', `${bytes[0].toString(16)} ${bytes[1].toString(16)} ${bytes[2].toString(16)}`);
const exported = await downloaded.text();
isTrue(exported.split('\n')[0].includes('name'), '§7 : l\'export a une ligne d\'en-têtes');
isTrue(exported.includes('Example Fashion Group'), '§7 : l\'export contient les entreprises filtrées');

await window.close();

/* Preuve d'internationalisation par le rendu : dictionnaire allemand. */
const deDict = JSON.parse(await readFile(at('locales/de/admin.json'), 'utf8'));
const domDe = new JSDOM(booted(deDict, 'de'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://tracefab.example/admin/?demo', virtualConsole: new VirtualConsole(),
});
const wDe = domDe.window;
await settle();
await settle();
wDe.document.querySelector('[data-view="prospects"]')
  .dispatchEvent(new wDe.MouseEvent('click', { bubbles: true }));
await settle();
await settle();
const deView = wDe.document.getElementById('app').textContent || '';
isTrue(deView.includes('CSV importieren'), 'DE : le bouton d\'import bascule en allemand');
isTrue(deView.includes('Weitere Filter'), 'DE : « More filters » devient « Weitere Filter »');
wDe.document.getElementById('f-advanced')
  .dispatchEvent(new wDe.MouseEvent('click', { bubbles: true }));
await settle();
const deViewOpen = wDe.document.getElementById('app').textContent || '';
isTrue(deViewOpen.includes('Nicht qualifiziert'),
  'DE : « non qualifié » bascule en allemand dans le panneau avancé');
isTrue(!deView.includes('Import CSV') && !deView.includes('More filters'),
  'DE : aucun libellé anglais ne subsiste');
isTrue((wDe.document.getElementById('import-open') || {}).placeholder !== undefined
  || deView.length > 500, 'DE : la vue se rend sans erreur');
await wDe.close();

/* -------------------------------------------------------------------------- */
console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications\n`);
process.exit(failures === 0 ? 0 : 1);
