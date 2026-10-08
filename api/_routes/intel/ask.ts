import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { activeBrandOrganizationIds } from '../../_lib/products.js';

/* Chantier 12 — TRACEFAB Intelligence : moteur de questions DETERMINISTE
   sur les donnees reelles du tenant. Pas de LLM, pas de generation de
   texte : chaque intention (fixed list) est un calcul explicite sur les
   tables certifications / produits / documents, et chaque resultat porte
   sa categorie epistemique (known / inferred / missing / needs_review)
   ainsi que l'entite source reelle (id). Le client formule les phrases ;
   le serveur ne retourne que des faits. Aucune donnee inventee, aucun
   risque fabrique. */

const INTENTS = [
  'certificates_expiring',
  'certificates_expired',
  'certifications_needs_review',
  'products_missing_data',
  'documents_pending',
  'evidence_unlinked',
] as const;

type Intent = (typeof INTENTS)[number];

type Finding = {
  category: 'known' | 'inferred' | 'missing' | 'needs_review';
  entityType: 'certification' | 'product' | 'document';
  id: string;
  label: string;
  sub: string | null;
  daysLeft: number | null;
  expiresAt: string | null;
};

const FINDING_LIMIT = 100;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const intentParam = Array.isArray(req.query.intent) ? req.query.intent[0] : req.query.intent;
    const intent = (INTENTS as readonly string[]).includes(intentParam || '') ? (intentParam as Intent) : null;
    if (!intent) return json(res, 400, { error: 'invalid_intent', intents: INTENTS });
    const windowRaw = Number(Array.isArray(req.query.windowDays) ? req.query.windowDays[0] : req.query.windowDays);
    const windowDays = Number.isFinite(windowRaw) ? Math.min(365, Math.max(1, Math.round(windowRaw))) : 45;

    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandIds = await activeBrandOrganizationIds(tx, user.id);
      if (!brandIds.length) return { empty: true as const };
      const supplierRows = await tx.$queryRaw<Array<{ supplier_organization_id: string }>>`
        SELECT DISTINCT supplier_organization_id
        FROM brand_supplier_relationships
        WHERE brand_organization_id = ANY(${brandIds}::uuid[])
          AND status = 'active'
      `;
      const ownerIds = [...brandIds, ...supplierRows.map((row) => row.supplier_organization_id)];
      const brandIdSet = new Set(brandIds);

      const now = new Date();
      const horizon = new Date(now.getTime() + windowDays * 86400000);
      const findings: Finding[] = [];
      const basedOn = { certifications: 0, products: 0, documents: 0 };

      if (intent === 'certificates_expiring' || intent === 'certificates_expired' || intent === 'certifications_needs_review') {
        const certs = await tx.certifications.findMany({
          where: { owner_organization_id: { in: ownerIds } },
          select: {
            id: true, standard_name: true, certificate_number: true, issuer_name: true,
            expires_at: true, status: true, owner_organization_id: true,
          },
          take: 300,
          orderBy: { expires_at: 'asc' },
        });
        basedOn.certifications = certs.length;
        const owners = await tx.$queryRaw<Array<{ organization_id: string; legal_name: string; display_name: string | null }>>`
          SELECT id::text AS organization_id, legal_name, display_name FROM organizations WHERE id = ANY(${ownerIds}::uuid[])
        `;
        const ownerName = new Map(owners.map((o) => [o.organization_id, o.display_name || o.legal_name]));
        for (const cert of certs) {
          const label = cert.standard_name;
          const sub = [cert.certificate_number, cert.issuer_name, ownerName.get(cert.owner_organization_id) || (brandIdSet.has(cert.owner_organization_id) ? null : 'supplier')].filter(Boolean).join(' · ') || null;
          const expiresAt = cert.expires_at ? cert.expires_at.toISOString() : null;
          const daysLeft = cert.expires_at ? Math.ceil((cert.expires_at.getTime() - now.getTime()) / 86400000) : null;
          const base = { entityType: 'certification' as const, id: cert.id, label, sub, expiresAt };
          if (intent === 'certificates_expiring') {
            if (cert.expires_at && cert.expires_at >= now && cert.expires_at <= horizon) {
              findings.push({ ...base, category: 'known', daysLeft });
            } else if (!cert.expires_at) {
              findings.push({ ...base, category: 'missing', daysLeft: null });
            }
          }
          if (intent === 'certificates_expired' && ((cert.expires_at && cert.expires_at < now) || cert.status === 'expired')) {
            findings.push({ ...base, category: 'known', daysLeft });
          }
          if (intent === 'certifications_needs_review' && ['declared', 'needs_review'].includes(cert.status)) {
            findings.push({ ...base, category: 'needs_review', daysLeft });
          }
          if (findings.length >= FINDING_LIMIT) break;
        }
      }

      if (intent === 'products_missing_data') {
        const products = await tx.tracefab_products.findMany({
          where: { brand_organization_id: { in: brandIds } },
          select: { id: true, name: true, reference: true, data_readiness: true, data_completion: true },
          take: 300,
          orderBy: { data_completion: 'asc' },
        });
        basedOn.products = products.length;
        for (const product of products) {
          const readyPct = Number(product.data_completion);
          const label = `${product.name} (${product.reference})`;
          const sub = `${product.data_readiness} · ${readyPct}%`;
          if (product.data_readiness === 'needs_review') {
            findings.push({ category: 'needs_review', entityType: 'product', id: product.id, label, sub, daysLeft: null, expiresAt: null });
          } else if (product.data_readiness === 'not_started' || readyPct < 50) {
            findings.push({ category: 'missing', entityType: 'product', id: product.id, label, sub, daysLeft: null, expiresAt: null });
          }
          if (findings.length >= FINDING_LIMIT) break;
        }
      }

      if (intent === 'documents_pending' || intent === 'evidence_unlinked') {
        const documents = await tx.documents.findMany({
          where: { owner_organization_id: { in: brandIds }, status: intent === 'documents_pending' ? { in: ['uploaded', 'scanning', 'rejected'] } : { not: 'deleted' } },
          select: {
            id: true, original_filename: true, kind: true, status: true, created_at: true,
            _count: {
              select: {
                certifications: true, data_points: true, data_responses: true,
                supply_chain_nodes: true, supply_chain_links: true,
                product_green_claims: true, transaction_certificates: true,
              },
            },
          },
          take: 300,
          orderBy: { created_at: 'desc' },
        });
        basedOn.documents = documents.length;
        for (const document of documents) {
          const base = { entityType: 'document' as const, id: document.id, label: document.original_filename, sub: `${document.kind} · ${document.status}`, daysLeft: null, expiresAt: null };
          if (intent === 'documents_pending') {
            if (document.status === 'rejected') findings.push({ ...base, category: 'needs_review' });
            else findings.push({ ...base, category: 'known' });
          } else {
            const links = document._count;
            const total = links.certifications + links.data_points + links.data_responses + links.supply_chain_nodes + links.supply_chain_links + links.product_green_claims + links.transaction_certificates;
            if (total === 0 && document.status === 'available') findings.push({ ...base, category: 'inferred' });
          }
          if (findings.length >= FINDING_LIMIT) break;
        }
      }

      return { intent, windowDays, basedOn, findings };
    });

    if (!result || ('empty' in result && result.empty)) return json(res, 200, { intent, windowDays, computedAt: new Date().toISOString(), basedOn: { certifications: 0, products: 0, documents: 0 }, findings: [] });
    return json(res, 200, { ...result, computedAt: new Date().toISOString() });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/intel/ask failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
