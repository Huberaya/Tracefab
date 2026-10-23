#!/usr/bin/env node
/**
 * Sonde de surface d'une Preview Vercel, sans aucun secret.
 *
 * POURQUOI CE SCRIPT EXISTE
 *   Le bac a sable d'analyse n'a aucun acces reseau a *.vercel.app : seule une
 *   machine disposant d'Internet peut constater ce que la Preview repond
 *   reellement. Ce script est cette machine.
 *
 * CE QU'IL AFFICHE
 *   - le code HTTP de `/api/health` et de `/api/config` ;
 *   - la CLASSE de la cle publique Clerk (pk_test_ / pk_live_ / absente), jamais
 *     la cle elle-meme : une cle publique n'est pas un secret, mais sa valeur
 *     n'a rien a faire dans un journal ;
 *   - la presence des services declares par la sonde de readiness, sans
 *     leurs valeurs.
 *
 * CE QU'IL NE FAIT PAS
 *   - il n'ecrit rien, ne cree aucun tenant, ne joint aucune base ;
 *   - il ne lit aucun secret ; il ne peut donc pas appeler la sonde interne.
 */
import assert from 'node:assert/strict';

const baseUrl = (process.env.TRACEFAB_STAGING_URL || '').trim();
if (!baseUrl) {
  console.error('TRACEFAB_STAGING_URL absent : aucune Preview a sonder.');
  process.exit(2);
}
const origin = new URL(baseUrl);
assert.equal(origin.protocol, 'https:', 'la Preview doit etre en HTTPS');

console.log(`preview_hote=${origin.hostname}`);

const health = await fetch(new URL('/api/health', origin));
console.log(`health_http=${health.status}`);
const healthBody = await health.text();
console.log(`health_ok=${/\"ok\"\s*:\s*true/.test(healthBody)}`);

const config = await fetch(new URL('/api/config', origin));
console.log(`config_http=${config.status}`);
let classeCle = 'absente';
if (config.status === 200) {
  const corps = await config.json().catch(() => ({}));
  const cle = typeof corps?.publishableKey === 'string' ? corps.publishableKey : '';
  if (cle.startsWith('pk_test_')) classeCle = 'pk_test';
  else if (cle.startsWith('pk_live_')) classeCle = 'pk_live';
  else if (cle) classeCle = 'inconnue';
  console.log(`config_clerk=${classeCle}`);
  console.log(`config_proxy_url_present=${Boolean(corps?.proxyUrl)}`);
}

// La sonde interne refuse l'appel sans secret : le statut 401 prouve que la
// route existe ET qu'elle est protegee. Aucun secret n'est utilise ici.
const readiness = await fetch(new URL('/api/internal/p2/readiness', origin));
console.log(`readiness_sans_secret_http=${readiness.status}`);
