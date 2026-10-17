import type { ProductRecord } from './products.js';

export class ProductFieldError extends Error {
  constructor(public field: string, message: string) { super(message); }
}
// ISO 3166-1 alpha-2 assigned codes, not merely any pair of letters.
const ISO2 = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
export type UpdateProductBody = {
  reference?: string;
  sku?: string | null;
  name?: string;
  category?: string | null;
  description?: string | null;
  productFamily?: string | null;
  colorName?: string | null;
  sizeRange?: string[];
  countryOfDesign?: string | null;
  countryOfManufacture?: string | null;
  weightGrams?: number | null;
  careInstructions?: Record<string, unknown> | null;
};

function requiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new ProductFieldError(field, `Texte requis ou longueur invalide (maximum ${maxLength}).`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) throw new ProductFieldError(field, `Texte requis ou longueur invalide (maximum ${maxLength}).`);
  return /^(inconnu|unknown)$/i.test(value.trim()) ? null : value.trim() || null;
}

function countryCode(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ProductFieldError(field, 'Code pays ISO-2 attendu (ex. FR).');
  const code = value.trim().toUpperCase();
  if (!code || /^(INCONNU|UNKNOWN)$/.test(code)) return null;
  if (!ISO2.has(code)) throw new ProductFieldError(field, 'Code pays ISO-2 valide attendu (ex. FR).');
  return code;
}

export function validateProductPatch(body: UpdateProductBody, current: ProductRecord) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProductFieldError('body', 'Un objet JSON est attendu.');
  const allowedKeys = new Set([
    'reference', 'sku', 'name', 'category', 'description', 'productFamily',
    'colorName', 'sizeRange', 'countryOfDesign', 'countryOfManufacture',
    'weightGrams', 'careInstructions',
  ]);
  const unknown = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (unknown) throw new ProductFieldError(unknown, 'Champ non autorisé.');

  const reference = Object.prototype.hasOwnProperty.call(body, 'reference')
    ? requiredString(body.reference, 'reference', 180)
    : current.reference;
  const name = Object.prototype.hasOwnProperty.call(body, 'name')
    ? requiredString(body.name, 'name', 240)
    : current.name;
  const sku = Object.prototype.hasOwnProperty.call(body, 'sku')
    ? optionalString(body.sku, 'sku', 120)
    : current.sku;
  const category = Object.prototype.hasOwnProperty.call(body, 'category')
    ? optionalString(body.category, 'category', 180)
    : current.category;
  const description = Object.prototype.hasOwnProperty.call(body, 'description')
    ? optionalString(body.description, 'description', 10000)
    : current.description;
  const productFamily = Object.prototype.hasOwnProperty.call(body, 'productFamily')
    ? optionalString(body.productFamily, 'productFamily', 180)
    : current.product_family;
  const colorName = Object.prototype.hasOwnProperty.call(body, 'colorName')
    ? optionalString(body.colorName, 'colorName', 120)
    : current.color_name;
  let sizeRange = Object.prototype.hasOwnProperty.call(body, 'sizeRange') ? body.sizeRange : current.size_range;
  const countryOfDesign = Object.prototype.hasOwnProperty.call(body, 'countryOfDesign')
    ? countryCode(body.countryOfDesign, 'countryOfDesign')
    : current.country_of_design;
  const countryOfManufacture = Object.prototype.hasOwnProperty.call(body, 'countryOfManufacture')
    ? countryCode(body.countryOfManufacture, 'countryOfManufacture')
    : current.country_of_manufacture;
  const weightGrams = Object.prototype.hasOwnProperty.call(body, 'weightGrams')
    ? body.weightGrams ?? null
    : current.weight_grams === null ? null : Number(current.weight_grams);
  const careInstructions = Object.prototype.hasOwnProperty.call(body, 'careInstructions')
    ? body.careInstructions ?? {}
    : current.care_instructions;

  if (!Array.isArray(sizeRange) || sizeRange.length > 50 || sizeRange.some((value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 40)) {
    throw new ProductFieldError('sizeRange', 'Saisir au maximum 50 tailles non vides de 40 caractères maximum.');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sizeRange')) sizeRange = sizeRange.map((value) => value.trim());
  if (weightGrams !== null && (typeof weightGrams !== 'number' || !Number.isFinite(weightGrams) || weightGrams < 0 || weightGrams > 1000000)) {
    throw new ProductFieldError('weightGrams', 'Saisir un poids numérique entre 0 et 1 000 000 grammes.');
  }
  if (typeof careInstructions !== 'object' || careInstructions === null || Array.isArray(careInstructions)) {
    throw new ProductFieldError('careInstructions', 'Un objet JSON est attendu.');
  }

  return { reference, sku, name, category, description, productFamily, colorName, sizeRange, countryOfDesign, countryOfManufacture, weightGrams, careInstructions };
}
