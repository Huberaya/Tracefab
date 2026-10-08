/**
 * POST /api/leads — capture pre-tenant des leads du site public.
 *
 * Endpoint public (aucune session Clerk) : l'insertion est encadree par
 *   1. une validation stricte des champs ;
 *   2. une limitation de debit best-effort par adresse IP (les fonctions
 *      serverless ne partagent pas d'etat durable : c'est un garde-fou,
 *      pas un rate limiter distribue — voir Chantier 16) ;
 *   3. le contexte transactionnel tracefab.public_ingest, seule condition
 *      d'ouverture de la politique RLS d'insertion sur tracefab_leads.
 *
 * Aucune donnee d'en-tete ni adresse IP n'est persistee : uniquement les
 * champs du formulaire et l'URL de la page d'origine.
 */
import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { prisma } from '../_lib/prisma.js';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http.js';
import { sendLeadNotificationEmail } from '../_lib/email.js';

const KINDS = new Set(['demo', 'contact', 'pilot']);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* -- Limitation de debit best-effort par IP ------------------------------ */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 3;
const rateBuckets = new Map<string, { windowStart: number; count: number }>();

function clientAddress(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const value = typeof first === 'string' ? first.split(',')[0]?.trim() : '';
  return value || 'unknown';
}

function rateLimited(address: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(address);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(address, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX_PER_WINDOW;
}

/* -- Validation ----------------------------------------------------------- */
type LeadBody = {
  kind?: unknown;
  name?: unknown;
  email?: unknown;
  company?: unknown;
  role?: unknown;
  message?: unknown;
  sourceUrl?: unknown;
};

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return cleanText(value, maxLength);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const address = clientAddress(req);
  if (rateLimited(address)) return json(res, 429, { error: 'rate_limited' });

  let body: LeadBody;
  try {
    body = await readJsonBody<LeadBody>(req);
  } catch {
    return json(res, 400, { error: 'invalid_json_body' });
  }

  const kind = typeof body.kind === 'string' && KINDS.has(body.kind) ? body.kind : null;
  const name = cleanText(body.name, 120);
  const email = cleanText(body.email, 254);
  if (!kind) return json(res, 400, { error: 'invalid_kind' });
  if (!name) return json(res, 400, { error: 'invalid_name' });
  if (!email || !EMAIL_RE.test(email)) return json(res, 400, { error: 'invalid_email' });

  const company = optionalText(body.company, 160);
  const role = optionalText(body.role, 80);
  const message = optionalText(body.message, 2000);
  /* company obligatoire pour une demande de pilote : c'est l'objet meme du lot. */
  if (kind === 'pilot' && !company) return json(res, 400, { error: 'invalid_company' });
  if ((body.role !== undefined && body.role !== null && body.role !== '') && role === null) {
    return json(res, 400, { error: 'invalid_role' });
  }
  if ((body.message !== undefined && body.message !== null && body.message !== '') && message === null) {
    return json(res, 400, { error: 'invalid_message' });
  }

  let sourceUrl: string | null = null;
  if (body.sourceUrl !== undefined && body.sourceUrl !== null && body.sourceUrl !== '') {
    if (typeof body.sourceUrl !== 'string' || body.sourceUrl.trim().length > 500) {
      return json(res, 400, { error: 'invalid_source_url' });
    }
    try {
      const parsed = new URL(body.sourceUrl.trim());
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return json(res, 400, { error: 'invalid_source_url' });
      }
      sourceUrl = parsed.toString().slice(0, 500);
    } catch {
      return json(res, 400, { error: 'invalid_source_url' });
    }
  }

  let leadId: string;
  try {
    const inserted = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('tracefab.public_ingest', 'true', true)`;
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO tracefab_leads (kind, full_name, email, company, role, message, source_url)
        VALUES (${kind}, ${name}, ${email.toLowerCase()}, ${company}, ${role}, ${message}, ${sourceUrl})
        RETURNING id
      `;
      return rows[0]?.id;
    });
    if (!inserted) throw new Error('lead_insert_failed');
    leadId = inserted;
  } catch (error) {
    console.error('[tracefab] lead insert failed', { error: String(error) });
    return json(res, 502, { error: 'lead_unavailable' });
  }

  /* Notification commerciale : opportunite, jamais bloquante. Le lead est
     deja persiste ; un echec d'email ne doit pas faire perdre la demande. */
  try {
    await sendLeadNotificationEmail({ kind, name, email, company, role, message, sourceUrl });
  } catch (error) {
    console.error('[tracefab] lead notification failed', { error: String(error) });
  }

  return json(res, 201, { status: 'recorded', id: leadId });
}
