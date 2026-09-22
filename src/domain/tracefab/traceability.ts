import type {
  DataValueStatus,
  ISODate,
  NodeType,
  SupplyChainLink,
  SupplyChainLinkType,
  SupplyChainNode,
  UUID,
} from './types';

export interface CreateSupplyChainNodeCommand {
  graphProductId: UUID;
  nodeType: NodeType;
  label: string;
  organizationId?: UUID | null;
  supplierSiteId?: UUID | null;
  productId?: UUID | null;
  materialId?: UUID | null;
  processCode?: string | null;
  metadata?: Record<string, unknown>;
  sourceDocumentId?: UUID | null;
  observedAt?: ISODate | null;
}

export interface AddSupplyChainLinkCommand {
  productId: UUID;
  sourceNodeId: UUID;
  targetNodeId: UUID;
  linkType: SupplyChainLinkType;
  sequenceNumber?: number | null;
  validFrom?: ISODate | null;
  validUntil?: ISODate | null;
  evidenceDocumentId?: UUID | null;
  metadata?: Record<string, unknown>;
}

export interface TraceabilityGraph {
  productId: UUID;
  nodes: SupplyChainNode[];
  links: SupplyChainLink[];
}

export interface TraceabilityNodeSummary {
  nodeId: UUID;
  nodeType: NodeType;
  label: string;
  status: DataValueStatus;
}
