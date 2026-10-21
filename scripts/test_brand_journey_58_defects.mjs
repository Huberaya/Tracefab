import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../assets/js/brand-console.1.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../brand-console/index.html', import.meta.url), 'utf8');
const fr = JSON.parse(fs.readFileSync(new URL('../assets/i18n/fr.json', import.meta.url), 'utf8')).console;
const pefRoute = fs.readFileSync(new URL('../api/_routes/products/[productId]/pef.ts', import.meta.url), 'utf8');
const settingsRoute = fs.readFileSync(new URL('../api/_routes/organization-settings.ts', import.meta.url), 'utf8');

const expectedFr = {
  cnDom2: 'COMPLÉTUDE DES DONNÉES',
  scGpsPolygons: 'Coordonnées GPS documentées',
  journeyDocumentRegistry: 'Registre documentaire avec contrôle d’intégrité',
  journeyLoadedDocuments: 'Documents chargés — intégrité SHA-256 contrôlée',
  evDownload: 'Télécharger le registre d’intégrité',
  evUpload: 'Déposer un nouveau document',
  journeyQuestionnaireModels: 'Modèles de questionnaires disponibles',
  qbDocEvidence: 'Document justificatif demandé + détection OCR',
  qcGreenShield: 'Audit d’allégations — détection de lacunes',
  riskDimData: 'Lacunes de complétude structurée',
};
for (const [key, value] of Object.entries(expectedFr)) assert.equal(fr[key], value, `copie FR incorrecte: ${key}`);

for (const token of [
  'loadOverviewInsights()', 'missingEvidenceCount', 'evidenceCoverage', 'declaredSteps', 'pefScore',
  "bt('journeyNoDocumentSource')", "bt('journeyNoCertMonitoring')", 'is-explanatory',
  "bt('journeySupplierRequired')", "bt('journeyAllStepsLinked')", 'disabled-obvious',
  "bt('journeyMissingEvidenceMessage')", "bt('journeyCertLifecycle')", "bt('journeyMappingGovernance')",
  'journeySourceCertificate', 'journeyDestinationProduct', 'journeyIntegrationLifecycle',
  'journeyPreviewApprovalFlow', 'journeyPefWarning', 'journeyStatusProvisional',
  'open-acknowledge-modal', 'acknowledge-issue', 'register-tc-form',
  'organization-settings-form', "api('/api/organization-settings')", 'journeyEvidenceWarnings',
]) assert.ok(source.includes(token), `contrat absent: ${token}`);

assert.ok(html.includes('.dc-pipeline-container.is-explanatory'), 'cycle vide non grisé');
assert.ok(html.includes('cursor: not-allowed'), 'état désactivé non perceptible');
assert.ok(pefRoute.includes('GET est une lecture pure'), 'GET PEF doit rester sans effet de bord');
assert.ok(!pefRoute.includes('regulatoryCompliance'), 'une lecture PEF ne doit pas attester la conformité');
assert.ok(settingsRoute.includes("roles: ['owner', 'admin']"), 'les paramètres doivent exiger un rôle privilégié');
assert.ok(settingsRoute.includes("action: ACTION"), 'chaque modification doit être historisée');
assert.ok(!fr.scMassNote.includes('éliminer tout risque'), 'promesse absolue de suppression du risque');
assert.ok(!fr.cnQcIntro.includes('authenticité documentaire'), 'le score qualité ne prouve pas l’authenticité');
console.log('Brand journey 58-defect contract passed');
