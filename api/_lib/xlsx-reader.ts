/**
 * §8 — Lecteur .xlsx sans aucune dépendance.
 *
 * POURQUOI PAS DE BIBLIOTHÈQUE
 *   `xlsx` (SheetJS) ou `exceljs` auraient fonctionné. Mais ce dépôt tourne sur
 *   des fonctions serverless : y ajouter ~900 Ko de parseur pour un seul écran
 *   d'import alourdit chaque déploiement, et SheetJS a un historique d'avis de
 *   sécurité qui obligerait à le surveiller. Un .xlsx est un ZIP de XML, et Node
 *   fournit déjà `zlib` : la lecture tient en un module sans import extérieur.
 *
 * CE QUI EST PRIS EN CHARGE
 *   - chaînes partagées (y compris le texte riche en plusieurs morceaux) ;
 *   - chaînes inline et valeurs de formule mises en cache ;
 *   - nombres, booléens, cellules d'erreur ;
 *   - DATES : un nombre Excel n'est une date que si son style le dit. C'est le
 *     point qui casse silencieusement les imports : sans cette détection, une
 *     colonne `collected_at` arrive en `45123` au lieu d'une date, et la ligne
 *     passe en `invalid` sans que personne comprenne pourquoi.
 *
 * CE QUI NE L'EST PAS (volontairement)
 *   - ZIP64 : un classeur de plus de 4 Go n'est pas un fichier d'import ;
 *   - les formules ne sont pas évaluées : c'est la valeur en cache qui est lue,
 *     c'est-à-dire ce qu'Excel affichait à la dernière ouverture ;
 *   - la première feuille seulement : un import n'a pas à deviner parmi
 *     plusieurs onglets lequel l'utilisateur voulait.
 *
 * Module PUR au sens du dépôt : un seul import, `node:zlib`, fourni par le
 * runtime. Aucune base, aucun client Prisma.
 */
import { inflateRawSync } from 'node:zlib';

/** Ce que renvoie le lecteur : la MÊME forme que parseCsvRows. */
export type SheetRecords = Array<Record<string, string>>;

export class XlsxError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

/* ------------------------------------------------------------------ ZIP --- */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/* L'EOCD est à la fin, mais un commentaire de ZIP peut le faire reculer : on le
   cherche en remontant, sur 64 Ko au plus (taille maximale du commentaire). */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new XlsxError('Archive ZIP invalide : répertoire de fin introuvable', 'xlsx_not_a_zip');
}

function readCentralDirectory(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || total === 0xffff) {
    throw new XlsxError('Archive ZIP64 non prise en charge', 'xlsx_zip64_unsupported');
  }
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new XlsxError('Répertoire central ZIP corrompu', 'xlsx_bad_central_directory');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.set(name, { name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, entries: Map<string, ZipEntry>, name: string): Buffer | null {
  const entry = entries.get(name);
  if (!entry) return null;
  const at = entry.localHeaderOffset;
  if (buf.readUInt32LE(at) !== LOCAL_SIG) {
    throw new XlsxError(`En-tête local invalide pour ${name}`, 'xlsx_bad_local_header');
  }
  /* Les longueurs de nom et de champ extra de l'en-tête LOCAL peuvent différer
     de celles du répertoire central : c'est l'en-tête local qui donne le début
     réel des données. Se fier au central décale la lecture de quelques octets. */
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new XlsxError(`Méthode de compression ${entry.method} non prise en charge`, 'xlsx_bad_compression');
}

/* ------------------------------------------------------------- XML utils --- */

const decodeEntities = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&'); // &amp; en dernier : sinon &lt; devient < puis <

/** Attribut d'une balise, ou null. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? decodeEntities(m[1]) : null;
}

/* ------------------------------------------------------------ contenu --- */

function sharedStrings(buf: Buffer | null): string[] {
  if (!buf) return [];
  const xml = buf.toString('utf8');
  const out: string[] = [];
  /* <si> peut contenir un seul <t> ou plusieurs <r><t>…</t></r> (texte riche) :
     ne prendre que le premier <t> perdrait la fin de la chaîne. */
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let si: RegExpExecArray | null;
  while ((si = siRe.exec(xml)) !== null) {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(si[1])) !== null) text += decodeEntities(t[1]);
    /* <si/> vide : la cellule existe mais ne contient rien. */
    out.push(text);
  }
  return out;
}

/** numFmtId prédéfinis qui sont des dates ou des durées (ECMA-376). */
const BUILTIN_DATE_FMT = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/**
 * numFmtId → « ce style est-il une date ? ».
 *
 * Les formats personnalisés (id >= 164) portent leur code : on retire ce qui est
 * entre guillemets et ce qui est échappé, puis on cherche un jeton de date.
 * Sans ce nettoyage, un format monétaire comme `0.00" m"` passerait pour une
 * durée — le `m` y est un libellé, pas des minutes.
 */
function dateStyleSet(styles: Buffer | null): Set<number> {
  const dateStyles = new Set<number>();
  if (!styles) return dateStyles;
  const xml = styles.toString('utf8');

  const customDate = new Set<number>();
  const nfRe = /<numFmt\b([^>]*)\/?>/g;
  let nf: RegExpExecArray | null;
  while ((nf = nfRe.exec(xml)) !== null) {
    const id = Number(attr(nf[1], 'numFmtId'));
    const code = attr(nf[1], 'formatCode') || '';
    if (isDateFormatCode(code)) customDate.add(id);
  }

  const xfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!xfsBlock) return dateStyles;
  const xfRe = /<xf\b([^>]*?)\/?>/g;
  let xf: RegExpExecArray | null;
  let index = 0;
  while ((xf = xfRe.exec(xfsBlock[1])) !== null) {
    const id = Number(attr(xf[1], 'numFmtId') ?? '0');
    if (BUILTIN_DATE_FMT.has(id) || customDate.has(id)) dateStyles.add(index);
    index += 1;
  }
  return dateStyles;
}

export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')   // littéraux entre guillemets
    .replace(/\[[^\]]*\]/g, '') // conditions [Red], [$-409]
    .replace(/\\./g, '')        // caractère échappé
    .replace(/\$/g, '');
  /* `d`, `y`, `h`, `s` ne servent qu'aux dates et durées. `m` seul est ambigu
     (mois ou minutes) mais n'apparaît jamais seul dans un format numérique. */
  return /[dyhs]/i.test(stripped) || /m{1,5}/i.test(stripped);
}

/** Colonne Excel → indice : A→0, Z→25, AA→26. */
export function columnIndexOf(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref);
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Numéro de série Excel → ISO.
 *
 * Excel compte les jours depuis 1900 et croit, à tort, que 1900 était bissextile.
 * L'époque 1899-12-30 compense ce décalage pour tous les numéros > 60, qui sont
 * les seuls réels : le 60 correspond au 29 février 1900, date qui n'a jamais
 * existé. Utiliser 1900-01-01 comme époque décalerait chaque date d'un jour.
 */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/* --------------------------------------------------------------- lecture --- */

function firstSheetPath(buf: Buffer, entries: Map<string, ZipEntry>): string | null {
  const wb = readEntry(buf, entries, 'xl/workbook.xml');
  const rels = readEntry(buf, entries, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) {
    /* Certains exportateurs n'écrivent ni workbook.xml ni .rels : on retombe
       alors sur le chemin conventionnel plutôt que de refuser le fichier. */
    return entries.has('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : null;
  }
  const relsXml = rels.toString('utf8');
  const targets = new Map<string, string>();
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let r: RegExpExecArray | null;
  while ((r = relRe.exec(relsXml)) !== null) {
    const id = attr(r[1], 'Id');
    const target = attr(r[1], 'Target');
    if (id && target) targets.set(id, target);
  }
  const sheetTag = /<sheet\b[^>]*\/?>/.exec(wb.toString('utf8'));
  if (!sheetTag) return null;
  const rid = attr(sheetTag[0], 'r:id') || attr(sheetTag[0], 'id');
  const target = rid ? targets.get(rid) : null;
  if (!target) return entries.has('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : null;
  const normalized = target.replace(/^\/?xl\//, '').replace(/^\//, '');
  const candidate = `xl/${normalized}`;
  return entries.has(candidate) ? candidate
    : entries.has(normalized) ? normalized : null;
}

/**
 * Lit la première feuille d'un .xlsx et renvoie des enregistrements indexés par
 * la première ligne, exactement comme parseCsvRows.
 *
 * Toute cellule est rendue en CHAÎCE : c'est le contrat du parseur CSV, et
 * c'est ce que attendent suggestMapping et applyImportRow en aval. Changer ce
 * contrat pour « aider » l'import ferait diverger les deux chemins.
 */
export function parseXlsxRows(input: Buffer): SheetRecords {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new XlsxError('Fichier vide', 'xlsx_empty');
  }
  const entries = readCentralDirectory(input);
  const sheetPath = firstSheetPath(input, entries);
  if (!sheetPath) throw new XlsxError('Aucune feuille trouvée dans le classeur', 'xlsx_no_sheet');

  const sheet = readEntry(input, entries, sheetPath);
  if (!sheet) throw new XlsxError(`Feuille illisible : ${sheetPath}`, 'xlsx_sheet_unreadable');
  const xml = sheet.toString('utf8');
  const strings = sharedStrings(readEntry(input, entries, 'xl/sharedStrings.xml'));
  const dateStyles = dateStyleSet(readEntry(input, entries, 'xl/styles.xml'));

  const rows: string[][] = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const inner = rowMatch[2] ?? '';
    const cells: string[] = [];
    /*
     * Deux alternatives explicites, et non une fermeture optionnelle.
     *
     * Avec `\/?>((?:[\s\S]*?))(?:<\/c>)?`, le corps non-greedy suivi d'une
     * fermeture FACULTATIVE matche la chaîne vide : le regex s'arrête juste
     * après la balise ouvrante et `<v>…</v>` n'est jamais lu. Toutes les
     * cellules ressortaient vides, toutes les lignes étaient filtrées comme
     * « entièrement vides », et le lecteur renvoyait []. L'échec était
     * silencieux — aucun fichier n'est rejeté, il arrive simplement sans lignes.
     */
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(inner)) !== null) {
      const selfClosing = c[1] !== undefined;
      const tag = selfClosing ? c[1] : c[2];
      const body = selfClosing ? '' : (c[3] || '');
      const type = attr(tag, 't');
      const ref = attr(tag, 'r') || '';
      /* Une cellule vide n'a pas d'attribut r exploitable : on la place dans
         l'ordre d'apparition plutôt que de décaler toute la ligne. */
      const index = ref ? columnIndexOf(ref) : cells.length;
      let value = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        const i = v ? Number(decodeEntities(v[1])) : NaN;
        value = Number.isInteger(i) ? (strings[i] ?? '') : '';
      } else if (type === 'inlineStr') {
        let text = '';
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t: RegExpExecArray | null;
        while ((t = tRe.exec(body)) !== null) text += decodeEntities(t[1]);
        value = text;
      } else if (type === 'e') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? decodeEntities(v[1]) : '';
      } else if (type === 'b') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        const raw = v ? decodeEntities(v[1]) : '';
        if (raw === '') {
          value = '';
        } else {
          const styleIndex = Number(attr(tag, 's') ?? '0');
          const num = Number(raw);
          if (dateStyles.has(styleIndex) && Number.isFinite(num)) {
            /* Une DATE est rendue en ISO : c'est la seule forme que le parseur
               d'import sait relire. Renvoyer « 12/03/2026 » imposerait de
               deviner entre jour/mois et mois/jour selon la locale du fichier. */
            value = excelSerialToIso(num) ?? raw;
          } else {
            value = raw;
          }
        }
      }
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    rows.push(cells);
  }

  /* Les lignes entièrement vides (Excel en écrit après la dernière donnée) sont
     écartées : sinon l'aperçu d'import annonce des lignes qui n'existent pas. */
  const filled = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (filled.length === 0) return [];

  const headers = filled[0].map((h, i) => (h.trim() === '' ? `colonne_${i + 1}` : h.trim()));
  const records: SheetRecords = [];
  for (const row of filled.slice(1)) {
    const record: Record<string, string> = {};
    headers.forEach((h, i) => { record[h] = (row[i] ?? '').trim(); });
    records.push(record);
  }
  return records;
}

/** Signature d'un .xlsx : un ZIP commence par PK\x03\x04. */
export function looksLikeXlsx(input: unknown): boolean {
  return Buffer.isBuffer(input) && input.length > 4
    && input[0] === 0x50 && input[1] === 0x4b
    && (input[2] === 0x03 || input[2] === 0x05 || input[2] === 0x07);
}
