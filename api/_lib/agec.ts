/**
 * Déclaration géographique AGEC article 13 (France).
 *
 * L'article 13 de la loi AGEC impose d'informer le consommateur du pays de
 * tissage/tricotage, de teinture/impression et de confection. Ces trois pays ne
 * sont pas une donnée à saisir en plus : ils sont déjà portés par les nœuds de
 * traçabilité du produit (`supply_chain_nodes.process_code` + le pays du site).
 *
 * Ce module les **déduit** donc de la chaîne existante, sans aucune colonne
 * nouvelle. Règle constante : ce qui ne peut pas être établi n'est pas inventé —
 * il remonte dans `gaps`, avec la raison exacte.
 */

export type AgecArticle13Block = {
  tissageTricotage?: string;
  teintureImpression?: string;
  confection?: string;
  microfibresPlastiques?: boolean;
  substancesDangereusesReachSvhc?: boolean;
  primesOuPenalitesEcoOrganisme?: string;
};

export type AgecGapReason =
  | 'no_node'
  | 'no_country'
  | 'ambiguous_country'
  | 'requires_declaration';

export type AgecGap = {
  field: keyof AgecArticle13Block;
  label: string;
  reason: AgecGapReason;
  detail: string;
  countries?: string[];
};

export type AgecDerivation = {
  agec: AgecArticle13Block;
  gaps: AgecGap[];
  /** Provenance de chaque pays retenu : quels nœuds l'ont établi. */
  derivedFrom: Array<{ field: keyof AgecArticle13Block; country: string; nodeIds: string[] }>;
};

/** Nœud minimal nécessaire : ce que renvoie déjà l'API de traçabilité. */
export type AgecSourceNode = {
  id?: string;
  node_type?: string;
  process_code?: string | null;
  site_country?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Vocabulaire aligné sur `groupGraphByStages()` de `_lib/supply-chain.ts` : les
 * mêmes `process_code` classent déjà les nœuds par échelon. Réutiliser cette
 * liste évite deux définitions concurrentes des étapes.
 */
export const AGEC_ART13_STAGES: Record<
  'tissageTricotage' | 'teintureImpression' | 'confection',
  { label: string; processes: readonly string[] }
> = {
  tissageTricotage: {
    label: 'Tissage / Tricotage',
    processes: ['weaving', 'knitting'],
  },
  teintureImpression: {
    label: 'Teinture / Impression',
    processes: ['dyeing', 'printing'],
  },
  confection: {
    label: 'Confection',
    processes: ['cutting', 'sewing', 'assembly'],
  },
};

export type AgecStageField = keyof typeof AGEC_ART13_STAGES;

/** Champs qu'aucune donnée de traçabilité ne peut établir : déclaration humaine. */
export const AGEC_DECLARED_FIELDS: Array<{
  field: keyof AgecArticle13Block;
  label: string;
  detail: string;
}> = [
  {
    field: 'microfibresPlastiques',
    label: 'Rejet de microfibres plastiques',
    detail: "À déclarer : aucun nœud de traçabilité ne porte cette information.",
  },
  {
    field: 'substancesDangereusesReachSvhc',
    label: 'Substances dangereuses (REACH SVHC)',
    detail: "À déclarer : à rattacher à un rapport d'analyse, pas à la chaîne.",
  },
  {
    field: 'primesOuPenalitesEcoOrganisme',
    label: 'Primes / pénalités éco-organisme',
    detail: "À déclarer : relève du contrat éco-organisme, pas de la traçabilité.",
  },
];

const COUNTRY_PATTERN = /^[A-Z]{2}$/;

/**
 * Pays d'un nœud. `site_country` vient de la jointure sur `supplier_sites`
 * (colonne obligatoire, VarChar(2)) ; `metadata` sert de repli quand le nœud
 * n'est pas rattaché à un site mais porte un pays saisi.
 */
export function nodeCountry(node: AgecSourceNode): string | null {
  const candidates = [
    node.site_country,
    (node.metadata?.country_code as string | undefined) ?? null,
    (node.metadata?.country as string | undefined) ?? null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim().toUpperCase();
    if (COUNTRY_PATTERN.test(normalized)) return normalized;
  }
  return null;
}

/**
 * Déduit le bloc AGEC article 13 des nœuds de traçabilité d'un produit.
 *
 * Un pays n'est retenu que s'il est **univoque** : si deux nœuds de la même
 * étape donnent deux pays, le champ reste vide et remonte en
 * `ambiguous_country` avec les deux valeurs. Choisir l'un des deux serait une
 * invention, et c'est précisément ce que la déclaration interdit.
 */
export function deriveAgecArticle13(nodes: AgecSourceNode[] = []): AgecDerivation {
  const agec: AgecArticle13Block = {};
  const gaps: AgecGap[] = [];
  const derivedFrom: AgecDerivation['derivedFrom'] = [];

  for (const field of Object.keys(AGEC_ART13_STAGES) as AgecStageField[]) {
    const stage = AGEC_ART13_STAGES[field];
    const matching = nodes.filter(
      (node) => typeof node.process_code === 'string' && stage.processes.includes(node.process_code),
    );

    if (matching.length === 0) {
      gaps.push({
        field,
        label: stage.label,
        reason: 'no_node',
        detail: `Aucun nœud de traçabilité avec un process_code parmi ${stage.processes.join(', ')}.`,
      });
      continue;
    }

    const byCountry = new Map<string, string[]>();
    for (const node of matching) {
      const country = nodeCountry(node);
      if (!country) continue;
      const ids = byCountry.get(country) ?? [];
      ids.push(node.id ?? '(sans identifiant)');
      byCountry.set(country, ids);
    }

    if (byCountry.size === 0) {
      gaps.push({
        field,
        label: stage.label,
        reason: 'no_country',
        detail: `${matching.length} nœud(s) d'étape « ${stage.label} », mais aucun pays déterminable : rattachez le nœud à un site ou renseignez metadata.country_code.`,
      });
      continue;
    }

    if (byCountry.size > 1) {
      const countries = [...byCountry.keys()].sort();
      gaps.push({
        field,
        label: stage.label,
        reason: 'ambiguous_country',
        detail: `Plusieurs pays pour l'étape « ${stage.label} » (${countries.join(', ')}). La déclaration exige un pays unique : aucun n'est retenu automatiquement.`,
        countries,
      });
      continue;
    }

    const [country, nodeIds] = [...byCountry.entries()][0];
    agec[field] = country;
    derivedFrom.push({ field, country, nodeIds });
  }

  for (const declared of AGEC_DECLARED_FIELDS) {
    gaps.push({
      field: declared.field,
      label: declared.label,
      reason: 'requires_declaration',
      detail: declared.detail,
    });
  }

  return { agec, gaps, derivedFrom };
}

/**
 * Le bloc n'est complet, au sens du validateur, que si les trois pays sont
 * établis. `dpp-validator.ts` exige en outre une longueur >= 2, ce que le
 * format ISO 3166-1 alpha-2 garantit.
 */
export function isAgecGeographyComplete(agec: AgecArticle13Block): boolean {
  return Boolean(agec.tissageTricotage && agec.teintureImpression && agec.confection);
}
