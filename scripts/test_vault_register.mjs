#!/usr/bin/env node
/**
 * Chantier 28 — Plus de faux succès : l'export du registre est réel, et la modale
 * d'import BOM devient atteignable.
 *
 * Trois défauts de la même famille étaient présents dans le portail fournisseur :
 *   1. `onclick="alert('Registre d'inventaire exporté.')"` annonçait un export qui
 *      n'avait jamais lieu — aucun fichier, aucune donnée ;
 *   2. `onclick="openBomModal()"` appelait une fonction qui n'a jamais existé :
 *      le bouton levait une ReferenceError silencieuse et ne faisait rien ;
 *   3. `modalView()` n'était invoquée nulle part, alors que `bind()` gère déjà
 *      `open-bom-import` et `close-modal` et que `/api/supplier/materials/import-bom`
 *      est enregistré (api/index.ts:13). Le chaînon manquant était dans `render()`.
 *
 * Ce test exécute le générateur CSV réel et pilote la modale dans jsdom : il ne se
 * contente pas de lire le source.
 *
 *   npm run test:vault:register
 */
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = new URL('../', import.meta.url);

let checks = 0;
let failures = 0;
const ok = (label) => { checks += 1; console.log(`  ok    ${label}`); };
const bad = (label, detail) => { failures += 1; checks += 1; console.error(`  FAIL  ${label}\n        ${detail ?? 'assertion failed'}`); };
const assert = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));
const eq = (actual, expected, label) =>
  assert(actual === expected, label, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);

const portalHtml = await readFile(new URL('supplier-portal/index.html', root), 'utf8');

/**
 * Le portail délègue ses libellés à public/i18n-core.js. Sans runtime, t(clé)
 * renvoie la clé : le message de succès du registre s'affichait alors
 * « ui_registre_exporte ». On fournit le VRAI dictionnaire français — ce test
 * assertit du texte français, c'est la langue cohérente ici.
 */
const portalDict = JSON.parse(
  await readFile(new URL('locales/fr/supplier.json', root), 'utf8'),
);
const portalI18n = (win) => {
  try { win.localStorage.setItem('tracefab_lang', 'fr'); } catch { /* ignore */ }
  win.TracefabI18n = {
    language: 'fr',
    missing: [],
    t(key, values) {
      const value = portalDict[key];
      if (value === undefined) return null;
      return values
        ? String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, (m, n) => (n in values ? values[n] : m))
        : value;
    },
    init(options) {
      this.language = (options && options.language) || 'fr';
      return Promise.resolve(this.language);
    },
    apply() {},
  };
};
const consoleHtml = await readFile(new URL('brand-console/index.html', root), 'utf8');
const documentsRoute = await readFile(new URL('api/_routes/documents.ts', root), 'utf8');

// ---------------------------------------------------------------------------
console.log('\nA. Les faux succès ont disparu');
// ---------------------------------------------------------------------------

eq((portalHtml.match(/alert\(/g) || []).length, 0, 'plus aucun alert() dans le portail fournisseur');
eq((consoleHtml.match(/alert\(/g) || []).length, 0, 'plus aucun alert() dans la console de marque');
assert(
  !portalHtml.includes('Registre d\'inventaire exporté'),
  'le message de succès mensonger a disparu',
);
assert(
  portalHtml.includes('onclick="exportVaultRegister()"'),
  'le bouton appelle une fonction réelle',
);
eq((portalHtml.match(/openBomModal/g) || []).length, 0, 'plus aucune référence à openBomModal, qui n’a jamais existé');
assert(
  portalHtml.includes('data-action="open-bom-import"'),
  'le bouton BOM utilise le mécanisme que bind() gère déjà',
);
assert(
  portalHtml.includes("action === 'open-bom-import'"),
  'et ce mécanisme existe bien dans bind()',
);
assert(
  portalHtml.includes('window.exportVaultRegister = exportVaultRegister'),
  'exportVaultRegister est exposée en global (le script est une IIFE)',
);

// ---------------------------------------------------------------------------
console.log('\nB. Les colonnes du registre sont celles de l’API, pas une invention');
// ---------------------------------------------------------------------------

/* Extrait les clés réellement renvoyées par GET /api/documents. */
const mapBlock = documentsRoute.slice(
  documentsRoute.indexOf('const documents = rows.map((row) => ({'),
  documentsRoute.indexOf('}));', documentsRoute.indexOf('const documents = rows.map((row) => ({')),
);
const apiColumns = [...mapBlock.matchAll(/^\s{6}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);
assert(apiColumns.length > 0, `colonnes extraites de documents.ts (${apiColumns.length})`, mapBlock.slice(0, 80));

const dom0 = new JSDOM(portalHtml, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.vercel.app/supplier-portal/?demo=1',
  virtualConsole: new VirtualConsole(),
  beforeParse: portalI18n,
});
if (dom0.window.document.readyState !== 'complete') {
  await new Promise((r) => dom0.window.addEventListener('load', r, { once: true }));
}
await new Promise((r) => setTimeout(r, 60));

const csv = dom0.window.buildVaultRegisterCsv([{ id: 'probe' }]);
const header = csv.split('\r\n')[0].split(',');
eq(header.length, apiColumns.length, `le registre a autant de colonnes que l’API (${apiColumns.length})`);
eq(
  JSON.stringify(header),
  JSON.stringify(apiColumns),
  'et exactement les mêmes, dans le même ordre',
);

// ---------------------------------------------------------------------------
console.log('\nC. Le générateur CSV, exécuté');
// ---------------------------------------------------------------------------

const build = dom0.window.buildVaultRegisterCsv;

/**
 * Découpe une ligne CSV en respectant les cellules encadrées (RFC 4180).
 * Un split(',') naïf cassait sur « Nhan Textile, Lda » et faisait échouer le test
 * alors que le générateur, lui, échappait correctement.
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuotes = false; }
      } else { cur += ch; }
    } else if (ch === '"') { inQuotes = true; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

const full = {
  id: 'doc-1',
  ownerOrganizationId: 'org-1',
  ownerOrganizationName: 'Nhan Textile, Lda',
  originalFilename: 'gots-2025.pdf',
  contentType: 'application/pdf',
  byteSize: 24576,
  sha256: 'a'.repeat(64),
  kind: 'certificate',
  status: 'available',
  visibility: 'private',
  expiresAt: '2027-01-31T00:00:00.000Z',
  createdAt: '2026-01-04T09:00:00.000Z',
  availableAt: '2026-01-04T09:00:00.000Z',
  updatedAt: '2026-02-01T10:00:00.000Z',
  verificationCount: 2,
  latestVerificationStatus: 'verified',
  metadata: { issuer: 'Control Union' },
};

const rows = build([full]).split('\r\n');
eq(rows.length, 2, 'un en-tête + une ligne de données');
const cells = parseCsvLine(rows[1]);
eq(cells[0], 'doc-1', 'l’identifiant est en première colonne');
eq(cells[apiColumns.indexOf('sha256')], 'a'.repeat(64), 'le scellé SHA-256 est repris tel quel');
eq(cells[apiColumns.indexOf('byteSize')], '24576', 'la taille reste numérique, sans unité inventée');
eq(
  cells[apiColumns.indexOf('metadata')],
  '{"issuer":"Control Union"}',
  'un objet est sérialisé en JSON',
);
assert(
  rows[1].includes('"{""issuer"":""Control Union""}"'),
  'et ses guillemets sont doublés dans le fichier (RFC 4180)',
  rows[1],
);
eq(
  cells[apiColumns.indexOf('ownerOrganizationName')],
  'Nhan Textile, Lda',
  'une virgule dans une valeur ne casse pas la ligne',
);
assert(
  rows[1].includes('"Nhan Textile, Lda"'),
  'elle est encadrée de guillemets dans le fichier',
  rows[1],
);

/* Un champ absent doit rester vide : ni « null », ni « N/A », ni une valeur devinée. */
const sparse = parseCsvLine(build([{ id: 'doc-2' }]).split('\r\n')[1]);
eq(sparse[0], 'doc-2', 'le champ présent est conservé');
eq(
  sparse.filter((c) => c !== '').length,
  1,
  'tous les autres champs sont vides',
  sparse.filter((c) => c !== '').join(' | '),
);
assert(
  !/null|undefined|N\/A|inconnu/i.test(build([{ id: 'doc-2' }])),
  'aucun marqueur de substitution n’est écrit à la place d’une donnée absente',
);

/* Échappement : guillemet, retour à la ligne. */
const quoted = build([{ id: 'doc-3', originalFilename: 'cert "final".pdf' }]).split('\r\n')[1];
assert(
  quoted.includes('"cert ""final"".pdf"'),
  'les guillemets d’un nom de fichier sont doublés et la cellule encadrée',
  quoted,
);

// ---------------------------------------------------------------------------
console.log('\nD. Un coffre vide ne produit aucun fichier');
// ---------------------------------------------------------------------------

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(portalHtml, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.vercel.app/supplier-portal/?demo=1',
  virtualConsole,
  beforeParse: portalI18n,
});
const { window } = dom;
const { document } = window;
if (document.readyState !== 'complete') {
  await new Promise((r) => window.addEventListener('load', r, { once: true }));
}
await new Promise((r) => setTimeout(r, 60));

const $ = (s) => document.querySelector(s);
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 20));
const state = window.tracefabSupplierPortal.state;

let blobs = [];
let downloads = [];
window.URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:fake/${blobs.length}`; };
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };

click($('[data-view="documents"]'));
await settle();
const exportButton = $('[onclick="exportVaultRegister()"]');
assert(!!exportButton, 'le bouton d’export est rendu dans la vue Coffre-fort');

const savedDocuments = state.documents;
state.documents = [];
click(exportButton);
await settle();
eq(blobs.length, 0, 'aucun fichier n’est produit quand le coffre est vide');
eq(downloads.length, 0, 'aucun téléchargement n’est déclenché');
assert(
  state.toast && state.toast.isError === true,
  'et l’utilisateur est prévenu au lieu de croire à un succès',
  JSON.stringify(state.toast),
);

// ---------------------------------------------------------------------------
console.log('\nE. L’export réel produit bien un fichier');
// ---------------------------------------------------------------------------

state.documents = savedDocuments;
assert(state.documents.length > 0, `des documents sont chargés (${state.documents.length})`);
click(exportButton);
await settle();

eq(blobs.length, 1, 'un blob est créé');
eq(downloads.length, 1, 'un téléchargement est déclenché');
assert(
  /^tracefab-registre-coffre-DEMO-\d{4}-\d{2}-\d{2}\.csv$/.test(downloads[0]),
  'le nom de fichier étiquette les données de démonstration',
  downloads[0],
);
eq(blobs[0].type, 'text/csv;charset=utf-8', 'le type MIME est déclaré');

/* Blob.text() retire le BOM par spécification : on vérifie les octets réels. */
const bytes = new Uint8Array(await blobs[0].arrayBuffer());
eq(bytes[0], 0xef, 'octet 1 du BOM UTF-8');
eq(bytes[1], 0xbb, 'octet 2 du BOM UTF-8');
eq(bytes[2], 0xbf, 'octet 3 du BOM UTF-8 (Excel et les accents)');
const text = new TextDecoder('utf-8').decode(bytes.subarray(3));
const lines = text.split('\r\n');
eq(lines.length, state.documents.length + 1, 'autant de lignes que de documents chargés, plus l’en-tête');
eq(lines[0], apiColumns.join(','), 'l’en-tête reprend les colonnes de l’API');
assert(
  lines[1].includes(state.documents[0].id),
  'la première ligne correspond au premier document chargé',
  lines[1].slice(0, 90),
);
assert(
  state.toast && state.toast.isError !== true && String(state.toast.message).includes(String(state.documents.length)),
  'le message de succès annonce le nombre réel de preuves',
  JSON.stringify(state.toast),
);

// ---------------------------------------------------------------------------
console.log('\nF. La modale d’import BOM s’ouvre et se ferme');
// ---------------------------------------------------------------------------

assert($('.modal-backdrop') === null, 'aucune modale n’est affichée au départ');

/* Le panneau d'import BOM vit dans overview() (l.1652-1745), pas dans la vue Coffre-fort. */
click($('[data-view="overview"]'));
await settle();
const bomButton = $('[data-action="open-bom-import"]');
assert(!!bomButton, 'le bouton d’import BOM est rendu dans la vue d’ensemble');
click(bomButton);
await settle();

assert($('.modal-backdrop') !== null, 'la modale s’ouvre');
/*
 * shell() (l.1513) rend déjà `${state.modal ? modalView(state.modal) : ''}`.
 * Ajouter le même rendu dans render() aurait affiché la modale deux fois : ce
 * comptage est ce qui manque pour attraper cette régression.
 */
eq(document.querySelectorAll('.modal-backdrop').length, 1, 'et une seule fois (shell() la rend déjà)');
eq(document.querySelectorAll('#bom-csv-input').length, 1, 'un seul champ de nomenclature, pas de formulaire dupliqué');
assert($('#bom-csv-input') !== null, 'le champ de saisie de la nomenclature est présent');
assert($('#bom-import-form') !== null, 'et son formulaire aussi');
assert(
  typeof window.handleBomImportSubmit === 'function',
  'la soumission est exposée en global pour le onsubmit inline',
);
assert(
  typeof window.previewBomCsv === 'function',
  'l’aperçu CSV l’est aussi',
);

click($('.modal-backdrop [data-action="close-modal"]'));
await settle();
assert($('.modal-backdrop') === null, 'la modale se referme');

eq(pageErrors.length, 0, 'aucune erreur de page sur tout le parcours', pageErrors.join(' | '));

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
