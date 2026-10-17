import type { Prisma } from '@prisma/client';
import type { VercelRequest } from './vercel-types.js';

/**
 * Contexte de locataire actif — explicite, obligatoire et valide cote serveur.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * L'incident Production du 2026-10-17 : un administrateur Clerk membre de deux
 * organisations, `Ginger` et `Tracefab Recette Production`, voyait depuis
 * Ginger le produit brouillon `RECETTE-DPP-20261017` qui n'appartient qu'au
 * tenant de recette.
 *
 * La cause n'etait ni RLS ni une politique manquante. Les deux idiomes de
 * bornage existants bornent l'UTILISATEUR, pas le LOCATAIRE ACTIF :
 *
 *   - `activeBrandOrganizationIds(tx, user.id)` puis `{ in: organizationIds }`
 *     retourne l'union de toutes les organisations du compte ;
 *   - `tracefab_can_access_org(org)` repond « cet utilisateur est-il membre ? »,
 *     ce qui est vrai pour Ginger comme pour la recette.
 *
 * Un compte mono-organisation rend les deux idiomes indiscernables d'un vrai
 * bornage tenant. C'est pourquoi le defaut n'a ete visible qu'avec un compte
 * multi-organisations — et pourquoi `scripts/test_cross_tenant.mjs`, qui
 * verifie la PRESENCE des maillons d'isolation et non l'etendue du filtre,
 * laissait passer la route.
 *
 * CE QUE CE MODULE IMPOSE
 *
 * Toute surface privee nomme son locataire. Un locataire absent, mal forme, ou
 * dont l'utilisateur n'est pas membre actif, est refuse AVANT toute requete
 * metier. Il n'existe aucun repli sur « toutes mes organisations » : ce repli
 * etait exactement le defaut.
 */

/** En-tete portant le locataire actif. Prioritaire sur la query string : il ne
 *  peut pas etre ecrase par un lien partage, et il accompagne les requetes qui
 *  n'ont pas de query string (POST, PATCH, DELETE). */
export const TENANT_HEADER = 'x-tracefab-organization-id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TenantError';
    this.status = status;
  }
}

export function isTenantError(error: unknown): error is TenantError {
  return error instanceof TenantError;
}

export type ActiveTenant = {
  organizationId: string;
  role: string;
  organizationType: string;
};

export type TenantScope = {
  /**
   * Restreindre a certains types d'organisation (catalogue, DPP, agregats
   * marque). Les valeurs sont celles de l'enum `organization_type` de
   * prisma/schema.prisma : brand, supplier, verifier, platform. Toute autre
   * valeur est une erreur de compilation, ce qui est voulu — un type
   * d'organisation invente ne doit pas pouvoir passer inapercu.
   */
  types?: Array<'brand' | 'supplier' | 'verifier' | 'platform'>;
  /**
   * Roles admis dans le locataire actif. Absent : tout role actif.
   * Valeurs de l'enum `membership_role`.
   */
  roles?: Array<'owner' | 'admin' | 'manager' | 'contributor' | 'viewer' | 'auditor'>;
};

function firstValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function headerValue(req: VercelRequest, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return firstValue(raw[0]);
  return firstValue(raw);
}

/**
 * Locataire demande par le client, dans l'ordre de precedence :
 * en-tete, puis `organizationId`, puis `brandOrganizationId`.
 *
 * Retourne `null` quand le client n'a rien demande : c'est au point d'appel de
 * decider si l'absence est une erreur (surfaces privees) ou non.
 */
export function requestedTenantId(req: VercelRequest): string | null {
  const fromHeader = headerValue(req, TENANT_HEADER);
  if (fromHeader) return fromHeader;

  const fromQuery = firstValue(req.query.organizationId) ?? firstValue(req.query.brandOrganizationId);
  if (fromQuery) return fromQuery;

  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    for (const key of ['organizationId', 'brandOrganizationId'] as const) {
      const raw = record[key];
      if (typeof raw === 'string') {
        const fromBody = firstValue(raw);
        if (fromBody) return fromBody;
      }
    }
  }

  return null;
}

/**
 * Resout et valide le locataire actif. Echoue toujours plutot que d'elargir.
 *
 * - absent            -> 400 `organization_id_required`
 * - mal forme         -> 400 `invalid_organization_id`
 * - non membre actif  -> 404 `organization_not_found`
 *
 * Le 404 plutot que le 403 sur un locataire non accessible est deliberate :
 * un 403 revelerait que l'organisation existe. L'appelant ne peut pas
 * distinguer « identifiant invalide » de « vous n'y avez pas acces ».
 */
export async function resolveActiveTenant(
  tx: Prisma.TransactionClient,
  userId: string,
  requested: string | null,
  scope: TenantScope = {},
): Promise<ActiveTenant> {
  if (!requested) {
    throw new TenantError(400, 'organization_id_required');
  }
  if (!UUID_RE.test(requested)) {
    throw new TenantError(400, 'invalid_organization_id');
  }

  const membership = await tx.organization_memberships.findFirst({
    where: {
      user_id: userId,
      organization_id: requested,
      status: 'active',
      ...(scope.types && scope.types.length ? { organizations: { type: { in: scope.types } } } : {}),
      ...(scope.roles && scope.roles.length ? { role: { in: scope.roles } } : {}),
    },
    select: {
      organization_id: true,
      role: true,
      organizations: { select: { type: true } },
    },
  });

  if (!membership) {
    // Meme reponse pour « inexistant », « pas membre » et « role insuffisant » :
    // distinguer les trois revelerait l'existence de l'organisation, ou le role
    // exact que l'appelant y detient.
    throw new TenantError(404, 'organization_not_found');
  }

  return {
    organizationId: membership.organization_id,
    role: membership.role,
    organizationType: membership.organizations.type,
  };
}

/**
 * Garde lisible pour les routes : resout le locataire ou leve. A appeler DANS
 * `withTracefabUserContext`, pour que la verification d'appartenance passe par
 * les memes politiques RLS que la requete metier.
 */
export async function requireActiveTenant(
  tx: Prisma.TransactionClient,
  req: VercelRequest,
  userId: string,
  scope: TenantScope = {},
): Promise<ActiveTenant> {
  return resolveActiveTenant(tx, userId, requestedTenantId(req), scope);
}

/**
 * Filtre Prisma bornant une colonne de rattachement AU locataire actif.
 *
 * `{ in: [tenant.organizationId] }` et non `tenant.organizationId` : la forme
 * tableau rend le remplacement d'un bornage multi-organisations mecanique et
 * lisible en revue, sans changer la forme du `where`.
 *
 * Le type de retour est explicite et le tableau mutable : les filtres Prisma
 * attendent `string[]`, et un `as const` produirait un tuple `readonly`
 * non assignable. Le compilateur ne le verrait que sur un client Prisma
 * reellement genere — c'est-a-dire en CI, pas sur un poste ou la generation
 * a echoue.
 */
export function tenantFilter(tenant: ActiveTenant): { in: string[] } {
  return { in: [tenant.organizationId] };
}
