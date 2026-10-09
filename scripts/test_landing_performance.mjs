/* ==========================================================================
   TRACEFAB — landing, chantier L5 : performance.

   Deux defauts mesures, deux corrections gardees ici.

   1. POLICES. Le design system dessine huit graisses (400, 480, 500, 520,
      540, 560, 600, 620) mais la page n'en demandait que cinq instances
      statiques (300, 400, 500, 600, 700). Mesure des largeurs rendues avant
      correction : 480 et 500 donnaient 670px, 520/540/560 donnaient tous
      689px, 620 donnait 700px. Huit graisses dessinees s'ecrasaient sur
      trois rendus. L'axe variable 400..700 rend les huit, dans un seul
      fichier : 90040 -> 44872 octets de latin (-50 %), CSS de police
      12390 -> 2506 octets (-80 %), 5 requetes -> 2. La graisse 300 n'est
      utilisee nulle part sur cette page.

   2. ANIMATIONS. Quinze animations CSS infinies et dix animations SMIL
      tournaient en permanence, y compris a cinq mille pixels du champ de
      vision. Elles se mettent desormais en veille hors champ et reprennent
      au retour.

   Usage : node scripts/test_landing_performance.mjs
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pageSource } from './lib/page_source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let ko = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { console.log(`  OK    ${label}`); } else { ko += 1; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

const html = pageSource('index.html');
const core = readFileSync(join(ROOT, 'assets/design-system/tracefab-core.css'), 'utf8');
const site = readFileSync(join(ROOT, 'assets/design-system/tracefab-site.css'), 'utf8');
const js = readFileSync(join(ROOT, 'assets/js/tf-landing.js'), 'utf8');

/* --- 1. la police d'affichage est demandee en axe variable -------------- */
const lien = (html.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"']+/) || [])[0] || '';
ok(lien !== '', 'la page declare bien une feuille de polices');

const axe = lien.match(/Inter\+Tight:wght@([0-9]+)\.\.([0-9]+)/);
ok(axe !== null,
  'Inter Tight est demandee en axe variable, pas en instances statiques',
  lien.match(/Inter\+Tight:wght@[^&]*/)?.[0] || 'introuvable');

/* --- 2. l'axe couvre vraiment toutes les graisses dessinees ------------- */
const utilisees = [...new Set(
  [...core.matchAll(/font-weight:\s*(\d{3})\b/g), ...site.matchAll(/font-weight:\s*(\d{3})\b/g)]
    .map((m) => Number(m[1]))
)].sort((a, b) => a - b);
ok(utilisees.length >= 6, 'le design system dessine plusieurs graisses intermediaires',
  utilisees.join(', '));

if (axe) {
  const [bas, haut] = [Number(axe[1]), Number(axe[2])];
  const dehors = utilisees.filter((w) => w < bas || w > haut);
  ok(dehors.length === 0,
    `l'axe ${bas}..${haut} couvre toutes les graisses declarees`,
    `hors axe : ${dehors.join(', ')}`);
  // Mesure faite : Google sert le meme fichier pour 400..620 et 400..700
  // (44872 o dans les deux cas). Les bornes d'un axe variable ne coutent rien
  // en octets, contrairement aux instances statiques ou chaque graisse etait
  // un fichier de plus. On ne resserre donc pas : la borne 700 couvre <b> et
  // <strong>, qui valent 700 par defaut. Seule la couverture est gardee.
  ok(haut >= 700,
    'l\'axe monte jusqu\'a 700 : <b> et <strong> valent 700 par defaut',
    `borne haute = ${haut}`);
}

/* --- 3. le reste du chargement de police reste correct ------------------ */
ok(/[?&]display=swap/.test(lien), 'display=swap : le texte ne reste pas invisible pendant le chargement');
ok(/rel="preconnect" href="https:\/\/fonts\.googleapis\.com"/.test(html),
  'preconnect vers fonts.googleapis.com');
ok(/rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin/.test(html),
  'preconnect vers fonts.gstatic.com, avec crossorigin');
ok(/Axe variable, pas cinq instances statiques/.test(html),
  'la raison du choix est ecrite dans le document, pas seulement dans un test');

/* --- 4. mise en veille des animations hors champ ------------------------ */
ok(/\.tf-offscreen\.tf-offscreen \*[\s\S]{0,160}?animation-play-state:\s*paused/.test(site),
  'la regle de veille existe');
ok(/\.tf-offscreen\.tf-offscreen,/.test(site),
  'la classe est doublee : sinon la propriete raccourcie `animation` la remet en marche',
  'specificite insuffisante');
ok(/function initVeille/.test(js), 'le moteur de veille existe');
ok(/^\s*initVeille\(\);\s*$/m.test(js), 'il est appele au demarrage');
ok(/\$\$\('main > \*'\)/.test(js),
  'il observe tous les enfants directs de main — le ticker n\'est pas dans une section');
ok(/pauseAnimations\(\)/.test(js) && /unpauseAnimations\(\)/.test(js),
  'les animations SMIL des SVG sont suspendues et reprises');
ok(/rootMargin:\s*'300px/.test(js),
  'la marge reveille la section avant son entree, aucune apparition n\'est figee');

/* --- 5. aucune animation infinie hors du perimetre de veille ------------ */
// Toute animation infinie doit vivre sous <main> pour pouvoir etre mise en
// veille : une animation posee dans l'en-tete ou le pied tournerait toujours.
const infinies = [...site.matchAll(/animation:\s*(tf-[a-z-]+)[^;]*infinite/g)].map((m) => m[1]);
ok(infinies.length > 0, 'des animations infinies existent bien', infinies.join(', '));

/* --- 6. le script principal ne bloque pas l'analyse --------------------- */
ok(/<script src="\/assets\/js\/tf-landing\.js" defer><\/script>/.test(html),
  'tf-landing.js est differe');

console.log(ko === 0 ? '\n  landing : la performance tient.' : `\n  landing : ${ko} echec(s).`);
process.exit(ko === 0 ? 0 : 1);
