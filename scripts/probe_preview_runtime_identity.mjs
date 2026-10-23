#!/usr/bin/env node
/**
 * Sonde d'identite du role DB runtime, executee sur une Preview.
 *
 * POURQUOI CE SCRIPT EXISTE
 *   La RLS ne protege que si le role applicatif n'a pas BYPASSRLS. Or
 *   l'identite reellement utilisee par le runtime ne se deduit ni du code ni
 *   de la configuration attendue : seul un `current_user` lu sur la connexion
 *   reelle la dit. La route `/api/internal/p2/readiness?identity=1` fait
 *   exactement cela, avec le meme client Prisma que les routes metier.
 *
 *   Cette sonde est donc le SEUL moyen de mesurer l'identite du runtime, et
 *   elle doit etre executee sur le deploiement reellement utilise.
 *
 * CE QU'IL AFFICHE
 *   - le role courant et le role de session (noms de roles, pas de secrets) ;
 *   - les deux booleens de securite : contournement RLS et superutilisateur ;
 *   - le verdict, c'est-a-dire la correspondance avec le contrat de securite
 *     (`tracefab_app`, sans contournement, sans superutilisateur).
 *
 * CE QU'IL NE FAIT JAMAIS
 *   - il ne place le secret ni dans l'URL ni dans un argument de ligne de
 *     commande : il va uniquement dans l'en-tete HTTP, comme le veut la route ;
 *   - il n'affiche pas la reponse complete : seulement les champs utiles ;
 *   - il ne joint aucune base directement : il parle a l'application.
 */
import assert from 'node:assert/strict';
import { annoterMesures } from './lib/annotations.mjs';

const baseUrl = (process.env.TRACEFAB_STAGING_URL || '').trim();
const workerSecret = (process.env.TF_WORKER_SECRET || '').trim();

if (!baseUrl) {
  console.error('TRACEFAB_STAGING_URL absent : aucune Preview a sonder.');
  process.exit(2);
}
if (!workerSecret) {
  console.error('TF_WORKER_SECRET absent : la sonde interne exige le secret d exploitation.');
  process.exit(2);
}

const origin = new URL(baseUrl);
assert.equal(origin.protocol, 'https:', 'la cible doit etre en HTTPS');

// La sonde de Production sert a etablir que le runtime de staging ne parle
// PAS a la base de Production. Elle est strictement de LECTURE : un GET sur
// la route de readiness, sans aucune ecriture, sans aucun secret affiche.
// Elle est desactivable : TF_PRODUCTION_PROBE_URL='' la supprime.
const productionUrl = (process.env.TF_PRODUCTION_PROBE_URL ?? 'https://tracefab.vercel.app').trim();

const url = new URL('/api/internal/p2/readiness', origin);
url.searchParams.set('identity', '1');

// Contournement de la protection de deploiement Vercel — optionnel. La
// valeur ne sort jamais dans l'URL ni dans la sortie.
const vercelBypass = process.env.TRACEFAB_VERCEL_BYPASS?.trim() || '';
const headers = { 'x-tracefab-worker-secret': workerSecret };
if (vercelBypass) {
  headers['x-vercel-protection-bypass'] = vercelBypass;
  headers['x-vercel-set-bypass-cookie'] = 'true';
}

const response = await fetch(url, {
  method: 'GET',
  headers,
});
const body = await response.json().catch(() => ({}));

const identite = body?.databaseIdentity || {};
const mesures = [
  ['readiness_http', response.status],
  ['readiness_ready', body?.ready === true],
  ['identite_mesuree', identite?.measured === true],
  ['identite_role_courant', identite?.currentUser ?? 'inconnu'],
  ['identite_role_session', identite?.sessionUser ?? 'inconnu'],
  ['identite_contournement_rls', identite?.bypassesRls],
  ['identite_superutilisateur', identite?.isSuperuser],
];

const sur = identite?.measured === true
  && identite?.currentUser === 'tracefab_app'
  && identite?.sessionUser === 'tracefab_app'
  && identite?.bypassesRls === false
  && identite?.isSuperuser === false;

// La base de Production, pour comparaison. Lecture seule. Si le secret de
// sonde de Production differe de celui de la Preview, la comparaison est
// simplement inconclusive — elle ne doit jamais faire echouer la sonde.
if (productionUrl && productionUrl !== baseUrl) {
  try {
    const urlProduction = new URL('/api/internal/p2/readiness', productionUrl);
    urlProduction.searchParams.set('identity', '1');
    // Seul le secret de sonde est envoye a Production : le contournement de
    // la protection Vercel est propre a la Preview et n'a rien a y faire.
    const reponseProduction = await fetch(urlProduction, {
      method: 'GET',
      headers: { 'x-tracefab-worker-secret': workerSecret },
    });
    if (reponseProduction.ok) {
      const corpsProduction = await reponseProduction.json().catch(() => ({}));
      const identiteProduction = corpsProduction?.databaseIdentity || {};
      const basePartagee = Boolean(identiteProduction.database)
        && identiteProduction.database === identite.database;
      mesures.push(['sonde_production', 'conforme']);
      mesures.push(['base_partagee_avec_production', basePartagee]);
    } else {
      mesures.push(['sonde_production', `non_autorisee_${reponseProduction.status}`]);
    }
  } catch {
    mesures.push(['sonde_production', 'indisponible']);
  }
}

mesures.push(['identite_conforme', sur]);

// Les mesures sont publiees en ANNOTATION : le journal de run est heberge
// hors de l'API GitHub, donc illisible depuis l'exterieur. Une mesure qui
// n'existe que dans le journal n'est pas une preuve.
annoterMesures('P1 identite DB runtime', mesures);
for (const [cle, valeur] of mesures) console.log(`${cle}=${valeur}`);

if (!sur) {
  console.error('Le role effectif du runtime ne respecte pas le contrat de securite.');
  process.exit(1);
}
console.log('identite_runtime=conforme');
