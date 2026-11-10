#!/usr/bin/env node
/**
 * Contrat statique des routes publiques DPP.
 * La preuve SQL d'etat publie/suspendu reste dans test_neon_dynamic_dpp_lifecycle.
 * Cette suite verrouille le raccord HTTP, le filtre de publication et le cache.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync('api/_routes/dpp/[gtin].ts', 'utf8');
const resolver = readFileSync('api/_lib/wallet/dpp-data-resolver.ts', 'utf8');
const identity = readFileSync('api/_routes/resolve/[publicId].ts', 'utf8');
const page = readFileSync('dpp/index.html', 'utf8');
const client = readFileSync('assets/js/dpp.2.js', 'utf8');

const checks = [
  ['route DPP publique en lecture seule', /req\.method !== 'GET'/.test(route)],
  ['contexte PostgreSQL public explicite', route.includes('withTracefabPublicContext')],
  ['resolution par la fonction canonique DPP', route.includes('resolveDppPassData(tx, gtinOrRef)')],
  ['aucune authentification Clerk sur la lecture publique', !route.includes('requireClerkUser')],
  ['un produit doit porter un public_slug', /public_slug:\s*\{\s*not:\s*null\s*\}/.test(resolver)],
  ['un enregistrement DPP doit etre publie', /readiness_status:\s*'published'/.test(resolver)],
  ['une relecture doit etre horodatee', /reviewed_at:\s*\{\s*not:\s*null\s*\}/.test(resolver)],
  ['historique public limite aux resumes publies', /public_summary\s+IS\s+NOT\s+NULL/i.test(route)],
  ['claims servis par la projection publique SQL', route.includes('tracefab_public_dpp_claims')],
  ['cache public revalide apres 60 secondes', /public, max-age=60, must-revalidate/.test(route)],
  ['aucun stale-while-revalidate apres suspension', !route.includes('stale-while-revalidate')],
  ['identifiant actif conserve sa destination canonique', /row\.status==='replaced'&&row\.replacement_public_id[\s\S]*\/dpp\/\?id=/.test(identity)],
  ['identifiant retire renvoie 410 sans cache', /status==='retired'/.test(identity) && /Cache-Control','no-store'/.test(identity)],
  ['identifiant remplace redirige de facon permanente', /row\.status==='replaced'/.test(identity) && /\?308:302/.test(identity)],
  ['page publique DPP expose un bandeau demo explicitement masque', /id="dpp-demo-banner"[^>]*hidden/.test(page)],
  ['page accepte GTIN, id ou segment de chemin', /params\.get\('gtin'\) \|\| params\.get\('id'\)/.test(client) && /fromPath/.test(client)],
  ['page appelle la route API avec un identifiant encode', /fetch\('\/api\/dpp\/' \+ encodeURIComponent\(id\)/.test(client)],
  ['page nue sans identifiant reste indisponible et signalee', /if \(!id\)[\s\S]*data-dpp-source', 'unavailable'[\s\S]*banner\.hidden = false/.test(client)],
  ['contenu demo masque tant qu aucun identifiant publie n est charge', /html\[data-dpp-requested="true"\].*\[data-dpp-demo-only\]/.test(page) && /html\[data-dpp-source="unavailable"\].*\[data-tf-demo\]/.test(page)],
  ['erreur API neutralise les donnees de demonstration', /neutralizeForMissingPassport\(\)/.test(client) && /Passeport indisponible ou inconnu/.test(client)],
  ['statut live exige une source live et au moins une donnee sourcee', /declared === 'live' && sourcedCount > 0/.test(client)],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log('  ok    ' + label);
  else { failures++; console.error('  ECHEC ' + label); }
}
console.log('\nContrat HTTP DPP public : ' + (checks.length - failures) + '/' + checks.length + ' controles.');
if (failures) process.exit(1);
