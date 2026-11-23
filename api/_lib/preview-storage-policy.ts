import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Stockage PostgreSQL STRICTEMENT reserve a la Preview de la PR #101.
 * Il n'est jamais selectionne par defaut et ne remplace pas S3 en production.
 * Les donnees doivent etre synthetiques et la base independante de production.
 */
export const PREVIEW_STORAGE_MAX_BYTES = 1024 * 1024;
export const PREVIEW_STORAGE_OBJECT_PATH = '/api/preview-storage/object';
export const PREVIEW_STORAGE_CAPABILITY_HEADER = 'x-tracefab-preview-capability';
export const PREVIEW_STORAGE_BRANCH = 'arena/647ac97c-tracefab';
const PREVIEW_STORAGE_ORIGIN = 'https://tracefab-git-arena-b9a1c6-baya-ibraimmayoanouedu-8164s-projects.vercel.app';
const ALLOWED_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_PATTERN = new RegExp(`^${UUID}/${UUID}/[A-Za-z0-9._-]{1,180}$`, 'i');

type PreviewConfig = { origin: string; key: Buffer; presignSeconds: number };
export type PreviewCapability = {
  v: 1;
  method: 'PUT' | 'GET';
  key: string;
  exp: number;
  size?: number;
  contentType?: string;
};

/**
 * Identite NON SECRETE de la cible PostgreSQL (pas de mot de passe ni de
 * nom d'utilisateur). Les parametres pouvant changer la cible sont refuses.
 * L'empreinte ne prouve pas que la base est isolee : l'admin doit le verifier.
 */
export function previewDatabaseFingerprint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('private_storage_preview_database_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error('private_storage_preview_database_invalid');
  }
  const params = [...url.searchParams.entries()].map(([name, value]) => [name.toLowerCase(), value] as const);
  if (params.some(([name]) => ['host', 'hostaddr', 'port', 'dbname', 'service', 'options',
    'ssl', 'uselibpqcompat', 'sslaccept'].includes(name))) {
    throw new Error('private_storage_preview_database_invalid');
  }
  const db = decodeURIComponent(url.pathname.slice(1));
  if (!db || db.includes('/') || url.hash) throw new Error('private_storage_preview_database_invalid');
  const host = url.hostname.toLowerCase();
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  const localTest = local && process.env.NODE_ENV === 'test'
    && process.env.TF_PREVIEW_STORAGE_LOCAL_TEST === '1' && !process.env.VERCEL;
  if (local && !localTest) throw new Error('private_storage_preview_database_invalid');
  const sslModes = [...url.searchParams.entries()].filter(([name]) => name.toLowerCase() === 'sslmode');
  // Les pilotes ne traitent pas toujours les noms/modes en casse variable de
  // la meme facon. verify-full exige chiffrement ET verification du nom.
  if (!local && (sslModes.length !== 1 || sslModes[0][0] !== 'sslmode' || sslModes[0][1] !== 'verify-full')) {
    throw new Error('private_storage_preview_database_tls_required');
  }
  return createHash('sha256').update(`tracefab-preview-db-v1\n${host}\n${url.port || '5432'}\n${db}`).digest('hex');
}

/** Une valeur inconnue echoue ; jamais de repli silencieux vers un stockage. */
export function usesPreviewPostgresStorage(): boolean {
  const backend = process.env.PRIVATE_STORAGE_BACKEND?.trim() || 's3';
  if (backend === 's3') return false;
  if (backend !== 'preview-postgres') throw new Error('private_storage_backend_invalid');
  return true;
}

/** L'empreinte et l'opt-in sont aussi obligatoires pour le provisionnement. */
export function assertPreviewDatabaseTarget(): void {
  if (process.env.VERCEL_ENV !== 'preview'
      || process.env.VERCEL_GIT_COMMIT_REF !== PREVIEW_STORAGE_BRANCH
      || process.env.TF_PREVIEW_STORAGE_TEST_ONLY !== '1') {
    throw new Error('private_storage_preview_not_enabled');
  }
  const databaseUrl = process.env.DATABASE_URL?.trim() || '';
  const fingerprint = previewDatabaseFingerprint(databaseUrl);
  const approved = process.env.TF_PREVIEW_STORAGE_DB_FINGERPRINT?.trim().toLowerCase() || '';
  if (!/^[a-f0-9]{64}$/.test(approved) || approved !== fingerprint) {
    throw new Error('private_storage_preview_database_not_approved');
  }
}

/** Tous les verrous sont evaluates avant signature, lecture ou ecriture. */
export function assertPreviewStorageConfig(): PreviewConfig {
  if (!usesPreviewPostgresStorage()) throw new Error('private_storage_preview_not_enabled');
  assertPreviewDatabaseTarget();
  const clerkSecret = process.env.CLERK_SECRET_KEY?.trim() || '';
  if (!clerkSecret.startsWith('sk_test_') || clerkSecret.length < 24) {
    throw new Error('private_storage_preview_test_key_required');
  }
  const presignSeconds = Number(process.env.PRIVATE_STORAGE_PRESIGN_SECONDS || 600);
  if (!Number.isInteger(presignSeconds) || presignSeconds < 60 || presignSeconds > 600) {
    throw new Error('private_storage_presign_window_invalid');
  }
  let origin = PREVIEW_STORAGE_ORIGIN;
  if (process.env.NODE_ENV === 'test' && process.env.TF_PREVIEW_STORAGE_LOCAL_TEST === '1' && !process.env.VERCEL) {
    const local = new URL(process.env.TF_PREVIEW_STORAGE_LOCAL_ORIGIN || 'http://127.0.0.1:1');
    if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.username || local.password
        || local.pathname !== '/' || local.search || local.hash || !local.port) {
      throw new Error('private_storage_preview_origin_invalid');
    }
    origin = local.origin;
  }
  // Derivation a usage unique depuis la cle Clerk de TEST deja disponible.
  // Ni la cle Clerk ni la cle derivee ne sont jamais envoyees au navigateur.
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(clerkSecret), Buffer.from('tracefab-preview-storage-v1'), Buffer.from(PREVIEW_STORAGE_BRANCH), 32));
  return { origin, key, presignSeconds };
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function makeCapability(payload: PreviewCapability, key: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', key as unknown as Uint8Array<ArrayBuffer>).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function previewSignedObject(method: 'PUT' | 'GET', key: string, contentType?: string, size?: number) {
  const config = assertPreviewStorageConfig();
  if (!validKey(key)) throw new Error('private_storage_preview_key_invalid');
  if (method === 'PUT' && (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > PREVIEW_STORAGE_MAX_BYTES)) {
    throw new Error('document_size_limit_exceeded');
  }
  if (method === 'PUT' && (!contentType || !ALLOWED_TYPES.has(contentType))) {
    throw new Error('document_content_type_not_allowed');
  }
  const payload: PreviewCapability = { v: 1, method, key, exp: Math.floor(Date.now() / 1000) + config.presignSeconds };
  if (method === 'PUT') { payload.size = size; payload.contentType = contentType; }
  return {
    url: `${config.origin}${PREVIEW_STORAGE_OBJECT_PATH}`,
    headers: {
      ...(method === 'PUT' ? { 'Content-Type': 'application/octet-stream' } : {}),
      'X-Tracefab-Preview-Capability': makeCapability(payload, config.key),
    },
  };
}

/** Valide la signature AVANT de decoder la charge ; aucun jeton n'est journalise. */
export function verifyPreviewCapability(raw: unknown, method: string, nowSeconds = Math.floor(Date.now() / 1000)): PreviewCapability | null {
  const config = assertPreviewStorageConfig();
  if (typeof raw !== 'string' || raw.length > 1600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const [encoded, sig] = raw.split('.');
  const expected = createHmac('sha256', config.key as unknown as Uint8Array<ArrayBuffer>).update(encoded).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || actual.toString('base64url') !== sig
      || !timingSafeEqual(actual as unknown as Uint8Array<ArrayBuffer>, expected as unknown as Uint8Array<ArrayBuffer>)) return null;
  let payload: PreviewCapability;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || payload.v !== 1 || payload.method !== method || !validKey(payload.key)
      || !Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds
      || payload.exp > nowSeconds + config.presignSeconds + 1) return null;
  if (payload.method === 'PUT' && (typeof payload.size !== 'number' || !Number.isInteger(payload.size) || payload.size < 1
      || payload.size > PREVIEW_STORAGE_MAX_BYTES || !payload.contentType || !ALLOWED_TYPES.has(payload.contentType))) return null;
  if (payload.method === 'GET' && (payload.size !== undefined || payload.contentType !== undefined)) return null;
  return payload;
}
