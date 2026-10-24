#!/usr/bin/env node
/**
 * Sessions Clerk de test pour la suite P1 staging.
 *
 * POURQUOI CE SCRIPT EXISTE
 *   `npm run test:p1:staging` exige trois etats de session Playwright
 *   authentifies et isoles : marque A, fournisseur, marque B dans une
 *   organisation distincte. Aucun etat de session n'est versionne dans le
 *   depot : ce sont des artefacts de session, donc des jetons. Ce script les
 *   fabrique a la volee, dans l'instance Clerk DE TEST, et les ecrit dans
 *   l'espace de travail du runner.
 *
 * CE QU'IL FAIT — deux phases
 *   phase `inspect`   (defaut) : lecture seule. Il decrit l'instance Clerk de
 *                      test (environnement, strategies de connexion relevees
 *                      sur la Frontend API, comptes et organisations de test
 *                      deja presents). Aucune ecriture, aucun secret affiche.
 *   phase `provision` : il cree ce qui manque — comptes de test, organisations
 *                      de test, adhesions — puis ouvre trois sessions
 *                      reelles et enregistre les trois etats de session.
 *
 * IDENTITES : echelle de candidats, perimetre strict
 *   L'API Clerk valide le format des adresses cote serveur, avec une regle
 *   plus stricte que le simple test syntaxique. Le 2026-10-24, le domaine
 *   special-use `tracefab.test` (TLD `.test`) a ete refuse en 422
 *   `form_param_format_invalid` sur `email_address` (run 40043764425). Le
 *   script n'improvise pas : il OFFRE a Clerk une echelle de candidats dans
 *   l'ordre documente dans `scripts/lib/identites_test.mjs` (domaines RFC
 *   2606 uniquement), retient le premier que l'instance accepte, et nomme le
 *   refus si les trois sont refuses. Le garde-fou de domaine est partage avec
 *   les tests de non-regression : aucune adresse hors perimetre ne peut
 *   etre candidate, meme apres modification.
 *
 *   Verification compatible avec le mode de verification de l'instance : les
 *   comptes sont crees avec `emailAddressIdentificationStatus: ['verified']`
 *   (defaut de l'API, explicite ici) — aucune verification par code n'est donc
 *   demandee a la connexion, quelle que soit la configuration `verify_at_sign_up`
 *   relevee en phase `inspect`.
 *
 * IDEMPOTENCE
 *   Chaque passe cherche les comptes par TOUS leurs candidats avant toute
 *   creation (`trouverIdentite`) ; l'organisation est reutilisee par son nom ;
 *   la creation n'a lieu que si le compte est absent de tous les candidats.
 *   Une relance ne multiplie donc ni utilisateur ni organisation — et elle le
 *   DIT : `creation_de_lance=<persona>:false` prouve que le compte existait.
 *
 * CE QU'IL REFUSE (codes de sortie, un par cause)
 *   2 configuration absente (cle ou cible manquante)
 *   3 cle qui ne commence pas par `sk_test_` — jamais de cle de production,
 *     meme tronquee dans la sortie
 *   4 strategie de connexion sans mot de passe confirmee sur l'instance
 *     (relevee sur la Frontend API ; indeterminee = on poursuit, le
 *     formulaire reel tranche et le refus est alors nomme)
 *   5 candidats d'adresses tous refuses par Clerk (422 format), avec les
 *     codes recus pour chaque candidat
 *   6 instance dont l'environnement releve est `production` — refusee, la
 *     cle `sk_test_` n'est qu'un premier garde-fou
 *   7 erreur API Clerk inattendue, nommee par son code, sans corps ni secret
 *   Toute adresse hors du perimetre `scripts/lib/identites_test.mjs` est
 *   refusee avant tout appel : aucune adresse reelle n'est touchee.
 *
 * CE QU'IL N'AFFICHE JAMAIS
 *   aucune valeur de secret, aucun cookie, aucun jeton de session, aucun
 *   mot de passe. Les etats de session ecrits sur disque ne sont ni commites
 *   ni publies en artefact : ils restent dans /tmp du runner.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { entetesBypass, exigerCiblePreview } from './lib/preview_deployment.mjs';
import { adresseAutorisee, candidatsIdentite } from './lib/identites_test.mjs';

const PHASE = (process.env.TF_P1_PHASE || 'inspect').trim();
const CLERK_API = 'https://api.clerk.com/v1';

const cle = (process.env.CLERK_SECRET_KEY || '').trim();
if (!cle) {
  console.error('CLERK_SECRET_KEY absent : aucun acces a l instance Clerk de test.');
  process.exit(2);
}
if (!cle.startsWith('sk_test_')) {
  console.error("CLERK_SECRET_KEY n'est pas une cle d'instance de test (`sk_test_`) : refus.");
  process.exit(3);
}

/**
 * Contournement de la protection de deploiement Vercel — OPTIONNEL.
 *
 * Les Previews Vercel de ce projet sont derriere la protection de deploiement
 * (SSO) : une requete non authentifiee y recoit un 302 vers `/sso-api`. Sans
 * contournement, ce script n'atteindrait JAMAIS le formulaire de connexion de
 * l'application — il mesurerait la protection, pas l'application.
 *
 * La valeur ne doit jamais etre affichee, ni loguee, ni placee dans une URL.
 */
const vercelBypass = (process.env.TRACEFAB_VERCEL_BYPASS || '').trim();
const bypassHeaders = entetesBypass(vercelBypass);

const baseUrl = (process.env.TRACEFAB_STAGING_URL || '').trim();
if (!baseUrl) {
  console.error('TRACEFAB_STAGING_URL absent : aucune cible.');
  process.exit(2);
}
// Cible validee AVANT tout appel : HTTPS, Preview Vercel du projet, sans
// parametre, jamais un hote de production.
const origin = exigerCiblePreview(baseUrl);
// Valeur canonique d'en-tête `Origin` : scheme + hote (+ port), jamais de
// chemin ni de barre oblique finale — `origin` est un objet URL.
const origineHttp = `${origin.protocol}//${origin.host}`;

const stateDir = (process.env.TF_P1_STATE_DIR || '/tmp/p1-storage-states').trim();

/**
 * Les trois personas du chantier P1. `base` est la partie locale de l'adresse
 * ; les candidats complets sont construits sur les domaines autorises uniquement
 * (`scripts/lib/identites_test.mjs`).
 */
const PERSONAS = [
  {
    cle: 'brand',
    fichier: 'brand.json',
    base: 'p1-brand-a',
    motDePasse: 'Tf-P1-Brand-A-2026!test',
    organisation: { nom: 'Tracefab P1 Marque A', type: 'brand' },
    surface: '/brand-console/',
  },
  {
    cle: 'supplier',
    fichier: 'supplier.json',
    base: 'p1-supplier',
    motDePasse: 'Tf-P1-Supplier-2026!test',
    organisation: { nom: 'Tracefab P1 Fournisseur', type: 'supplier' },
    surface: '/supplier-portal/',
  },
  {
    cle: 'second-brand',
    fichier: 'second-brand.json',
    base: 'p1-brand-b',
    motDePasse: 'Tf-P1-Brand-B-2026!test',
    organisation: { nom: 'Tracefab P1 Marque B', type: 'brand' },
    surface: '/brand-console/',
  },
];

// Garde-fou AVANT tout appel : chaque candidat de chaque persona doit etre
// dans le perimetre autorise. Une base invalide (espace, `@`) ou une adresse
// hors domaine est un arret immediat, pas un essai silencieux.
const candidatsParPersona = new Map();
for (const persona of PERSONAS) {
  let candidats;
  try {
    candidats = candidatsIdentite(persona.base);
  } catch {
    throw new Error(`base_identite_invalide:${persona.cle}`);
  }
  for (const adresse of candidats) {
    assert.ok(
      adresseAutorisee(adresse),
      `adresse hors du perimetre de test autorise : ${adresse}`,
    );
  }
  candidatsParPersona.set(persona.cle, candidats);
}

// Le SDK n'est charge qu'APRES les garde-fous (cle `sk_test_`, cible
// Preview, perimetre d'adresses) : un refus immediat ne depend jamais du
// chargement de la bibliotheque.
const { createClerkClient } = await import('@clerk/backend');
const clerk = createClerkClient({ secretKey: cle });

async function clerkApi(path, options = {}) {
  const response = await fetch(`${CLERK_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${cle}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) {
    const code = body?.errors?.[0]?.code || body?.code || `http_${response.status}`;
    throw new Error(`clerk_api_${code}`);
  }
  return body;
}

/* --- 1. etat de l'instance Clerk de test ---------------------------------- */

// L'objet `GET /v1/instance` du SDK v3 ne porte QUE `id`, `environment_type`
// et `allowed_origins` (InstanceJSON du SDK installe) : les anciens champs
// `instance_type` / `auth_settings` n'existent plus et donnaient un etat
// silencieusement inconnu. On lit les champs reels, on les nomme, et on
// refuse toute instance relevee en production.
const instance = await clerkApi('/instance').catch((e) => ({ __erreur: String(e?.message || e) }));
const instanceErreur = instance?.__erreur || null;
const environnementInstance = instance?.environment_type || 'inconnue';
console.log(`instance_environnement=${environnementInstance}`);
console.log(`instance_cles=${instance && !instanceErreur ? Object.keys(instance).sort().join(',') : 'absente'}`);
if (instanceErreur) console.log(`instance_erreur=${instanceErreur.slice(0, 80)}`);
if (environnementInstance === 'production') {
  console.error("instance_de_production : l'environment releve est `production`. "
    + 'Ce harnais ne cree que des comptes de test ; la cle et la configuration sont a revoir.');
  process.exit(6);
}

/**
 * Strategies de connexion reellement activees sur l'instance.
 *
 * Source : `GET {frontend-api}/v1/environment` — l'objet que clerk-js lui-meme
 * charge avant d'afficher le formulaire de connexion. La lecture est
 * PUBBLIQUE (aucun secret ; la cle publique de l'application est retiree de
 * `/api/config`, qui sert justement la configuration bootstrap). Tout echec
 * est nomme mais n'arrete pas : c'est le formulaire reel, etape provision,
 * qui fait autorite — un releve indetermine n'est pas une strategie absente.
 */
async function releverStrategiesInstance() {
  const resultats = { cause: null, passwordActif: null, passwordPremierFacteur: null,
    verificationEmailInscription: null, modeInscription: null, allowlistSeule: null,
    secondFacteurObligatoire: null };
  try {
    const repConfig = await fetch(new URL('/api/config', origin), {
      headers: bypassHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (!repConfig.ok) { resultats.cause = `config_http_${repConfig.status}`; return resultats; }
    const config = await repConfig.json();
    const pk = String(config?.publishableKey || '');
    if (!pk.startsWith('pk_')) { resultats.cause = 'config_cle_absente'; return resultats; }
    // La cle publique encode la Frontend API : base64 de `hote$`. Aucune
    // valeur n'est imprimee — seule l'identification de l'hote sert au
    // diagnostic.
    const decode = Buffer.from(pk.replace(/^pk_(test|live)_/, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8');
    const hote = decode.split('$')[0].trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hote)) { resultats.cause = 'fapi_non_identifiee'; return resultats; }

    const entetesFapi = { Origin: origineHttp };
    let repEnv = await fetch(`https://${hote}/v1/environment`, {
      headers: entetesFapi, signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (!repEnv || !repEnv.ok) {
      // Certains comptes rejettent un Origin non declare : on retente sans.
      repEnv = await fetch(`https://${hote}/v1/environment`, {
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
    }
    if (!repEnv || !repEnv.ok) { resultats.cause = repEnv ? `environment_http_${repEnv.status}` : 'environment_injoignable'; return resultats; }
    const env = await repEnv.json();
    const us = env?.user_settings || {};
    const bool = (v) => (typeof v === 'boolean' ? v : null);
    resultats.passwordActif = bool(us.attributes?.password?.enabled);
    resultats.passwordPremierFacteur = bool(us.attributes?.password?.used_for_first_factor);
    resultats.verificationEmailInscription = bool(us.attributes?.email_address?.verify_at_sign_up);
    resultats.modeInscription = typeof us.sign_up?.mode === 'string' ? us.sign_up.mode : null;
    resultats.allowlistSeule = bool(us.sign_up?.allowlist_only);
    resultats.secondFacteurObligatoire = bool(us.sign_in?.second_factor?.required);
    return resultats;
  } catch (e) {
    resultats.cause = `lecture_strategies:${e?.name || 'erreur'}`;
    return resultats;
  }
}

const strategies = await releverStrategiesInstance();
console.log(`strategies_source=${strategies.cause ? `indeterminee:${strategies.cause}` : 'frontend_api'}`);
console.log(`strategie_mot_de_passe=${strategies.passwordActif ?? 'inconnu'}`);
console.log(`mot_de_passe_premier_facteur=${strategies.passwordPremierFacteur ?? 'inconnu'}`);
console.log(`verification_email_inscription=${strategies.verificationEmailInscription ?? 'inconnu'}`);
console.log(`mode_inscription=${strategies.modeInscription ?? 'inconnu'}`);
console.log(`inscription_allowlist_seule=${strategies.allowlistSeule ?? 'inconnu'}`);
console.log(`second_facteur_obligatoire=${strategies.secondFacteurObligatoire ?? 'inconnu'}`);

/* --- 2. comptes de test deja presents -------------------------------------- */

/**
 * Recherche l'un des candidats du persona deja enregistre. La reponse
 * paginee du Backend API porte ses elements dans `data` : lire le tableau de
 * premier niveau donnerait toujours « aucun compte » et le script
 * recreerait un compte a chaque passage.
 *
 * @returns {Promise<{adresse: string, utilisateur: object}|null>}
 */
async function trouverIdentite(persona) {
  const candidats = candidatsParPersona.get(persona.cle);
  for (const adresse of candidats) {
    const page = await clerk.users.getUserList({ emailAddress: [adresse], limit: 1 });
    const u = page?.data?.[0] || null;
    if (u) return { adresse, utilisateur: u };
  }
  return null;
}

const etats = [];
for (const persona of PERSONAS) {
  const trouve = await trouverIdentite(persona);
  etats.push({ persona, adresse: trouve?.adresse || null, utilisateur: trouve?.utilisateur || null });
  console.log(`compte_present=${persona.cle}:${Boolean(trouve)}`);
}

async function organisationsDeTest() {
  try {
    const page = await clerk.organizations.getOrganizationList({ limit: 100 });
    return page?.data || [];
  } catch {
    return [];
  }
}

const organisations = await organisationsDeTest();
for (const persona of PERSONAS) {
  const trouvee = organisations.find((o) => o?.name === persona.organisation.nom);
  console.log(`organisation_presente=${persona.cle}:${Boolean(trouvee)}`);
}

if (PHASE === 'inspect') {
  console.log('phase=inspect — aucune ecriture effectuee.');
  process.exit(0);
}

// La connexion par mot de passe est la seule strategie que ce script sait
// jouer sans intervention. Si l'instance de test l'interdit CONFIRMEMENT,
// il faut le dire plutot que d'echouer plus tard sur un delai d'attente
// trompeur. Un releve indetermine ne bloque pas : le formulaire reel,
// etape apres, tranche et nomme alors le refus.
if (strategies.passwordActif === false || strategies.passwordPremierFacteur === false) {
  console.error(`L'instance Clerk de test n'offre pas la connexion par mot de passe `
    + `(strategie_mot_de_passe=${strategies.passwordActif}, `
    + `mot_de_passe_premier_facteur=${strategies.passwordPremierFacteur}) : `
    + 'ce harnais ne sait ouvrir une session que par mot de passe. '
    + "Activez la strategie mot de passe dans l'instance de test, ou fournissez une autre strategie.");
  process.exit(4);
}

/* --- 3. provision : comptes, organisations, adhesions ----------------------- */

/**
 * Cree le compte du persona en offrant chaque candidat a l'instance, dans
 * l'ordre. Un 422 `form_param_format_invalid` porte sur le format de
 * l'adresse : le candidat suivant est essaye, le refus est enregistre. Toute
 * AUTRE erreur API est immediatement rejetee — masquer un refus different
 * derriere le format serait un faux diagnostic.
 *
 * @returns {Promise<{adresse: string, utilisateur: object, creation: boolean}>}
 */
async function assurerUtilisateur(persona) {
  const existant = etats.find((e) => e.persona.cle === persona.cle);
  if (existant?.utilisateur) {
    // Un mot de passe deja pose n'est pas relisible : on le repose pour que la
    // session soit ouvrable meme si le compte precedait ce chantier.
    // `updateUser` accepte le mot de passe en clair (il est chiffre par
    // Clerk) ; `skipPasswordChecks` evite le refus des listes de mots de
    // passe faibles.
    await clerk.users.updateUser(existant.utilisateur.id, {
      password: persona.motDePasse,
      skipPasswordChecks: true,
    });
    console.log(`creation_de_lance=${persona.cle}:false`);
    return { adresse: existant.adresse, utilisateur: existant.utilisateur, creation: false };
  }

  const candidats = candidatsParPersona.get(persona.cle);
  const refus = [];
  for (const [indice, adresse] of candidats.entries()) {
    try {
      const u = await clerk.users.createUser({
        // En v3, `emailAddress` est une liste d'adresses et le statut de
        // verification est un tableau parallele. Les adresses sont verifiees
        // par defaut ; on l'ecrit quand meme pour ne pas dependre de ce
        // defaut : la connexion n'exigera alors aucun code, quel que soit le
        // mode `verify_at_sign_up` releve en phase inspect.
        emailAddress: [adresse],
        emailAddressIdentificationStatus: ['verified'],
        firstName: 'P1',
        lastName: persona.cle,
        password: persona.motDePasse,
        skipPasswordChecks: true,
      });
      console.log(`candidat_accepte=${persona.cle}:${indice}`);
      console.log(`creation_de_lance=${persona.cle}:true`);
      return { adresse, utilisateur: u, creation: true };
    } catch (e) {
      const codeClerk = e?.errors?.[0]?.code || e?.code || `http_${e?.status || 'inconnu'}`;
      if (codeClerk === 'form_param_format_invalid') {
        // Refus de FORMAT de l'adresse : on note, on essaie le candidat
        // suivant. Le code seul sort dans le journal — jamais de corps.
        refus.push(`${indice}:${codeClerk}`);
        continue;
      }
      console.error(`clerk_api_inattendue persona=${persona.cle} candidat=${indice} code=${codeClerk}`);
      process.exit(7);
    }
  }
  console.error(`clerk_adresses_refusees persona=${persona.cle} candidats=${candidats.join(',')} refus=${refus.join('|')}`);
  process.exit(5);
}

async function assurerOrganisation(persona, utilisateurClerk) {
  const metadata = {
    tracefab_organization_type: persona.organisation.type,
    legal_name: persona.organisation.nom,
  };
  const liste = await organisationsDeTest();
  const existante = liste.find((o) => o?.name === persona.organisation.nom);
  const organisation = existante
    ? await clerk.organizations.updateOrganizationMetadata(existante.id, { publicMetadata: metadata })
    : await clerk.organizations.createOrganization({
        name: persona.organisation.nom,
        publicMetadata: metadata,
      });
  console.log(`creation_organisation_lance=${persona.cle}:${existante ? 'false' : 'true'}`);

  const adhesions = await clerk.organizations.getOrganizationMembershipList({
    organizationId: organisation.id,
    limit: 100,
  });
  const dejaMembre = (adhesions?.data || []).find((m) => m?.publicUserData?.userId === utilisateurClerk.id);
  if (!dejaMembre) {
    await clerk.organizations.createOrganizationMembership({
      organizationId: organisation.id,
      userId: utilisateurClerk.id,
      role: 'org:admin',
    });
  }
  return organisation;
}

/* --- 4. sessions reelles et etats de session -------------------------------- */

const browser = await chromium.launch({ headless: true });
try {
  mkdirSync(stateDir, { recursive: true });

  for (const { persona } of etats) {
    const { adresse, utilisateur: u } = await assurerUtilisateur(persona);
    const organisation = await assurerOrganisation(persona, u);
    console.log(`provisionne=${persona.cle}:utilisateur:${Boolean(u)}:organisation:${Boolean(organisation)}`);

    const context = await browser.newContext({
      ...(Object.keys(bypassHeaders).length ? { extraHTTPHeaders: bypassHeaders } : {}),
    });
    const page = await context.newPage();
    // Les appels same-origin faits par la page elle-meme doivent porter le
    // meme contournement que la navigation, sinon la protection les
    // intercepterait aussi (302 vers /sso-api au lieu de la reponse JSON).
    if (Object.keys(bypassHeaders).length) {
      await page.addInitScript((headers) => {
        const original = window.fetch.bind(window);
        window.fetch = (input, init = {}) => {
          const merged = { ...(init.headers || {}) };
          for (const [name, value] of Object.entries(headers)) merged[name] = value;
          return original(input, { ...init, headers: merged });
        };
      }, bypassHeaders);
    }
    await page.goto(new URL(persona.surface, origin).toString(), { waitUntil: 'networkidle' });

    // Connexion reelle par l'IHM Clerk de l'application : ce n'est pas une
    // session injectee, c'est celle que produirait un utilisateur.
    const champIdentifiant = page.locator('input[name="identifier"], input[id*="identifier"], input[type="email"]').first();
    await champIdentifiant.waitFor({ state: 'visible', timeout: 45000 });
    await champIdentifiant.fill(adresse);
    const bouton = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Continuer")').first();
    await bouton.click();

    const champMotDePasse = page.locator('input[name="password"], input[type="password"]').first();
    try {
      await champMotDePasse.waitFor({ state: 'visible', timeout: 45000 });
    } catch {
      throw new Error(
        `le formulaire de connexion n'a pas propose de champ mot de passe pour ${persona.cle} : `
        + "soit la strategie de l'instance de test n'est pas le mot de passe, "
        + 'soit le compte a ete refuse a cette etape.',
      );
    }
    await champMotDePasse.fill(persona.motDePasse);
    await page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Continuer")').first().click();

    await page.waitForFunction(() => {
      const app = window.tracefabBrandConsole || window.tracefabSupplierPortal || window.tracefabQualityCenter;
      return Boolean(app?.state?.clerk?.session);
    }, null, { timeout: 60000 });

    const chemin = join(stateDir, persona.fichier);
    await context.storageState({ path: chemin });
    console.log(`etat_de_session_ecrit=${persona.cle}:${existsSync(chemin)}`);
    await context.close();
  }
} finally {
  await browser.close();
}

console.log('sessions_preparees=3');
