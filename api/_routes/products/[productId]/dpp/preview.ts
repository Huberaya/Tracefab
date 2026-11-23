import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabRequestContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { accessibleProduct } from '../../../../_lib/quality.js';
import { buildDppSummary, fetchLatestDppRecord } from '../../../../_lib/dpp.js';

/**
 * APERCU PRIVE d'un passeport brouillon — lecture seule.
 *
 * Avant : « Preview DPP · draft » ouvrait /dpp/?gtin=…, une URL PUBLIQUE qui
 * n'affiche un passeport que s'il a ete publie. L'utilisateur ne pouvait donc
 * pas relire son propre dossier avant publication, et croyait parfois voir
 * un produit de demonstration a la place.
 *
 * Cette route relit UNIQUEMENT des donnees persistees : la fiche produit, ses
 * identifiants, sa composition, ses points de donnees declares, les preuves
 * liees au dossier et le dernier enregistrement DPP. Elle n'ecrit rien, ne
 * recalcule rien et ne declenche aucune publication. `accessibleProduct`
 * exige a la fois l'acces a l'organisation et le locataire ACTIF : un
 * identifiant d'un autre tenant repond 404.
 *
 * Le resultat distingue explicitement brouillon / incomplet / valide / publie,
 * affiche les champs manquants et les blocages, et marque chaque valeur avec
 * son statut de confiance. Aucune valeur absente n'est presentee comme
 * verifiee ; aucune exigence reglementaire n'est attestee.
 */
function routeProductId(req: VercelRequest): string | null {
  const value = req.query.productId;
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : null;
}

const toText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });

    const { user } = await requireClerkUser(req);
    const result = await withTracefabRequestContext(req, user, async (tx) => {
      const product = await accessibleProduct(tx, productId);
      if (!product) return null;

      const rows = await tx.$queryRaw<Array<{
        id: string; reference: string; name: string; category: string | null;
        description: string | null; version: number; status: string;
        public_slug: string | null; country_of_manufacture: string | null;
        color_name: string | null; size_range: string[] | null;
        weight_grams: unknown; data_readiness: string; data_completion: unknown;
        created_at: Date; updated_at: Date;
      }>>`
        SELECT id, reference, name, category, description, version, status,
               public_slug, country_of_manufacture, color_name, size_range,
               weight_grams, data_readiness, data_completion, created_at, updated_at
        FROM tracefab_products WHERE id = ${productId}::uuid LIMIT 1
      `;
      if (!rows[0]) return null;
      const p = rows[0];

      const identifiers = await tx.$queryRaw<Array<{ type: string; value: string; is_primary: boolean }>>`
        SELECT identifier_type AS type, identifier_value AS value, is_primary
        FROM product_identifiers WHERE product_id = ${productId}::uuid
        ORDER BY created_at ASC
      `;
      const composition = await tx.$queryRaw<Array<{ material: string | null; role: string | null; percentage: unknown; origin: string | null }>>`
        SELECT m.name AS material, pm.material_role AS role, pm.percentage,
               m.origin_country_code AS origin
        FROM product_materials pm LEFT JOIN materials m ON m.id = pm.material_id
        WHERE pm.product_id = ${productId}::uuid
        ORDER BY pm.product_version DESC, pm.material_role ASC
      `;
      const dataPoints = await tx.$queryRaw<Array<{ key: string; value: unknown; status: string; version: number }>>`
        SELECT data_key AS key, value, status::text AS status, version
        FROM data_points WHERE product_id = ${productId}::uuid
        ORDER BY data_key ASC, version DESC
      `;
      const documents = await tx.$queryRaw<Array<{
        id: string; filename: string; status: string; kind: string; available_at: Date | null;
      }>>`
        SELECT id, original_filename AS filename, status::text AS status,
               kind::text AS kind, available_at
        FROM documents
        WHERE status <> 'deleted'
          AND metadata ->> 'productId' = ${productId}
          AND tracefab_can_access_document(id)
        ORDER BY created_at DESC LIMIT 100
      `;
      const record = await fetchLatestDppRecord(tx, productId);
      const dossier = buildDppSummary(record, productId, p.version);

      return {
        product: {
          id: p.id,
          reference: p.reference,
          name: p.name,
          category: p.category,
          description: p.description,
          version: p.version,
          status: p.status,
          publicSlug: p.public_slug,
          countryOfManufacture: p.country_of_manufacture,
          colorName: p.color_name,
          sizeRange: p.size_range,
          weightGrams: toText(p.weight_grams),
          dataReadiness: p.data_readiness,
          dataCompletion: toText(p.data_completion),
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        },
        identifiers,
        composition: composition.map((entry) => ({
          material: entry.material,
          role: entry.role,
          percentage: entry.percentage === null ? null : String(entry.percentage),
          origin: entry.origin,
        })),
        dataPoints: dataPoints.map((entry) => ({
          key: entry.key,
          value: entry.value,
          status: entry.status,
          version: entry.version,
        })),
        documents: documents.map((entry) => ({
          id: entry.id,
          filename: entry.filename,
          status: entry.status,
          kind: entry.kind,
          availableAt: entry.available_at,
        })),
        dossier,
      };
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });

    const status = result.dossier.readinessStatus;
    const state = status === 'published' ? 'published'
      : status === 'ready_to_publish' ? 'validated'
        : result.dossier.blockingCount > 0 || result.dossier.missingFields.length > 0 ? 'incomplete'
          : 'draft';

    // Un brouillon ne doit jamais etre servi par un cache partage ni indexe.
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return json(res, 200, {
      preview: true,
      private: true,
      published: status === 'published',
      state,
      trust: {
        source: 'persisted_records',
        note: 'Valeurs relues en base. declarees = non verifiees ; documented = preuve liee ; aucun champ absent n est presente comme verifie.',
        legalDisclaimer: 'Profil interne de preparation technique : ce n est ni une certification ni une attestation de conformite reglementaire.',
      },
      generatedAt: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    // Une exception metier SQL levee par une fonction de lecture (profil DPP,
    // acces document) doit garder son code au lieu de devenir un 500 opaque.
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/products/:productId/dpp/preview failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
