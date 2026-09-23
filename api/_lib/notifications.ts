import type { Prisma } from '@prisma/client';

export type OrganizationNotificationAudience = {
  organizationName: string;
  recipients: Array<{ email: string; fullName: string }>;
};

export async function organizationNotificationAudience(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<OrganizationNotificationAudience> {
  const organization = await tx.organizations.findUnique({
    where: { id: organizationId },
    select: {
      legal_name: true,
      display_name: true,
      organization_memberships: {
        where: { status: 'active' },
        select: {
          users_organization_memberships_user_idTousers: {
            select: { email: true, fullName: true },
          },
        },
      },
    },
  });

  if (!organization) {
    return { organizationName: 'Tracefab organization', recipients: [] };
  }

  return {
    organizationName: organization.display_name || organization.legal_name,
    recipients: organization.organization_memberships
      .map(({ users_organization_memberships_user_idTousers: user }) => user)
      .filter((user): user is { email: string; fullName: string } => Boolean(user?.email))
      .map((user) => ({ email: user.email, fullName: user.fullName })),
  };
}
