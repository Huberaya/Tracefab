/**
 * Selection du deploiement Preview correspondant EXACTEMENT au commit teste.
 *
 * POURQUOI CE MODULE EXISTE
 *   Le chantier P1 a echoue trois fois de suite pour la meme raison : la cible
 *   des tests etait une URL figee dans le workflow. Une URL de Preview Vercel
 *   est immuable pour UN commit ; des qu'un nouveau commit est pousse, l'URL
 *   figee designe soit un deploiement d'un AUTRE commit, soit un alias de
 *   branche que Vercel re-canonicalise (307 vers un autre hote). Tester une
 *   telle URL ne prouve rien : on mesure une redirection, pas l'application.
 *
 *   L'API GitHub expose deja la correspondance exacte commit -> deploiement :
 *   l'application GitHub de Vercel cree un Deployment par build, avec `sha` et
 *   un statut dont `environment_url` porte l'URL IMMUABLE du deploiement. Le
 *   workflow n'a donc besoin d'aucun jeton Vercel : `deployments: read` suffit.
 *
 * CE QUE LE MODULE GARANTIT
 *   1. l'URL retenue est celle d'un deploiement dont `sha` EGALE le SHA teste
 *      (comparaison stricte, jamais un prefixe) ;
 *   2. le statut de ce deploiement est `success` (sinon on attend, puis on
 *      echoue en le NOMMANT : `pending`, `failure`, `error`) ;
 *   3. l'URL est en HTTPS, sur un hote de Preview Vercel, du projet attendu,
 *      et JAMAIS sur un hote de production ;
 *   4. aucun secret n'est jamais place dans une URL : une URL portant des
 *      parametres est refusee.
 *
 * CE QUE LE MODULE NE FAIT PAS
 *   - il n'ecrit rien dans Vercel ; il ne fait que des GET sur api.github.com ;
 *   - il ne lit ni n'affiche aucune valeur de secret ;
 *   - il n'accepte jamais silencieusement un deploiement d'un autre commit.
 */

/** Codes de sortie — un code par cause, pour que l'echec soit lisible. */
export const CODES_PREVIEW = Object.freeze({
  ok: 0,
  configuration: 2,
  api: 3,
  aucun_deploiement: 11,
  etat_non_pret: 12,
  url_invalide: 13,
  sha_divergent: 14,
});

import { appendFileSync } from 'node:fs';

const API_PAR_DEFAUT = 'https://api.github.com';

/**
 * Hotes qui servent la PRODUCTION de ce projet. Aucun test de staging ne doit
 * jamais les atteindre : un test qui ecrit sur la production n'est pas un test.
 */
const HOSTS_PRODUCTION = Object.freeze(['tracefab.vercel.app', 'www.tracefab.vercel.app']);

export function hostsProduction(env = process.env) {
  const supplementaires = String(env.TRACEFAB_PRODUCTION_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...HOSTS_PRODUCTION, ...supplementaires]);
}

/** Classe un hote : production, preview Vercel, domaine Vercel, ou externe. */
export function classerHote(hostname, env = process.env) {
  const hote = String(hostname || '').trim().toLowerCase();
  if (!hote) return 'inconnu';
  if (hostsProduction(env).has(hote)) return 'production';
  if (hote.endsWith('.vercel.app')) return 'preview_vercel';
  if (hote === 'vercel.com' || hote.endsWith('.vercel.com')) return 'vercel_com';
  if (hote === 'vercel.app' || hote.endsWith('.vercel.sh')) return 'vercel_infrastructure';
  return 'externe';
}

/**
 * Valide une URL de cible. Retourne `{ ok, raison?, url?, hostname?, classe? }`.
 * Aucun message ne contient l'URL complete quand elle porte des parametres :
 * une URL de contournement peut transporter un jeton.
 */
export function validerUrlPreview(brut, env = process.env) {
  const texte = String(brut || '').trim();
  if (!texte) return { ok: false, raison: 'url_absente' };
  let url;
  try {
    url = new URL(texte);
  } catch {
    return { ok: false, raison: 'url_illisible' };
  }
  if (url.protocol !== 'https:') return { ok: false, raison: 'protocole_non_https' };
  if (url.username || url.password) return { ok: false, raison: 'identifiants_dans_url' };
  if (url.search) return { ok: false, raison: 'parametres_dans_url' };
  const classe = classerHote(url.hostname, env);
  if (classe === 'production') return { ok: false, raison: 'hote_de_production_interdit' };
  if (classe !== 'preview_vercel') return { ok: false, raison: `hote_hors_preview_vercel:${classe}` };
  const prefixe = String(env.TRACEFAB_PREVIEW_HOST_PREFIX ?? 'tracefab-').trim().toLowerCase();
  if (prefixe && !url.hostname.toLowerCase().startsWith(prefixe)) {
    return { ok: false, raison: 'hote_hors_du_projet' };
  }
  return { ok: true, url, hostname: url.hostname.toLowerCase(), classe };
}

/**
 * Refuse une cible qui n'est pas un deploiement de Preview verifie.
 * Utilise par les scripts qui joignent la cible, pour qu'aucun d'eux ne puisse
 * joindre la production meme si la variable d'environnement est mal reglee.
 */
export function exigerCiblePreview(brut, env = process.env) {
  const verdict = validerUrlPreview(brut, env);
  if (!verdict.ok) {
    throw new Error(
      `cible refusee (${verdict.raison}) : la cible doit etre un deploiement de Preview Vercel en HTTPS, `
      + 'sans parametre d URL et jamais un hote de production',
    );
  }
  return verdict.url;
}

/**
 * En-tete de contournement de la protection de deploiement Vercel.
 *
 * POURQUOI UN SEUL EN-TETE
 *   Le 2026-10-23, le pre-vol du chantier P1 a recu un `307` dont la
 *   destination etait la MEME URL que celle demandee, et l'a lu comme une
 *   « redirection inconnue » avant de sortir en `exit code 5`. Ce 307 n'etait
 *   ni l'application ni la protection : c'etait la poignee de main que Vercel
 *   declenche sur `x-vercel-set-bypass-cookie`.
 *
 *   Documentation Vercel (« Protection Bypass for Automation », configuration
 *   avancee) : « This will set the authorization bypass as a cookie using a
 *   redirect with a Set-Cookie header. » Autrement dit : demander la pose du
 *   cookie fait repondre 307 vers la meme URL. Un client serveur sans bocal a
 *   cookies (fetch, curl, Node) ne conserve pas ce Set-Cookie ; s'il renvoie
 *   l'en-tete, Vercel repose le cookie et redirige encore : boucle, ou 307
 *   permanent.
 *
 *   L'en-tete `x-vercel-protection-bypass` seul ouvre la Preview en UNE
 *   requete, sans redirection. Le cookie n'est utile qu'a un NAVIGATEUR qui
 *   enchaine des navigations sans en-tetes personnalises. Playwright pose
 *   `extraHTTPHeaders` sur toutes les requetes du contexte (`test_p1_staging.mjs`,
 *   `prepare_p1_staging_sessions.mjs`) : il n'a donc pas besoin du cookie non
 *   plus.
 *
 *   Consequence mesuree et exploitable : avec ce seul en-tete, une Preview
 *   ouverte repond 200 (application) ; une Preview dont le secret est faux ou
 *   absent repond 302 vers `vercel.com/sso-api`. Les deux causes restent donc
 *   distinguables — c'est ce que `preview_surface.mjs` nomme
 *   `contournement_invalide` et `contournement_absent`.
 *
 * La valeur du secret n'est jamais journalisee, ni placee dans une URL.
 */
export function entetesBypass(secret) {
  const valeur = String(secret || '').trim();
  if (!valeur) return {};
  return { 'x-vercel-protection-bypass': valeur };
}

/**
 * Extrait du `Set-Cookie` la paire `nom=valeur` a renvoyer telle quelle pour
 * terminer une poignee de main de contournement.
 *
 * Utilise UNIQUEMENT par la sonde, et seulement si Vercel repond malgre tout un
 * 307 vers le meme hote (par exemple si l'en-tete `x-vercel-set-bypass-cookie`
 * etait reintroduit par erreur). Le cookie n'est jamais journalise : il porte
 * une autorisation.
 */
export function cookieDeBypass(setCookie) {
  const brut = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie || '');
  const paires = [];
  for (const ligne of brut.split('\n')) {
    const m = ligne.match(/(?:^|;\s*)((?:__)?_?vercel[a-z_]*)=([^;]+)/i);
    if (m) paires.push(`${m[1]}=${m[2]}`);
  }
  return paires.join('; ');
}

/** Vrai si le SHA est un SHA de commit complet (40 hexadecimaux). */
export function estShaComplet(sha) {
  return /^[0-9a-f]{40}$/i.test(String(sha || '').trim());
}

async function appelApi({ apiBase, token, chemin, fetchImpl }) {
  const reponse = await fetchImpl(`${apiBase}${chemin}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tracefab-p1-preview-selection',
    },
  });
  if (!reponse.ok) {
    return { ok: false, status: reponse.status };
  }
  const corps = await reponse.json();
  return { ok: true, corps };
}

/**
 * Selectionne le deploiement Preview du SHA teste, en attendant qu'il soit pret.
 *
 * @param {object} options
 * @param {string} options.repository  `owner/repo`
 * @param {string} options.token       jeton GitHub (deja present dans le runner)
 * @param {string} options.sha         SHA EXACT attendu (40 hexadecimaux)
 * @param {string} [options.environnement='Preview'] environnement GitHub porte par le deploiement Vercel
 * @param {number} [options.delaiMaxMs] attente maximale d'un deploiement pret
 * @param {number} [options.intervalleMs] intervalle entre deux lectures
 * @param {Function} [options.fetchImpl] injectable pour les tests hors ligne
 * @param {Function} [options.journal]  journalisation sans secret
 */
export async function selectionnerDeploiementPreview(options) {
  const {
    repository,
    token,
    sha,
    environnement = 'Preview',
    delaiMaxMs = 20 * 60 * 1000,
    intervalleMs = 15 * 1000,
    fetchImpl = globalThis.fetch,
    apiBase = API_PAR_DEFAUT,
    journal = () => {},
    dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
    maintenant = () => Date.now(),
  } = options || {};

  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return { code: CODES_PREVIEW.configuration, raison: 'repository_absent_ou_invalide' };
  }
  if (!token) return { code: CODES_PREVIEW.configuration, raison: 'jeton_github_absent' };
  if (!estShaComplet(sha)) return { code: CODES_PREVIEW.configuration, raison: 'sha_absent_ou_non_complet' };

  const limite = maintenant() + Math.max(0, delaiMaxMs);
  let dernierDiagnostic = { candidats: 0, etats: [], urlRejetee: null };

  for (;;) {
    let liste;
    try {
      liste = await appelApi({
        apiBase,
        token,
        fetchImpl,
        chemin: `/repos/${repository}/deployments?sha=${encodeURIComponent(sha)}&per_page=100`,
      });
    } catch (error) {
      return { code: CODES_PREVIEW.api, raison: `api_injoignable:${String(error?.message || error).slice(0, 80)}` };
    }
    if (!liste.ok) return { code: CODES_PREVIEW.api, raison: `api_deployments_http_${liste.status}` };

    const tous = Array.isArray(liste.corps) ? liste.corps : [];
    // La correspondance de SHA est verifiee sur le deploiement lui-meme, pas
    // sur le parametre de requete : `?sha=` filtre les refs, il ne garantit
    // rien sur le build. Un deploiement d'un autre commit est ignore, jamais
    // utilise.
    const candidats = tous
      .filter((d) => String(d?.sha || '').toLowerCase() === String(sha).toLowerCase())
      .filter((d) => String(d?.environment || '').toLowerCase() !== 'production')
      .filter((d) => String(d?.environment || '').toLowerCase() === String(environnement).toLowerCase())
      .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));

    dernierDiagnostic.candidats = candidats.length;
    dernierDiagnostic.etats = [];

    for (const deploiement of candidats) {
      let statuts;
      try {
        statuts = await appelApi({
          apiBase,
          token,
          fetchImpl,
          chemin: `/repos/${repository}/deployments/${deploiement.id}/statuses?per_page=20`,
        });
      } catch (error) {
        return { code: CODES_PREVIEW.api, raison: `api_injoignable_statuts:${String(error?.message || error).slice(0, 80)}` };
      }
      if (!statuts.ok) {
        return { code: CODES_PREVIEW.api, raison: `api_statuts_http_${statuts.status}` };
      }
      const etat = String(statuts.corps?.[0]?.state || 'pending').toLowerCase();
      const urlBrute = statuts.corps?.[0]?.environment_url || statuts.corps?.[0]?.target_url || '';
      dernierDiagnostic.etats.push(`${deploiement.id}:${etat}`);

      if (etat !== 'success') continue;

      const verdict = validerUrlPreview(urlBrute);
      if (!verdict.ok) {
        // Un deploiement pret dont l'URL est inutilisable (production, autre
        // projet, parametres) est une erreur de configuration : on s'arrete
        // tout de suite au lieu d'attendre une autre URL qui n'arrivera pas.
        return {
          code: CODES_PREVIEW.url_invalide,
          raison: verdict.raison,
          deploymentId: deploiement.id,
          url: String(urlBrute || ''),
        };
      }
      journal(`deploiement_preview id=${deploiement.id} etat=${etat} hote=${verdict.hostname} sha=${sha}`);
      return {
        code: CODES_PREVIEW.ok,
        url: `${verdict.url.protocol}//${verdict.url.host}`,
        hostname: verdict.hostname,
        deploymentId: deploiement.id,
        deploymentSha: String(deploiement.sha).toLowerCase(),
        deploymentRef: deploiement.ref,
        etat,
        shaTeste: String(sha).toLowerCase(),
        urlSource: 'deploiement_du_sha',
      };
    }

    if (maintenant() >= limite) {
      if (dernierDiagnostic.candidats === 0) {
        return { code: CODES_PREVIEW.aucun_deploiement, raison: 'aucun_deploiement_preview_pour_ce_sha', ...dernierDiagnostic };
      }
      return { code: CODES_PREVIEW.etat_non_pret, raison: 'deploiement_present_mais_jamais_pret', ...dernierDiagnostic };
    }
    if (intervalleMs > 0) await dormir(intervalleMs);
  }
}

/** Ecrit une sortie de step GitHub Actions quand le fichier existe. */
export function ecrireSortie(nom, valeur) {
  const fichier = process.env.GITHUB_OUTPUT;
  if (fichier) {
    // Nouvelle syntaxe (nom<<delimiteur) : une URL ne peut pas casser le format.
    const delimiteur = `FIN_${nom}_${Date.now()}`;
    appendFileSync(fichier, `${nom}<<${delimiteur}\n${valeur}\n${delimiteur}\n`);
  }
}

/** Ecrit une variable d'environnement pour les steps suivants. */
export function ecrireEnvironnement(nom, valeur) {
  const fichier = process.env.GITHUB_ENV;
  if (fichier) {
    const delimiteur = `FIN_${nom}_${Date.now()}`;
    appendFileSync(fichier, `${nom}<<${delimiteur}\n${valeur}\n${delimiteur}\n`);
  }
}
