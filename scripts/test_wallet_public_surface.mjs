#!/usr/bin/env node
/**
 * Les cartes wallet publiques doivent dériver du passeport publié,
 * pas d'un jeu de données fictif. Contrôle sur les sources : aucune connexion.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apple = readFileSync(join(root, 'api/_routes/dpp/[gtin]/apple-wallet.ts'), 'utf8');
const google = readFileSync(join(root, 'api/_routes/dpp/[gtin]/google-wallet.ts'), 'utf8');
const dpp = readFileSync(join(root, 'api/_routes/dpp/[gtin].ts'), 'utf8');
const fallback = join(root, 'api/_lib/wallet/fallback-data.ts');

let fails = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => {
  fails += 1;
  console.log(`  ECHEC ${m}`);
};

for (const [name, src] of [
  ['apple-wallet', apple],
  ['google-wallet', google],
]) {
  /getFallbackDppData/.test(src)
    ? ko(`${name} importe encore getFallbackDppData`)
    : ok(`${name} n'importe pas getFallbackDppData`);
  /resolveDppPassData/.test(src) && /withTracefabPublicContext/.test(src)
    ? ok(`${name} passe par le résolveur public`)
    : ko(`${name} n'appelle pas resolveDppPassData sous contexte public`);
  /3760123456789/.test(src)
    ? ko(`${name} conserve un GTIN fictif par défaut`)
    : ok(`${name} n'a pas de GTIN fictif par défaut`);
  /missing_identifier/.test(src)
    ? ok(`${name} refuse un identifiant absent`)
    : ko(`${name} n'exige pas l'identifiant`);
  /product_passport_not_found/.test(src)
    ? ok(`${name} rend 404 si le passeport n'est pas public`)
    : ko(`${name} ne rend pas 404 hors publication`);
  /detail: errMsg/.test(src) || /error: errMsg/.test(src)
    ? ko(`${name} fuit le détail d'erreur au client`)
    : ok(`${name} ne fuit pas le détail d'erreur`);
}

/resolveDppPassData/.test(dpp) && /withTracefabPublicContext/.test(dpp)
  ? ok('GET /api/dpp/:gtin reste le même contrat public')
  : ko('GET /api/dpp/:gtin a perdu le résolveur public');

try {
  readFileSync(fallback);
  ok('fallback-data.ts conservé pour les tests de génération');
} catch {
  ko('fallback-data.ts absent');
}

if (fails) {
  console.error(`\n${fails} contrat(s) wallet public violé(s).`);
  process.exit(1);
}
console.log('\nSurface wallet publique : OK.');
process.exit(0);
