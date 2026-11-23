import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { assertPreviewStorageConfig, PREVIEW_STORAGE_MAX_BYTES } from './preview-storage-policy.js';

/**
 * Table dediee dans une base de TEST deja isolee ; pas de migration de
 * production et aucune creation de table au runtime. L'administrateur la
 * provisionne explicitement avec scripts/provision_preview_storage.ts.
 * RLS exige la cle exacte, armee uniquement pour une transaction courte.
 * Les objets expirent apres 24 h et sont en insertion unique : un PUT encore
 * valide ne peut pas remplacer un objet deja analyse.
 */
export async function assertPreviewTransactionRole(tx: Prisma.TransactionClient): Promise<void> {
  const roles = await tx.$queryRaw<Array<{ role: string; bypass: boolean }>>`
    SELECT current_user::text AS role,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass
  `;
  if (roles[0]?.role !== 'tracefab_app' || roles[0]?.bypass !== false) {
    throw new Error('private_storage_preview_role_invalid');
  }
}

export async function putPreviewObject(key: string, contentType: string, body: Buffer): Promise<boolean> {
  assertPreviewStorageConfig();
  if (!body.length || body.length > PREVIEW_STORAGE_MAX_BYTES) throw new Error('document_size_limit_exceeded');
  return prisma.$transaction(async (tx) => {
    await assertPreviewTransactionRole(tx);
    await tx.$executeRaw`SELECT set_config('tracefab.preview_storage_key', ${key}, true)`;
    const inserted = await tx.$executeRaw`
      INSERT INTO tracefab_preview_store.objects (object_key, content_type, body, expires_at)
      VALUES (${key}, ${contentType}, ${body as unknown as Uint8Array<ArrayBuffer>}, NOW() + INTERVAL '24 hours')
      ON CONFLICT (object_key) DO NOTHING
    `;
    return inserted === 1;
  });
}

export async function headPreviewObject(key: string): Promise<{ byteSize: number; contentType: string }> {
  assertPreviewStorageConfig();
  return prisma.$transaction(async (tx) => {
    await assertPreviewTransactionRole(tx);
    await tx.$executeRaw`SELECT set_config('tracefab.preview_storage_key', ${key}, true)`;
    const rows = await tx.$queryRaw<Array<{ byte_size: number; content_type: string }>>`
      SELECT octet_length(body)::integer AS byte_size, content_type
      FROM tracefab_preview_store.objects
      WHERE object_key = ${key} AND expires_at > NOW()
      LIMIT 1
    `;
    if (!rows[0]) throw new Error('document_object_not_found');
    return { byteSize: Number(rows[0].byte_size), contentType: rows[0].content_type };
  });
}

export async function readPreviewObject(key: string): Promise<ArrayBuffer> {
  assertPreviewStorageConfig();
  return prisma.$transaction(async (tx) => {
    await assertPreviewTransactionRole(tx);
    await tx.$executeRaw`SELECT set_config('tracefab.preview_storage_key', ${key}, true)`;
    const rows = await tx.$queryRaw<Array<{ body: Uint8Array }>>`
      SELECT body FROM tracefab_preview_store.objects
      WHERE object_key = ${key} AND expires_at > NOW()
      LIMIT 1
    `;
    if (!rows[0]) throw new Error('document_object_not_found');
    return Uint8Array.from(rows[0].body).buffer as ArrayBuffer;
  });
}
