import type {
  DppRecord,
  DppReadinessStatus,
  UUID,
} from './types';

export interface ComputeDppReadinessCommand {
  productId: UUID;
  profileKey?: string;
  profileVersion?: string;
}

export interface MarkDppReadyToPublishCommand {
  dppRecordId: UUID;
}

export interface DppReadinessSummary {
  record: DppRecord;
  status: DppReadinessStatus;
  missingRequirementKeys: string[];
  blockingRequirementKeys: string[];
  isPublic: false;
}
