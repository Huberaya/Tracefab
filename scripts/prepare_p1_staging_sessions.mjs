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
 *                      test (strategies de connexion), les comptes de test
 *                      deja presents et les organisations de test deja
 *                      presentes. Aucune ecriture, aucun secret affiche.
 *   phase `provision` : il cree ce qui manque — comptes de test, organisations
 *                      de test, adhesions — puis ouvre trois sessions
 *                      reelles et enregistre les trois etats de session.
 *
 * CE QU'IL REFUSE
 *   1. une cle qui ne commence pas par `sk_test_` : une cle d'instance de
 *      production est refusee sans etre affichee, meme tronquee ;
 *   2. toute adresse qui n'est pas en domaine `.test` : aucune adresse reelle
 *      n'est touchee ;
 *   3. une cible qui n'est pas une Preview Vercel en HTTPS.
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

const stateDir = (process.env.TF_P1_STATE_DIR || '/tmp/p1-storage-states').trim();

/**
 * Les trois personas du chantier P1. Tous les domaines sont `.test` : aucune
 * adresse reelle n'est utilisee, et aucune donnee reelle n'est lue.
 */
const PERSONAS = [
  {
    cle: 'brand',
    fichier: 'brand.json',
    email: 'p1-brand-a@tracefab.test',
    motDePasse: 'Tf-P1-Brand-A-2026!test',
    organisation: { nom: 'Tracefab P1 Marque A', type: 'brand' },
    surface: '/brand-console/',
  },
  {
    cle: 'supplier',
    fichier: 'supplier.json',
    email: 'p1-supplier@tracefab.test',
    motDePasse: 'Tf-P1-Supplier-2026!test',
    organisation: { nom: 'Tracefab P1 Fournisseur', type: 'supplier' },
    surface: '/supplier-portal/',
  },
  {
    cle: 'second-brand',
    fichier: 'second-brand.json',
    email: 'p1-brand-b@tracefab.test',
    motDePasse: 'Tf-P1-Brand-B-2026!test',
    organisation: { nom: 'Tracefab P1 Marque B', type: 'brand' },
    surface: '/brand-console/',
  },
];

for (const persona of PERSONAS) {
  assert.ok(persona.email.endsWith('.test'), 'adresse de test attendue');
}

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

const { createClerkClient } = await import('@clerk/backend');
const clerk = createClerkClient({ secretKey: cle });

const instance = await clerkApi('/instance').catch(() => null);
const auth = instance?.auth_settings || {};
console.log(`instance_instance=${instance?.instance_type || 'inconnue'}`);
console.log(`instance_email_password=${Boolean(auth?.password?.enabled)}`);
console.log(`instance_first_factor=${Array.isArray(auth?.first_factor) ? auth.first_factor.join(',') : 'inconnu'}`);
console.log(`instance_sign_up=${auth?.sign_up?.enabled === false ? 'desactive' : 'actif'}`);

/* --- 2. comptes de test deja presents -------------------------------------- */

async function utilisateur(email) {
  // La reponse paginee du Backend API porte ses elements dans `data` : lire le
  // tableau de premier niveau donnerait toujours « aucun compte » et le
  // script recréerait un compte a chaque passage.
  const page = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
  return page?.data?.[0] || null;
}

const etats = [];
for (const persona of PERSONAS) {
  const u = await utilisateur(persona.email);
  etats.push({ persona, utilisateur: u });
  console.log(`compte_present=${persona.cle}:${Boolean(u)}`);
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
// jouer sans intervention. Si l'instance de test ne l'a pas, il faut le dire
// plutot que d'echouer plus tard sur un delai d'attente trompeur.
if (instance && instance.auth_settings && auth.password && auth.password.enabled === false) {
  console.error("L'instance Clerk de test n'a pas la strategie mot de passe : "
    + 'ce harnais ne sait ouvrir une session que par mot de passe. '
    + "Activez la strategie mot de passe dans l'instance de test, ou fournissez une autre strategie.");
  process.exit(4);
}

/* --- 3. provision : comptes, organisations, adhesions ----------------------- */

async function assurerUtilisateur(persona) {
  const existant = await utilisateur(persona.email);
  if (existant) {
    // Un mot de passe deja pose n'est pas relisible : on le repose pour que la
    // session soit ouvrable meme si le compte precedait ce chantier.
    // `updateUser` accepte le mot de passe en clair (il est chiffre par
    // Clerk) ; `skipPasswordChecks` evite le refus des listes de mots de
    // passe faibles.
    await clerk.users.updateUser(existant.id, {
      password: persona.motDePasse,
      skipPasswordChecks: true,
    });
    return existant;
  }
  return clerk.users.createUser({
    // En v3, `emailAddress` est une liste d'adresses et le statut de
    // verification est un tableau parallele. Les adresses sont verifiees par
    // defaut ; on l'ecrit quand meme pour ne pas dependre de ce defaut.
    emailAddress: [persona.email],
    emailAddressIdentificationStatus: ['verified'],
    firstName: 'P1',
    lastName: persona.cle,
    password: persona.motDePasse,
    skipPasswordChecks: true,
  });
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

  for (const { persona, utilisateur: existant } of etats) {
    const u = await assurerUtilisateur(persona);
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
    await champIdentifiant.fill(persona.email);
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
