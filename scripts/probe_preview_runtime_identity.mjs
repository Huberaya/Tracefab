#!/usr/bin/env node
/**
 * Preuve de l'identite PostgreSQL du runtime, mesuree SUR la Preview.
 *
 * POURQUOI CETTE SONDE EXISTE
 *   La RLS ne protege que si le role applicatif n'a ni BYPASSRLS, ni SUPERUSER,
 *   ni appartenance a un role qui les porte, et s'il n'est pas proprietaire des
 *   tables. Or l'identite effectivement utilisee ne se deduit ni du code ni de
 *   la configuration attendue : `DATABASE_URL` peut pointer n'importe quel
 *   role. Une inspection de configuration ne prouve donc rien.
 *
 *   La route `GET /api/internal/p2/readiness?identity=1` lit ces attributs sur
 *   la connexion du MEME client Prisma que les routes metier
 *   (`api/_lib/readiness-probes.ts`, unique `new PrismaClient()` de `api/`).
 *   C'est la condition pour mesurer le runtime et pas une connexion ouverte a
 *   cote : un `psql` branche sur la meme URL mesurerait une AUTRE connexion.
 *
 * CE QUE CETTE SONDE N'EST PAS
 *   - ce n'est pas une connexion administrative : elle n'ouvre aucun socket
 *     vers PostgreSQL, elle parle a l'application ;
 *   - elle ne fait aucune ecriture : la route lit le catalogue et compte au
 *     plus une ligne visible ;
 *   - elle n'affiche aucun secret, aucune URL, aucun cookie, aucun jeton ;
 *   - elle n'affiche pas le nom de la base (le depot est public) : seulement un
 *     booleen de comparaison avec la Production.
 *
 * CODES DE SORTIE — un code par cause, pour qu'un echec soit lisible
 *   2  configuration (URL absente, refusee) ou secret de sonde absent
 *   4  la cible n'est pas l'application (redirection : protection ou cible obsolete)
 *   5  l'identite n'a pas pu etre mesuree (route injoignable, reponse inexploitable)
 *   6  l'identite est mesuree et elle VIOLENTE le contrat — les ecarts sont nommes
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
const vercelBypass = (process.env.TRACEFAB_VERCEL_BYPASS || '').trim();
const entetesContournement = entetesBypass(vercelBypass);

const url = new URL('/api/internal/p2/readiness', origin);
url.searchParams.set('identity', '1');

/** Appel unique, redirection NON suivie : une redirection est une mesure. */
async function appeler(entetes) {
  const reponse = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: entetes,
    signal: AbortSignal.timeout(20000),
  });
  const corpsBrut = await reponse.text().catch(() => '');
  let corps = {};
  try { corps = JSON.parse(corpsBrut); } catch { corps = {}; }
  return { reponse, corps };
}

if (!workerSecret) {
  // DIAGNOSTIC. Sans le secret de sonde, la mesure est impossible. Mais on
  // peut encore dire OU le secret manque, au lieu de le deviner : la route
  // interne repond 503 quand l'application n'a aucun secret d'exploitation
  // configure, 401 quand elle en a un mais que l'appelant ne le presente pas,
  // 302 quand la protection Vercel intercepte encore, et une redirection vers
  // un AUTRE deploiement quand la cible n'est pas celle du commit.
  let code = 0;
  let erreur = 'joignable_non';
  let destination = { classe: 'aucune', hote: null, chemin: null, parametres: [] };
  let classeReponse = 'injoignable';
  try {
    const { reponse, corps } = await appeler(entetesContournement);
    code = reponse.status;
    destination = analyserDestination(reponse.headers.get('location'), origin);
    classeReponse = reponse.status >= 300 && reponse.status < 400
      ? 'redirection'
      : classerReponse({ status: reponse.status, contentType: reponse.headers.get('content-type'), corps: JSON.stringify(corps) }).classe;
    erreur = corps?.error || 'aucune';
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

let resultat;
try {
  resultat = await appeler({ 'x-tracefab-worker-secret': workerSecret, ...entetesContournement });
} catch (error) {
  console.log('::error title=P1 identite DB::cause=cible_injoignable — la Preview na pas repondu');
  console.error(`Preview injoignable : ${String(error?.message || error).split('\n')[0].slice(0, 80)}`);
  process.exit(5);
}

const { reponse, corps } = resultat;

// Une redirection n'est PAS suivie : suivre un 302 vers /sso-api lirait une
// page de connexion comme une reponse applicative, et suivre un 307 vers un
// autre deploiement mesurerait un AUTRE commit que celui teste.
if (reponse.status >= 300 && reponse.status < 400) {
  const redirection = analyserDestination(reponse.headers.get('location'), origin);
  annoterMesures('P1 identite DB runtime', [
    ['readiness_http', reponse.status],
    ['readiness_redirection_classe', redirection.classe],
    ['readiness_redirection_hote', redirection.hote || 'aucun'],
    ['readiness_redirection_chemin', redirection.chemin || 'aucun'],
    ['identite_mesuree', false],
    ['identite_conforme', false],
    ['cause', 'cible_nest_pas_lapplication'],
  ]);
  console.error(`La sonde a recu ${reponse.status} vers ${redirection.hote || 'un hote inconnu'} `
    + `(${redirection.chemin || '?'}, classe ${redirection.classe}) : l application n'a pas repondu, `
    + "donc l'identite du runtime n'est PAS mesuree.");
  process.exit(4);
}

const identite = corps?.databaseIdentity || {};
const violations = Array.isArray(corps?.databaseIdentityViolations) ? corps.databaseIdentityViolations : [];

// La sonde de Production sert uniquement a etablir que le runtime de staging
// ne parle PAS a la base de Production. Strictement en LECTURE, sans aucun
// secret affiche. Desactivable : TF_PRODUCTION_PROBE_URL='' la supprime.
const productionUrl = (process.env.TF_PRODUCTION_PROBE_URL ?? 'https://tracefab.vercel.app').trim();

const mesures = [
  ['readiness_http', reponse.status],
  ['readiness_ready', corps?.ready === true],
  ['identite_mesuree', identite?.measured === true],
  ['identite_detail', identite?.detail ?? 'inconnu'],
  // Identite effective.
  ['identite_role_courant', identite?.currentUser ?? 'inconnu'],
  ['identite_role_session', identite?.sessionUser ?? 'inconnu'],
  ['identite_set_role_detecte', identite?.currentUser !== identite?.sessionUser],
  // Attributs de role — le coeur de la preuve.
  ['attribut_superuser', identite?.isSuperuser],
  ['attribut_bypassrls', identite?.bypassesRls],
  ['attribut_canlogin', identite?.canLogin],
  ['attribut_createrole', identite?.canCreateRole],
  ['attribut_createdb', identite?.canCreateDb],
  ['attribut_replication', identite?.canReplicate],
  ['attribut_inherit', identite?.inheritsPrivileges],
  // Appartenance a un role privilegie : un role peut etre conforme en
  // apparence et contourner la RLS par adhesion heritee.
  ['attribut_membres_privilegies', identite?.privilegedMemberships],
  ['attribut_membres_privilegies_noms', (identite?.privilegedMembershipNames || []).join('+') || 'aucun'],
  // RLS reellement applicable.
  ['rls_guc_row_security', identite?.rowSecurityGuc ?? 'inconnu'],
  ['rls_activee_sur_products', identite?.rlsEnabledOnProducts],
  ['rls_forcee_sur_products', identite?.rlsForcedOnProducts],
  ['role_proprietaire_de_products', identite?.ownsProductTable],
  // Privileges : lecture oui, ecriture directe non, creation non.
  ['privilege_select_products', identite?.canSelectProducts],
  ['privilege_ecriture_directe_products', identite?.canWriteProducts],
  ['privilege_create_base', identite?.canCreateInDatabase],
  ['privilege_create_schema', identite?.canCreateInSchema],
  // La mesure decisive : ce que ce role voit SANS contexte arme.
  ['lignes_visibles_sans_contexte', identite?.rowsVisibleWithoutContext],
  ['ecarts', violations.join('|') || 'aucun'],
];

const mesuree = identite?.measured === true;
const sur = mesuree && violations.length === 0;

// Comparaison avec la base de Production : uniquement un booleen. Le nom de la
// base ne sort jamais — le depot est public.
if (productionUrl && productionUrl !== baseUrl) {
  try {
    const urlProduction = new URL('/api/internal/p2/readiness', productionUrl);
    urlProduction.searchParams.set('identity', '1');
    // Seul le secret de sonde est envoye a Production : le contournement de la
    // protection Vercel est propre a la Preview et n'a rien a y faire.
    const reponseProduction = await fetch(urlProduction, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'x-tracefab-worker-secret': workerSecret },
      signal: AbortSignal.timeout(15000),
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

// Les mesures sont publiees en ANNOTATION : le journal de run est heberge hors
// de l'API GitHub, donc illisible depuis l'exterieur. Une mesure qui n'existe
// que dans le journal n'est pas une preuve.
annoterMesures('P1 identite DB runtime', mesures);
for (const [cle, valeur] of mesures) console.log(`${cle}=${valeur}`);

if (!mesuree) {
  console.log('::error title=P1 identite DB::cause=identite_non_mesuree — la route interne a repondu mais l identite est indisponible');
  console.error(`Identite NON MESUREE (detail=${identite?.detail ?? 'inconnu'}) : `
    + "aucune conclusion sur le role du runtime n'est possible.");
  process.exit(5);
}

if (!sur) {
  console.log(`::error title=P1 identite DB::cause=role_non_conforme — ${violations.join(' | ')}`);
  console.error(`Le role effectif du runtime ne respecte pas le contrat de securite : ${violations.join(' ; ')}`);
  process.exit(6);
}

console.log('identite_runtime=conforme');
