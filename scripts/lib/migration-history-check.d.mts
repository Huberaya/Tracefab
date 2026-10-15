export interface MigrationRecord {
  migration_name: string;
  started_at?: Date | string | null;
  finished_at?: Date | string | null;
  rolled_back_at?: Date | string | null;
}
export interface MigrationHistoryResult {
  ok: boolean;
  diskCount: number;
  applied: string[];
  pending: string[];
  failed: string[];
  unknown: string[];
  errors: string[];
}
export function compareMigrationHistory(
  diskNames: string[],
  records: MigrationRecord[],
): MigrationHistoryResult;
