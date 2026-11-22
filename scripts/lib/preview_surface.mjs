/**
 * Mesure de la surface d'une Preview Vercel — et surtout DIAGNOSTIC de ce qui
 * a repondu : l'application, ou la protection de deploiement.
 *
 * POURQUOI CE MODULE EXISTE
 *   Un simple test « HTTP 200 » ne prouve rien : la protection de deploiement
 *   Vercel repond elle aussi. Et un test « HTTP 307 » ne prouve rien non plus :
 *   le 2026-10-23, le pre-vol du chantier P1 a recu des 307 dont le CHEMIN de
 *   destination etait identique au chemin demande, ce qui a ete lu comme une
 *   « redirection vers elle-meme ». C'etait en realite une redirection vers un
 *   AUTRE HOTE : l'alias de branche teste ne designait plus le deploiement du
 *   commit, et Vercel re-canonicalisait vers un autre deploiement. Le chemin
 *   seul ne permet pas de le voir ; l'HOTE est indispensable.
 *
 * REGLES DE MESURE
 *   1. aucune redirection n'est suivie aveuglement : chaque destination est
 *      d'abord CLASSEE (meme hote, autre deploiement Vercel, production, SSO
 *      Vercel, domaine externe) ;
 *   2. le contournement de protection n'est JAMAIS envoye a un autre hote que
 *      la cible demandee : une redirection est suivie SANS en-tete, ou pas du
 *      tout. Un secret ne voyage que vers le domaine explicitement autorise ;
 *   3. aucun corps de reponse, cookie ou jeton n'est journalise : seulement un
 *      code HTTP, un type de contenu, une classe et des NOMS de parametres.
 *
 * CODES DE SORTIE : une cause, un code.
 *   2 configuration   3 cible refusee      5 protection intercepte
 *   6 injoignable     7 alias obsolete     8 application degradee
 *   9 reponse inattendue
 */
import { classerHote, cookieDeBypass, entetesBypass, validerUrlPreview } from './preview_deployment.mjs';

export const CODES_SONDE = Object.freeze({
  ok: 0,
  configuration: 2,
  cible_refusee: 3,
  protection: 5,
  injoignable: 6,
  url_obsolete: 7,
  application_degradee: 8,
  reponse_inattendue: 9,
});

const CHEMINS_PAR_DEFAUT = ['/api/health', '/api/config', '/api/internal/p2/readiness'];
const TAILLE_CORPS_MAX = 20000;

/** Classes de destination d'une redirection. */
export function analyserDestination(location, origine) {
  if (!location) return { classe: 'aucune', hote: null, chemin: null, parametres: [] };
  let cible;
  try {
    cible = new URL(location, origine);
  } catch {
    return { classe: 'non_analysable', hote: null, chemin: null, parametres: [] };
  }
  const hote = cible.hostname.toLowerCase();
  const classeHote = classerHote(hote);
  let classe;
  if (cible.pathname.startsWith('/sso-api') || classeHote === 'vercel_com') classe = 'sso_vercel';
  else if (classeHote === 'production') classe = 'production';
  else if (classeHote === 'preview_vercel' && hote !== origine.hostname.toLowerCase()) classe = 'autre_deploiement';
  else if (hote === origine.hostname.toLowerCase()) classe = 'meme_hote';
  else classe = 'externe';
  return {
    classe,
    hote,
    chemin: cible.pathname,
    // Les NOMS de parametres seulement : une URL de protection peut porter un
    // jeton, et un jeton ne doit jamais entrer dans un journal.
    parametres: [...cible.searchParams.keys()].sort(),
  };
}

/** Classe une reponse HTTP : application, protection, page, erreur, autre. */
export function classerReponse({ status, contentType, corps }) {
  const type = String(contentType || '').toLowerCase();
  const texte = String(corps || '');
  const html = /^\s*(<!doctype html|<html)/i.test(texte);
  const marqueursProtection = ['vercel_auth_enabled', 'sso-api', 'deployment protection', 'sign in to vercel']
    .filter((m) => texte.toLowerCase().includes(m));
  const marqueursApplicatif = ['"ok"', 'publishablekey', 'tracefab-api', '"ready"', '"service"']
    .filter((m) => texte.toLowerCase().includes(m));

  if (status >= 300 && status < 400) return { classe: 'redirection', html, marqueursProtection, marqueursApplicatif };
  if (status === 401 || status === 403) return { classe: 'protection', html, marqueursProtection, marqueursApplicatif };
  if (status === 404) return { classe: 'introuvable', html, marqueursProtection, marqueursApplicatif };
  if (status >= 500) return { classe: 'erreur_serveur', html, marqueursProtection, marqueursApplicatif };
  if (status === 200) {
    if (marqueursProtection.length && !marqueursApplicatif.length) {
      return { classe: 'protection', html, marqueursProtection, marqueursApplicatif };
    }
    if (marqueursApplicatif.length) return { classe: 'application', html, marqueursProtection, marqueursApplicatif };
    if (html || type.includes('text/html')) return { classe: 'page_html', html, marqueursProtection, marqueursApplicatif };
    return { classe: 'inattendue', html, marqueursProtection, marqueursApplicatif };
  }
  return { classe: 'inattendue', html, marqueursProtection, marqueursApplicatif };
}

async function lireCorpsBorne(reponse) {
  try {
    const texte = await reponse.text();
    return texte.slice(0, TAILLE_CORPS_MAX);
  } catch {
    return '';
  }
}

/**
 * Sonde une cible et retourne des mesures `[cle, valeur]` plus un objet
 * exploitable pour le diagnostic. Ne leve jamais pour une erreur reseau : un
 * echec reseau est une MESURE (`http=000`), pas une exception.
 */
export async function sonderCible(origine, options = {}) {
  const {
    bypass = '',
    chemins = CHEMINS_PAR_DEFAUT,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    hoteDeploiementAttendu = null,
  } = options;

  const entetes = entetesBypass(bypass);
  const contournementEnvoye = Object.keys(entetes).length > 0;
  const mesures = [
    ['preview_hote', origine.hostname],
    ['contournement_disponible', contournementEnvoye],
  ];
  const resultats = [];

  for (const chemin of chemins) {
    const url = new URL(chemin, origine);
    const resultat = { chemin, http: null, classe: 'injoignable', destination: null, suivi: null };
    let reponse;
    try {
      reponse = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: entetes,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      resultat.http = 0;
      resultat.erreur = String(error?.message || error).split('\n')[0].slice(0, 80);
      mesures.push([`${chemin}_http`, `000`]);
      mesures.push([`${chemin}_classe`, 'injoignable']);
      mesures.push([`${chemin}_erreur`, resultat.erreur]);
      resultats.push(resultat);
      continue;
    }

    const corps = await lireCorpsBorne(reponse);
    const contenu = classerReponse({ status: reponse.status, contentType: reponse.headers.get('content-type'), corps });
    resultat.http = reponse.status;
    resultat.classe = contenu.classe;
    resultat.marqueursProtection = contenu.marqueursProtection;

    mesures.push([`${chemin}_http`, reponse.status]);
    mesures.push([`${chemin}_classe`, contenu.classe]);
    const type = (reponse.headers.get('content-type') || '').split(';')[0];
    if (type) mesures.push([`${chemin}_content_type`, type]);
    if (contenu.marqueursProtection.length) {
      mesures.push([`${chemin}_marqueurs_protection`, contenu.marqueursProtection.join(',')]);
    }

    if (contenu.classe === 'redirection') {
      const destination = analyserDestination(reponse.headers.get('location'), origine);
      resultat.destination = destination;
      mesures.push([`${chemin}_redirection_classe`, destination.classe]);
      // L'HOTE est la mesure qui manquait : sans lui, une redirection vers un
      // autre deploiement ressemble a une redirection vers soi-meme.
      mesures.push([`${chemin}_redirection_hote`, destination.hote || 'non_analysable']);
      mesures.push([`${chemin}_redirection_chemin`, destination.chemin || 'non_analysable']);
      mesures.push([`${chemin}_redirection_parametres`, destination.parametres.join(',') || 'aucun']);
      if (hoteDeploiementAttendu) {
        mesures.push([`${chemin}_redirection_vers_le_deploiement_attendu`, destination.hote === String(hoteDeploiementAttendu).toLowerCase()]);
      }

      // POIGNEE DE MAIN DE CONTOURNEMENT — meme hote, 307/308, un Set-Cookie.
      // C'est la signature exacte de `x-vercel-set-bypass-cookie` (cf.
      // entetesBypass) : Vercel ne refuse pas l'appel, il demande d'abord au
      // client de conserver l'autorisation dans un cookie, par une redirection
      // vers la MEME URL. Un client serveur n'a pas de bocal a cookies ; sans
      // ce rejeu il ne verrait qu'un 307 eternel et conclurait — a tort — a un
      // echec de contournement.
      //
      // Le rejeu est unique, sur le MEME hote, avec le cookie renvoye : le
      // cookie n'est jamais journalise, et l'en-tete de contournement ne sort
      // pas du domaine autorise (c'est le meme hote que la cible).
      const estPoigneeDeMain = (reponse.status === 307 || reponse.status === 308)
        && destination.classe === 'meme_hote';
      if (estPoigneeDeMain) {
        const setCookie = reponse.headers.getSetCookie?.() || reponse.headers.get('set-cookie');
        const cookie = cookieDeBypass(setCookie);
        resultat.handshake = { cookieRecu: Boolean(cookie) };
        mesures.push([`${chemin}_handshake_bypass`, cookie ? 'cookie_recu' : 'sans_cookie']);
        if (cookie) {
          try {
            const rejeu = await fetchImpl(url, {
              method: 'GET',
              redirect: 'manual',
              headers: { ...entetes, cookie },
              signal: AbortSignal.timeout(timeoutMs),
            });
            const corpsRejeu = await lireCorpsBorne(rejeu);
            const contenuRejeu = classerReponse({
              status: rejeu.status,
              contentType: rejeu.headers.get('content-type'),
              corps: corpsRejeu,
            });
            resultat.handshake.http = rejeu.status;
            resultat.handshake.classe = contenuRejeu.classe;
            mesures.push([`${chemin}_handshake_http`, rejeu.status]);
            mesures.push([`${chemin}_handshake_classe`, contenuRejeu.classe]);
            if (contenuRejeu.classe === 'application') {
              // La poignee de main a abouti : ce qui compte est la reponse
              // FINALE, pas le 307 intermediaire.
              resultat.http = rejeu.status;
              resultat.classe = 'application';
              resultat.destination = null;
              resultat.marqueursProtection = contenuRejeu.marqueursProtection;
              resultat.corpsFinal = corpsRejeu;
            }
          } catch (error) {
            resultat.handshake.erreur = String(error?.message || error).split('\n')[0].slice(0, 60);
            mesures.push([`${chemin}_handshake_http`, '000']);
            mesures.push([`${chemin}_handshake_erreur`, resultat.handshake.erreur]);
          }
        }
      }

      // La redirection est suivie UNE fois, et seulement vers un deploiement de
      // Preview : jamais vers vercel.com (SSO), jamais vers la production,
      // jamais vers un domaine externe. Et SANS en-tete de contournement :
      // le secret ne sort pas du domaine autorise.
      if (!estPoigneeDeMain && destination.hote && classerHote(destination.hote) === 'preview_vercel') {
        try {
          const suite = await fetchImpl(new URL(reponse.headers.get('location'), origine), {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
          });
          const corpsSuite = await lireCorpsBorne(suite);
          const contenuSuite = classerReponse({
            status: suite.status,
            contentType: suite.headers.get('content-type'),
            corps: corpsSuite,
          });
          resultat.suivi = { http: suite.status, classe: contenuSuite.classe };
          mesures.push([`${chemin}_redirection_suivie_http`, suite.status]);
          mesures.push([`${chemin}_redirection_suivie_classe`, contenuSuite.classe]);
        } catch (error) {
          mesures.push([`${chemin}_redirection_suivie_http`, '000']);
          mesures.push([`${chemin}_redirection_suivie_erreur`, String(error?.message || error).split('\n')[0].slice(0, 60)]);
        }
      }
    }

    // Le corps exploite est celui de la reponse FINALE : si la poignee de main
    // de contournement a abouti, le 307 intermediaire n'a pas de corps utile.
    const corpsExploitable = resultat.corpsFinal ?? corps;

    if (resultat.http === 200 && resultat.classe === 'application' && chemin === '/api/health') {
      let corpsJson = {};
      try { corpsJson = JSON.parse(corpsExploitable); } catch { corpsJson = {}; }
      const sain = corpsJson?.ok === true;
      resultat.healthOk = sain;
      mesures.push([`${chemin}_ok`, sain]);
      if (!sain && corpsJson?.error) mesures.push([`${chemin}_erreur_applicative`, String(corpsJson.error).slice(0, 40)]);
    }

    if (resultat.http === 200 && resultat.classe === 'application' && chemin === '/api/config') {
      let corpsJson = {};
      try { corpsJson = JSON.parse(corpsExploitable); } catch { corpsJson = {}; }
      const cle = typeof corpsJson?.publishableKey === 'string' ? corpsJson.publishableKey : '';
      const classeCle = cle.startsWith('pk_test_') ? 'pk_test'
        : cle.startsWith('pk_live_') ? 'pk_live'
          : cle ? 'inconnue' : 'absente';
      resultat.classeCleClerk = classeCle;
      mesures.push(['config_clerk', classeCle]);
      mesures.push(['config_proxy_url_present', Boolean(corpsJson?.proxyUrl)]);
    }

    resultats.push(resultat);
  }

  const verdict = diagnostiquer({ origine, resultats, bypassPresent: contournementEnvoye, hoteDeploiementAttendu });
  mesures.push(['cause', verdict.cause]);
  mesures.push(['verdict', verdict.code === CODES_SONDE.ok ? 'application_atteinte' : 'application_non_atteinte']);
  return { mesures, resultats, verdict };
}

/**
 * Traduit les mesures en UNE cause nommee. C'est la piece qui remplace
 * « Process completed with exit code 5 » par une phrase actionnable.
 */
export function diagnostiquer({ origine, resultats, bypassPresent, hoteDeploiementAttendu = null }) {
  const atteint = resultats.some((r) => r.classe === 'application');
  const sante = resultats.find((r) => r.chemin === '/api/health');
  if (atteint) {
    if (sante && sante.healthOk === false) {
      return {
        code: CODES_SONDE.application_degradee,
        cause: 'application_joignable_base_indisponible',
        message: 'l application repond, mais /api/health declare la base indisponible : la Preview est joignable, sa base ne l est pas',
        action: 'verifier la variable de base de l environnement Preview dans Vercel, puis redeployer',
      };
    }
    return { code: CODES_SONDE.ok, cause: 'application_atteinte', message: 'l application repond', action: 'aucune' };
  }

  const injoignable = resultats.every((r) => r.classe === 'injoignable');
  if (injoignable) {
    return {
      code: CODES_SONDE.injoignable,
      cause: 'hote_injoignable',
      message: `aucune reponse de ${origine.hostname} : DNS, TLS ou deploiement supprime`,
      action: 'verifier que le deploiement existe encore et que son URL est celle de ce commit',
    };
  }

  const sso = resultats.find((r) => r.destination && r.destination.classe === 'sso_vercel');
  if (sso) {
    return bypassPresent
      ? {
        code: CODES_SONDE.protection,
        cause: 'contournement_invalide',
        message: `la protection de deploiement Vercel intercepte encore l appel (${sso.http} vers ${sso.destination.chemin}) `
          + 'alors que le secret de contournement est PRESENT dans l environnement : le secret est donc invalide, '
          + 'revoque, ou rattache a un autre projet Vercel que celui du deploiement teste',
        action: 'regenerer « Protection Bypass for Automation » dans le projet Vercel de ce deploiement, puis remplacer '
          + 'VERCEL_AUTOMATION_BYPASS_SECRET dans l environnement GitHub tracefab-clerk-test',
      }
      : {
        code: CODES_SONDE.protection,
        cause: 'contournement_absent',
        message: 'la Preview est derriere la protection de deploiement Vercel et aucun secret de contournement n est fourni',
        action: 'deposer VERCEL_AUTOMATION_BYPASS_SECRET dans l environnement GitHub tracefab-clerk-test',
      };
  }

  const obsolete = resultats.find((r) => r.destination
    && (r.destination.classe === 'autre_deploiement' || r.destination.classe === 'production'));
  if (obsolete) {
    const memeDeploiement = hoteDeploiementAttendu
      && obsolete.destination.hote === String(hoteDeploiementAttendu).toLowerCase();
    return {
      code: CODES_SONDE.url_obsolete,
      cause: 'cible_obsolete',
      message: `${origine.hostname} redirige (${obsolete.http}) vers ${obsolete.destination.hote} `
        + `sur le chemin ${obsolete.destination.chemin} sans parametre de protection : cette URL n est pas `
        + `le deploiement du commit teste, elle est re-canonicalisee par Vercel vers un autre deploiement`
        + (memeDeploiement ? ' (qui est bien celui du commit : c est l URL employee qui est obsolete)' : ''),
      action: 'utiliser l URL immuable du deploiement Preview du commit teste, resolue par la liste des Deployments GitHub',
    };
  }

  const poignee = resultats.find((r) => r.handshake && r.classe !== 'application');
  if (poignee) {
    return poignee.handshake.cookieRecu
      ? {
        code: CODES_SONDE.protection,
        cause: 'handshake_bypass_non_abouti',
        message: `${origine.hostname} repond ${poignee.http} vers la MEME URL et le rejeu avec le cookie `
          + `renvoye par Vercel donne ${poignee.handshake.http ?? 'aucune reponse'} `
          + `(${poignee.handshake.classe ?? 'injoignable'}) : la poignee de main de contournement n aboutit pas`,
        action: 'supprimer l en-tete x-vercel-set-bypass-cookie des appels serveur : il demande a Vercel '
          + 'de poser un cookie par redirection, ce qu un client sans bocal a cookies ne peut pas terminer',
      }
      : {
        code: CODES_SONDE.protection,
        cause: 'handshake_bypass_sans_cookie',
        message: `${origine.hostname} repond ${poignee.http} vers la MEME URL, sans Set-Cookie exploitable : `
          + 'Vercel demande une poignee de main que le client ne peut pas terminer',
        action: 'n envoyer que x-vercel-protection-bypass (sans x-vercel-set-bypass-cookie) et relancer le pre-vol',
      };
  }

  const protection = resultats.find((r) => r.classe === 'protection');
  if (protection) {
    return {
      code: CODES_SONDE.protection,
      cause: bypassPresent ? 'contournement_invalide' : 'contournement_absent',
      message: `la protection de deploiement Vercel repond ${protection.http} sur ${protection.chemin} : l application n est pas atteinte`,
      action: bypassPresent
        ? 'verifier que le secret de contournement appartient au projet Vercel de ce deploiement'
        : 'deposer VERCEL_AUTOMATION_BYPASS_SECRET dans l environnement tracefab-clerk-test',
    };
  }

  const erreurServeur = resultats.find((r) => r.classe === 'erreur_serveur');
  if (erreurServeur) {
    return {
      code: CODES_SONDE.application_degradee,
      cause: 'application_en_erreur',
      message: `l application repond ${erreurServeur.http} sur ${erreurServeur.chemin} : le deploiement est atteint mais echoue`,
      action: 'lire les journaux du deploiement Vercel pour ce SHA',
    };
  }

  const detail = resultats.map((r) => `${r.chemin}:${r.http}:${r.classe}`).join(' ');
  return {
    code: CODES_SONDE.reponse_inattendue,
    cause: 'reponse_inattendue',
    message: `reponse non reconnue — ${detail}`,
    action: 'comparer avec les codes et classes attendus : application=JSON, protection=302 /sso-api ou 401/403',
  };
}

/** Prefixe de validation de cible, partage par les scripts qui joignent la cible. */
export function verifierCible(brut) {
  const verdict = validerUrlPreview(brut);
  if (!verdict.ok) {
    return {
      ok: false,
      code: CODES_SONDE.cible_refusee,
      cause: verdict.raison,
      message: 'cible refusee : la cible doit etre un deploiement de Preview Vercel en HTTPS, sans parametre, jamais la production',
    };
  }
  return { ok: true, url: verdict.url, hostname: verdict.hostname };
}
