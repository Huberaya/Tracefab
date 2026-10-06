import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CertificationEvidenceKind = 'certificate' | 'scope_certificate' | 'transaction_certificate' | 'test_report' | 'audit_report';

export type CertificationStandard = {
  code: string;
  name: string;
  issuer: string;
  referenceVersion: string;
  scope: string;
  evidenceKinds: CertificationEvidenceKind[];
  requiredFields: string[];
  officialUrl: string;
  catalogStatus: 'active' | 'superseded';
  claimCaveat: string;
};

type CertificationCatalogFile = {
  catalogVersion: string;
  title: string;
  disclaimer: string;
  standards: CertificationStandard[];
};

const CATALOG_ROOT = join(process.cwd(), 'catalog/certification-standards');
const CATALOG_FILE = join(CATALOG_ROOT, '2026.10.json');
const EVIDENCE_KINDS = new Set<CertificationEvidenceKind>(['certificate', 'scope_certificate', 'transaction_certificate', 'test_report', 'audit_report']);
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,79}$/;
const VERSION_PATTERN = /^\d{4}(?:\.\d+)?$/;

function parseCatalog(): CertificationCatalogFile {
  const value = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as Partial<CertificationCatalogFile>;
  if (typeof value.catalogVersion !== 'string' || !/^\d{4}\.\d+$/.test(value.catalogVersion)) throw new Error('certification_catalog_version_invalid');
  if (typeof value.title !== 'string' || typeof value.disclaimer !== 'string' || !Array.isArray(value.standards) || value.standards.length === 0) throw new Error('certification_catalog_metadata_invalid');
  const standards = value.standards.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('certification_standard_invalid');
    const standard = entry as Partial<CertificationStandard>;
    if (
      typeof standard.code !== 'string' || !CODE_PATTERN.test(standard.code)
      || typeof standard.name !== 'string' || !standard.name.trim()
      || typeof standard.issuer !== 'string' || !standard.issuer.trim()
      || typeof standard.referenceVersion !== 'string' || !VERSION_PATTERN.test(standard.referenceVersion)
      || typeof standard.scope !== 'string' || !standard.scope.trim()
      || !Array.isArray(standard.evidenceKinds) || standard.evidenceKinds.length === 0
      || standard.evidenceKinds.some((kind) => typeof kind !== 'string' || !EVIDENCE_KINDS.has(kind as CertificationEvidenceKind))
      || !Array.isArray(standard.requiredFields) || standard.requiredFields.some((field) => typeof field !== 'string' || !field.trim())
      || typeof standard.officialUrl !== 'string' || !/^https:\/\//.test(standard.officialUrl)
      || (standard.catalogStatus !== 'active' && standard.catalogStatus !== 'superseded')
      || typeof standard.claimCaveat !== 'string' || !standard.claimCaveat.trim()
    ) throw new Error(`certification_standard_invalid:${standard.code ?? 'unknown'}`);
    return {
      code: standard.code,
      name: standard.name,
      issuer: standard.issuer,
      referenceVersion: standard.referenceVersion,
      scope: standard.scope,
      evidenceKinds: [...standard.evidenceKinds] as CertificationEvidenceKind[],
      requiredFields: [...standard.requiredFields],
      officialUrl: standard.officialUrl,
      catalogStatus: standard.catalogStatus,
      claimCaveat: standard.claimCaveat,
    };
  });
  const codes = new Set<string>();
  for (const standard of standards) {
    if (codes.has(standard.code)) throw new Error(`certification_standard_duplicate:${standard.code}`);
    codes.add(standard.code);
  }
  return { catalogVersion: value.catalogVersion, title: value.title, disclaimer: value.disclaimer, standards };
}

let cache: CertificationCatalogFile | null = null;

export function certificationStandardsCatalog() {
  if (!cache) cache = parseCatalog();
  return cache;
}

export function listCertificationStandards() {
  return certificationStandardsCatalog().standards;
}

export function getCertificationStandard(code: unknown) {
  if (typeof code !== 'string') return null;
  return listCertificationStandards().find((standard) => standard.code === code.trim().toUpperCase()) ?? null;
}

export function certificationStandardsSource() {
  const catalog = certificationStandardsCatalog();
  return {
    source: 'versioned_tracefab_certification_catalog',
    catalogVersion: catalog.catalogVersion,
    count: catalog.standards.length,
    disclaimer: catalog.disclaimer,
  };
}
