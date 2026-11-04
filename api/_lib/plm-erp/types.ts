export const PLM_ERP_SYSTEM_TYPES = [
  'centric_plm',
  'lectra_kubix',
  'sap_s4hana',
  'infor_fashion',
  'gs1_epcis',
  'generic_csv',
] as const;

export type PlmErpSystemType = (typeof PLM_ERP_SYSTEM_TYPES)[number];

export const PLM_ERP_AUTH_TYPES = [
  'api_key',
  'bearer_token',
  'oauth2',
  'webhook',
  'manual_import',
] as const;

export type PlmErpAuthType = (typeof PLM_ERP_AUTH_TYPES)[number];

export function isPlmErpSystemType(value: unknown): value is PlmErpSystemType {
  return typeof value === 'string'
    && (PLM_ERP_SYSTEM_TYPES as readonly string[]).includes(value);
}

export function isPlmErpAuthType(value: unknown): value is PlmErpAuthType {
  return typeof value === 'string'
    && (PLM_ERP_AUTH_TYPES as readonly string[]).includes(value);
}
