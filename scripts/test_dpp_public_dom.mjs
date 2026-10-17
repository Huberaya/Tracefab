/* ==========================================================================
   Hydratation reelle du passeport public, sans navigateur.

   Le contrat navigateur existait mais ne pouvait pas s'executer dans cet
   environnement (aucun binaire Chromium). Ce test charge le HTML reel dans
   jsdom, execute le script reel `assets/js/dpp.2.js`, et remplace uniquement
   le reseau par un payload de projection publique.

   Ce qui est prouve :
     - un identifiant reel masque toute la demonstration ;
     - les valeurs de l'API sont inserees comme TEXTE (aucune execution) ;
     - les affirmations affichent leur niveau reel, leurs preuves acceptees,
       leur verificateur et les contradictions ;
     - le JSON-LD ne contient que des champs `sourced` ;
     - une erreur reseau ne retombe jamais sur les affirmations de demo.
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let failures = 0;
const ok = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.error('  ECHEC ' + m); failures++; };
const assert = (cond, msg) => { if (cond) ok(msg); else fail(msg); };

const HTML = readFileSync('dpp/index.html', 'utf8');
const SCRIPT = readFileSync('assets/js/dpp.2.js', 'utf8');

const field = (value, status = 'sourced', source = 'product_record') => ({ value, status, source });

function payload() {
  return {
    dpp: {
      productName: field('T-shirt Coton Bio <img src=x onerror="window.__xss=1">'),
      productReference: field('AT-ESS-001'),
      sku: field('SKU-TEST-1'),
      gtin: field('3760123456789', 'unverified'),
      serialNumber: field(null, 'not_filled'),
      category: field('T-shirt'),
      brandName: field('Atelier Réel'),
      countryOfManufacture: field('Portugal'),
      countryOfDesign: field(null, 'not_filled'),
      weightGrams: field(185),
      composition: field('95 % coton biologique, 5 % élasthanne'),
      materials: [
        {
          name: field('Coton biologique', 'sourced', 'materials_record'),
          percentage: field(95, 'sourced', 'materials_record'),
          role: field('principal', 'sourced', 'materials_record'),
          originCountry: field('Portugal', 'sourced', 'materials_record'),
        },
        {
          name: field('Élasthanne', 'sourced', 'materials_record'),
          percentage: field(5, 'unverified', 'materials_record'),
          role: field(null, 'not_filled'),
          originCountry: field(null, 'not_filled'),
        },
      ],
      supplyChainSummary: field('Filature et tissage au Portugal ; confection au Portugal.'),
      careInstructions: field('Laver à 30 °C.'),
      recyclingInstructions: field(null, 'not_filled'),
      transactionCertificateNumber: field('TC-2026-0042'),
      verificationDate: field('2026-09-01'),
      links: { dppUrl: 'https://tracefab.example/dpp/3760123456789', digitalLinkUri: field(null, 'not_filled') },
      presentation: {
        source: 'live', sourcedFieldCount: 18, missingFieldCount: 6, unverifiedFieldCount: 2,
        lastUpdatedAt: '2026-10-01T09:30:00.000Z', publicClaimsCount: 1,
      },
      limits: {
        missingFields: 6, unverifiedFields: 2, claimsWithoutAcceptedEvidence: 1,
        notice: 'Les données absentes ne sont pas remplacées par des valeurs supposées.',
      },
      capabilities: { hasComposition: true, hasTraceability: true, hasCareInstructions: true, hasClaims: true },
    },
    claims: [{
      id: 'claim-1',
      claimKey: 'origin.portugal',
      statement: '<img src=x onerror="window.__xss=1"> Tissé au Portugal',
      validationStatus: 'third_party_verified',
      validFrom: '2026-01-01',
      validUntil: '2027-01-01',
      expired: false,
      acceptedEvidenceCount: 2,
      evidenceLabels: ['Certificat de traçabilité — filature', 'Rapport d’audit — confection'],
      contradictingEvidenceCount: 1,
      verifierDisplayName: 'Audit Tiers SA',
      reviewedAt: '2026-09-01T10:00:00.000Z',
    }],
    history: [{
      id: 'event-1', eventType: 'published', validationStatus: 'controlled',
      publicSummary: 'Passeport publié après revue.', recordedAt: '2026-10-01T09:30:00.000Z',
      businessOccurredAt: '2026-10-01T09:30:00.000Z', verifiedByName: null,
    }],
  };
}

function makeDom(url, response) {
  const dom = new JSDOM(HTML, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.TF_I18N = {
    lang: 'fr',
    t: (key, fallback) => (fallback === undefined ? key : fallback),
    setLanguage: () => {},
  };
  window.TFActions = { register: () => {} };
  window.fetch = () => (response instanceof Error
    ? Promise.reject(response)
    : Promise.resolve({ ok: true, json: async () => response }));
  window.eval(SCRIPT);
  return dom;
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 80));

/* --- 1. Passeport reel hydrate ------------------------------------------ */
{
  const dom = makeDom('https://tracefab.example/dpp/3760123456789', payload());
  const { window } = dom;
  await wait();
  const document = window.document;
  const root = document.getElementById('dpp-live');

  assert(document.documentElement.getAttribute('data-dpp-source') === 'live', 'source de page = live');
  assert(document.documentElement.getAttribute('data-dpp-requested') === 'true', 'identifiant reel signale');
  assert(root && root.hidden === false, 'sections publiques affichees');
  assert(document.getElementById('dpp-demo-banner')?.hidden === true, 'banniere de demonstration masquee');
  const heroText = document.querySelector('.product-hero')?.textContent || '';
  assert(!heroText.includes('GOTS') && !heroText.includes('Atelier Demo'),
    'aucune certification ni marque de demonstration dans le heros reel');

  const identity = document.getElementById('live-identity')?.textContent || '';
  assert(identity.includes('Atelier Réel'), 'identite reelle affichee');
  assert(identity.includes('Portugal'), 'pays de fabrication affiche');
  assert(identity.includes('Non renseigné'), 'champ absent signale explicitement');
  assert(!identity.includes('Atelier Demo'), 'aucune valeur de demonstration conservee');

  const claims = document.getElementById('live-claims');
  const claimText = claims?.textContent || '';
  assert(claimText.includes('Tissé au Portugal'), 'affirmation reelle affichee');
  assert(claimText.includes('Vérifié par un tiers'), 'niveau de controle reel affiche');
  assert(claimText.includes('2 preuves acceptées'), 'nombre de preuves acceptees affiche');
  assert(claimText.includes('Audit Tiers SA'), 'verificateur identifie');
  assert(claimText.includes('1 preuve contradictoire acceptée'), 'contradiction signalee');
  assert(claims && claims.querySelectorAll('img').length === 0, 'aucun HTML de l API execute');
  assert(window.__xss === undefined, 'aucun script injecte execute');
  assert(claimText.includes('<img src=x'), 'la charge hostile reste du texte visible');

  const limits = document.getElementById('live-missing')?.textContent || '';
  assert(limits.includes('affirmation(s) annoncent un niveau de confiance sans preuve acceptée'),
    'limite sur les affirmations sans preuve affichee');

  const jsonLd = JSON.parse(document.getElementById('dpp-jsonld')?.textContent || '{}');
  assert(jsonLd['@type'] === 'Product', 'JSON-LD de type Product');
  assert(jsonLd.name.includes('T-shirt Coton Bio'), 'JSON-LD reprend le nom source');
  assert(jsonLd.gtin === undefined, 'JSON-LD exclut un GTIN non verifie');
  assert(Array.isArray(jsonLd.material) && jsonLd.material.length === 1, 'JSON-LD exclut une matiere au pourcentage non source');
  assert(!JSON.stringify(jsonLd).includes('GOTS'), 'aucune certification inventee dans le JSON-LD');
  assert(JSON.stringify(jsonLd).includes('"url"'), 'JSON-LD porte l URL publique');

  assert(document.title.includes('T-shirt Coton Bio'), 'titre de page derive du nom source');
}

/* --- 2. Erreur reseau : jamais de retombee sur la demo ------------------ */
{
  const dom = makeDom('https://tracefab.example/dpp/0000000000000', new Error('404'));
  const { window } = dom;
  await wait();
  const document = window.document;
  assert(document.getElementById('dpp-live')?.hidden === true, 'erreur : sections publiques masquees');
  assert(document.documentElement.getAttribute('data-dpp-source') === 'unavailable', 'erreur : source unavailable');
  const banner = document.getElementById('dpp-demo-banner');
  assert(banner && banner.hidden === false, 'erreur : banniere visible');
  assert((banner?.textContent || '').includes('Aucune donnée de démonstration'), 'erreur : message honnete');
  assert(!(document.getElementById('lifecycle-list')?.textContent || '').includes('Passeport créé'),
    'erreur : aucun historique de demonstration');
}

/* --- 3. Sans identifiant : demo assumee --------------------------------- */
{
  const dom = makeDom('https://tracefab.example/dpp/', payload());
  const { window } = dom;
  await wait();
  const document = window.document;
  assert(document.getElementById('dpp-live')?.hidden === true, 'demo : sections publiques masquees');
  assert(document.getElementById('dpp-demo-banner')?.hidden === false, 'demo : banniere visible');
  assert(document.querySelector('.product-hero.demo-only'), 'demo : bloc de demonstration marque');
  assert(HTML.includes('html[data-dpp-requested="true"] .demo-only'), 'demo : regle de masquage presente');
}

if (failures) {
  console.error(`\nPasseport public (DOM) : ${failures} echec(s).`);
  process.exit(1);
}
console.log('\nPasseport public (DOM) : hydratation, honnetete et non-execution verifiees.');
