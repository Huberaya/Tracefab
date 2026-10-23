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
 *   - le code HTTP et le type de contenu de `/api/health`, `/api/config` et
 *     `/api/internal/p2/readiness` ;
 *   - la CLASSE de la reponse : reponse applicative JSON, ou page de
 *     protection Vercel. Une page de protection est distinguEE par des
 *     marqueurs, jamais par son contenu brut : aucun corps n'est recopie,
 *     aucun en-tete `set-cookie` n'est lu ni affiche ;
 *   - la CLASSE de la cle publique Clerk (pk_test / pk_live / absente), jamais
 *     la cle elle-meme.
 *
 * POURQUOI LA CLASSE DE REPONSE EST MESUREE
 *   Une protection Vercel Authentication repond 200 avec une page HTML : un
 *   simple test HTTP 200 conclurait a tort que l'application a repondu. Or la
 *   distinction « l'application a repondu » / « la protection a repondu » est
 *   exactement ce qui separerait une preuve d'un test non execute.
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
import { readFileSync } from 'node:fs';
import { annoterMesures } from './lib/annotations.mjs';

const depuisFichier = (process.env.TRACEFAB_PREVIEW_URLS_FILE || '').trim();
const cibles = [
  ...(process.env.TRACEFAB_PREVIEW_URLS || process.env.TRACEFAB_STAGING_URL || '')
    .split(','),
  ...(depuisFichier ? readFileSync(depuisFichier, 'utf8').split('\n') : []),
]
  .map((u) => u.trim())
  .filter(Boolean)
  .filter((u, i, tab) => tab.indexOf(u) === i);

if (!cibles.length) {
  console.error('TRACEFAB_PREVIEW_URLS absent : aucune Preview a sonder.');
  process.exit(2);
}

/** Marqueurs de protection Vercel Authentication — jamais le contenu brut. */
const MARQUEURS_PROTECTION = ['vercel_auth_enabled', 'vercel', 'challenge', 'password', 'sign in', 'login'];
/** Marqueurs d'une reponse applicative. */
const MARQUEURS_APPLICATIF = ['publishableKey', '"ok"', 'service', 'tracefab'];

function classerRepponse(corps, contentType) {
  const texte = corps.toLowerCase();
  const protection = MARQUEURS_PROTECTION.filter((m) => texte.includes(m.toLowerCase()));
  const applicatif = MARQUEURS_APPLICATIF.filter((m) => texte.includes(m.toLowerCase()));
  const html = /^\s*(<!doctype html|<html)/i.test(corps);
  let classe = 'inconnue';
  if (html) classe = 'page_html';
  else if (applicatif.length) classe = 'application';
  else if (protection.length) classe = 'protection_possible';
  return { classe, html, marqueursProtection: protection, marqueursApplicatif: applicatif, contentType };
}

// Contournement de la protection de deploiement Vercel — optionnel. La
// valeur ne sort jamais dans l'URL ni dans la sortie.
const vercelBypass = process.env.TRACEFAB_VERCEL_BYPASS?.trim() || '';
const entetes = vercelBypass
  ? { 'x-vercel-protection-bypass': vercelBypass, 'x-vercel-set-bypass-cookie': 'true' }
  : {};

async function sonder(origin, chemin, mesures) {
  try {
    const response = await fetch(new URL(chemin, origin), { redirect: 'manual', headers: entetes });
    const corps = await response.text();
    const info = classerRepponse(corps, response.headers.get('content-type') || '');
    mesures.push([`${chemin}_http`, response.status]);
    mesures.push([`${chemin}_classe`, info.classe]);
    if (info.contentType) mesures.push([`${chemin}_content_type`, info.contentType.split(';')[0]]);
    if (info.marqueursProtection.length) mesures.push([`${chemin}_marqueurs_protection`, info.marqueursProtection.join(',')]);
    if (info.marqueursApplicatif.length) mesures.push([`${chemin}_marqueurs_applicatif`, info.marqueursApplicatif.join(',')]);
    // Destination de la redirection : le CHEMIN et les NOMS de parametres
    // suffisent a nommer le mecanisme. Aucune valeur de parametre n'est lue
    // ni affichee : une URL de protection peut porter un jeton.
    const location = response.headers.get('location');
    if (location) {
      try {
        const cible = new URL(location, origin);
        mesures.push([`${chemin}_redirection_chemin`, cible.pathname]);
        const params = [...cible.searchParams.keys()].sort();
        if (params.length) mesures.push([`${chemin}_redirection_parametres`, params.join(',')]);
      } catch {
        mesures.push([`${chemin}_redirection_chemin`, 'non analysable']);
      }
    }
    return { response, corps, info };
  } catch (error) {
    mesures.push([`${chemin}_http`, `000 (${String(error?.message || error).split('\n')[0].slice(0, 60)})`]);
    return { response: null, corps: '', info: null };
  }
}

for (const cible of cibles) {
  const origin = new URL(cible);
  assert.equal(origin.protocol, 'https:', 'la Preview doit etre en HTTPS');
  const mesures = [['preview_hote', origin.hostname]];

  const health = await sonder(origin, '/api/health', mesures);
  if (health.response && health.info?.classe === 'application') {
    mesures.push(['health_ok', /"ok"\s*:\s*true/.test(health.corps)]);
  }

  const config = await sonder(origin, '/api/config', mesures);
  if (config.response?.status === 200 && config.info?.classe === 'application') {
    let corps = {};
    try { corps = JSON.parse(config.corps); } catch { corps = {}; }
    const cle = typeof corps?.publishableKey === 'string' ? corps.publishableKey : '';
    let classe = 'absente';
    if (cle.startsWith('pk_test_')) classe = 'pk_test';
    else if (cle.startsWith('pk_live_')) classe = 'pk_live';
    else if (cle) classe = 'inconnue';
    mesures.push(['config_clerk', classe]);
    mesures.push(['config_proxy_url_present', Boolean(corps?.proxyUrl)]);
  }

  await sonder(origin, '/api/internal/p2/readiness', mesures);

  console.log(`--- ${mesures.map(([cle, valeur]) => `${cle}=${valeur}`).join('\n    ')}`);
  annoterMesures(`Preview ${origin.hostname}`, mesures);
}
