import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The handlers use this small common subset of Vercel's Node adapter types.
 * Keeping the declarations local avoids pulling the adapter's build-time
 * dependency tree into the application just for type-only imports.
 */
export interface VercelRequest extends IncomingMessage {
  body?: unknown;
  cookies?: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
}

export interface VercelResponse extends ServerResponse {
  status(code: number): VercelResponse;
  json(body: unknown): VercelResponse;
  send(body: unknown): VercelResponse;
}
