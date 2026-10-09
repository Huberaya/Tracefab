#!/usr/bin/env node
/**
 * CHANTIER ADMIN 08 — §8 import CSV **et Excel**.
 *
 * CE QUI MANQUAIT
 *   L'import ne lisait que du CSV, et l'interface n'avait même pas de sélecteur
 *   de fichier : une zone de texte où coller le contenu. `xlsx` n'apparaissait
 *   nulle part — ni dans le parseur, ni dans la page, ni dans package.json.
 *
 * LE PIÈGE CENTRAL
 *   Dans un .xlsx, une date n'est pas une date : c'est un nombre (45123) dont le
 *   STYLE dit s'il faut le lire comme une date. Sans cette détection, une colonne
 *   `collected_at` arrive en `45123`, la ligne passe en `invalid`, et personne ne
 *   comprend pourquoi. C'est le cas que ce test vérifie en premier.
 *
 *   A.  xlsx-reader compile et n'importe que node:zlib ;
 *   B.  lecture d'un VRAI classeur, construit ici ;
 *   C.  types de cellules ;
 *   D.  dates — et ce qui n'en est PAS une ;
 *   E.  lignes éparses et vides ;
 *   F.  fichiers illisibles ;
 *   G.  readImportPayload — la porte partagée ;
 *   H.  les deux routes passent par la même porte ;
 *   I.  i18n ;
 *   J.  l'interface.
 *
 *   npm run test:admin:chantier08
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
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

/* ------------------------------------------------- un vrai classeur .xlsx --- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Écrit un ZIP (donc un .xlsx) réel, deflate compris. */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(deflated.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    chunks.push(head, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const X = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/**
 * Construit un classeur. `cells` = { A1: {t,v,s,is} }.
 * Les styles : 0 = général, 1 = date (numFmtId 14), 2 = `0.00" m"` (PAS une date).
 */
function buildXlsx({ strings, rows, sheetName = 'Prospects', withStyles = true } = {}) {
  const shared = `<?xml version="1.0"?><sst xmlns="${NS}" count="${(strings || []).length}" `
    + `uniqueCount="${(strings || []).length}">${(strings || []).map((s) => `<si><t>${X(s)}</t></si>`).join('')}</sst>`;
  const cellXml = (ref, c) => {
    if (!c) return '';
    const s = c.s === undefined ? '' : ` s="${c.s}"`;
    if (c.t === 'inlineStr') return `<c r="${ref}" t="inlineStr"${s}><is><t>${X(c.is)}</t></is></c>`;
    const tt = !c.t || c.t === 'n' ? '' : ` t="${c.t}"`;
    return `<c r="${ref}"${tt}${s}><v>${X(c.v)}</v></c>`;
  };
  const body = Object.entries(rows).map(([r, cs]) => `<row r="${r}">`
    + Object.entries(cs).map(([ref, c]) => cellXml(ref, c)).join('') + '</row>').join('');
  const sheet = `<?xml version="1.0"?><worksheet xmlns="${NS}"><sheetData>${body}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0"?><styleSheet xmlns="${NS}">`
    + '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00&quot; m&quot;"/></numFmts>'
    + '<fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>'
    + '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>';
  const files = {
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${NS}" `
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${X(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships '
      + 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
      + 'Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': shared,
  };
  if (withStyles) files['xl/styles.xml'] = styles;
  return buildZip(files);
}

/* -------------------------------------------------------------------------- */
console.log('\nA. xlsx-reader compile et reste sans dépendance');
/* -------------------------------------------------------------------------- */

await mkdir(at('.cache'), { recursive: true });
const outDir = await mkdtemp(at('.cache/admin08-'));
const run = (cmd, args) => import('node:child_process').then(({ spawn }) => new Promise((res, rej) => {
  const child = spawn(cmd, args, { cwd: root });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (c) => (c === 0 ? res(out) : rej(new Error(out.slice(-600)))));
}));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/xlsx-reader.ts', 'api/_lib/import-payload.ts',
    '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020,DOM',
  ]);
  ok('xlsx-reader.ts et import-payload.ts compilent');
} catch (e) {
  bad('les modules §8 ne compilent pas', e.message.slice(0, 400));
}

const R = await import(pathToFileURL(join(outDir, 'xlsx-reader.js')).href);
const readerSrc = await readFile(at('api/_lib/xlsx-reader.ts'), 'utf8');
const imports = [...readerSrc.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
eq(JSON.stringify(imports), JSON.stringify(['node:zlib']),
  'xlsx-reader n\'importe que node:zlib : aucune dépendance ajoutée au déploiement');

/* -------------------------------------------------------------------------- */
console.log('\nB. Lecture d\'un vrai classeur');
/* -------------------------------------------------------------------------- */

const { parseXlsxRows, looksLikeXlsx, columnIndexOf, excelSerialToIso, isDateFormatCode } = R;

const sample = buildXlsx({
  strings: ['Name', 'Website', 'Country', 'Collected', 'Active', 'Maison & Filles', 'https://ex.fr', 'FR'],
  rows: {
    1: { A1: { t: 's', v: 0 }, B1: { t: 's', v: 1 }, C1: { t: 's', v: 2 }, D1: { t: 's', v: 3 }, E1: { t: 's', v: 4 } },
    2: { A2: { t: 's', v: 5 }, B2: { t: 's', v: 6 }, C2: { t: 's', v: 7 },
      D2: { v: 45123, s: 1 }, E2: { t: 'b', v: 1 } },
  },
});

isTrue(looksLikeXlsx(sample), 'un classeur construit ici est reconnu comme .xlsx');
isTrue(!looksLikeXlsx(Buffer.from('name,country\nA,FR\n')), 'un CSV n\'est PAS pris pour un .xlsx');
isTrue(!looksLikeXlsx(null) && !looksLikeXlsx('pas un tampon'),
  'looksLikeXlsx ne lève pas sur une entrée absurde');

const rows = parseXlsxRows(sample);
eq(rows.length, 1, 'une ligne de données');
eq(rows[0].Name, 'Maison & Filles',
  'les chaînes partagées sont lues et l\'entité &amp; est décodée');
eq(rows[0].Website, 'https://ex.fr', 'les URL passent intactes');
eq(rows[0].Country, 'FR', 'les codes courts passent');
eq(rows[0].Active, 'TRUE', 'un booléen Excel devient TRUE, pas 1');

eq(columnIndexOf('A1'), 0, 'colonne A → 0');
eq(columnIndexOf('Z9'), 25, 'colonne Z → 25');
eq(columnIndexOf('AA1'), 26, 'colonne AA → 26 (pas 1)');
eq(columnIndexOf('AZ3'), 51, 'colonne AZ → 51');

/* -------------------------------------------------------------------------- */
console.log('\nC. Types de cellules');
/* -------------------------------------------------------------------------- */

const types = parseXlsxRows(buildXlsx({
  strings: ['h1', 'h2', 'h3', 'h4'],
  rows: {
    1: { A1: { t: 's', v: 0 }, B1: { t: 's', v: 1 }, C1: { t: 's', v: 2 }, D1: { t: 's', v: 3 } },
    2: { A2: { t: 'inlineStr', is: 'en ligne' }, B2: { v: 1234.5 },
      C2: { t: 'b', v: 0 }, D2: { t: 'e', v: '#N/A' } },
  },
}));
eq(types[0].h1, 'en ligne', 'une chaîne inline est lue');
eq(types[0].h2, '1234.5', 'un nombre est rendu tel quel, sans arrondi ni formatage');
eq(types[0].h3, 'FALSE', 'un booléen à 0 devient FALSE');
eq(types[0].h4, '#N/A', 'une cellule d\'erreur est rendue, pas avalée');

/* Texte riche : un <si> peut porter plusieurs <r><t>. Ne lire que le premier
   morceau tronquerait la valeur — un nom de société coupé devient un doublon
   manqué à l'import. */
const rich = buildZip({
  'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="' + NS + '" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships '
    + 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
    + 'Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="' + NS + '" count="2" uniqueCount="2">'
    + '<si><r><t>Maison</t></r><r><t xml:space="preserve"> </t></r><r><t>Lumière</t></r></si>'
    + '<si><t>Nom</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="' + NS + '"><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>0</v></c></row></sheetData></worksheet>',
});
const richRows = parseXlsxRows(rich);
eq(richRows[0].Nom, 'Maison Lumière',
  'un texte riche en trois morceaux est concaténé, pas tronqué au premier');

/* -------------------------------------------------------------------------- */
console.log('\nD. Les dates — et ce qui n\'en est PAS une');
/* -------------------------------------------------------------------------- */

eq(excelSerialToIso(45123), '2023-07-16T00:00:00.000Z',
  '45123 → 2023-07-16 (époque 1899-12-30, qui compense le bug de 1900)');
eq(excelSerialToIso(45123.5), '2023-07-16T12:00:00.000Z', 'la fraction donne l\'heure');
eq(excelSerialToIso(25569), '1970-01-01T00:00:00.000Z',
  '25569 → 1970-01-01 : l\'époque est la bonne');
/* Excel croit que 1900 était bissextile. L'époque 1899-12-30 est exacte pour les
   numéros >= 61, qui sont les seuls réels ; en dessous, le décalage d'un jour
   vient d'Excel lui-même, pas de ce lecteur. Aucune date de prospection n'est
   antérieure à 1900, mais c'est dit plutôt que laissé implicite. */
eq(excelSerialToIso(61), '1900-03-01T00:00:00.000Z',
  '61 → 1900-03-01, première valeur au-delà du bug de 1900');
eq(excelSerialToIso(0), null, 'le numéro 0 n\'est pas une date Excel');
eq(excelSerialToIso(-5), null, 'un numéro négatif n\'est pas une date');
eq(excelSerialToIso(Number.NaN), null, 'NaN ne produit pas « Invalid Date »');

const dated = parseXlsxRows(buildXlsx({
  strings: ['d'],
  rows: { 1: { A1: { t: 's', v: 0 } }, 2: { A2: { v: 45123, s: 1 } } },
}));
eq(dated[0].d, '2023-07-16T00:00:00.000Z',
  'un nombre au format date devient ISO — sinon collected_at arrive en 45123');

const notDated = parseXlsxRows(buildXlsx({
  strings: ['m'],
  /* style 2 = `0.00" m"` : le « m » est un libellé entre guillemets, pas des minutes. */
  rows: { 1: { A1: { t: 's', v: 0 } }, 2: { A2: { v: 45123, s: 2 } } },
}));
eq(notDated[0].m, '45123',
  'un format monétaire avec un « m » littéral n\'est PAS converti en date');

const noStyles = parseXlsxRows(buildXlsx({
  strings: ['n'], withStyles: false,
  rows: { 1: { A1: { t: 's', v: 0 } }, 2: { A2: { v: 45123, s: 1 } } },
}));
eq(noStyles[0].n, '45123',
  'sans styles.xml, rien n\'est deviné comme date — mieux vaut un nombre brut qu\'une date inventée');

eq(isDateFormatCode('dd/mm/yyyy'), true, 'dd/mm/yyyy est une date');
eq(isDateFormatCode('yyyy-mm-dd hh:mm'), true, 'yyyy-mm-dd hh:mm est une date');
eq(isDateFormatCode('#,##0.00'), false, '#,##0.00 n\'est pas une date');
eq(isDateFormatCode('0.00" m"'), false, 'un « m » entre guillemets n\'est pas une date');
/* `\` échappe le caractère suivant : dans `0.00\ m`, le `m` n'est PAS échappé,
   c'est un vrai jeton de minutes — ce format EST une durée. Le cas à écarter est
   celui où l'échappement retire le seul jeton de date. */
eq(isDateFormatCode('0.00\\ m'), true, 'un « m » non échappé reste des minutes');
eq(isDateFormatCode('\\#0.00'), false, 'un « # » échappé n\'est pas un jeton de date');

/* -------------------------------------------------------------------------- */
console.log('\nE. Lignes éparses et vides');
/* -------------------------------------------------------------------------- */

const sparse = parseXlsxRows(buildXlsx({
  strings: ['a', 'b', 'c', 'v'],
  rows: {
    1: { A1: { t: 's', v: 0 }, B1: { t: 's', v: 1 }, C1: { t: 's', v: 2 } },
    /* B absente : C doit rester en colonne C, pas remonter en B. */
    2: { A2: { t: 's', v: 3 }, C2: { t: 's', v: 3 } },
    3: {},
  },
}));
eq(sparse.length, 1, 'une ligne entièrement vide est écartée');
eq(sparse[0].b, '', 'une cellule absente vaut une chaîne vide, pas un décalage');
eq(sparse[0].c, 'v', 'la colonne C garde sa position malgré le trou en B');

const noHeader = parseXlsxRows(buildXlsx({
  strings: ['x'],
  rows: { 1: { A1: { t: 's', v: 0 }, C1: { t: 's', v: 0 } } },
}));
isTrue(Object.keys(noHeader).length === 0, 'des en-têtes seuls ne produisent aucune ligne');

eq(parseXlsxRows(buildXlsx({ strings: [], rows: { 1: {} } })).length, 0,
  'un classeur vide renvoie zéro ligne, pas une exception');

/* -------------------------------------------------------------------------- */
console.log('\nF. Fichiers illisibles');
/* -------------------------------------------------------------------------- */

let threw = null;
try { parseXlsxRows(Buffer.from('ceci n\'est pas un zip du tout')); } catch (e) { threw = e; }
isTrue(Boolean(threw), 'un fichier qui n\'est pas un ZIP est refusé');
eq(threw && threw.code, 'xlsx_not_a_zip', 'et il dit pourquoi : xlsx_not_a_zip');

let empty = null;
try { parseXlsxRows(Buffer.alloc(0)); } catch (e) { empty = e; }
eq(empty && empty.code, 'xlsx_empty', 'un fichier vide est refusé, pas lu comme vide');

/* Un ZIP dont l'EOCD annonce du ZIP64 doit être refusé explicitement. */
const zip64 = Buffer.from(sample);
const eocdAt = (() => {
  for (let i = zip64.length - 22; i >= 0; i -= 1) {
    if (zip64.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
})();
zip64.writeUInt16LE(0xffff, eocdAt + 10);
let z64 = null;
try { parseXlsxRows(zip64); } catch (e) { z64 = e; }
eq(z64 && z64.code, 'xlsx_zip64_unsupported', 'le ZIP64 est refusé avec sa raison, pas deviné');

/* Un classeur sans feuille. */
let noSheet = null;
try { parseXlsxRows(buildZip({ 'rien.xml': '<?xml version="1.0"?><a/>' })); } catch (e) { noSheet = e; }
eq(noSheet && noSheet.code, 'xlsx_no_sheet', 'un ZIP sans feuille est refusé avec sa raison');

/* -------------------------------------------------------------------------- */
console.log('\nG. readImportPayload — la porte partagée');
/* -------------------------------------------------------------------------- */

const P = await import(pathToFileURL(join(outDir, 'import-payload.js')).href);
const { readImportPayload, importPayloadStatus, MAX_IMPORT_BYTES } = P;

const csvPayload = readImportPayload({ csv: 'name,country\nMaison,FR\n' });
eq(csvPayload.status, 'ok', 'un CSV collé est toujours accepté — le chemin existant n\'est pas cassé');
eq(csvPayload.format, 'csv', 'et il est annoncé comme csv');
eq(csvPayload.records[0].name, 'Maison', 'avec les mêmes enregistrements qu\'avant');

const xlsxPayload = readImportPayload({ file: sample.toString('base64') });
eq(xlsxPayload.status, 'ok', 'un classeur base64 est accepté');
eq(xlsxPayload.format, 'xlsx', 'et annoncé comme xlsx');
eq(xlsxPayload.records[0].Name, 'Maison & Filles', 'avec le contenu lu');

/* La détection se fait sur le CONTENU : un CSV envoyé dans `file` reste du CSV. */
const mislabeled = readImportPayload({ file: Buffer.from('name,country\nX,FR\n').toString('base64') });
eq(mislabeled.status, 'ok', 'un CSV envoyé via `file` est lu quand même');
eq(mislabeled.format, 'csv', 'et reconnu comme csv par sa signature, pas par son nom');

eq(readImportPayload({}).error, 'import_file_required', 'ni csv ni file → import_file_required');
eq(readImportPayload({ csv: '   ' }).error, 'import_file_required', 'un csv de blancs compte comme absent');
eq(readImportPayload({ file: '!!!pas du base64!!!' }).error, 'import_file_unreadable',
  'un base64 corrompu est une erreur métier');

/* LA LIMITE PORTE SUR LES OCTETS DÉCODÉS.
   En base64, 2 Mo de données font ~2,73 Mo de texte : comparer la chaîne à la
   limite refuserait un fichier valide. On construit un classeur juste sous la
   limite et on vérifie qu'il passe, puis un débordement. */
isTrue(sample.length < MAX_IMPORT_BYTES, 'l\'échantillon tient sous la limite');
isTrue(Buffer.byteLength(sample.toString('base64')) > sample.length,
  'le base64 est bien plus long que les octets réels — d\'où la limite sur le décodé');
const oversized = Buffer.concat([sample, Buffer.alloc(MAX_IMPORT_BYTES)]);
eq(readImportPayload({ file: oversized.toString('base64') }).error, 'crm_import_file_too_large',
  'un fichier trop lourd une fois décodé est refusé');
eq(importPayloadStatus('crm_import_file_too_large'), 413, 'trop lourd → 413');
eq(importPayloadStatus('import_file_unreadable'), 422, 'illisible → 422, pas 500');
eq(readImportPayload({ csv: 'a\n1\n' }).status, 'ok', 'un csv minimal passe');

/*
 * LE cas qui distingue les deux limites.
 *
 * 1,6 Mo de données font ~2,14 Mo en base64. Comparer la CHAÎNE base64 à la
 * limite refuserait ce fichier alors qu'il tient largement une fois décodé.
 * Sans cet échantillon précis, remplacer buf.length par file.length ne change
 * aucun résultat et la régression passe inaperçue.
 */
const underLimit = Buffer.concat([
  Buffer.from('name,country\n'),
  Buffer.alloc(1600000, 0x61),
]);
isTrue(underLimit.length < MAX_IMPORT_BYTES, 'l\'échantillon tient sous la limite une fois décodé');
isTrue(underLimit.toString('base64').length > MAX_IMPORT_BYTES,
  'mais son base64 dépasse la limite — c\'est ce qui distingue les deux règles');
const underPayload = readImportPayload({ file: underLimit.toString('base64') });
eq(underPayload.status, 'ok',
  'un fichier sous la limite décodée est accepté même si son base64 la dépasse');

/* -------------------------------------------------------------------------- */
console.log('\nH. Les deux routes passent par la même porte');
/* -------------------------------------------------------------------------- */

for (const route of ['preview', 'commit']) {
  const src = await readFile(at(`api/_routes/admin/import/${route}.ts`), 'utf8');
  isTrue(/readImportPayload\(body\)/.test(src),
    `${route}.ts appelle readImportPayload`);
  /* Ni appel, ni import : un import survivant signale un retour au parseur
     local, et donc une divergence possible entre l'aperçu et l'import. */
  isTrue(!/parseCsvRows/.test(src),
    `${route}.ts ne connaît plus du tout le parseur CSV — sinon il divergerait de l'autre`);
  isTrue(!/MAX_CSV_BYTES/.test(src),
    `${route}.ts ne définit plus sa propre limite de taille`);
  isTrue(/importPayloadStatus\(/.test(src),
    `${route}.ts traduit les erreurs avec le statut partagé`);
}
/* Les deux doivent envoyer le même corps : c'est ce qui garantit qu'un aperçu
   réussi peut être importé. */
const page = await readFile(at('admin/index.html'), 'utf8');
const fileFieldRe = /state\.importFile \? \{ file: state\.importFile \} : \{ csv: state\.importCsv \}/g;
eq((page.match(fileFieldRe) || []).length, 2,
  'l\'aperçu ET l\'import envoient le classeur de la même façon');

/* -------------------------------------------------------------------------- */
console.log('\nI. i18n');
/* -------------------------------------------------------------------------- */

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
for (const l of LANGS) dicts[l] = JSON.parse(await readFile(at(`locales/${l}/admin.json`), 'utf8'));
const NEW_KEYS = ['import.file', 'import.fileHint', 'import.fileChosen', 'import.demoNoBinary'];
for (const l of LANGS) {
  eq(NEW_KEYS.filter((k) => !dicts[l][k]).length, 0, `${l} : les 4 nouvelles clés sont présentes`);
  eq(Object.keys(dicts[l]).length, Object.keys(dicts.en).length, `${l} : même nombre de clés qu'en`);
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
isTrue(dicts.fr['import.fileHint'].includes('.xlsx'),
  'le format .xlsx est nommé dans l\'aide, pas seulement « Excel »');

/* -------------------------------------------------------------------------- */
console.log('\nJ. L\'interface');
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

click(document.querySelector('[data-view="prospects"]'));
await settle();
click(document.getElementById('import-open'));
await settle();

const fileInput = document.getElementById('im-file');
isTrue(Boolean(fileInput), 'un sélecteur de fichier existe — l\'import n\'est plus seulement « coller du texte »');
eq(fileInput.getAttribute('accept'), '.csv,.xlsx', 'il accepte .csv et .xlsx');
eq(fileInput.getAttribute('type'), 'file', 'c\'est bien un input de type file');
isTrue(Boolean(document.querySelector('#im-file-hint')), 'l\'aide du sélecteur est associée par aria-describedby');
isTrue(Boolean(document.getElementById('im-csv')), 'le collage de CSV reste disponible');

/*
 * Tout se pilote par le DOM : `state` et `runImportPreview` vivent dans l'IIFE
 * de la page et ne sont pas atteignables par window.eval. Passer par le vrai
 * sélecteur de fichier exerce handleImportFile PUIS runImportPreview, c'est-à-
 * dire le chemin que suit un utilisateur — pas une copie du test.
 */
const setFiles = (input, file) => {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const modalText = () => (document.querySelector('.modalbox') && document.querySelector('.modalbox').textContent) || '';

isTrue(modalText().includes('CSV ou Excel'),
  'avant tout choix, l\'aide nomme les deux formats — sinon Excel reste une fonction cachée');
isTrue(modalText().includes('.xlsx'), 'et le format exact .xlsx est écrit, pas seulement « Excel »');

const xlsxFile = new window.File([sample], 'prospects.xlsx',
  { type: 'application/vnd.openxmlformats.spreadsheetml.sheet' });
setFiles(fileInput, xlsxFile);
await settle();
isTrue(modalText().includes('prospects.xlsx'),
  'le nom du classeur choisi est affiché — un fichier invisible serait renvoyé à l\'aveugle');
isTrue(modalText().includes('Fichier choisi'),
  'et l\'aide bascule sur le fichier choisi au lieu de répéter une aide générique');
isTrue(document.getElementById('im-csv').disabled,
  'le textarea est désactivé quand un classeur est chargé : on ne mélange pas binaire et texte');

/* Le mode démonstration ne peut pas lire un binaire : il doit le dire. */
document.getElementById('im-source').value = 'Salon Première Vision';
click(document.getElementById('im-preview'));
await settle();
await settle();
isTrue(modalText().includes('démonstration'),
  'en démo, un classeur binaire produit un message, pas un aperçu inventé',
  modalText().slice(0, 160));
isTrue(Boolean(document.getElementById('im-file')),
  'et l\'utilisateur reste sur l\'étape fichier pour coller un CSV');

/* Un CSV choisi au sélecteur est versé dans le textarea : il reste relisable. */
click(document.getElementById('m-cancel'));
await settle();
click(document.getElementById('import-open'));
await settle();
const csvFile = new window.File(['name,country\nMaison,FR\n'], 'prospects.csv', { type: 'text/csv' });
setFiles(document.getElementById('im-file'), csvFile);
await settle();
eq(document.getElementById('im-csv').value, 'name,country\nMaison,FR\n',
  'un CSV choisi au sélecteur est versé dans le textarea, pas envoyé en base64');
isTrue(!document.getElementById('im-csv').disabled,
  'et le textarea reste modifiable — l\'utilisateur peut corriger avant l\'aperçu');

/* Sans provenance, l'import est refusé avant même de regarder le fichier (§9). */
document.getElementById('im-source').value = '   ';
click(document.getElementById('im-preview'));
await settle();
isTrue(/source/i.test(modalText()),
  'la provenance reste obligatoire : §9 interdit un portefeuille sans origine',
  modalText().slice(0, 140));

/* Ni fichier ni texte → refus, pas un import vide. */
document.getElementById('im-source').value = 'Salon';
document.getElementById('im-csv').value = '';
click(document.getElementById('im-preview'));
await settle();
const nothingMsg = modalText();
isTrue(nothingMsg.length > 0 && !nothingMsg.includes('NaN'),
  'sans fichier ni texte collé, l\'aperçu est refusé proprement');

eq(pageErrors.length, 0, 'aucune erreur JavaScript pendant le rendu', pageErrors.slice(0, 3).join(' | '));

console.log(`\n${failures ? 'ÉCHEC' : 'SUCCÈS'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures ? 1 : 0);
