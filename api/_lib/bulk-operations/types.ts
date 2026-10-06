export type BulkProductImportRow = {
  reference: string;
  name: string;
  category?: string;
  sku?: string;
  description?: string;
  weightGrams?: number;
  countryOfManufacture?: string;
  countryOfDesign?: string;
  gtin?: string;
  materialComposition?: string;
};

export type BulkSupplierImportRow = {
  email: string;
  legalName: string;
  displayName?: string;
  countryCode?: string;
  tier?: string;
  contactName?: string;
  contactPhone?: string;
  activityTypes?: string[];
};

export type BulkImportSummary = {
  totalProcessed: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errors: Array<{
    row: number;
    identifier: string;
    message: string;
  }>;
};

export type ExportFormat = 'csv' | 'json';
