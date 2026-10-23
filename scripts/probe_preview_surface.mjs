#!/usr/bin/env node
/**
 * Sonde de surface d'une ou plusieurs Previews Vercel, sans aucun secret.
 *
 * POURQUOI CE SCRIPT EXISTE
 *   Le bac a sable d'analyse n'a aucun acces reseau a *.vercel.app : seule une
 *   machine disposant d'Internet peut constater ce que la Preview repond
 *   reellement. Ce script est cette machine.
 *
 * CE QU'IL AFFICHE — par Preview, et pour une seule URL a la fois
 *   - le code HTTP de `/api/health` et de `/api/config` ;
 *   - la CLASSE de la cle publique Clerk (pk_test / pk_live / absente), jamais
 *     la cle elle-meme : une cle publique n'est pas un secret, mais sa valeur
 *     n'a rien a faire dans un journal ;
 *   - le code HTTP de la sonde interne SANS secret : un 401 prouve que la route
 *     existe ET qu'elle est protegee.
 *
 * CE QU'IL NE FAIT PAS
 *   - il n'ecrit rien, ne cree aucun tenant, ne joint aucune base ;
 *   - il ne lit aucun secret ; il ne peut donc pas appeler la sonde interne
 *     avec le secret d'exploitation.
 */
import assert from 'node:assert/strict';

const cibles = (process.env.TRACEFAB_PREVIEW_URLS || process.env.TRACEFAB_STAGING_URL || '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

if (!cibles.length) {
  console.error('TRACEFAB_PREVIEW_URLS absent : aucune Preview a sonder.');
  process.exit(2);
}

for (const cible of cibles) {
  const origin = new URL(cible);
  assert.equal(origin.protocol, 'https:', 'la Preview doit etre en HTTPS');
  console.log(`--- preview_hote=${origin.hostname}`);

  try {
    const health = await fetch(new URL('/api/health', origin));
    const healthBody = await health.text();
    console.log(`health_http=${health.status}`);
    console.log(`health_ok=${/"ok"\s*:\s*true/.test(healthBody)}`);
  } catch (error) {
    console.log(`health_http=000 (${String(error?.message || error).split('\n')[0].slice(0, 80)})`);
  }

  try {
    const config = await fetch(new URL('/api/config', origin));
    console.log(`config_http=${config.status}`);
    if (config.status === 200) {
      const corps = await config.json().catch(() => ({}));
      const cle = typeof corps?.publishableKey === 'string' ? corps.publishableKey : '';
      let classe = 'absente';
      if (cle.startsWith('pk_test_')) classe = 'pk_test';
      else if (cle.startsWith('pk_live_')) classe = 'pk_live';
      else if (cle) classe = 'inconnue';
      console.log(`config_clerk=${classe}`);
      console.log(`config_proxy_url_present=${Boolean(corps?.proxyUrl)}`);
    }
  } catch (error) {
    console.log(`config_http=000 (${String(error?.message || error).split('\n')[0].slice(0, 80)})`);
  }

  try {
    const readiness = await fetch(new URL('/api/internal/p2/readiness', origin));
    console.log(`readiness_sans_secret_http=${readiness.status}`);
  } catch (error) {
    console.log(`readiness_sans_secret_http=000 (${String(error?.message || error).split('\n')[0].slice(0, 80)})`);
  }
}
