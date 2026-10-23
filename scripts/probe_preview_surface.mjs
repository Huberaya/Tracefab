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
 *
 * Les mesures sont aussi emises en annotations : l'hote qui sert les journaux
 * de run n'est pas joignable depuis le bac a sable d'analyse, alors que
 * api.github.com l'est.
 */
import assert from 'node:assert/strict';
import { annoterMesures } from './lib/annotations.mjs';

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
  const mesures = [['preview_hote', origin.hostname]];

  try {
    const health = await fetch(new URL('/api/health', origin));
    const healthBody = await health.text();
    mesures.push(['health_http', health.status]);
    mesures.push(['health_ok', /"ok"\s*:\s*true/.test(healthBody)]);
  } catch (error) {
    mesures.push(['health_http', `000 (${String(error?.message || error).split('\n')[0].slice(0, 60)})`]);
  }

  try {
    const config = await fetch(new URL('/api/config', origin));
    mesures.push(['config_http', config.status]);
    if (config.status === 200) {
      const corps = await config.json().catch(() => ({}));
      const cle = typeof corps?.publishableKey === 'string' ? corps.publishableKey : '';
      let classe = 'absente';
      if (cle.startsWith('pk_test_')) classe = 'pk_test';
      else if (cle.startsWith('pk_live_')) classe = 'pk_live';
      else if (cle) classe = 'inconnue';
      mesures.push(['config_clerk', classe]);
      mesures.push(['config_proxy_url_present', Boolean(corps?.proxyUrl)]);
    }
  } catch (error) {
    mesures.push(['config_http', `000 (${String(error?.message || error).split('\n')[0].slice(0, 60)})`]);
  }

  try {
    const readiness = await fetch(new URL('/api/internal/p2/readiness', origin));
    mesures.push(['readiness_sans_secret_http', readiness.status]);
  } catch (error) {
    mesures.push(['readiness_sans_secret_http', `000 (${String(error?.message || error).split('\n')[0].slice(0, 60)})`]);
  }

  console.log(`--- ${mesures.map(([cle, valeur]) => `${cle}=${valeur}`).join('\n')}`);
  annoterMesures(`Preview ${origin.hostname}`, mesures);
}
