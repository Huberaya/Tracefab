#!/usr/bin/env node
/**
 * Sonde REELLE de la protection de deploiement Vercel, depuis un runner
 * GitHub (qui a acces a *.vercel.app, contrairement au sandbox d'analyse).
 *
 * Ce script n'utilise AUCUN secret, aucun jeton, aucun cookie. Il emet une
 * seule requete GET sans en-tete d'autorisation vers /api/health de la
 * Preview et verifie que la reponse n'est PAS une reponse applicative 200.
 *
 *  - protection active  -> redirection Vercel /sso-api ou /login, ou page
 *                          identifiee "Protected Deployment" : PASS ;
 *  - 401/403 generique ou redirection tierce -> BLOCKED (pas une preuve) ;
 *  - application 200    -> la protection est ABSENTE : FAIL (exit 1).
 *
 * Seules des donnees non sensibles sont journalisees : code HTTP, nom d'hote
 * de redirection (sans query), type de contenu, booleens. Aucune valeur
 * d'en-tete n'est imprimee.
 */
import { creerExpurgateur, classifierProtection } from './lib/preview_harness_safety.mjs';

const redact = creerExpurgateur([]);

const URL_BRUTE = String(process.env.TF_PREVIEW_URL || '').trim();
if (!URL_BRUTE) {
  console.error('  BLOCKED — TF_PREVIEW_URL absent : aucune sonde lancee.');
  process.exit(2);
}
let cible;
try { cible = new URL(URL_BRUTE); } catch {
  console.error('  REFUS — TF_PREVIEW_URL invalide.');
  process.exit(3);
}
if (cible.protocol !== 'https:' || !cible.hostname.endsWith('.vercel.app')) {
  console.error('  REFUS — seule une Preview HTTPS *.vercel.app peut etre sondee.');
  process.exit(3);
}

const url = new URL('/api/health', cible.origin);
let statut = 0;
let lieu = '';
let cheminRedirection = '';
let typeContenu = '';
let corps = '';
try {
  const reponse = await fetch(url, { method: 'GET', redirect: 'manual' });
  statut = reponse.status;
  const brutLieu = reponse.headers.get('location') || '';
  try {
    if (brutLieu) {
      const destination = new URL(brutLieu, cible.origin);
      lieu = destination.hostname;
      cheminRedirection = destination.pathname; // jamais la query ni les cookies
    }
  } catch { lieu = '(hote illisible)'; }
  typeContenu = (reponse.headers.get('content-type') || '').split(';')[0];
  corps = redact(await reponse.text()).slice(0, 600);
} catch (error) {
  console.error(`  BLOCKED — la Preview est injoignable depuis le runner (${redact(error.message).slice(0, 120)}).`);
  process.exit(2);
}

const { pageProtection, reponseApplicative, verdict } = classifierProtection({
  statut, lieu, chemin: cheminRedirection, typeContenu, corps,
});

console.log(`  sonde_preview                 : ${cible.hostname.replace(/[a-z0-9]{8,}/gi, '<id>')}`);
console.log(`  statut_http                   : ${statut}`);
console.log(`  type_contenu                  : ${typeContenu || '(aucun)'}`);
console.log(`  redirection_hote              : ${lieu || '(aucune)'}`);
console.log(`  page_protection_detectee      : ${pageProtection}`);
console.log(`  reponse_applicative_200       : ${reponseApplicative}`);
// Les journaux Actions peuvent etre inaccessibles hors de GitHub. Une
// annotation non sensible garde le code HTTP et le verdict consultables via
// l'API check-runs, sans en-tete, cookie, URL signee ni corps de reponse.
if (process.env.GITHUB_ACTIONS === 'true') {
  const level = verdict === 'PASS' ? 'notice' : 'warning';
  console.log(`::${level} title=Preview P9::sans bypass, HTTP ${statut}, verdict ${verdict}`);
}

if (verdict === 'FAIL') {
  console.error('  FAIL — la Preview repond 200 sans bypass : la protection de deploiement est ABSENTE.');
  process.exit(1);
}
if (verdict === 'BLOCKED') {
  console.error(`  BLOCKED — reponse inclassable (HTTP ${statut}) : la protection n a pas pu etre confirmee.`);
  process.exit(2);
}
console.log('  PASS — protection Vercel active : un acces sans bypass ne atteint pas l application.');
