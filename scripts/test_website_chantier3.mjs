#!/usr/bin/env node
/* ==========================================================================
   Chantier 03 — Website & Trust Center : contrat statique.

   Verifie, sans base ni navigateur :
     1. la route /api/leads est enregistree et son handler encadre
        (contexte RLS public_ingest, limitation de debit, validation,
        aucune authentification contournée) ;
     2. la migration tracefab_leads force la RLS et borne les colonnes ;
     3. l'adaptateur email de notification existe ;
     4. les cinq pages publiques existent avec SEO minimal
        (canonical, hreflang x-default, JSON-LD, selecteur de langue) ;
     5. la landing capture reellement le lead (POST /api/leads, etats
        succes/erreur) et ne ment plus sur le modal ;
     6. le namespace i18n `site` existe en EN et dans les six locales
        completes (parite deja garantie par test:i18n, on verifie la cle
        racine ici) ;
     7. sitemap et .env.example refletent le chantier.
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.error('  ECHEC ' + m); failures++; };
const check = (cond, m) => (cond ? ok(m) : fail(m));

/* --- 1. route leads ------------------------------------------------------ */
const index = read('api/index.ts');
check(/\^leads\$\/\.test ?\(|pattern: \/\^leads\$\/, params: \[\], load: \(\) => import\('\.\/_routes\/leads\.js'\)/.test(index),
  'route /api/leads enregistree dans api/index.ts');
check(existsSync(join(ROOT, 'api/_routes/leads.ts')), 'handler api/_routes/leads.ts present');

const leads = read('api/_routes/leads.ts');
check(leads.includes("set_config('tracefab.public_ingest'"), 'insertion sous contexte tracefab.public_ingest');
check(leads.includes('rateLimited') && leads.includes('RATE_WINDOW_MS'), 'limitation de debit best-effort presente');
check(leads.includes("KINDS = new Set(['demo', 'contact', 'pilot'])"), 'kind encadre : demo/contact/pilot');
check(leads.includes('EMAIL_RE.test(email)'), "validation d'email presente");
check(!leads.includes('requireClerkUser'), 'endpoint public : pas de session Clerk exigee (pas de contournement)');
check(leads.includes('new URL(body.sourceUrl.trim())'), 'source_url valide comme URL');
check(leads.includes('429'), 'reponse 429 en cas de depassement de debit');

/* --- 2. migration -------------------------------------------------------- */
const mig = read('prisma/migrations/20261008100000_website_leads/migration.sql');
check(mig.includes('CREATE TABLE IF NOT EXISTS tracefab_leads'), 'table tracefab_leads creee');
check(mig.includes('ENABLE ROW LEVEL SECURITY') && mig.includes('FORCE ROW LEVEL SECURITY'), 'RLS activee ET forcee');
check(mig.includes("current_setting('tracefab.public_ingest', true) = 'true'"), "politique d'insertion bornee au contexte d'ingestion");
check(mig.includes("current_setting('tracefab.worker_context', true) = 'true'"), 'lecture reservee au contexte worker interne');
check(!/FOR SELECT[\s\S]*USING\s*\(\s*true\s*\)/.test(mig), 'aucune politique de lecture ouverte (write-only)');
check(mig.includes("kind IN ('demo', 'contact', 'pilot')"), 'contrainte CHECK sur kind');
check(mig.includes("email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'"), 'contrainte CHECK sur email');

/* --- 3. notification ----------------------------------------------------- */
const email = read('api/_lib/email.ts');
check(email.includes('export async function sendLeadNotificationEmail'), 'adaptateur sendLeadNotificationEmail exporte');
check(email.includes('TRACEFAB_LEADS_NOTIFICATION_EMAIL'), 'destination configurable via env');
check(read('.env.example').includes('TRACEFAB_LEADS_NOTIFICATION_EMAIL='), '.env.example documente la variable');

/* --- 4. pages publiques -------------------------------------------------- */
const PAGES = ['platform', 'security', 'resources', 'about', 'contact'];
for (const p of PAGES) {
  const path = `${p}/index.html`;
  if (!existsSync(join(ROOT, path))) { fail(`page ${path} absente`); continue; }
  const html = read(path);
  check(html.includes(`<link rel="canonical" href="https://tracefab.vercel.app/${p}/">`), `${p}: canonical`);
  check(html.includes(`hreflang="x-default" href="https://tracefab.vercel.app/${p}/"`), `${p}: hreflang x-default`);
  check(html.includes('application/ld+json'), `${p}: donnees structurees JSON-LD`);
  check(html.includes('id="tf-site-lang"'), `${p}: selecteur de langue`);
  check(html.includes('data-i18n='), `${p}: copie portee par le catalogue i18n`);
  check(html.includes('tracefab-touch.css'), `${p}: socle tactile charge`);
}

/* --- 5. landing : capture reelle ----------------------------------------- */
const landing = read('index.html');
check(landing.includes('data-tf-demo-error'), 'landing : etat d\'erreur du modal present');
check(landing.includes('id="tf-demo-submit"'), 'landing : bouton de submission identifie (etat busy)');
check(!landing.includes('not connected to a mailbox'), 'landing : plus de mention « formulaire non connecte »');
const landingJs = read('assets/js/tf-landing.js');
check(landingJs.includes("fetch('/api/leads'"), 'landing : POST reel vers /api/leads');
check(landingJs.includes("kind: 'demo'"), 'landing : kind=demo pour les leads du modal');
const en = read('assets/i18n/en.js');
check(!en.includes('not connected to a mailbox'), 'en.js : succes du modal mis a jour');
check(/\bsending:/.test(en) && /\berrorTxt:/.test(en), 'en.js : cles modal.sending et modal.errorTxt presentes');

/* --- 6. namespace site ---------------------------------------------------- */
check(/\n\s*"site":\s*\{/.test(en) || /\n\s*site:\s*\{/.test(en), 'en.js : bloc site present');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const data = JSON.parse(read(`assets/i18n/${lang}.json`));
  check(Boolean(data.site && data.site.nav && data.site.form && data.site.contact), `${lang}: namespace site complet (nav/form/contact)`);
}

/* --- 7. sitemap ----------------------------------------------------------- */
const sitemap = read('sitemap.xml');
for (const p of PAGES) {
  check(sitemap.includes(`<loc>https://tracefab.vercel.app/${p}/</loc>`), `sitemap : /${p}/ reference`);
}

/* --- footer landing : plus de liens vers des .md non servis --------------- */
const footerLinks = landing.match(/tf-footer[\s\S]*?<\/footer>/);
check(footerLinks && !footerLinks[0].includes('/docs/'), 'landing footer : plus de liens vers des .md non servis');

if (failures) {
  console.error(`\nWebsite chantier 3 : ${failures} echec(s).`);
  process.exit(1);
}
console.log('\nWebsite chantier 3 : contrat OK.');
