#!/usr/bin/env node
/**
 * Resout l'URL du deploiement Preview du commit reellement teste.
 *
 * POURQUOI CE SCRIPT EXISTE
 *   Un workflow qui code une URL de Preview en dur teste, au mieux, le commit
 *   d'hier. Le 2026-10-23, le pre-vol de `p1-staging-authenticated.yml` a
 *   mesure un 307 sur l'alias de branche `tracefab-git-arena-e13749-…` : la
 *   requete n'atteignait pas l'application, et le script ne regardait que le
 *   CHEMIN de la redirection, ce qui affichait une redirection « vers
 *   elle-meme » et masquait un changement d'HOTE. Le diagnostic etait
 *   illisible ; la cible etait fausse.
 *
 *   Ce script remplace l'URL figee par la seule source fiable disponible :
 *   l'API GitHub des Deployments, alimentee par l'application Vercel. Elle
 *   associe un SHA a un deploiement et un deploiement a une URL IMMUABLE.
 *
 * ENTREES (toutes optionnelles, valeurs par defaut GitHub Actions)
 *   GITHUB_REPOSITORY / TRACEFAB_REPO      `owner/repo`
 *   GH_TOKEN / GITHUB_TOKEN                jeton du run (deja present)
 *   TF_TARGET_SHA / GITHUB_SHA             SHA exact teste
 *   TF_PREVIEW_ENVIRONMENT                 defaut `Preview`
 *   TF_PREVIEW_WAIT_SECONDS                defaut 1200
 *   TF_PREVIEW_POLL_SECONDS                defaut 15
 *   TF_PREVIEW_URL_OVERRIDE                URL imposee ; ACCEPTEE seulement si
 *                                          c'est l'URL d'un deploiement `success`
 *                                          DE CE SHA, sinon echec explicite
 *
 * SORTIES (via $GITHUB_OUTPUT)
 *   preview_url, deployment_id, deployment_sha, deployment_state, url_source
 *
 * CODES DE SORTIE — chacun nomme une cause differente
 *   2  configuration incomplete (repo, jeton, SHA)
 *   3  API GitHub injoignable ou refusee
 *   11 aucun deploiement Preview pour ce SHA
 *   12 deploiement present mais jamais pret (pending/in_progress/failure)
 *   13 URL de deploiement inutilisable (production, autre projet, parametres)
 *   14 URL imposee qui n'est pas celle d'un deploiement de ce SHA
 */
import {
  CODES_PREVIEW,
  selectionnerDeploiementPreview,
  ecrireSortie,
  estShaComplet,
  validerUrlPreview,
} from './lib/preview_deployment.mjs';

/**
 * Base d'API : `https://api.github.com`, et surchargeable UNIQUEMENT vers la
 * boucle locale — c'est ce qui permet d'eprouver les codes de sortie hors
 * ligne sans jamais pouvoir detourner le jeton du run vers un autre hote.
 */
function baseApi() {
  const brut = (process.env.TRACEFAB_GITHUB_API || '').trim();
  if (!brut) return undefined;
  try {
    const url = new URL(brut);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return undefined;
    return brut.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}
const apiBase = baseApi();

const journal = (ligne) => console.log(ligne);

function echouer(code, cause, message, details = {}) {
  for (const [cle, valeur] of Object.entries(details)) {
    if (valeur !== undefined && valeur !== null && valeur !== '') journal(`${cle}=${valeur}`);
  }
  console.log(`cause=${cause}`);
  console.log(`::error title=P1 cible Preview::cause=${cause} — ${message}`);
  process.exit(code);
}

const repository = (process.env.TRACEFAB_REPO || process.env.GITHUB_REPOSITORY || '').trim();
const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.TRACEFAB_GH_TOKEN || '').trim();
const sha = (process.env.TF_TARGET_SHA || process.env.GITHUB_SHA || '').trim();
const environnement = (process.env.TF_PREVIEW_ENVIRONMENT || 'Preview').trim();
const attente = Number(process.env.TF_PREVIEW_WAIT_SECONDS || 1200);
const intervalle = Number(process.env.TF_PREVIEW_POLL_SECONDS || 15) * 1000;
const surcharge = (process.env.TF_PREVIEW_URL_OVERRIDE || '').trim();

journal(`sha_teste=${sha || 'absent'}`);
journal(`environnement_attendu=${environnement}`);
journal(`attente_max_secondes=${attente}`);

if (!repository || !estShaComplet(sha)) {
  echouer(
    CODES_PREVIEW.configuration,
    'configuration_incomplete',
    'GITHUB_REPOSITORY et un SHA complet (40 caracteres) sont exiges ; sans eux, '
    + 'aucune correspondance commit -> deploiement ne peut etre etablie',
    { repository: repository || 'absent' },
  );
}
if (!token) {
  echouer(
    CODES_PREVIEW.configuration,
    'jeton_github_absent',
    'le step doit recevoir `GH_TOKEN: ${{ github.token }}` et le job la permission `deployments: read`',
  );
}

// Une URL imposee n'est acceptee que si elle correspond a un deploiement
// `success` DE CE SHA. C'est ce qui empeche de « corriger » un echec en
// pointant une URL d'un autre commit : ce serait un faux vert.
if (surcharge) {
  const verdict = validerUrlPreview(surcharge);
  if (!verdict.ok) {
    echouer(CODES_PREVIEW.url_invalide, verdict.raison, 'URL imposee refusee : elle doit etre un deploiement de Preview Vercel en HTTPS, sans parametre', { url_source: 'entree_manuelle' });
  }
  const correspondance = await selectionnerDeploiementPreview({
    repository, token, sha, environnement,
    delaiMaxMs: 0, intervalleMs: 0, journal, apiBase,
  });
  if (correspondance.code !== CODES_PREVIEW.ok) {
    echouer(
      correspondance.code === CODES_PREVIEW.ok ? CODES_PREVIEW.aucun_deploiement : correspondance.code,
      correspondance.raison,
      'aucun deploiement Preview pret ne correspond a ce SHA : l URL imposee ne peut donc pas etre rattachee au commit teste',
      { url_source: 'entree_manuelle', candidats: correspondance.candidats, etats: (correspondance.etats || []).join(',') },
    );
  }
  if (correspondance.hostname !== verdict.hostname) {
    echouer(
      CODES_PREVIEW.sha_divergent,
      'url_imposee_hors_du_deploiement_du_sha',
      `l URL imposee (hote ${verdict.hostname}) n est pas le deploiement de ce commit `
      + `(hote attendu ${correspondance.hostname}) : accepter cette URL testerait un autre commit`,
      { url_source: 'entree_manuelle' },
    );
  }
  ecrireSortie('preview_url', correspondance.url);
  ecrireSortie('deployment_id', correspondance.deploymentId);
  ecrireSortie('deployment_sha', correspondance.deploymentSha);
  ecrireSortie('deployment_state', correspondance.etat);
  ecrireSortie('url_source', 'entree_manuelle_verifiee');
  ecrireSortie('deployment_host', correspondance.hostname);
  journal(`deploiement_id=${correspondance.deploymentId}`);
  journal(`deploiement_sha=${correspondance.deploymentSha}`);
  journal(`preview_hote=${correspondance.hostname}`);
  journal(`url_source=entree_manuelle_verifiee`);
  console.log(
    `::notice title=P1 cible Preview::deploiement_id=${correspondance.deploymentId} `
    + `deploiement_sha=${correspondance.deploymentSha} sha_teste=${sha} `
    + `correspondance_sha=exacte etat=${correspondance.etat} hote=${correspondance.hostname} url_source=entree_manuelle_verifiee`,
  );
  process.exit(0);
}

const resultat = await selectionnerDeploiementPreview({
  repository,
  token,
  sha,
  environnement,
  delaiMaxMs: Math.max(0, attente) * 1000,
  intervalleMs: intervalle,
  journal,
  apiBase,
});

if (resultat.code !== CODES_PREVIEW.ok) {
  const messages = {
    [CODES_PREVIEW.api]: 'l API GitHub des Deployments est injoignable ou a refuse la lecture : verifier la permission `deployments: read` du job',
    [CODES_PREVIEW.aucun_deploiement]: 'aucun deploiement Preview n existe pour ce SHA : le build Vercel n a pas ete declenche, ou il a echoue avant de creer le deploiement',
    [CODES_PREVIEW.etat_non_pret]: 'un deploiement Preview existe pour ce SHA mais n a jamais atteint l etat `success` : lire les etats ci-dessus, puis consulter le build Vercel',
    [CODES_PREVIEW.url_invalide]: 'le deploiement est pret mais son URL est refusee : hote de production, hote hors du projet, protocole non HTTPS ou parametres dans l URL',
  };
  echouer(
    resultat.code,
    resultat.raison,
    messages[resultat.code] || 'selection du deploiement impossible',
    {
      deploiement_candidats: resultat.candidats,
      deploiement_etats: (resultat.etats || []).join(','),
      deploiement_id: resultat.deploymentId,
    },
  );
}

ecrireSortie('preview_url', resultat.url);
ecrireSortie('deployment_id', resultat.deploymentId);
ecrireSortie('deployment_sha', resultat.deploymentSha);
ecrireSortie('deployment_state', resultat.etat);
ecrireSortie('url_source', resultat.urlSource);
ecrireSortie('deployment_host', resultat.hostname);

journal(`deploiement_id=${resultat.deploymentId}`);
journal(`deploiement_sha=${resultat.deploymentSha}`);
journal(`deploiement_ref=${resultat.deploymentRef || ''}`);
journal(`deploiement_etat=${resultat.etat}`);
journal(`preview_hote=${resultat.hostname}`);
journal(`correspondance_sha=exacte`);
console.log(
  `::notice title=P1 cible Preview::deploiement_id=${resultat.deploymentId} `
  + `deploiement_sha=${resultat.deploymentSha} sha_teste=${sha} correspondance_sha=exacte `
  + `etat=${resultat.etat} hote=${resultat.hostname} url_source=deploiement_du_sha`,
);
