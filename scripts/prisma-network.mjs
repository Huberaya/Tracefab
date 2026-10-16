#!/usr/bin/env node
/**
 * Sonde réseau du checksum du moteur Prisma.
 *
 * Cette sonde ne valide JAMAIS la génération du client. Elle établit seulement
 * que le point de téléchargement Prisma répond par HTTP 2xx (en suivant les
 * redirections HTTPS). La génération réelle et verify_prisma_client.mjs restent
 * les seules preuves d'un client utilisable.
 */
import { request as httpsRequest } from 'node:https';

export const PRISMA_BINARIES_HOST = 'binaries.prisma.sh';
const PRISMA_CHECK_URL = new URL(
  'https://binaries.prisma.sh/all_commits/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x/schema-engine.gz.sha256',
);
const REQUEST_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;

/**
 * Retourne {reachable, statusCode?, reason?, errorCode?, redirects}.
 * `requestImpl` est injectable uniquement pour tester les issues HTTP/réseau
 * sans accès internet. Le chemin par défaut utilise HTTPS vers le binaire Prisma.
 */
export function probePrismaBinaries({
  requestImpl = httpsRequest,
  url = PRISMA_CHECK_URL,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let initialUrl;
    try {
      initialUrl = new URL(url);
    } catch {
      finish({ reachable: false, reason: 'invalid-url', redirects: 0 });
      return;
    }
    if (initialUrl.protocol !== 'https:') {
      finish({ reachable: false, reason: 'insecure-url', redirects: 0 });
      return;
    }

    const requestUrl = (target, redirectsLeft, redirectsFollowed) => {
      if (settled) return;
      let request;
      let responseHandled = false;
      try {
        request = requestImpl(
          {
            hostname: target.hostname,
            port: target.port || 443,
            path: `${target.pathname}${target.search}`,
            method: 'HEAD',
            timeout: timeoutMs,
          },
          (response) => {
            if (settled || responseHandled) return;
            responseHandled = true;
            const statusCode = Number(response.statusCode) || 0;
            const location = response.headers?.location;
            response.resume?.();

            if (statusCode >= 200 && statusCode < 300) {
              finish({ reachable: true, statusCode, redirects: redirectsFollowed });
              return;
            }

            if (statusCode >= 300 && statusCode < 400 && location) {
              if (redirectsLeft <= 0) {
                finish({ reachable: false, reason: 'redirect-limit', statusCode, redirects: redirectsFollowed });
                return;
              }
              let nextUrl;
              try {
                nextUrl = new URL(location, target);
              } catch {
                finish({ reachable: false, reason: 'invalid-redirect', statusCode, redirects: redirectsFollowed });
                return;
              }
              if (nextUrl.protocol !== 'https:') {
                finish({ reachable: false, reason: 'insecure-redirect', statusCode, redirects: redirectsFollowed });
                return;
              }
              requestUrl(nextUrl, redirectsLeft - 1, redirectsFollowed + 1);
              return;
            }

            finish({ reachable: false, reason: 'http', statusCode, redirects: redirectsFollowed });
          },
        );
      } catch (error) {
        finish({
          reachable: false,
          reason: 'network',
          errorCode: error?.code || 'REQUEST_ERROR',
          redirects: redirectsFollowed,
        });
        return;
      }

      request.on('error', (error) => {
        if (settled || responseHandled) return;
        responseHandled = true;
        finish({
          reachable: false,
          reason: 'network',
          errorCode: error?.code || 'REQUEST_ERROR',
          redirects: redirectsFollowed,
        });
      });
      request.on('timeout', () => {
        if (settled || responseHandled) return;
        responseHandled = true;
        finish({ reachable: false, reason: 'timeout', redirects: redirectsFollowed });
        request.destroy();
      });
      request.end();
    };

    requestUrl(initialUrl, maxRedirects, 0);
  });
}
