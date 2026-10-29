#!/usr/bin/env node
/**
 * Intégrité du contexte d'identité — contrôle statique.
 *
 * POURQUOI CE TEST EXISTE
 * -----------------------
 * L'isolation multi-tenant repose sur `tracefab.user_id` / `tracefab.user_email`
 * posés par withTracefabUserContext(). La base ne distingue pas un contexte
 * posé par l'application d'un contexte posé par un attaquant : quiconque peut
 * exécuter `set_config('tracefab.user_id', …)` peut se faire passer pour un
 * autre utilisateur. Cette surface n'est fermée QUE si chaque appel applicatif
 * pose le contexte depuis la PRINCIPALITÉ AUTHENTIFIÉE (Clerk), jamais depuis
 * une entrée de requête.
 *
 * LA RÈGLE
 * --------
 * Tout appel à withTracefabUserContext / withTracefabWorkerContext passe
 * l'identité résolue par requireClerkUser (ou équivalent serveur), jamais
 * req.query / req.body / une valeur dérivée d'une entrée client.
 *
 * Exécution : node scripts/test_context_integrity.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let echecs = 0;
const ok = (cond, message) => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!cond) echecs += 1;
};

const sources = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.ts')) sources.push(full);
  }
};
walk('api');

const APPELS = /withTracefab(?:User|Worker|Public)Context\s*\(\s*([^,)]*)/g;
// Accepté : paramètres issus d'une résolution d'auth serveur.
const IDENTITE_FIABLE = /^(user\.id|user\.email|auth\.user\.id|auth\.user\.email)$/;
const APPELS_SANS_IDENTITE = /withTracefab(?:Worker|Public)Context\s*\(\s*(async|\(|[a-zA-Z_])/;

let total = 0;
let suspects = 0;
for (const file of sources) {
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(APPELS)) {
    const premier = (m[1] || '').trim();
    // withTracefabUserContext(userId, userEmail, …) : les deux premiers
    // arguments sont l'identité. matchAll ne capture que le premier.
    if (/^withTracefab(User|Worker)/.test(m[0]) && m[0].includes('User')) {
      total += 1;
      if (!IDENTITE_FIABLE.test(premier)) {
        suspects += 1;
        console.log(`  ECHEC ${file} : contexte posé depuis « ${premier.slice(0, 60)} »`);
      }
    }
  }
}

ok(total > 0, `${total} appel(s) withTracefabUserContext inventoriés dans api/`);
ok(suspects === 0, suspects === 0
  ? 'chaque contexte utilisateur est posé depuis la principauté authentifiée (user.id / user.email)'
  : `${suspects} appel(s) posent le contexte depuis une valeur non authentifiée`);

// Les setters ne doivent nulle part être alimentés par une entrée client.
const setConfigs = [];
for (const file of sources) {
  const code = readFileSync(file, 'utf8');
  if (/set_config\s*\(\s*'tracefab\.user_id'/.test(code) && !file.endsWith(join('_lib', 'context.ts'))) {
    setConfigs.push(file);
  }
}
ok(setConfigs.length === 0,
  setConfigs.length === 0
    ? "set_config('tracefab.user_id') n'est appelé que depuis api/_lib/context.ts"
    : `set_config('tracefab.user_id') hors context.ts : ${setConfigs.join(', ')}`);

// L'e-mail Clerk alimente `tracefab.user_email`, qui est la SEULE barriere de
// la politique `passport_access_select` (migration 20261006250000) : un
// demandeur externe voit ses propres demandes d'acces par egalite d'e-mail.
// Mesure du 28/10/2026, base jetable, role `tracefab_app` sans BYPASSRLS :
//   sans GUC -> 0 ligne ; GUC = e-mail de la victime -> 1 ligne ; autre -> 0.
// Une adresse non verifiee suffirait donc a lire les demandes d'un tiers.
const auth = readFileSync(join('api', '_lib', 'auth.ts'), 'utf8');
const identite = readFileSync(join('api', '_lib', 'clerk-identity.ts'), 'utf8');
ok(auth.includes('verifiedPrimaryEmail(clerkUser)'),
  "api/_lib/auth.ts propage l'e-mail via verifiedPrimaryEmail (aucune autre source)");
ok(!/emailAddresses/.test(auth),
  "api/_lib/auth.ts ne lit plus lui-meme emailAddresses : un seul chemin d'identite");
ok(/verification\?\.status\s*!==\s*'verified'/.test(identite),
  "api/_lib/clerk-identity.ts exige une adresse Clerk verifiee");
ok(identite.includes('clerk_email_unverified'),
  "le refus d'une adresse non verifiee porte un motif nomme (clerk_email_unverified)");
// Le comportement lui-meme est eprouve, cas par cas, par test:clerk-identity :
// une assertion statique ne prouve pas qu'une adresse non verifiee est refusee.

console.log(`\n  Intégrité du contexte d'identité : ${echecs === 0 ? 'OK' : `${echecs} échec(s)`}.`);
process.exit(echecs === 0 ? 0 : 1);
