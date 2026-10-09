/**
 * §6 — Les titres de poste prioritaires.
 *
 * POURQUOI UNE LISTE CANONIQUE
 *   Le cahier des charges nomme dix titres à traiter en priorité : ce sont eux
 *   qui portent la décision d'achat sur la traçabilité. Sans normalisation,
 *   « CEO », « C.E.O. », « Chief Executive Officer » et « PDG » seraient quatre
 *   personnes différentes aux yeux du produit, et la prospection passerait à côté
 *   de la moitié de ses cibles.
 *
 * POURQUOI LES TITRES SONT EN ANGLAIS
 *   Ce sont des identifiants de rôle, pas du texte d'interface : c'est la forme
 *   dans laquelle ils arrivent des fichiers importés et de LinkedIn. Le texte
 *   d'accompagnement, lui, est traduit dans les sept langues. Traduire les
 *   titres eux-mêmes ferait que la suggestion ne correspond plus à ce que
 *   l'utilisateur saisit réellement — ce qui annulerait l'intérêt de la liste.
 *
 * LE CHOIX DÉLIBÉRÉ : ÊTRE ÉTROIT
 *   « Product Manager » n'est PAS un alias de « Digital Product Manager ». Un
 *   faux positif coûte plus cher qu'un oubli : il fait perdre du temps commercial
 *   sur une personne qui ne décide pas, et finit par faire ignorer le signal.
 *   Seuls les équivalents linguistiques et les abréviations du MÊME rôle sont
 *   acceptés.
 *
 * Module PUR — aucun import.
 */

/** Les dix titres du cahier des charges, dans son ordre. */
export const PRIORITY_TITLES = [
  'CEO',
  'Founder',
  'COO',
  'Supply Chain Director',
  'Sustainability Director',
  'Procurement Director',
  'Compliance Director',
  'Digital Product Manager',
  'Product Development Director',
  'CSR/ESG Manager',
] as const;

export type PriorityTitle = (typeof PRIORITY_TITLES)[number];

/**
 * Formes acceptées pour chaque titre : abréviations, formes longues et
 * équivalents dans les langues de l'interface. Tout est comparé après
 * normalisation, donc en minuscules et sans ponctuation.
 */
const ALIASES: Record<PriorityTitle, readonly string[]> = {
  CEO: ['ceo', 'chief executive officer', 'chief executive', 'pdg',
    'président directeur général', 'présidente directrice générale',
    'geschaeftsfuehrer', 'amministratore delegato', 'consejero delegado'],
  Founder: ['founder', 'founders', 'cofounder', 'co founder', 'fondateur', 'fondatrice',
    'gründer', 'gründerin', 'fondatore', 'fundador', 'fundadora', 'oprichter'],
  COO: ['coo', 'chief operating officer', 'directeur des opérations',
    'directrice des opérations', 'direttore operativo', 'director de operaciones'],
  'Supply Chain Director': ['supply chain director', 'director of supply chain',
    'head of supply chain', 'directeur supply chain', 'directrice supply chain',
    'direttore della catena di fornitura', 'leiter lieferkette'],
  'Sustainability Director': ['sustainability director', 'director of sustainability',
    'head of sustainability', 'directeur durabilité', 'directrice durabilité',
    'direttore della sostenibilità', 'director de sostenibilidad',
    'nachhaltigkeitsdirektor'],
  'Procurement Director': ['procurement director', 'director of procurement',
    'head of procurement', 'chief procurement officer', 'cpo',
    'directeur des achats', 'directrice des achats', 'direttore acquisti',
    'einkaufsdirektor'],
  'Compliance Director': ['compliance director', 'director of compliance',
    'head of compliance', 'directeur conformité', 'directrice conformité',
    'direttore compliance', 'director de cumplimiento'],
  'Digital Product Manager': ['digital product manager', 'digital product lead',
    'chef de produit digital', 'chef de produit numérique',
    'responsable de produit numérique', 'digitaler produktmanager'],
  'Product Development Director': ['product development director',
    'director of product development', 'head of product development',
    'directeur du développement produit', 'directrice du développement produit',
    'direttore sviluppo prodotto'],
  'CSR/ESG Manager': ['csr manager', 'esg manager', 'csr esg manager', 'csr/esg manager',
    'responsable rse', 'responsable esg', 'responsable rse esg',
    'responsable rse/esg', 'responsable rse esg', 'esg beauftragter'],
};

/**
 * Réduit un titre à une forme comparable.
 *
 * `C.E.O.` → `ceo`, « Directeur  Supply-Chain » → `directeur supply chain`.
 * Les points, tirets et barres obliques sont des séparateurs, pas du sens : les
 * garder ferait de « C.E.O. » un titre inconnu.
 */
export function normalizeTitle(title: string | null | undefined): string {
  if (typeof title !== 'string') return '';
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // les accents ne doivent pas créer de doublons
    .toLowerCase()
    /*
     * Le point est SUPPRIMÉ, pas remplacé par un espace.
     *
     * C'est la différence entre reconnaître « C.E.O. » et ne pas le reconnaître :
     * un point dans un titre sépare des initiales, pas des mots. Le traiter comme
     * un séparateur donnait « c e o », qui ne correspond à rien.
     *
     * La barre oblique, elle, doit devenir un ESPACE : « CSR/ESG Manager »
     * donne « csr esg manager ». Le rattrapage ci-dessous s'en charge déjà —
     * la nommer ici serait du code mort, et une ligne qui ne change rien finit
     * par être lue comme une garantie.
     */
    .replace(/\./g, '')
    .replace(/[^a-z0-9äöüéèêàâîôûçñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Titre normalisé → titre canonique, ou null. */
const LOOKUP: Map<string, PriorityTitle> = (() => {
  const map = new Map<string, PriorityTitle>();
  for (const canonical of PRIORITY_TITLES) {
    map.set(normalizeTitle(canonical), canonical);
    for (const alias of ALIASES[canonical]) map.set(normalizeTitle(alias), canonical);
  }
  return map;
})();

export function matchPriorityTitle(title: string | null | undefined): PriorityTitle | null {
  const key = normalizeTitle(title);
  if (!key) return null;
  return LOOKUP.get(key) ?? null;
}

export function isPriorityTitle(title: string | null | undefined): boolean {
  return matchPriorityTitle(title) !== null;
}

/**
 * Annote une liste de contacts.
 *
 * Fait côté SERVEUR : la page n'a pas de système de modules et ne peut pas
 * importer ce fichier. Recopier la liste dans le composant créerait deux sources
 * de vérité qui divergeraient — exactement ce que §6 cherche à éviter.
 */
export function annotateContacts<T extends Record<string, unknown>>(
  contacts: T[],
): Array<T & { priority_title: PriorityTitle | null }> {
  if (!Array.isArray(contacts)) return [];
  return contacts.map((c) => ({
    ...c,
    priority_title: matchPriorityTitle(typeof c.job_title === 'string' ? c.job_title : null),
  }));
}
