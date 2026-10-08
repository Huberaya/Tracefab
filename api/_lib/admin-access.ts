import type { VercelRequest } from './vercel-types.js';
import { requireClerkUser } from './auth.js';
import { withTracefabUserContext } from './context.js';
import {
  isAdminAccessDenied,
  selectPlatformAdminAccess,
} from './crm-access.js';
import type { AdminRole, PlatformMembershipCandidate } from './crm-access.js';

/**
 * Résolution de l'accès Admin — partie liée à Clerk et à la base.
 *
 * La règle d'autorisation elle-même vit dans `crm-access.ts`, qui n'importe rien :
 * elle est ainsi exécutable dans un test sans client Prisma généré. Ce fichier ne
 * fait que récupérer les memberships et appliquer la règle.
 */

export { ADMIN_ROLES, isAdminAccessDenied, selectPlatformAdminAccess } from './crm-access.js';
export type { AdminRole, PlatformAdminAccess, PlatformMembershipCandidate } from './crm-access.js';

export interface AdminContext {
  userId: string;
  userEmail: string;
  fullName: string;
  role: AdminRole;
  platformOrganizationId: string;
  organizationName: string;
}

/**
 * Résout le contexte Admin, ou lève `admin_access_denied`.
 *
 * Cet utilisateur est authentisé mais n'est pas Admin : l'appelant doit répondre
 * 403, pas 401. Confondre les deux dirait à un utilisateur légitime que sa session
 * est morte.
 */
export async function requirePlatformAdmin(req: VercelRequest): Promise<AdminContext> {
  const { user } = await requireClerkUser(req);

  const memberships = (await withTracefabUserContext(user.id, user.email, (tx) =>
    tx.organization_memberships.findMany({
      where: { user_id: user.id, status: 'active' },
      select: {
        organization_id: true,
        role: true,
        status: true,
        organizations: {
          select: { id: true, type: true, legal_name: true, display_name: true, status: true },
        },
      },
      orderBy: { created_at: 'asc' },
    }),
  )) as unknown as PlatformMembershipCandidate[];

  const access = selectPlatformAdminAccess(memberships);
  if (!access) {
    throw new Error('admin_access_denied');
  }

  return {
    userId: user.id,
    userEmail: user.email,
    fullName: user.fullName,
    role: access.role,
    platformOrganizationId: access.organization.id,
    organizationName: access.organization.display_name || access.organization.legal_name,
  };
}
