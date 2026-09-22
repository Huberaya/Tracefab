import type {
  DataRequest,
  DataRequestItem,
  DataRequestItemStatus,
  DataRequestStatus,
  DataResponse,
  DataType,
  DataValueStatus,
  ISODateTime,
  UUID,
} from './types';

export interface CreateDataRequestCommand {
  brandOrganizationId: UUID;
  supplierOrganizationId: UUID;
  productId: UUID | null;
  title: string;
  questionnaireKey: string;
  questionnaireVersion: string;
  dueAt?: ISODateTime | null;
  idempotencyKey?: string | null;
}

export interface AddDataRequestItemCommand {
  dataRequestId: UUID;
  fieldKey: string;
  label: string;
  dataType: DataType;
  required: boolean;
  evidenceRequired: boolean;
  helpText?: string | null;
  validationRules?: Record<string, unknown>;
  evidenceKinds?: string[];
}

export interface SubmitDataResponseCommand {
  dataRequestItemId: UUID;
  value: unknown;
  sourceDocumentId?: UUID | null;
}

export interface ReviewDataResponseCommand {
  dataResponseId: UUID;
  status: Extract<DataValueStatus, 'verified_by_reviewer' | 'needs_review'>;
  reviewComment?: string | null;
}

export interface DataRequestProgress {
  dataRequestId: UUID;
  status: DataRequestStatus;
  completionPercentage: number;
  requiredItems: number;
  answeredRequiredItems: number;
  items: Array<{
    itemId: UUID;
    status: DataRequestItemStatus;
    required: boolean;
    hasCurrentResponse: boolean;
  }>;
}

export interface DataCollectionBundle {
  request: DataRequest;
  items: DataRequestItem[];
  currentResponses: DataResponse[];
}
