import { isUuid } from './products.js';

export const TEXTILE_PROCESS_CODES = [
  'ginning',
  'spinning',
  'weaving',
  'knitting',
  'dyeing',
  'printing',
  'finishing',
  'cutting',
  'sewing',
  'assembly',
  'laundering',
  'packaging',
] as const;

export type TextileProcessCode = (typeof TEXTILE_PROCESS_CODES)[number];

export const PROCESS_LABELS: Record<TextileProcessCode, string> = {
  ginning: 'Égrenage (Ginning)',
  spinning: 'Filature (Spinning)',
  weaving: 'Tissage (Weaving)',
  knitting: 'Tricotage (Knitting)',
  dyeing: 'Teinture (Dyeing)',
  printing: 'Impression (Printing)',
  finishing: 'Ennoblissement / Apprêt (Finishing)',
  cutting: 'Coupe (Cutting)',
  sewing: 'Confection / Coutures (Sewing)',
  assembly: 'Assemblage (Assembly)',
  laundering: 'Lavage / Délavage (Laundering)',
  packaging: 'Conditionnement (Packaging)',
};

export type SupplyChainNodeType = 'product' | 'material' | 'organization' | 'site' | 'process';
export type SupplyChainLinkType =
  | 'sourced_from'
  | 'transformed_at'
  | 'manufactured_at'
  | 'supplied_by'
  | 'contains'
  | 'next_step';

export type SupplyChainNodeRecord = {
  id: string;
  node_type: SupplyChainNodeType;
  label: string;
  organization_id: string | null;
  supplier_site_id: string | null;
  product_id: string | null;
  material_id: string | null;
  process_code: string | null;
  metadata: Record<string, unknown>;
  status: string;
  observed_at: string | null;
  created_at: string;
  site_name?: string | null;
  site_country?: string | null;
  site_city?: string | null;
  material_name?: string | null;
  material_type?: string | null;
  organization_name?: string | null;
  source_document_id: string | null;
};

export type SupplyChainLinkRecord = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  link_type: SupplyChainLinkType;
  sequence_number: number | null;
  valid_from: string | null;
  valid_until: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  evidence_document_id: string | null;
};

export type SupplyChainGraphPayload = {
  product_id: string;
  nodes: SupplyChainNodeRecord[];
  links: SupplyChainLinkRecord[];
};

export function validateNodeInput(body: Record<string, unknown>) {
  const allowedTypes: SupplyChainNodeType[] = ['product', 'material', 'organization', 'site', 'process'];
  const nodeType = body.nodeType as SupplyChainNodeType;
  if (!allowedTypes.includes(nodeType)) throw new Error('invalid_node_type');

  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label || label.length > 240) throw new Error('invalid_node_label');

  const organizationId = body.organizationId ? String(body.organizationId).trim() : null;
  if (organizationId && !isUuid(organizationId)) throw new Error('invalid_organization_id');

  const supplierSiteId = body.supplierSiteId ? String(body.supplierSiteId).trim() : null;
  if (supplierSiteId && !isUuid(supplierSiteId)) throw new Error('invalid_supplier_site_id');

  const materialId = body.materialId ? String(body.materialId).trim() : null;
  if (materialId && !isUuid(materialId)) throw new Error('invalid_material_id');

  const productId = body.productId ? String(body.productId).trim() : null;
  if (productId && !isUuid(productId)) throw new Error('invalid_product_id');

  const processCode = body.processCode ? String(body.processCode).trim() : null;
  if (processCode && processCode.length > 80) throw new Error('invalid_process_code');

  const sourceDocumentId = body.sourceDocumentId ? String(body.sourceDocumentId).trim() : null;
  if (sourceDocumentId && !isUuid(sourceDocumentId)) throw new Error('invalid_source_document_id');

  const observedAt = body.observedAt ? String(body.observedAt).trim() : null;
  if (observedAt && !/^\d{4}-\d{2}-\d{2}$/.test(observedAt)) throw new Error('invalid_observed_at');

  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};

  return {
    nodeType,
    label,
    organizationId,
    supplierSiteId,
    materialId,
    productId,
    processCode,
    metadata,
    sourceDocumentId,
    observedAt,
  };
}

export function validateLinkInput(body: Record<string, unknown>) {
  const sourceNodeId = String(body.sourceNodeId || '').trim();
  if (!isUuid(sourceNodeId)) throw new Error('invalid_source_node_id');

  const targetNodeId = String(body.targetNodeId || '').trim();
  if (!isUuid(targetNodeId)) throw new Error('invalid_target_node_id');
  if (sourceNodeId === targetNodeId) throw new Error('self_referencing_link_not_allowed');

  const allowedLinkTypes: SupplyChainLinkType[] = [
    'sourced_from',
    'transformed_at',
    'manufactured_at',
    'supplied_by',
    'contains',
    'next_step',
  ];
  const linkType = body.linkType as SupplyChainLinkType;
  if (!allowedLinkTypes.includes(linkType)) throw new Error('invalid_link_type');

  let sequenceNumber: number | null = null;
  if (body.sequenceNumber !== undefined && body.sequenceNumber !== null && body.sequenceNumber !== '') {
    sequenceNumber = Number(body.sequenceNumber);
    if (!Number.isInteger(sequenceNumber) || sequenceNumber < 0) throw new Error('invalid_sequence_number');
  }

  const validFrom = body.validFrom ? String(body.validFrom).trim() : null;
  if (validFrom && !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) throw new Error('invalid_valid_from');

  const validUntil = body.validUntil ? String(body.validUntil).trim() : null;
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new Error('invalid_valid_until');

  if (validFrom && validUntil && validFrom > validUntil) {
    throw new Error('invalid_link_date_range');
  }

  const evidenceDocumentId = body.evidenceDocumentId ? String(body.evidenceDocumentId).trim() : null;
  if (evidenceDocumentId && !isUuid(evidenceDocumentId)) throw new Error('invalid_evidence_document_id');

  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};

  return {
    sourceNodeId,
    targetNodeId,
    linkType,
    sequenceNumber,
    validFrom,
    validUntil,
    evidenceDocumentId,
    metadata,
  };
}

export function groupGraphByStages(nodes: SupplyChainNodeRecord[]) {
  const stages = {
    tier4_raw_materials: [] as SupplyChainNodeRecord[],
    tier3_spinning: [] as SupplyChainNodeRecord[],
    tier2_fabric: [] as SupplyChainNodeRecord[],
    tier1_assembly: [] as SupplyChainNodeRecord[],
    tier0_product: [] as SupplyChainNodeRecord[],
    other_nodes: [] as SupplyChainNodeRecord[],
  };

  for (const node of nodes) {
    if (node.node_type === 'product') {
      stages.tier0_product.push(node);
    } else if (node.node_type === 'material') {
      stages.tier4_raw_materials.push(node);
    } else if (node.process_code === 'spinning' || node.process_code === 'ginning') {
      stages.tier3_spinning.push(node);
    } else if (['weaving', 'knitting', 'dyeing', 'printing', 'finishing'].includes(node.process_code || '')) {
      stages.tier2_fabric.push(node);
    } else if (['cutting', 'sewing', 'assembly', 'laundering', 'packaging'].includes(node.process_code || '')) {
      stages.tier1_assembly.push(node);
    } else if (node.node_type === 'site' || node.node_type === 'organization') {
      // Sites without explicit process assigned go to other or site stages
      stages.other_nodes.push(node);
    } else {
      stages.other_nodes.push(node);
    }
  }

  return stages;
}

export function computeTraceabilitySummary(nodes: SupplyChainNodeRecord[], links: SupplyChainLinkRecord[]) {
  const documentedNodes = nodes.filter((n) => n.status === 'documented' || n.status === 'verified_by_reviewer' || n.source_document_id);
  const documentedLinks = links.filter((l) => l.status === 'documented' || l.status === 'verified_by_reviewer' || l.evidence_document_id);

  const totalEntities = nodes.length + links.length;
  const totalDocumented = documentedNodes.length + documentedLinks.length;
  const documentationRate = totalEntities > 0 ? Math.round((totalDocumented / totalEntities) * 100) : 0;

  // Process distinct stages covered
  const stagesCovered = new Set<string>();
  nodes.forEach((n) => {
    if (n.process_code) stagesCovered.add(n.process_code);
    if (n.node_type === 'material') stagesCovered.add('material');
    if (n.node_type === 'product') stagesCovered.add('product');
  });

  return {
    nodeCount: nodes.length,
    linkCount: links.length,
    documentedNodeCount: documentedNodes.length,
    documentedLinkCount: documentedLinks.length,
    documentationRate,
    stagesCoveredCount: stagesCovered.size,
    isCompleteChain: stagesCovered.has('material') && stagesCovered.has('product') && nodes.some((n) => n.node_type === 'site'),
  };
}
