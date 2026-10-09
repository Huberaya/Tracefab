/**
 * §8 — Lecture du fichier d'import, CSV ou Excel.
 *
 * POURQUOI UN MODULE PARTAGÉ
 *   `import/preview.ts` et `import/commit.ts` décodent le fichier chacun de leur
 *   côté. Ajouter Excel dans l'un sans l'autre donnerait le pire des comportements
 *   : l'aperçu accepterait le classeur, puis l'import le refuserait. Les deux
 *   portes appellent donc la même fonction.
 *
 * DÉTECTION PAR LE CONTENU, PAS PAR LE NOM
 *   Un `.csv` renommé `.xlsx` (ou l'inverse) arrive. Se fier à l'extension ferait
 *   passer un fichier texte au lecteur ZIP, qui répondrait « archive invalide »
 *   pour un fichier parfaitement lisible. On regarde les quatre premiers octets :
 *   un ZIP commence par `PK`. C'est la signature qui décide, le nom n'informe que
 *   le message renvoyé à l'utilisateur.
 *
 * LA LIMITE PORTE SUR LES OCTETS DÉCODÉS
 *   Le base64 gonfle d'environ un tiers. Comparer la chaîne base64 à la limite
 *   refuserait un fichier de 1,6 Mo et accepterait 2,6 Mo de données réelles.
 */
import { parseCsvRows } from './bulk-operations/csv-parser.js';
import { looksLikeXlsx, parseXlsxRows, XlsxError } from './xlsx-reader.js';

/** 2 Mo une fois décodé : un fichier de prospection raisonnable tient en dessous. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export type ImportFormat = 'csv' | 'xlsx';

/*
 * Le discriminant est une CHAÎNE, pas un booléen.
 *
 * `npm run api:typecheck` lance tsc sur une liste de fichiers explicite, donc
 * SANS tsconfig.json et sans --strict. Sans strictNullChecks, les types
 * littéraux true/false s'élargissent en boolean et un union discriminé par
 * `ok` ne se réduit plus : les deux routes compilaient avec 10 erreurs
 * TS2339. Un discriminant chaîne reste un type unitaire dans ce mode.
 */
export type ImportPayloadResult =
  | { status: 'ok'; records: Array<Record<string, string>>; format: ImportFormat }
  | {
      status: 'error';
      error:
        | 'import_file_required'
        | 'crm_import_file_too_large'
        | 'import_file_unreadable'
        | 'import_file_has_no_data_rows';
      detail?: string;
    };

/** Décode un champ base64 sans lever : un contenu invalide est une erreur métier. */
function decodeBase64(value: string): Buffer | null {
  try {
    const buf = Buffer.from(value, 'base64');
    /* Buffer.from n'échoue jamais : il ignore silencieusement ce qu'il ne sait
       pas décoder. Un base64 tronqué donnerait donc un tampon court et valide en
       apparence — d'où la vérification par réencodage. */
    if (buf.length === 0) return null;
    if (buf.toString('base64').replace(/=+$/, '') !== value.replace(/\s/g, '').replace(/=+$/, '')) {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

export function readImportPayload(
  body: Record<string, unknown>,
  limitBytes: number = MAX_IMPORT_BYTES,
): ImportPayloadResult {
  const file = typeof body.file === 'string' ? body.file.trim() : '';
  const csv = typeof body.csv === 'string' ? body.csv : '';

  if (file) {
    const buf = decodeBase64(file);
    if (!buf) {
      return { status: 'error', error: 'import_file_unreadable', detail: 'base64_invalide' };
    }
    if (buf.length > limitBytes) return { status: 'error', error: 'crm_import_file_too_large' };

    if (looksLikeXlsx(buf)) {
      try {
        const records = parseXlsxRows(buf);
        if (!records.length) return { status: 'error', error: 'import_file_has_no_data_rows' };
        return { status: 'ok', records, format: 'xlsx' };
      } catch (error) {
        /* Un classeur corrompu est une erreur de l'utilisateur, pas une panne :
           on renvoie la raison plutôt qu'un 500 qui ferait croire à un incident. */
        const detail = error instanceof XlsxError ? error.code : 'xlsx_illisible';
        return { status: 'error', error: 'import_file_unreadable', detail };
      }
    }

    /* Pas une signature ZIP : c'est du texte, quelle que soit l'extension. */
    const records = parseCsvRows(buf.toString('utf8'));
    if (!records.length) return { status: 'error', error: 'import_file_has_no_data_rows' };
    return { status: 'ok', records, format: 'csv' };
  }

  if (csv.trim()) {
    if (Buffer.byteLength(csv, 'utf8') > limitBytes) {
      return { status: 'error', error: 'crm_import_file_too_large' };
    }
    const records = parseCsvRows(csv);
    if (!records.length) return { status: 'error', error: 'import_file_has_no_data_rows' };
    return { status: 'ok', records, format: 'csv' };
  }

  return { status: 'error', error: 'import_file_required' };
}

/**
 * Statut HTTP d'une erreur de lecture.
 * Centralisé pour que les deux routes répondent pareil — un 422 d'un côté et un
 * 500 de l'autre pour la même cause rendrait le bug impossible à diagnostiquer.
 */
export function importPayloadStatus(error: string): number {
  if (error === 'crm_import_file_too_large') return 413;
  return 422;
}
