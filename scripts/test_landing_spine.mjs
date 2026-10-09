/* ==========================================================================
   TRACEFAB — landing, chantier L2 : la colonne vertebrale des 7 couches.

   La section #platform affirme « Each layer answers one question, and hands
   its answer to the next ». Elle rendait pourtant un tableau de sept rangees
   identiques : la phrase promettait une chaine, la mise en page montrait une
   liste. Le rail rend la phrase litterale — une ligne continue, un noeud par
   couche, et un relais nomme ce que la couche transmet a la suivante
   (NETWORK, PRODUCT, PROOF, TRUST LEVEL, CHAIN, SIGNALS, PASSPORT).

   Ce test garde aussi le defaut trouve en chemin, qui lui preexistait : la
   regle mobile `.tf-layer__desc { grid-column: 2 }` visait un petit-enfant de
   la grille. `grid-column` n'a aucun effet sur un element qui n'est pas un
   enfant direct du conteneur : les sept descriptions se repliaient dans la
   colonne de 64px, un mot par ligne, et gonflaient #platform a 4 688px sur
   mobile. L'invariant garde ici est donc : tout ce que la grille place doit
   etre un enfant direct de .tf-layer.

   Usage : node scripts/test_landing_spine.mjs
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pageSource } from './lib/page_source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COUCHES = 7;
const RELAIS = ['Network', 'Product', 'Proof', 'Trust level', 'Chain', 'Signals', 'Passport'];
const LOCALES = ['fr', 'de', 'it', 'es', 'nl', 'pt'];

let ko = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { console.log(`  OK    ${label}`); } else { ko += 1; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

const html = pageSource('index.html');
const css = readFileSync(join(ROOT, 'assets/design-system/tracefab-site.css'), 'utf8');
const js = readFileSync(join(ROOT, 'assets/js/tf-landing.js'), 'utf8');

/* --- enfants directs d'une couche, par balayage equilibre ---------------
   Le balayage doit partir de la balise ouvrante de .tf-layer elle-meme : en
   demarrant apres, la profondeur est decalee d'un cran et le scanner rapporte
   les petits-enfants a la place des enfants. */
function enfantsDirects(html, idCouche) {
  const marque = html.indexOf(`id="${idCouche}"`);
  if (marque < 0) return null;
  const debut = html.lastIndexOf('<div', marque);
  const jetons = [...html.slice(debut).matchAll(/<\/?[a-zA-Z][^>]*>/g)];
  const sortie = [];
  let profondeur = 0;
  for (const m of jetons) {
    const j = m[0];
    const autoFermante = /\/>$/.test(j) || /^<(br|img|input|hr|meta|link|path|use|circle|rect|line|source)\b/i.test(j);
    if (j.startsWith('</')) {
      profondeur -= 1;
      if (profondeur === 0) break;           // fin de la couche
      continue;
    }
    if (autoFermante) continue;
    if (profondeur === 1) {
      const c = j.match(/class="([^"]*)"/);
      sortie.push(c ? c[1].trim() : '(sans classe)');
    }
    profondeur += 1;
  }
  return sortie;
}

/* --- 1. chaque couche porte le rail et son relais ----------------------- */
for (let i = 1; i <= COUCHES; i++) {
  const enfants = enfantsDirects(html, `layer-0${i}`);
  const attendus = ['tf-layer__rail', 'tf-layer__head', 'tf-layer__body', 'tf-layer__aside'];
  ok(enfants !== null && attendus.every((c) => enfants.includes(c)),
    `couche 0${i} : les 4 elements de grille sont des enfants directs`,
    `trouve: ${(enfants || []).join(' / ') || 'aucun'}`);
  ok(enfants !== null && enfants.length === attendus.length,
    `couche 0${i} : la grille ne recoit aucun element en trop`,
    `${(enfants || []).length} enfant(s)`);
  const d = html.indexOf(`id="layer-0${i}"`);
  const f = i < COUCHES ? html.indexOf(`id="layer-0${i + 1}"`) : html.length;
  const bloc = html.slice(d, f);
  ok(bloc.includes('tf-layer__pass-mark') && bloc.includes(`spine.layers.l${i}.out`),
    `couche 0${i} : marqueur de relais + cle i18n \`out\``);
}

/* --- 2. le terminal ferme la chaine, lui seul --------------------------- */
const terminaux = (html.match(/data-tf-terminal/g) || []).length;
ok(terminaux === 1, 'une seule couche est terminale (la 07)', `${terminaux} trouvee(s)`);
ok(html.indexOf('data-tf-terminal') > html.indexOf('id="layer-06"'),
  'la couche terminale est bien la derniere');

/* --- 3. l'invariant qui avait cede -------------------------------------- */
const mobile = css.slice(css.indexOf('@media (max-width: 1080px)'));
const bloc1080 = mobile.slice(0, mobile.indexOf('\n}'));
ok(/\.tf-layer__head,\s*\.tf-layer__body,\s*\.tf-layer__aside\s*\{[^}]*grid-column:\s*2/.test(bloc1080),
  'mobile : head, body et aside sont places en colonne 2');
ok(!/\.tf-layer__desc\s*\{[^}]*grid-column/.test(css),
  'aucun `grid-column` pose sur .tf-layer__desc, qui n\'est pas un element de grille');
ok(/\.tf-layer__rail\s*\{[^}]*grid-row:\s*1\s*\/\s*span 3/.test(bloc1080),
  'mobile : le rail couvre les trois rangees de la couche');

/* --- 4. la geometrie du rail reste correcte, meme neutralisee ----------
   Les regles du rail sont conservees dans la feuille mais desactivees par le
   bloc de neutralisation (section 9). On continue de verifier leur geometrie
   pour qu'une reactivation redonne une ligne continue, pas sept traits. */
ok(/\.tf-layer__rail::before[\s\S]{0,400}?bottom:\s*calc\(var\(--tf-layer-pad[^)]*\)\s*\*\s*-2/.test(css),
  'la regle du rail franchit les deux gouttieres (geometrie prete a reactiver)');
ok(/--tf-layer-pad:/.test(css), 'le pas de gouttiere est une variable, lisible par le rail');

/* --- 5. le mecanisme de remplissage reste en place, reactivable --------- */
ok(/is-live/.test(js) && /IntersectionObserver/.test(js),
  'le mecanisme de remplissage au defilement reste cable (reactivable)');
ok(/reduceMotion[\s\S]{0,200}?is-live/.test(js),
  'mouvement reduit : les couches sont allumees d\'emblee, sans animation');
ok(/prefers-reduced-motion[\s\S]{0,200}?\.tf-layer__rail::after\s*\{\s*transition:\s*none/.test(css),
  'mouvement reduit : la transition du rail est neutralisee en CSS aussi');

/* --- 9. retour a l'aspect d'avant L2 : les trois ajouts sont neutralises --
   L'utilisateur a demande la section telle qu'elle etait avant le chantier L2.
   L2 avait ajoute trois choses VISUELLES : le rail vertical, le losange sur le
   numero, et le mot de relais. Elles sont neutralisees par un bloc unique en
   fin de feuille. Ces assertions sont la garde de ce choix : si le bloc saute,
   le rail revient et le test doit le dire. Le correctif de grille mobile de L2,
   lui, est conserve - il repare un bug anterieur (section 3). */
const neutre = css.slice(css.indexOf('L2 neutralise sur demande'));
ok(css.includes('L2 neutralise sur demande'),
  'le bloc de neutralisation de L2 est present');
ok(/\.tf-layer__rail::before,\s*\n\.tf-layer__rail::after\s*\{\s*display:\s*none/.test(neutre),
  'avant L2 : la ligne du rail est masquee');
ok(/\.tf-layer__num::before\s*\{\s*display:\s*none/.test(neutre),
  'avant L2 : le losange du numero est masque');
ok(/\.tf-layer__pass\s*\{\s*display:\s*none/.test(neutre),
  'avant L2 : le mot de relais est masque');
ok(/\.tf-layer__rail\s*\{\s*padding-left:\s*0/.test(neutre),
  'avant L2 : le rail ne reserve plus sa gouttiere de 20px');
ok(css.lastIndexOf('.tf-layer__pass {') > css.indexOf('.tf-layer__pass {'),
  "la neutralisation passe apres la regle d'origine (elle gagne la cascade)");

/* --- 6. i18n : le relais parle les 6 langues de la phase 1 -------------- */
const en = readFileSync(join(ROOT, 'assets/i18n/en.js'), 'utf8');
ok((en.match(/out: '/g) || []).length === COUCHES,
  `en.js : ${COUCHES} relais traduits`, `${(en.match(/out: '/g) || []).length} trouve(s)`);
for (const l of LOCALES) {
  const d = JSON.parse(readFileSync(join(ROOT, `assets/i18n/${l}.json`), 'utf8'));
  const manquants = [];
  for (let i = 1; i <= COUCHES; i++) {
    const v = d?.spine?.layers?.[`l${i}`]?.out;
    if (!v || !String(v).trim()) manquants.push(`l${i}`);
  }
  ok(manquants.length === 0, `${l}.json : les ${COUCHES} relais sont traduits`, manquants.join(', '));
}

/* --- 7. le mot du relais survit au repli mobile ------------------------- */
ok(!/\.tf-layer__pass\s*\{[^}]*font-size:\s*0/.test(css),
  'le mot du relais n\'est pas escamote par un font-size nul');
ok(/\.tf-layer__pass > span:not\(\.tf-layer__pass-mark\)[\s\S]{0,200}?clip: rect\(0 0 0 0\)/.test(css),
  'mobile : le mot sort de l\'affichage mais reste dans le document');

/* --- 8. les relais declares correspondent au recit --------------------- */
const dansHtml = RELAIS.filter((m) => html.includes(`.out">${m}</span>`));
ok(dansHtml.length === COUCHES, 'la chaine racontee est complete, dans l\'ordre',
  dansHtml.join(' > ') || 'aucun');

console.log(ko === 0 ? '\n  landing : la colonne vertebrale tient.' : `\n  landing : ${ko} echec(s).`);
process.exit(ko === 0 ? 0 : 1);
