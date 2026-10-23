#!/usr/bin/env node
/**
 * Sonde de surface d'une ou plusieurs Previews Vercel.
 *
 * POURQUOI CE SCRIPT EXISTE
 *   Le bac a sable d'analyse n'a aucun acces reseau a *.vercel.app : seule une
 *   machine disposant d'Internet peut constater ce que la Preview repond
 *   reellement. Ce script est cette machine.
 *
 * CE QU'IL MESURE — par Preview, et pour chaque chemin
 *   - le code HTTP et le type de contenu ;
 *   - la CLASSE de la reponse : application, protection Vercel, redirection,
 *     page HTML, erreur serveur, injoignable ;
 *   - pour une redirection : la CLASSE et l'HOTE de sa destination, son chemin
 *     et les NOMS de ses parametres. L'HOTE est indispensable : sans lui, une
 *     redirection vers un AUTRE deploiement ressemble a une redirection vers
 *     soi-meme (defaut constate le 2026-10-23) ;
 *   - la classe de la cle publique Clerk (pk_test / pk_live / absente).
 *
 * CE QU'IL NE FAIT PAS
 *   - il n'affiche aucun corps de reponse, aucun cookie, aucun jeton, aucune
 *     valeur de secret, et aucune valeur de parametre d'URL ;
 *   - il ne suit une redirection QUE vers un deploiement de Preview Vercel, et
 *     SANS en-tete de contournement : le secret ne sort jamais du domaine
 *     autorise ;
 *   - il n'ecrit rien, ne cree aucun tenant, ne joint aucune base.
 *
 * MODES
 *   non strict (defaut) : mesure et rapporte, sans conclure — utiliser pour
 *     observer plusieurs Previews dont on sait qu'elles sont protegees.
 *   strict (TF_PROBE_STRICT=1) : si l'application n'est pas atteinte, le
 *     script s'arrete avec un CODE DISTINCT par cause et une annotation qui
 *     nomme la cause et l'action. Un pre-vol qui echoue doit bloquer les tests
 *     dependants ; il ne doit pas etre illisible.
 *
 * ENTREES
 *   TRACEFAB_PREVIEW_URLS / TRACEFAB_STAGING_URL / TRACEFAB_PREVIEW_URLS_FILE
 *   TRACEFAB_VERCEL_BYPASS (optionnel) — jamais affiche
 *   TF_PROBE_STRICT=1, TF_DEPLOYMENT_HOST (hote du deploiement attendu du SHA)
 */
import { readFileSync } from 'node:fs';
import { annoterMesures } from './lib/annotations.mjs';
import { CODES_SONDE, sonderCible } from './lib/preview_surface.mjs';
import { validerUrlPreview } from './lib/preview_deployment.mjs';

const depuisFichier = (process.env.TRACEFAB_PREVIEW_URLS_FILE || '').trim();
const cibles = [
  ...(process.env.TRACEFAB_PREVIEW_URLS || process.env.TRACEFAB_STAGING_URL || '').split(','),
  ...(depuisFichier ? readFileSync(depuisFichier, 'utf8').split('\n') : []),
]
  .map((u) => u.trim())
  .filter(Boolean)
  .filter((u, i, tab) => tab.indexOf(u) === i);

if (!cibles.length) {
  // En mode non strict (diagnostic), l'absence de cible n'est pas un echec :
  // elle est annoncee. En mode strict (pre-vol), elle ARRETE le job, parce
  // qu'aucun test ne doit s'executer sans cible verifiee.
  if (process.env.TF_PROBE_STRICT === '1') {
    console.error('TRACEFAB_PREVIEW_URLS absent : aucune Preview a sonder.');
    console.log('::error title=P1 pre-vol::cause=configuration_absente — aucune URL de Preview fournie');
    process.exit(CODES_SONDE.configuration);
  }
  console.log('::notice title=P1 diagnostic::cause=aucune_cible — aucun deploiement Preview a sonder');
  console.log('aucune_cible=a_sonder');
  process.exit(0);
}

const strict = process.env.TF_PROBE_STRICT === '1';
const bypass = (process.env.TRACEFAB_VERCEL_BYPASS || '').trim();
const hoteDeploiementAttendu = (process.env.TF_DEPLOYMENT_HOST || '').trim().toLowerCase() || null;

let codeFinal = CODES_SONDE.ok;
let causeFinale = '';
let messageFinal = '';
let actionFinale = '';

for (const cible of cibles) {
  // La cible est validee AVANT tout appel : une cible de production, un
  // protocole non HTTPS ou une URL portant des parametres est refusee, jamais
  // « corrigee » silencieusement.
  const validation = validerUrlPreview(cible);
  if (!validation.ok) {
    console.log(`cible_refusee=${validation.raison}`);
    console.log(`::error title=P1 pre-vol::cause=${validation.raison} — cible refusee avant tout appel reseau`);
    process.exit(CODES_SONDE.cible_refusee);
  }

  const { mesures, verdict } = await sonderCible(validation.url, {
    bypass,
    hoteDeploiementAttendu,
  });

  console.log(`--- ${mesures.map(([cle, valeur]) => `${cle}=${valeur}`).join('\n    ')}`);
  annoterMesures(`Preview ${validation.hostname}`, mesures);
  console.log(`::notice title=P1 pre-vol — cause::${validation.hostname} cause=${verdict.cause} ` +
    `code=${verdict.code} message=${verdict.message}`);

  if (verdict.code !== CODES_SONDE.ok && codeFinal === CODES_SONDE.ok) {
    codeFinal = verdict.code;
    causeFinale = verdict.cause;
    messageFinal = verdict.message;
    actionFinale = verdict.action;
  }
}

if (strict && codeFinal !== CODES_SONDE.ok) {
  // Une annotation d'erreur NOMMEE, plus un code distinct : « exit code 5 »
  // sans phrase etait exactement ce qui rendait l'echec inexploitable.
  console.log(`::error title=P1 pre-vol — cause ${causeFinale}::${messageFinal} | action: ${actionFinale}`);
  console.error(`Pre-vol en echec — cause=${causeFinale} : ${messageFinal}`);
  console.error(`Action attendue : ${actionFinale}`);
  process.exit(codeFinal);
}

if (strict) {
  console.log('pre_vol=application_atteinte');
}
