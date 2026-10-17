/* ==========================================================================
   Contrat de confiance DPP : interface privee + API + regles SQL.

   Ce test ne remplace pas l'execution PostgreSQL (voir
   test_neon_dynamic_dpp_lifecycle.mjs). Il verifie que l'interface privee
   n'expose pas un chemin qui contournerait les fonctions SQL, et que les
   libelles de statut existent dans toutes les langues completes.
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { pageSource } from './lib/page_source.mjs';

let failures = 0;
const ok = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.error('  ECHEC ' + m); failures++; };
const assert = (cond, msg) => { if (cond) ok(msg); else fail(msg); };

const consoleSrc = pageSource('brand-console/index.html');
const dppSrc = pageSource('dpp/index.html');
const claims = readFileSync('api/_routes/products/[productId]/dpp/claims.ts', 'utf8');
const review = readFileSync('api/_routes/products/[productId]/dpp/claims/[claimId]/review.ts', 'utf8');
const evidence = readFileSync('api/_routes/products/[productId]/dpp/claims/[claimId]/evidence.ts', 'utf8');
const mandates = readFileSync('api/_routes/dpp/mandates.ts', 'utf8');
const revoke = readFileSync('api/_routes/dpp/mandates/[mandateId]/revoke.ts', 'utf8');
const migration = readFileSync('prisma/migrations/20261017120000_dpp_trust_reviews/migration.sql', 'utf8');
const router = readFileSync('api/index.ts', 'utf8');

/* --- 1. Console : un chemin explicite par action ------------------------ */
assert(consoleSrc.includes('function dppTrustView'), 'console: panneau de confiance present');
assert(consoleSrc.includes('loadDppTrust'), 'console: chargement des affirmations et evenements');
for (const endpoint of [
  '/dpp/claims', '/dpp/claims/', '/review', '/evidence', '/dpp/events',
  '/api/dpp/mandates', '/revoke',
]) {
  assert(consoleSrc.includes(endpoint), `console: endpoint ${endpoint} appele`);
}
assert(consoleSrc.includes('data-claim-review'), 'console: revue d affirmation reliee au formulaire');
assert(consoleSrc.includes('data-claim-evidence'), 'console: liaison de preuve reliee au formulaire');
assert(consoleSrc.includes('data-revoke-mandate'), 'console: revocation de mandat exposee');
assert(!/validationStatus\s*:\s*'third_party_verified'/.test(consoleSrc) || consoleSrc.includes('state.dppAsVerifier ? \'third_party_verified\''),
  'console: third_party_verified reserve au verificateur');
assert(consoleSrc.includes("state.dppAsVerifier ? 'third_party' : 'actor_declaration'"),
  'console: source d evenement derivee du role');
assert(!consoleSrc.includes("name=\"resultingStatus\" value="), 'console: statut de revue non fige dans le HTML');
assert(consoleSrc.includes('dppClaimDeclaredHint'), 'console: une affirmation nait declaree, dit explicitement');

/* --- 2. Routes : delegation aux fonctions SQL --------------------------- */
assert(/requestedStatus !== 'declared'/.test(claims), 'API: creation limitee au statut declared');
assert(claims.includes('tracefab_add_dpp_claim'), 'API: creation via fonction SQL');
assert(review.includes('tracefab_review_dpp_claim'), 'API: revue via fonction SQL');
assert(!/validation_status\s*=\s*/.test(review), 'API: aucune ecriture directe de statut');
assert(evidence.includes('tracefab_link_dpp_claim_evidence'), 'API: preuve via fonction SQL');
assert(mandates.includes('tracefab_grant_dpp_verification_mandate'), 'API: mandat via fonction SQL');
assert(mandates.includes('activeBrandOrganizationIds'), 'API: mandat cadre par les organisations de marque');
assert(revoke.includes('tracefab_revoke_dpp_verification_mandate'), 'API: revocation via fonction SQL');
assert(revoke.includes('invalid_revocation_reason'), 'API: motif de revocation exige');
assert(router.includes('/^dpp\\/mandates$'), 'routeur: route des mandats enregistree');
assert(router.includes('/^dpp\\/mandates\\/([^\\/]+)\\/revoke$/'), 'routeur: route de revocation enregistree');

/* --- 3. Migration : les regles ne sont pas decoratives ------------------ */
for (const marker of [
  'dpp_claim_initial_status_must_be_declared',
  'dpp_claim_evidence_required',
  "p_resulting_status = 'third_party_verified' AND v_evidence_count < 1",
  'dpp_verification_mandate_required',
  'third_party_verifier_role_required',
  'dpp_claim_reviews_are_append_only',
  'dpp_verification_mandates',
]) {
  assert(migration.includes(marker), `migration: regle ${marker}`);
}
assert(migration.includes('tracefab_grant_dpp_verification_mandate')
  && migration.includes('tracefab_revoke_dpp_verification_mandate'), 'migration: mandats accordables et revocables');
assert(migration.includes('REVOKE ALL ON FUNCTION tracefab_grant_dpp_verification_mandate'), 'migration: mandat non executable par PUBLIC');
assert(/ENABLE ROW LEVEL SECURITY/.test(migration), 'migration: RLS activee');
assert(/FORCE ROW LEVEL SECURITY/.test(migration), 'migration: RLS forcee');
assert(!/GRANT\s+EXECUTE[^;]*TO\s+PUBLIC/i.test(migration), 'migration: aucune fonction ouverte a PUBLIC');

/* --- 4. Page publique : aucune confiance fabriquee ---------------------- */
assert(!/class="[^"]*badge[^"]*"[^>]*>\s*(Certified|Verified|GOTS|OEKO)/i.test(dppSrc),
  'passeport public: pas de badge de certification code en dur');
assert(dppSrc.includes('dpp-live'), 'passeport public: conteneur vivant present');
assert(dppSrc.includes('hidden'), 'passeport public: conteneur vivant masque par defaut');
assert(!/statusUnverified[^\n]*GOTS/.test(dppSrc), 'passeport public: demo et donnees reelles separes');

/* --- 5. i18n : statuts de confiance dans toutes les langues completes --- */
const en = readFileSync('assets/i18n/en.js', 'utf8');
for (const key of ['stControlled', 'stCorroborated', 'stThirdPartyVerified',
  'dppClaimsTitle', 'dppMandatesTitle', 'dppEvidenceAdd']) {
  assert(en.includes(key), `i18n EN: cle ${key}`);
}
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const dict = JSON.parse(readFileSync(`assets/i18n/${lang}.json`, 'utf8'));
  const missing = ['stControlled', 'stCorroborated', 'stThirdPartyVerified']
    .filter((k) => !dict.shared?.[k]);
  const missingConsole = ['dppClaimsTitle', 'dppMandatesTitle', 'dppEvidenceAdd']
    .filter((k) => !dict.console?.[k]);
  assert(!missing.length && !missingConsole.length, `i18n ${lang}: statuts et libelles complets`);
}

if (failures) {
  console.error(`\nContrat de confiance DPP : ${failures} echec(s).`);
  process.exit(1);
}
console.log('\nContrat de confiance DPP : interface, API et regles alignees.');
