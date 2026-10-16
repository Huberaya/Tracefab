#!/usr/bin/env npx tsx
/**
 * Garde de signature des Wallets en production.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Avant ce correctif, les deux générateurs basculaient SILENCIEUSEMENT sur une
 * signature factice (Apple : « PKCS7_DEV_SIGNATURE_… » ; Google : secret HS256
 * en dur) quand la clé était absente ou la signature en échec. Une route
 * servait alors un passe non signé avec un statut 200. En production, cela ne
 * doit JAMAIS arriver : l'absence de signature est une erreur de configuration.
 *
 * Le test vérifie, pour NODE_ENV=production : erreur explicite (Apple et
 * Google, clé absente) ; et hors production : le mode de développement reste
 * disponible (aucune régression des tests locaux).
 *
 *   npm run test:wallet:signature-production
 */
import assert from 'node:assert/strict';

const env = process.env as Record<string, string | undefined>;
const sauvegarde = { ...env };

// Fixture conforme au contrat DppPassData / SourcedField (api/_lib/wallet/types.ts).
// Un champ absent est un etat explicite : value null, jamais une valeur inventee.
const f = <T,>(value: T | null, status: 'sourced' | 'unverified' | 'not_filled' | 'unavailable' = value === null ? 'not_filled' : 'sourced', source: string | null = value === null ? null : 'test.fixture') => ({ value, status, source });
const donnees: any = {
  productId: '00000000-0000-4000-8000-00000000f1f1',
  productName: f('Test Signature'), productReference: f('T-SIG-1'), sku: f('SKU-SIG-1'),
  gtin: f('4006381333931'), serialNumber: f('T-SIG-1-v1'), category: f(null),
  brandName: f('Marque Test'), countryOfManufacture: f(null), countryOfDesign: f('FR'),
  weightGrams: f(null), composition: f(null), materials: [], supplyChainSummary: f(null),
  pefScore: f(null), pefGrade: f(null), carbonFootprintKgCo2e: f(null),
  waterScarcityM3: f(null), circularityScore: f(null), verificationDate: f(null),
  transactionCertificateNumber: f(null), careInstructions: f(null),
  recyclingInstructions: f(null), dppUrl: 'https://tracefab.com/dpp/4006381333931',
  digitalLinkUri: f('https://id.tracefab.com/01/4006381333931', 'sourced', 'gs1.digital_link'),
  presentation: { source: 'partial' },
  brandCountry: 'FR',
};

function reinitialiser() {
  for (const k of Object.keys(env)) if (!(k in sauvegarde)) delete env[k];
  for (const [k, v] of Object.entries(sauvegarde)) env[k] = v;
  delete env.APPLE_PASS_CERTIFICATE_PEM; delete env.APPLE_PASS_KEY_PEM;
  delete env.GOOGLE_WALLET_PRIVATE_KEY;
}

let echecs = 0;
const cas = async (libelle: string, f: () => Promise<void>) => {
  try { await f(); console.log(`  ok    ${libelle}`); }
  catch (e: any) { echecs += 1; console.log(`  ECHEC ${libelle} — ${e.message}`); }
};

console.log('\n  Signature des Wallets — garde de production\n');

const apple = await import('../api/_lib/wallet/apple-pass-generator.ts');
const google = await import('../api/_lib/wallet/google-wallet-generator.ts');

await cas('production + Apple sans certificat : erreur explicite', async () => {
  reinitialiser(); env.NODE_ENV = 'production';
  await assert.rejects(() => apple.generateApplePkpass(donnees), /apple_wallet_not_configured/);
});
await cas('production + Google sans clé : erreur explicite, aucun jeton émis', async () => {
  reinitialiser(); env.NODE_ENV = 'production';
  assert.throws(() => google.generateGoogleWalletPass(donnees), /google_wallet_not_configured/);
});
await cas('production + Google clé invalide : erreur, pas de repli HS256', async () => {
  reinitialiser(); env.NODE_ENV = 'production'; env.GOOGLE_WALLET_PRIVATE_KEY = 'pas-une-cle';
  assert.throws(() => google.generateGoogleWalletPass(donnees), /google_wallet_signing_failed/);
});
await cas('hors production + Google sans clé : mode développement disponible', async () => {
  reinitialiser(); env.NODE_ENV = 'test';
  const r = google.generateGoogleWalletPass(donnees);
  assert.equal(r.isSimulated, true);
});
await cas('hors production + Apple sans certificat : mode développement disponible', async () => {
  reinitialiser(); env.NODE_ENV = 'test';
  const buf = await apple.generateApplePkpass(donnees);
  assert.ok(buf.length > 0);
});

reinitialiser();
console.log(echecs
  ? `\n  ${echecs} échec(s) — une signature factice pourrait sortir en production.`
  : '\n  Aucun passe non signé ne peut sortir en production.');
process.exit(echecs ? 1 : 0);
