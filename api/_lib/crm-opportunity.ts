/**
 * Opportunité TRACEFAB — Chantier Admin 04 (§4).
 *
 * Module pur. Chaque conclusion cite le champ qui l'a produite, et une absence de
 * donnée ne produit AUCUNE conclusion.
 *
 * Ce n'est pas une prédiction et ce n'est pas du texte marketing : c'est une
 * relecture structurée des champs réellement saisis. Si l'équipe n'a rien saisi,
 * la réponse est « données insuffisantes », jamais une justification inventée.
 */

/** États membres de l'UE — fait, pas interprétation. */
export const EU_MEMBER_STATES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
] as const;

export interface OpportunityInput {
  company_type?: string | null;
  country_code?: string | null;
  product_count?: number | null;
  supplier_count?: number | null;
  maturity?: string | null;
  dpp_interest?: string | null;
  traceability_interest?: string | null;
  stage?: string | null;
  estimated_value_eur?: number | null;
}

export interface Finding {
  /** Clé de traduction. Le libellé vient du dictionnaire, jamais d'ici. */
  code: string;
  /** Le champ et la valeur qui ont produit cette conclusion. */
  evidence: string;
}

export interface OpportunityResult {
  problems: Finding[];
  features: Finding[];
  /** Nombre de signaux réels. 0 → `insufficient`. */
  signals: number;
  insufficient: boolean;
  /** Couches L01–L07 concernées, dans l'ordre du socle. */
  layers: string[];
}

const num = (value: unknown): number | null =>
  (typeof value === 'number' && Number.isFinite(value) ? value : null);

const has = (value: unknown): boolean =>
  value !== null && value !== undefined && String(value).trim() !== '';

/**
 * Seuils explicites.
 *
 * Ils sont arbitraires mais ÉCRITS : un lecteur peut les contester, ce qu'il ne
 * peut pas faire avec un « potentiel élevé » sorti de nulle part.
 */
export const THRESHOLDS = {
  manySuppliers: 20,
  largeCatalogue: 100,
  richSignals: 3,
} as const;

/*
 * La signature accepte aussi un enregistrement brut : la ligne vient de Prisma,
 * dont le type est `Record<string, unknown>` tant que le client n'est pas généré.
 * Le corps lit chaque champ défensivement (`num`, `has`), donc un champ absent ou
 * du mauvais type produit « pas de signal », jamais une exception.
 * `OpportunityInput` reste la documentation du contrat attendu.
 */
export function assessOpportunity(
  rawInput: OpportunityInput | Record<string, unknown>,
): OpportunityResult {
  const input = rawInput as OpportunityInput;
  const problems: Finding[] = [];
  const features: Finding[] = [];
  const layers = new Set<string>();

  const suppliers = num(input.supplier_count);
  const products = num(input.product_count);
  const maturity = has(input.maturity) ? String(input.maturity) : null;
  const country = has(input.country_code) ? String(input.country_code).toUpperCase() : null;
  const dpp = has(input.dpp_interest) ? String(input.dpp_interest) : null;
  const traceability = has(input.traceability_interest) ? String(input.traceability_interest) : null;

  /* --- problèmes probables, chacun ancré dans un champ --- */

  if (suppliers !== null && suppliers >= THRESHOLDS.manySuppliers) {
    problems.push({ code: 'manySuppliers', evidence: `supplier_count = ${suppliers}` });
    layers.add('L01');
    features.push({ code: 'supplyChainMapping', evidence: `supplier_count = ${suppliers}` });

    /* Un grand nombre de fournisseurs ET une maturité faible ou inconnue : la
       consolidation est nécessairement manuelle. Les deux conditions sont
       exigées — l'une seule ne suffit pas à l'affirmer. */
    if (maturity === 'low' || maturity === 'unknown') {
      problems.push({
        code: 'supplierDataManual',
        evidence: `supplier_count = ${suppliers}, maturity = ${maturity}`,
      });
      layers.add('L04');
      features.push({
        code: 'dataQuality',
        evidence: `supplier_count = ${suppliers}, maturity = ${maturity}`,
      });
    }
  }

  if (products !== null && products >= THRESHOLDS.largeCatalogue) {
    problems.push({ code: 'largeCatalogue', evidence: `product_count = ${products}` });
    layers.add('L02');
    features.push({ code: 'productData', evidence: `product_count = ${products}` });

    if (maturity !== 'high') {
      problems.push({
        code: 'catalogueUnstructured',
        evidence: `product_count = ${products}, maturity = ${maturity || 'unknown'}`,
      });
      layers.add('L03');
      features.push({ code: 'evidenceCenter', evidence: `product_count = ${products}` });
    }
  }

  if (country && (EU_MEMBER_STATES as readonly string[]).includes(country)) {
    problems.push({ code: 'esprScope', evidence: `country_code = ${country} (EU)` });
    layers.add('L07');
    features.push({ code: 'dppReadiness', evidence: `country_code = ${country} (EU)` });
  }

  if (dpp === 'high') {
    problems.push({ code: 'declaredDppInterest', evidence: 'dpp_interest = high' });
    layers.add('L07');
    features.push({ code: 'dppReadiness', evidence: 'dpp_interest = high' });
  }

  if (traceability === 'high') {
    problems.push({ code: 'declaredTraceabilityInterest', evidence: 'traceability_interest = high' });
    layers.add('L05');
    features.push({ code: 'traceability', evidence: 'traceability_interest = high' });
  }

  /* Une maturité inconnue est un MANQUE, pas une conclusion. Elle est signalée
     comme telle : c'est la question à poser, pas un diagnostic. */
  if (maturity === 'unknown') {
    problems.push({ code: 'maturityUnknown', evidence: 'maturity = unknown' });
  }

  /* L06 n'est pertinente que si plusieurs signaux convergent. La proposer sur un
     seul champ saisi serait du remplissage. */
  const signals = [
    suppliers !== null && suppliers >= THRESHOLDS.manySuppliers,
    products !== null && products >= THRESHOLDS.largeCatalogue,
    country !== null && (EU_MEMBER_STATES as readonly string[]).includes(country),
    dpp === 'high',
    traceability === 'high',
  ].filter(Boolean).length;

  if (signals >= THRESHOLDS.richSignals) {
    layers.add('L06');
    features.push({ code: 'intelligence', evidence: `signal_count = ${signals}` });
  }

  /* Dédoublonnage en conservant l'ordre : plusieurs signaux peuvent pointer la
     même fonctionnalité, et la répéter trois fois ne la rend pas plus pertinente. */
  const unique = (list: Finding[]) => {
    const seen = new Set<string>();
    return list.filter((f) => (seen.has(f.code) ? false : (seen.add(f.code), true)));
  };

  const sortedLayers = ['L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07']
    .filter((l) => layers.has(l));

  return {
    problems: unique(problems),
    features: unique(features),
    signals,
    insufficient: signals === 0,
    layers: sortedLayers,
  };
}
