import { COMPANY_TYPES, MATURITIES, PRIORITIES, PIPELINE_STAGES, countryCodeInput } from './crm.js';
import type { ParseResult } from './crm.js';

/**
 * Import CSV — Chantier Admin 03 (§8).
 *
 * Module pur : aucune requête, aucun `process.env`. Tout ce qui peut être décidé
 * sans base l'est ici, et donc testé.
 *
 * Trois règles structurent ce fichier :
 *
 *  1. **Rien n'est inventé.** Une colonne absente du fichier reste absente de la
 *     ligne. Aucun « default » métier n'est fabriqué côté application : si le
 *     fichier ne dit pas la taille, la taille est vide, pas « moyenne ».
 *
 *  2. **La provenance survit (§9).** Chaque ligne importée porte `source`,
 *     `source_detail` et `collected_at`. Sans ces trois champs, un portefeuille
 *     importé devient indiscernable d'un portefeuille saisi — et donc invérifiable.
 *
 *  3. **Un doublon n'est jamais tranché silencieusement.** Il est signalé avec sa
 *     raison et sa ligne existante. Ni saut muet, ni écrasement muet.
 */

export const INTEREST_LEVELS = ['unknown', 'low', 'medium', 'high'] as const;

/**
 * Colonnes importables.
 *
 * `aliases` sont des en-têtes CSV plausibles, normalisés (minuscules, sans
 * accents, séparateurs → `_`) par `normalizeHeaderKey()` du parseur du dépôt.
 * Le mapping est une SUGGESTION : l'opérateur peut toujours le corriger.
 */
export const IMPORT_FIELDS = [
  { key: 'name', type: 'text', required: true, aliases: ['name', 'company', 'company_name', 'organisation', 'organisation_name',
    /* fr */ 'nom', 'nom_de_la_societe', 'nom_societe', 'societe', 'entreprise', 'raison_sociale', 'denomination',
    /* de */ 'firma', 'unternehmen', 'firmenname',
    /* it */ 'nome', 'azienda', 'ragione_sociale',
    /* es / pt */ 'nombre', 'empresa', 'denominacion',
    /* nl */ 'naam', 'bedrijf', 'bedrijfsnaam'] },
  { key: 'website', type: 'text', required: false, aliases: ['website', 'site', 'site_web', 'url', 'domain', 'domaine'] },
  { key: 'country_code', type: 'country', required: false, aliases: ['country', 'country_code', 'country_iso', 'iso', 'pays', 'code_pays',
    'land', 'paese', 'pais', 'staat'] },
  { key: 'city', type: 'text', required: false, aliases: ['city', 'town', 'ville', 'localite', 'stadt', 'citta', 'ciudad', 'stad', 'cidade'] },
  { key: 'industry', type: 'text', required: false, aliases: ['industry', 'sector', 'secteur', 'industrie', 'filiere', 'branche', 'settore', 'segmento'] },
  { key: 'company_type', type: 'company_type', required: false, aliases: ['company_type', 'type', 'type_societe', 'categorie'] },
  { key: 'employee_band', type: 'text', required: false, aliases: ['employee_band', 'employees', 'size', 'taille', 'effectif', 'effectifs', 'salaries',
    'nombre_salaries', 'nb_salaries', 'mitarbeiter', 'dipendenti', 'empleados', 'medewerkers'] },
  { key: 'revenue_band', type: 'text', required: false, aliases: ['revenue_band', 'revenue', 'revenu', 'chiffre_affaires', 'chiffre_d_affaires', 'ca',
    'umsatz', 'fatturato', 'facturacion', 'omzet'] },
  { key: 'product_count', type: 'count', required: false, aliases: ['product_count', 'products', 'produits', 'nombre_produits', 'nb_produits', 'references',
    'produkte', 'prodotti', 'productos', 'producten', 'produtos'] },
  { key: 'supplier_count', type: 'count', required: false, aliases: ['supplier_count', 'suppliers', 'fournisseurs', 'nombre_fournisseurs', 'nb_fournisseurs',
    'lieferanten', 'fornitori', 'proveedores', 'leveranciers', 'fornecedores'] },
  { key: 'maturity', type: 'maturity', required: false, aliases: ['maturity', 'digital_maturity', 'maturite', 'maturite_numerique'] },
  { key: 'priority', type: 'priority', required: false, aliases: ['priority', 'priorite'] },
  { key: 'stage', type: 'stage', required: false, aliases: ['stage', 'pipeline_stage', 'etape', 'statut_pipeline'] },
  { key: 'source', type: 'text', required: false, aliases: ['source', 'origine', 'provenance'] },
  { key: 'source_detail', type: 'text', required: false, aliases: ['source_detail', 'source_details', 'detail_source'] },
  { key: 'collected_at', type: 'date', required: false, aliases: ['collected_at', 'collection_date', 'date_collecte', 'date_de_collecte', 'collected_on'] },
  { key: 'dpp_interest', type: 'interest', required: false, aliases: ['dpp_interest', 'dpp', 'interet_dpp', 'dpp_interet'] },
  { key: 'traceability_interest', type: 'interest', required: false, aliases: ['traceability_interest', 'traceability', 'interet_tracabilite', 'tracabilite'] },
  { key: 'owner_name', type: 'text', required: false, aliases: ['owner', 'owner_name', 'responsable', 'commercial', 'charge_de_compte'] },
  { key: 'notes', type: 'text', required: false, aliases: ['notes', 'note', 'commentaire', 'commentaires', 'remarques'] },
] as const;

export type ImportFieldType = (typeof IMPORT_FIELDS)[number]['type'];

/** En-tête CSV → champ cible suggéré, ou `null` si rien ne correspond. */
export function suggestMapping(headers: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const taken = new Set<string>();

  /* Premier passage : correspondance exacte d'alias. Un en-tête ne peut pas
     revendiquer deux champs, et un champ ne peut pas être revendiqué deux fois —
     sinon deux colonnes « Ville » et « City » écriraient l'une sur l'autre. */
  for (const header of headers) {
    const norm = normalizeHeaderKey(header);
    let hit: string | null = null;
    for (const field of IMPORT_FIELDS) {
      if (taken.has(field.key)) continue;
      if (norm === field.key || (field.aliases as readonly string[]).includes(norm)) {
        hit = field.key;
        break;
      }
    }
    if (hit) {
      out[header] = hit;
      taken.add(hit);
    } else {
      out[header] = null;
    }
  }
  return out;
}

/** Normalisation identique à celle du parseur du dépôt, pour rester cohérent. */
export function normalizeHeaderKey(header: string): string {
  return String(header ?? '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/* -------------------------------------------------------------------------- *
 * Détection de doublons
 * -------------------------------------------------------------------------- */

const LEGAL_SUFFIXES = new Set([
  'sa', 'sarl', 'sas', 'sasu', 'eurl', 'sci', 'scop', 'se',
  'ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'plc', 'lp', 'llp',
  'gmbh', 'ag', 'kg', 'ohg', 'ug', 'eg',
  'srl', 'spa', 'snc', 'sapa', 'scs',
  'bv', 'nv', 'cv', 'vof',
  'ab', 'as', 'aps', 'oy', 'asa',
  'sl', 'sll', 'sc',
]);

/**
 * Nom d'entreprise ramené à sa partie discriminante.
 *
 * « Maison Lumière SAS » et « MAISON LUMIERE » sont la même entreprise ; sans
 * cette normalisation, chaque variante créerait une ligne et le portefeuille se
 * remplirait de fantômes.
 */
export function normalizeCompanyName(name: string): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !LEGAL_SUFFIXES.has(w))
    .join(' ')
    .trim();
}

/** Domaine registrable, ou `null`. `www.` et un chemin sont retirés. */
export function domainOf(website: string | null | undefined): string | null {
  if (!website) return null;
  const raw = String(website).trim().toLowerCase();
  if (!raw) return null;
  const noScheme = raw.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  const host = noScheme.split(/[/?#]/)[0];
  if (!host || !host.includes('.')) return null;
  return host;
}

export interface DuplicateCandidate {
  /** Index dans le fichier importé, 0 = première ligne de données. */
  index: number;
  name: string;
  reason: 'same_name' | 'same_name_and_country' | 'same_domain';
  existingId: string;
  existingName: string;
}

export interface ExistingCompany {
  id: string;
  name: string;
  country_code?: string | null;
  website?: string | null;
}

/**
 * Signale les doublons, sans rien décider.
 *
 * Deux niveaux de certitude, parce qu'ils n'appellent pas la même décision :
 *   - `same_name_and_country` : quasi certain, l'opérateur devra justifier un ajout ;
 *   - `same_name` seul, ou `same_domain` : probable. Deux homonymes dans deux pays
 *     sont deux prospects ; une holding et sa marque partagent souvent un domaine.
 */
export function detectDuplicates(
  rows: Array<{ name?: string | null; country_code?: string | null; website?: string | null }>,
  existing: ExistingCompany[],
): DuplicateCandidate[] {
  const byName = new Map<string, ExistingCompany[]>();
  const byDomain = new Map<string, ExistingCompany>();

  for (const company of existing) {
    const key = normalizeCompanyName(company.name);
    if (key) {
      const list = byName.get(key) || [];
      list.push(company);
      byName.set(key, list);
    }
    const domain = domainOf(company.website);
    if (domain && !byDomain.has(domain)) byDomain.set(domain, company);
  }

  const found: DuplicateCandidate[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const key = normalizeCompanyName(row?.name || '');
    const country = (row?.country_code || '').toUpperCase();

    if (key) {
      const matches = byName.get(key) || [];
      const sameCountry = country
        ? matches.find((m) => (m.country_code || '').toUpperCase() === country)
        : null;
      const hit = sameCountry || matches[0];
      if (hit) {
        found.push({
          index,
          name: row?.name || '',
          reason: sameCountry ? 'same_name_and_country' : 'same_name',
          existingId: hit.id,
          existingName: hit.name,
        });
        continue;
      }
    }

    const domain = domainOf(row?.website);
    const byDomainHit = domain ? byDomain.get(domain) : undefined;
    if (byDomainHit) {
      found.push({
        index,
        name: row?.name || '',
        reason: 'same_domain',
        existingId: byDomainHit.id,
        existingName: byDomainHit.name,
      });
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- *
 * Conversion d'une ligne
 * -------------------------------------------------------------------------- */

const clean = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text.length ? text : null;
};

const parseCount = (value: unknown): number | null => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  /* « 1 200 » et « 1,200 » et « 1.200 » sont tous des milliers, selon la locale
     du fichier. On retire les séparateurs avant de lire le nombre. */
  const digits = text.replace(/[\s\u00a0\u202f]/g, '').replace(/[,.\u202f]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const parsed = Number(digits);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const oneOf = (value: unknown, allowed: readonly string[]) => {
  const norm = normalizeHeaderKey(String(value ?? ''));
  if (!norm) return null;
  return allowed.includes(norm) ? norm : undefined;
};

/**
 * Applique le mapping puis valide.
 *
 * Une colonne présente mais illisible est une ERREUR, pas un silence : importer
 * « FR » dans un champ pays et laisser passer « France » produirait un
 * portefeuille dont on ne sait plus ce qu'il contient.
 */
export function applyImportRow(
  record: Record<string, unknown>,
  mapping: Record<string, string | null>,
): ParseResult<Record<string, unknown>> {
  const errors: string[] = [];
  const data: Record<string, unknown> = {};

  for (const [header, target] of Object.entries(mapping)) {
    if (!target) continue;
    const field = IMPORT_FIELDS.find((f) => f.key === target);
    if (!field) {
      errors.push(`unknown_field_${target}`);
      continue;
    }
    const value = record[normalizeHeaderKey(header)] ?? record[header];

    if (field.type === 'text') {
      const text = clean(value);
      if (text) data[target] = text.length > 4000 ? text.slice(0, 4000) : text;
      continue;
    }
    if (field.type === 'count') {
      const text = clean(value);
      if (!text) continue;
      const count = parseCount(text);
      if (count === null) {
        errors.push(`${target}_must_be_a_number`);
        continue;
      }
      data[target] = count;
      continue;
    }
    if (field.type === 'country') {
      const text = clean(value);
      if (!text) continue;
      /* Lit la valeur entière AVANT de valider. Tronquer à 2 caractères
         transformerait « France » en « Fr », un code ISO valide.
         `countryCodeInput` pousse son propre message : on le remplace par un
         message qui nomme la colonne importée, plus utile à l'opérateur. */
      const before = errors.length;
      const code = countryCodeInput(text, errors);
      if (!code) {
        if (errors.length > before) errors.splice(before, 1);
        errors.push(`${target}_must_be_iso_alpha2`);
        continue;
      }
      data[target] = code;
      continue;
    }
    if (field.type === 'company_type' || field.type === 'maturity'
      || field.type === 'priority' || field.type === 'interest') {
      const allowed = field.type === 'company_type' ? COMPANY_TYPES
        : field.type === 'maturity' ? MATURITIES
          : field.type === 'priority' ? PRIORITIES
            : INTEREST_LEVELS;
      const text = clean(value);
      if (!text) continue;
      const hit = oneOf(text, allowed as readonly string[]);
      if (hit === undefined) {
        errors.push(`${target}_unknown_value`);
        continue;
      }
      data[target] = hit;
      continue;
    }
    if (field.type === 'stage') {
      const text = clean(value);
      if (!text) continue;
      const hit = oneOf(text, [...PIPELINE_STAGES, 'lost']);
      if (hit === undefined) {
        errors.push(`${target}_unknown_value`);
        continue;
      }
      data[target] = hit;
      continue;
    }
    if (field.type === 'date') {
      const text = clean(value);
      if (!text) continue;
      const parsed = Date.parse(text);
      if (Number.isNaN(parsed)) {
        errors.push(`${target}_must_be_a_date`);
        continue;
      }
      data[target] = new Date(parsed).toISOString();
    }
  }

  if (!clean(data.name)) errors.push('name_required');

  /* Un stage `lost` sans motif n'est pas importable : la contrainte en base le
     refuse, autant le dire avant l'écriture. */
  if (data.stage === 'lost' && !clean(data.lost_reason)) errors.push('lost_reason_required');

  if (errors.length) return { data: null, errors };
  return { data, errors: [] };
}

/* -------------------------------------------------------------------------- *
 * Aperçu (§8 : « Preview then Import »)
 * -------------------------------------------------------------------------- */

export interface ImportContext {
  /** Provenance déclarée par l'opérateur. Obligatoire : §9. */
  source: string;
  sourceDetail?: string | null;
  /** Date de collecte. Par défaut : aujourd'hui, jamais une date inventée plus tard. */
  collectedAt?: string | null;
  mapping: Record<string, string | null>;
  existing: ExistingCompany[];
  /** Lignes déjà vues dans CE fichier — un fichier peut se dupliquer lui-même. */
  skipDuplicates?: boolean;
}

export interface ImportRowPreview {
  index: number;
  name: string;
  status: 'new' | 'duplicate' | 'invalid';
  duplicate?: DuplicateCandidate;
  errors?: string[];
  data?: Record<string, unknown>;
}

/**
 * Construit l'aperçu. N'écrit rien.
 *
 * Trois statuts par ligne, et jamais un quatrième : `new`, `duplicate`,
 * `invalid`. Une ligne invalide n'est jamais « corrigée » automatiquement —
 * deviner la valeur d'un champ illisible, c'est inventer une donnée.
 */
export function buildImportPreview(
  records: Array<Record<string, unknown>>,
  context: ImportContext,
): {
  headers: string[];
  mapping: Record<string, string | null>;
  rows: ImportRowPreview[];
  counts: { total: number; new: number; duplicate: number; invalid: number; skipped: number };
  unmapped: string[];
} {
  const headers = records.length ? Object.keys(records[0]) : [];
  const mapping = context.mapping && Object.keys(context.mapping).length
    ? context.mapping
    : suggestMapping(headers);

  const unmapped = headers.filter((h) => !mapping[h]);
  const rows: ImportRowPreview[] = [];
  const seenInFile = new Set<string>();

  let newCount = 0;
  let duplicateCount = 0;
  let invalidCount = 0;
  let skipped = 0;

  for (let index = 0; index < records.length; index += 1) {
    const parsed = applyImportRow(records[index], mapping);
    if (!parsed.data) {
      invalidCount += 1;
      rows.push({
        index,
        name: String(records[index][normalizeHeaderKey('name')] ?? records[index].name ?? ''),
        status: 'invalid',
        errors: parsed.errors,
      });
      continue;
    }

    const data = parsed.data as Record<string, unknown>;
    const duplicate = detectDuplicates([data as never], context.existing)[0]
      || detectDuplicatesFromKey(data, seenInFile);

    if (duplicate) {
      duplicateCount += 1;
      if (context.skipDuplicates) {
        skipped += 1;
        continue;
      }
      rows.push({
        index,
        name: String(data.name || ''),
        status: 'duplicate',
        duplicate,
        data,
      });
      continue;
    }

    const key = normalizeCompanyName(String(data.name || ''));
    if (key) seenInFile.add(key);

    /* Provenance : écrite par l'import, jamais par le fichier. Un fichier qui
       prétend sa propre date de collecte n'est pas une source. */
    data.source = context.source;
    if (context.sourceDetail) data.source_detail = context.sourceDetail;
    data.collected_at = context.collectedAt || new Date().toISOString();

    newCount += 1;
    rows.push({ index, name: String(data.name || ''), status: 'new', data });
  }

  return {
    headers,
    mapping,
    rows,
    counts: { total: records.length, new: newCount, duplicate: duplicateCount, invalid: invalidCount, skipped },
    unmapped,
  };
}

/** Doublon interne au fichier : deux fois la même entreprise dans le même CSV. */
function detectDuplicatesFromKey(
  data: Record<string, unknown>,
  seenInFile: Set<string>,
): DuplicateCandidate | null {
  const key = normalizeCompanyName(String(data.name || ''));
  if (!key || !seenInFile.has(key)) return null;
  return {
    index: -1,
    name: String(data.name || ''),
    reason: 'same_name',
    existingId: 'in_file',
    existingName: String(data.name || ''),
  };
}

/** Filtres persistables dans une liste de prospection (§7). */
export const SAVED_VIEW_FILTER_KEYS = [
  'stage', 'priority', 'country', 'company_type', 'maturity', 'q', 'due',
  'employee_band', 'dpp_interest', 'traceability_interest',
  'product_count_min', 'product_count_max', 'supplier_count_min', 'supplier_count_max',
] as const;

/**
 * Ne conserve que les clés de filtre connues.
 *
 * Un `jsonb` libre accepterait n'importe quoi ; rejouer ensuite un filtre
 * inconnu contre Prisma produirait une erreur opaque, ou pire, un filtre ignoré
 * qui renverrait tout le portefeuille en le faisant passer pour filtré.
 */
export function sanitizeSavedFilters(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(SAVED_VIEW_FILTER_KEYS as readonly string[]).includes(key)) continue;
    const text = String(value ?? '').trim();
    /*
     * Un filtre vide n'est pas persisté. Sans ce garde, `{ q: '' }` produisait un
     * objet non vide, et `POST /api/admin/lists` acceptait une liste sans aucun
     * filtre réel — le garde `no_known_filter` était contourné.
     */
    if (!text || text.length > 200) continue;
    out[key] = text;
  }
  return out;
}
