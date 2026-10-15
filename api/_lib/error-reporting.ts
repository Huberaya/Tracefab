import { randomUUID } from 'node:crypto';

/**
 * Remontee d'erreurs applicative — neutre vis-a-vis du fournisseur.
 *
 * Deux canaux, dans cet ordre :
 *   1. un journal JSON structure sur stderr, toujours. Vercel le capture ; il
 *      ne depend d'aucun service tiers et survit a la panne du second canal.
 *   2. un POST optionnel vers TRACEFAB_ERROR_WEBHOOK_URL. N'importe quel
 *      collecteur accepte un webhook JSON : Sentry via un relais, Datadog,
 *      Better Stack, ou une fonction maison. Le depot n'ajoute donc aucune
 *      dependance de fournisseur, conformement a son style existant.
 *
 * Trois regles non negociables :
 *   - la remontee ne jette jamais. Un collecteur en panne ne doit pas
 *     transformer une erreur en deuxieme erreur.
 *   - aucun secret ne sort. Les messages d'erreur sont caviardes avant envoi :
 *     une chaine de connexion Postgres ou une cle d'API dans un message
 *     d'exception est un accident frequent.
 *   - aucune donnee personnelle. On transmet un identifiant utilisateur
 *     opaque, jamais une adresse e-mail ni un corps de requete.
 */

export type ErrorContext = {
  route?: string;
  method?: string;
  path?: string;
  userId?: string;
  organizationId?: string;
  status?: number;
  /**
   * Etape qui a echoue. La distinction n'est pas cosmetique : un module de
   * route qui ne se charge pas (dependance absente du paquet deploye) et une
   * exception d'un gestionnaire produisent le meme 500 cote client, alors que
   * les causes, les correctifs et les responsables n'ont rien a voir.
   */
  phase?: 'module_load' | 'handler';
};

export type ErrorReportStatus = 'logged' | 'forwarded' | 'forward_failed';

const SERVICE = 'tracefab-api';

/** Motifs caviardes avant toute sortie. Mieux vaut un message amoindri qu'une
 *  cle d'API archivee pour toujours dans un collecteur de logs. */
const REDACTIONS: Array<[RegExp, string]> = [
  [/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://[caviarde]'],
  [/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{8,}/g, '[cle-caviardee]'],
  [/\bre_[A-Za-z0-9_-]{8,}/g, '[cle-resend-caviardee]'],
  [/\bAKIA[0-9A-Z]{12,}/g, '[cle-aws-caviardee]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [caviarde]'],
  [/\beyJ[A-Za-z0-9._-]{16,}/g, '[jeton-caviarde]'],
  [/([?&](?:token|key|secret|signature|x-amz-credential)=)[^&\s]+/gi, '$1[caviarde]'],
];

export function redact(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

function endpoint() {
  const configured = process.env.TRACEFAB_ERROR_WEBHOOK_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('https_required');
    return url;
  } catch {
    return null;
  }
}

function timeoutMs() {
  const value = Number(process.env.TRACEFAB_ERROR_WEBHOOK_TIMEOUT_MS || 3000);
  return Number.isInteger(value) && value >= 500 && value <= 10000 ? value : 3000;
}

export function errorReportingConfigured() {
  return Boolean(endpoint());
}

/** Identifiant de correlation : rendu au client, present dans le journal et
 *  dans le collecteur. C'est ce que l'utilisateur cite au support. */
export function correlationId() {
  return randomUUID();
}

  function describe(error: unknown) {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code ?? null;
      // Le nom du module absent est la seule information qui distingue
      // « paquet incomplet » de « erreur metier » : sans lui, le journal dit
      // qu'une erreur est survenue, jamais laquelle. Le message est deja
      // caviarde juste apres, et seuls le nom et le code sont extraits.
      const missing = error.message.match(/Cannot find module ['"]([^'"]+)['"]/);
      return {
        name: error.name,
        code,
        moduleSpecifier: missing ? missing[1] : null,
        message: redact(error.message).slice(0, 500),
        // La pile est tronquee : au-dela, c'est du bruit qui coute en stockage.
        stack: error.stack ? redact(error.stack).split('\n').slice(0, 12).join('\n') : null,
      };
    }
    return { name: 'NonError', code: null, moduleSpecifier: null, message: redact(String(error)).slice(0, 500), stack: null };
  }

export async function reportError(
  error: unknown,
  context: ErrorContext = {},
  id: string = correlationId(),
): Promise<ErrorReportStatus> {
  const described = describe(error);
  const payload = {
    schema: 'tracefab-error-report-v1',
    service: SERVICE,
    correlationId: id,
    occurredAt: new Date().toISOString(),
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
    release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null,
    error: described,
      context: {
        route: context.route ?? null,
        method: context.method ?? null,
        path: context.path ? redact(context.path) : null,
        status: context.status ?? 500,
        // Etape de la panne : `module_load` designe un paquet deploye
        // incomplet, `handler` une erreur d execution. C est le champ a
        // interroger en premier dans un journal.
        phase: context.phase ?? 'handler',
      // Identifiants opaques : suffisants pour correler, inutilisables pour
      // identifier une personne depuis le collecteur.
      userId: context.userId ?? null,
      organizationId: context.organizationId ?? null,
    },
  };

  // Canal 1 : toujours. Meme si le canal 2 est absent ou tombe.
  try {
    console.error(JSON.stringify(payload));
  } catch {
    // Un payload non serialisable ne doit pas faire disparaitre l'erreur.
    console.error(`${SERVICE} error ${id}: ${described.name}`);
  }

  const target = endpoint();
  if (!target) return 'logged';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.TRACEFAB_ERROR_WEBHOOK_TOKEN?.trim()
          ? { Authorization: `Bearer ${process.env.TRACEFAB_ERROR_WEBHOOK_TOKEN.trim()}` }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(JSON.stringify({
        service: SERVICE, event: 'error_report_delivery_failed',
        correlationId: id, status: response.status,
      }));
      return 'forward_failed';
    }
    return 'forwarded';
  } catch {
    console.error(JSON.stringify({
      service: SERVICE, event: 'error_report_delivery_failed', correlationId: id,
    }));
    return 'forward_failed';
  } finally {
    clearTimeout(timer);
  }
}
