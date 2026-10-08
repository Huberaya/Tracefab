#!/usr/bin/env node
/**
 * Chantier 27 — Les API exposées au Chantier 24 sont branchées, sans fabrication.
 *
 * Trois choses sont vérifiées :
 *   A. le manifeste d'audit réel n'invente plus ni vérificateur ni date de vérification
 *      (modules compilés et exécutés) ;
 *   B. GET /api/integrations/plm ne publie plus trois connecteurs inventés « CONNECTED » ;
 *   C. les deux API branchables le sont vraiment : un bouton, un gestionnaire, et le bon
 *      endpoint — avec le contrat d'entrée vérifié dans le source du gestionnaire.
 *
 * `POST /api/quality/calculate-index` n'est volontairement PAS branché : il exige un
 * tableau `components` de dix champs par composant que TRACEFAB ne stocke nulle part.
 * Le brancher sur un formulaire aurait transformé un indice de qualité en nombre
 * auto-déclaré. Ce test épingle cette décision.
 *
 *   npm run test:api:wiring
 */
import { readFile } from 'node:fs/promises';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

let checks = 0;
let failures = 0;
const ok = (label) => { checks += 1; console.log(`  ok  ${label}`); };
const fail = (label, detail) => {
  failures += 1;
  checks += 1;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const assert = (cond, label, detail) => (cond ? ok(label) : fail(label, detail));
const eq = (actual, expected, label) =>
  assert(actual === expected, label, `obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', ...options });
    let output = '';
    child.stdout?.on('data', (c) => { output += c; });
    child.stderr?.on('data', (c) => { output += c; });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} a échoué (${code})\n${output}`)),
    );
  });
}

const read = (rel) => readFile(join(root, rel), 'utf8');

// ---------------------------------------------------------------------------
console.log('\nA. Le manifeste d’audit n’invente plus la vérification');
// ---------------------------------------------------------------------------

await mkdir(join(root, '.cache'), { recursive: true });
const outDir = await mkdtemp(join(root, '.cache', 'apipack-test-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/audit-pack.ts', '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020',
  ], { cwd: root });
  ok('audit-pack.ts compile sans erreur');
} catch (error) {
  fail('audit-pack.ts ne compile pas', String(error.message).split('\n')[0]);
}

const { generateAuditPackManifest } = await import(
  pathToFileURL(join(outDir, 'audit-pack.js')).href
);
assert(typeof generateAuditPackManifest === 'function', 'generateAuditPackManifest importée du module réel');

/* Rapport à zéro : ce que renvoie calculateDataQualityIndex sans composants. */
const emptyReport = {
  productId: 'p-1',
  sku: 'AW26-0248',
  overallScore: 0,
  completenessScore: 0,
  evidenceCoverageScore: 0,
  verificationScore: 0,
  consistencyScore: 0,
  tierDistribution: { certified: 0, verified: 0, documented: 0, declared: 0, needs_review: 0, missing: 0 },
  components: [],
  csrdAuditReadiness: {
    isAuditable: false,
    esrsCategoryCoverage: { e1_climate: false, e2_pollution: false, e4_biodiversity: false, e5_circular_economy: false },
    blockingDiscrepancies: ['No components supplied for evaluation.'],
  },
};

/* Un document SANS vérification : le cas qui déclenchait l'invention. */
const unverifiedDoc = {
  id: 'doc-1',
  filename: 'gots-certificate.pdf',
  sha256: 'a'.repeat(64),
  standard: 'GOTS v6.0',
};

const manifest = generateAuditPackManifest('org-1', emptyReport, [unverifiedDoc]);
eq(manifest.evidenceFiles.length, 1, 'le document fourni figure au manifeste');
eq(manifest.evidenceFiles[0].verifiedBy, null, 'aucun vérificateur n’est inventé');
eq(manifest.evidenceFiles[0].verifiedAt, null, 'aucune date de vérification n’est inventée');

/* Un document réellement vérifié doit conserver ses valeurs. */
const verifiedManifest = generateAuditPackManifest('org-1', emptyReport, [{
  ...unverifiedDoc,
  verifiedBy: 'Control Union',
  verifiedAt: '2026-03-04T10:00:00.000Z',
}]);
eq(verifiedManifest.evidenceFiles[0].verifiedBy, 'Control Union', 'un vérificateur réel est conservé');
eq(verifiedManifest.evidenceFiles[0].verifiedAt, '2026-03-04T10:00:00.000Z', 'une date réelle est conservée');

/* Sans composant, le manifeste doit le dire plutôt qu'afficher un indice flatteur. */
eq(manifest.summary.dataQualityIndex, 0, 'l’indice vaut 0 quand aucun composant n’est fourni');
eq(manifest.summary.isFullyDefensible, false, 'le manifeste ne se déclare pas défendable');
eq(manifest.summary.auditorSignoffReady, false, 'et ne se déclare pas prêt pour signature');

const auditSrc = await read('api/_lib/audit-pack.ts');
assert(
  !auditSrc.includes('TRACEFAB_ALGORITHMIC_AUDITOR') ||
    auditSrc.split('TRACEFAB_ALGORITHMIC_AUDITOR').length === 2,
  'l’auditeur algorithmique inventé ne subsiste que dans le commentaire explicatif',
);

// ---------------------------------------------------------------------------
console.log('\nB. GET /api/integrations/plm ne publie plus de connecteurs inventés');
// ---------------------------------------------------------------------------

const plmSrc = await read('api/_routes/integrations/plm.ts');
for (const fabricated of ['conn-centric-01', 'conn-lectra-01', 'conn-sap-01', 'SAP_S4HANA', 'LECTRA_KUBIX', 'CENTRIC_PLM']) {
  assert(!plmSrc.includes(fabricated), `identifiant inventé absent : ${fabricated}`);
}
assert(plmSrc.includes('availableConnectors: []'), 'la liste des connecteurs est vide');
assert(
  /Aucun connecteur PLM\/ERP n’est configuré/.test(plmSrc),
  'la réponse explique pourquoi la liste est vide',
);
assert(
  !/status: 'CONNECTED'/.test(plmSrc),
  'aucun connecteur n’est déclaré CONNECTED',
);
assert(
  !/lastSyncedAt: new Date\(Date\.now\(\)/.test(plmSrc),
  'aucune date de synchronisation n’est fabriquée sur Date.now()',
);
/* La branche POST, elle, fait un vrai travail : elle doit subsister. */
assert(plmSrc.includes('ingestPlmProductBom'), 'l’ingestion réelle de nomenclatures est conservée');

// ---------------------------------------------------------------------------
console.log('\nC. Les deux API branchables sont réellement branchées');
// ---------------------------------------------------------------------------

const consoleSrc = await read('brand-console/index.html');
assert(
  consoleSrc.includes("'/api/quality/audit-pack'"),
  'la console appelle POST /api/quality/audit-pack',
);
assert(
  consoleSrc.includes("action === 'generate-audit-pack'"),
  'un gestionnaire traite l’action « generate-audit-pack »',
);
assert(
  consoleSrc.includes('data-action="generate-audit-pack"'),
  'un bouton déclenche cette action',
);
assert(
  /async function generateAuditPack\(/.test(consoleSrc),
  'la fonction d’appel existe',
);
/* Le contrat d'entrée vérifié dans le gestionnaire : productId obligatoire. */
assert(
  /productId,\n?\s*sku:/.test(consoleSrc) || consoleSrc.includes('productId,'),
  'l’appel fournit productId, seul champ obligatoire de l’endpoint',
);
const auditRoute = await read('api/_routes/quality/audit-pack.ts');
assert(
  auditRoute.includes("error: 'product_id_required'"),
  'le gestionnaire exige bien productId (contrat confirmé côté serveur)',
);
assert(
  auditRoute.includes('components || []'),
  'et traite components comme optionnel — aucun composant n’est donc inventé côté client',
);

const portalSrc = await read('supplier-portal/index.html');
assert(
  portalSrc.includes("'/api/supplier/certifications/ocr-extract'"),
  'le portail fournisseur appelle POST /api/supplier/certifications/ocr-extract',
);
assert(
  portalSrc.includes("id=\"certificate-ocr-form\""),
  'un formulaire d’extraction OCR est rendu',
);
assert(
  portalSrc.includes("getElementById('certificate-ocr-form')"),
  'sa soumission est branchée',
);
assert(
  /async function extractCertificateOcr\(/.test(portalSrc),
  'la fonction d’appel existe',
);
assert(
  portalSrc.includes('name="rawText"'),
  'le formulaire fournit rawText, seul champ obligatoire de l’endpoint',
);
const ocrRoute = await read('api/_routes/supplier/certifications/ocr-extract.ts');
assert(
  ocrRoute.includes("error: 'raw_text_required'"),
  'le gestionnaire exige bien rawText (contrat confirmé côté serveur)',
);
assert(
  portalSrc.includes('state.ocr'),
  'le résultat est stocké dans l’état du portail',
);
assert(
  /Rien n’a été enregistré|n’enregistre pas/.test(portalSrc),
  'l’interface précise qu’extraire ne déclare rien',
);

// ---------------------------------------------------------------------------
console.log('\nD. calculate-index n’est pas branché sur des composants inventés');
// ---------------------------------------------------------------------------

assert(
  !consoleSrc.includes("'/api/quality/calculate-index'"),
  'la console n’appelle pas calculate-index',
);
assert(
  !portalSrc.includes("'/api/quality/calculate-index'"),
  'le portail fournisseur non plus',
);
/* La raison est documentée dans le code, pas seulement dans ce test. */
assert(
  auditRoute.includes('ComponentQualityItem'),
  'le contrat exige des ComponentQualityItem — dix champs par composant',
);

// ---------------------------------------------------------------------------
console.log('\nE. Les quatre routes restent déclarées et ordonnées');
// ---------------------------------------------------------------------------

const router = await read('api/index.ts');
for (const path of [
  'integrations/plm',
  'quality/audit-pack',
  'quality/calculate-index',
  'supplier/certifications/ocr-extract',
]) {
  assert(router.includes(`_routes/${path}.js`), `${path} est déclaré dans le routeur`);
}
const ocrIndex = router.indexOf('supplier\\/certifications\\/ocr\\-extract');
const byIdIndex = router.indexOf("supplier\\/certifications\\/([^\\/]+)$");
assert(ocrIndex > -1 && byIdIndex > -1 && ocrIndex < byIdIndex, 'ocr-extract reste déclaré avant [certificationId]');

await rm(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
