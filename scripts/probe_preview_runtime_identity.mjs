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
import { annoterMesures } from './lib/annotations.mjs';
import { entetesBypass, exigerCiblePreview } from './lib/preview_deployment.mjs';
import { analyserDestination, classerReponse } from './lib/preview_surface.mjs';

const baseUrl = (process.env.TRACEFAB_STAGING_URL || '').trim();
const workerSecret = (process.env.TF_WORKER_SECRET || '').trim();

if (!baseUrl) {
  console.error('TRACEFAB_STAGING_URL absent : aucune Preview a sonder.');
  process.exit(2);
}

// Cible validee AVANT tout appel : HTTPS, Preview Vercel du projet, sans
// parametre, jamais un hote de production.
const origin = exigerCiblePreview(baseUrl);

// Contournement de la protection de deploiement Vercel — optionnel. La
// valeur ne sort jamais dans l'URL ni dans la sortie.
const entetesContournement = entetesBypass(process.env.TRACEFAB_VERCEL_BYPASS);

if (!workerSecret) {
  // DIAGNOSTIC. Sans le secret de sonde, la mesure est impossible. Mais on
  // peut encore dire OU le secret manque, au lieu de le deviner : la route
  // interne repond 503 quand l'application n'a aucun secret d exploitation
  // configure, 401 quand elle en a un mais que l'appelant ne le presente
  // pas, et 302 quand la protection Vercel intercepte encore l'appel. Ces
  // trois reponses designent trois corrections differentes.
  const urlDiagnostic = new URL('/api/internal/p2/readiness', origin);
  urlDiagnostic.searchParams.set('identity', '1');
  let code = 0;
  let erreur = 'joignable_non';
  let destination = { classe: 'aucune', hote: null, chemin: null, parametres: [] };
  let classeReponse = 'injoignable';
  try {
    // `redirect: 'manual'` : une redirection est une MESURE, pas un detour.
    // Suivre un 302 vers /sso-api ferait lire une page de connexion comme si
    // c'etait l'application, et un 307 vers un autre deploiement ferait
    // mesurer un AUTRE commit que celui teste.
    const reponse = await fetch(urlDiagnostic, {
      method: 'GET',
      redirect: 'manual',
      headers: entetesContournement,
      signal: AbortSignal.timeout(15000),
    });
    code = reponse.status;
    destination = analyserDestination(reponse.headers.get('location'), origin);
    const corpsBrut = await reponse.text().catch(() => '');
    classeReponse = classerReponse({
      status: code,
      contentType: reponse.headers.get('content-type'),
      corps: corpsBrut,
    }).classe;
    try { erreur = JSON.parse(corpsBrut)?.error || 'aucune'; } catch { erreur = 'aucune'; }
  } catch {
    erreur = 'joignable_non';
  }
  const estRedirection = code >= 300 && code < 400;
  const versProtection = destination.classe === 'sso_vercel' || code === 302;
  const versAutreDeploiement = destination.classe === 'autre_deploiement' || destination.classe === 'production';
  const diagnostic = versAutreDeploiement
    ? 'la cible nest pas le deploiement du commit teste : Vercel la re-canonicalise vers un autre deploiement'
    : versProtection
      ? 'la protection de deploiement Vercel intercepte encore l appel : le secret de contournement est absent ou faux dans l environnement GitHub tracefab-clerk-test'
      : code === 503
        ? 'la Preview na pas de secret d exploitation configure : le poser dans Vercel (environnement Preview, nom TRACEFAB_NOTIFICATION_WORKER_SECRET) puis redeployer'
        : code === 401
          ? 'la Preview a un secret d exploitation : il manque dans l environnement GitHub tracefab-clerk-test, sous le nom TRACEFAB_NOTIFICATION_WORKER_SECRET'
          : code === 200
            ? 'la route interne ne demande aucun secret : la mesure de l identite nest pas protegee'
            : estRedirection
              ? 'redirection non reconnue : inspecter la destination mesuree ci-dessous'
              : 'la Preview est injoignable depuis ce runner : aucun diagnostic possible';
  annoterMesures('P1 staging — diagnostic du secret de sonde', [
    ['sonde_sans_secret_http', code],
    ['sonde_sans_secret_classe', classeReponse],
    ['sonde_sans_secret_redirection_classe', destination.classe],
    ['sonde_sans_secret_redirection_hote', destination.hote || 'aucune'],
    ['sonde_sans_secret_redirection_chemin', destination.chemin || 'aucun'],
    ['sonde_sans_secret_erreur', erreur],
    ['sonde_sans_secret_diagnostic', diagnostic],
  ]);
  console.error(`TF_WORKER_SECRET absent : la sonde interne exige le secret d exploitation. ${diagnostic}`);
  process.exit(2);
}

// La sonde de Production sert a etablir que le runtime de staging ne parle
// PAS a la base de Production. Elle est strictement de LECTURE : un GET sur
// la route de readiness, sans aucune ecriture, sans aucun secret affiche.
// Elle est desactivable : TF_PRODUCTION_PROBE_URL='' la supprime.
const productionUrl = (process.env.TF_PRODUCTION_PROBE_URL ?? 'https://tracefab.vercel.app').trim();

const url = new URL('/api/internal/p2/readiness', origin);
url.searchParams.set('identity', '1');

const headers = { 'x-tracefab-worker-secret': workerSecret, ...entetesContournement };

const response = await fetch(url, {
  method: 'GET',
  // Une redirection n'est pas suivie : elle est nommee. Suivre un 302 vers la
  // page de protection lirait une page de connexion comme une reponse de
  // l'application, et suivre un 307 changerait de commit sans le dire.
  redirect: 'manual',
  headers,
});
const corpsBrut = await response.text().catch(() => '');
const redirection = response.headers.get('location')
  ? analyserDestination(response.headers.get('location'), origin)
  : { classe: 'aucune', hote: null, chemin: null, parametres: [] };
if (response.status >= 300 && response.status < 400) {
  annoterMesures('P1 identite DB runtime', [
    ['readiness_http', response.status],
    ['readiness_redirection_classe', redirection.classe],
    ['readiness_redirection_hote', redirection.hote || 'aucun'],
    ['readiness_redirection_chemin', redirection.chemin || 'aucun'],
    ['identite_conforme', false],
  ]);
  console.error(`La sonde a recu ${response.status} vers ${redirection.hote || 'un hote inconnu'} `
    + `(${redirection.chemin || '?'}, classe ${redirection.classe}) : l application n'a pas repondu.`);
  process.exit(4);
}
let body = {};
try { body = JSON.parse(corpsBrut); } catch { body = {}; }

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
