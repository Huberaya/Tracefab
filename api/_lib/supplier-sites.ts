import type { Prisma } from '@prisma/client';

export const SUPPLIER_SITE_SELECT = {
  id: true,
  supplier_id: true,
  name: true,
  country_code: true,
  address: true,
  city: true,
  postal_code: true,
  latitude: true,
  longitude: true,
  activity_types: true,
  is_active: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.supplier_sitesSelect;

export type SupplierSiteRecord = Prisma.supplier_sitesGetPayload<{ select: typeof SUPPLIER_SITE_SELECT }>;

export function serializeSupplierSite(site: SupplierSiteRecord) {
  return {
    id: site.id,
    supplierId: site.supplier_id,
    name: site.name,
    countryCode: site.country_code,
    address: site.address,
    city: site.city,
    postalCode: site.postal_code,
    latitude: site.latitude,
    longitude: site.longitude,
    activityTypes: site.activity_types,
    isActive: site.is_active,
    createdAt: site.created_at,
    updatedAt: site.updated_at,
  };
}

export function requiredSiteString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) throw new Error(`invalid_${field}`);
  return value.trim();
}

export function optionalSiteString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) throw new Error(`invalid_${field}`);
  return value.trim() || null;
}

export function siteCountry(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) throw new Error('invalid_site_country_code');
  return value.trim().toUpperCase();
}

export function siteActivityTypes(value: unknown) {
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 120)) {
    throw new Error('invalid_site_activity_types');
  }
  return value.map((item) => item.trim());
}

export function siteCoordinate(value: unknown, field: string, min: number, max: number) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`invalid_${field}`);
  return number;
}

export function siteMutationValues(body: Record<string, unknown>, current?: SupplierSiteRecord) {
  const allowedKeys = new Set(['name', 'countryCode', 'address', 'city', 'postalCode', 'latitude', 'longitude', 'activityTypes', 'isActive']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new Error('invalid_site_fields');
  const name = Object.prototype.hasOwnProperty.call(body, 'name') ? requiredSiteString(body.name, 'site_name', 240) : current?.name;
  const countryCode = Object.prototype.hasOwnProperty.call(body, 'countryCode') ? siteCountry(body.countryCode) : current?.country_code;
  const address = Object.prototype.hasOwnProperty.call(body, 'address') ? optionalSiteString(body.address, 'site_address', 500) : current?.address ?? null;
  const city = Object.prototype.hasOwnProperty.call(body, 'city') ? optionalSiteString(body.city, 'site_city', 160) : current?.city ?? null;
  const postalCode = Object.prototype.hasOwnProperty.call(body, 'postalCode') ? optionalSiteString(body.postalCode, 'site_postal_code', 40) : current?.postal_code ?? null;
  const latitude = Object.prototype.hasOwnProperty.call(body, 'latitude') ? siteCoordinate(body.latitude, 'site_latitude', -90, 90) : current?.latitude ?? null;
  const longitude = Object.prototype.hasOwnProperty.call(body, 'longitude') ? siteCoordinate(body.longitude, 'site_longitude', -180, 180) : current?.longitude ?? null;
  const activityTypes = Object.prototype.hasOwnProperty.call(body, 'activityTypes') ? siteActivityTypes(body.activityTypes) : current?.activity_types ?? [];
  const isActive = Object.prototype.hasOwnProperty.call(body, 'isActive') ? body.isActive : current?.is_active ?? true;
  if (typeof isActive !== 'boolean') throw new Error('invalid_site_active');
  if (!name || !countryCode) throw new Error('invalid_site_fields');
  return { name, countryCode, address, city, postalCode, latitude, longitude, activityTypes, isActive };
}
