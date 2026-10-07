/* ==========================================================================
   TRACEFAB — landing, chantier L1 : plancher typographique.

   La page rendait 218 noeuds de texte sous 11px : 7,5px pour la signature
   de marque, 8px et 8,5px pour la quasi-totalite des libelles techniques,
   10px pour les cellules de la matrice. Le cahier des charges demande de
   « petits labels techniques » — il ne demande pas des labels illisibles.
   En mono gris sur fond sombre, avec un tracking de 0.2em qui disjoint les
   lettres, 8,5px n'est plus lu : c'est une texture.

   La cause n'etait pas une valeur isolee mais une micro-echelle en px brut
   installee SOUS le bareme de tokens (qui s'arretait a 10px). Elle a ete
   supprimee : le bareme commence a 11px, et plus aucune regle ne declare de
   taille en px brut en dessous.

   Ce test garde le plancher. Il est statique (il lit le CSS) pour rester
   rapide et sans navigateur ; la verification rendue est faite par les
   captures du chantier.

   Usage : node scripts/test_landing_lisibilite.mjs
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANCHER = 11;
const FEUILLES = [
  'assets/design-system/tracefab-core.css',
  'assets/design-system/tracefab-site.css',
];

let ko = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { console.log(`  OK    ${label}`); } else { ko += 1; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* --- 1. aucune taille en px brut sous le plancher ----------------------- */
for (const f of FEUILLES) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  const fautes = [...src.matchAll(/font-size:\s*([0-9.]+)px/g)]
    .map((m) => Number(m.group ? m.group(1) : m[1]))
    .filter((v) => v < PLANCHER);
  ok(fautes.length === 0, `${f.split('/').pop()} : aucune taille en px sous ${PLANCHER}px`,
    fautes.join('px, ') + (fautes.length ? 'px' : ''));
}

/* --- 2. le bareme de tokens lui-meme respecte le plancher --------------- */
const core = readFileSync(join(ROOT, FEUILLES[0]), 'utf8');
const tokens = [...core.matchAll(/--tf-size-(\w+):\s*([0-9.]+)(rem|px)\s*;/g)]
  .map((m) => ({ nom: m[1], px: m[3] === 'rem' ? Number(m[2]) * 16 : Number(m[2]) }));

ok(tokens.length >= 7, 'le bareme de tailles est lisible depuis le CSS', `${tokens.length} token(s)`);

const sousPlancher = tokens.filter((t) => t.px < PLANCHER);
ok(sousPlancher.length === 0, `aucun token de taille sous ${PLANCHER}px`,
  sousPlancher.map((t) => `${t.nom}=${t.px}px`).join(', '));

/* --- 3. le plancher reste un vrai cran, pas un doublon ------------------ */
const petits = tokens.filter((t) => t.px < 14).sort((a, b) => a.px - b.px);
ok(petits.length >= 2, 'au moins deux crans de libelles existent',
  petits.map((t) => `${t.nom}=${t.px}`).join(' '));
if (petits.length >= 2) {
  ok(petits[1].px - petits[0].px >= 0.5,
    'les deux plus petits crans restent distincts',
    `${petits[0].nom}=${petits[0].px}px vs ${petits[1].nom}=${petits[1].px}px`);
  ok(petits[0].px === PLANCHER, `le plus petit cran vaut exactement ${PLANCHER}px`,
    `${petits[0].nom}=${petits[0].px}px`);
}

/* --- 4. la raison du plancher est ecrite dans la feuille ---------------- */
ok(/Plancher typographique/.test(core),
  'le plancher est documente dans le CSS, pas seulement dans un test');

/* --- 5. les libelles passent par les tokens, plus par du px brut -------- */
const site = readFileSync(join(ROOT, FEUILLES[1]), 'utf8');
const viaToken = (site.match(/font-size:\s*var\(--tf-size-3xs\)/g) || []).length;
ok(viaToken >= 10, 'les libelles techniques consomment le token de plancher',
  `${viaToken} usage(s)`);

console.log(ko === 0 ? `\n  landing : plancher typographique de ${PLANCHER}px tenu.` : `\n  landing : ${ko} echec(s).`);
process.exit(ko === 0 ? 0 : 1);
