/**
 * Le systeme de design doit atteindre les neuf surfaces.
 *
 * Constat a l'origine de ce garde : cinq surfaces sur neuf ne chargeaient pas
 * tracefab-core.css, six sur neuf ne chargeaient pas Inter Tight, et trente
 * jetons locaux dupliquaient un jeton du systeme sous un autre nom avec un
 * ecart de quelques points RVB. Une correction portee au systeme n'atteignait
 * donc que la moitie du produit, et les corrections de contraste avaient du
 * etre appliquees cinq fois a la main.
 *
 * Les quatre controles ci-dessous echouent dans les deux sens : ils rejettent
 * une surface qui decroche du systeme, et ils rejettent une duplication qui
 * reapparait.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import assert from 'node:assert';

const SURFACES = execSync('git ls-files "*.html"', { encoding: 'utf8' })
  .split('\n').filter(Boolean);

let faits = 0;
const controle = (titre, vrai, detail = '') => {
  assert.ok(vrai, `${titre}${detail ? ' — ' + detail : ''}`);
  console.log(`  ✓ ${titre}`);
  faits += 1;
};

/* --- 1. Chaque surface charge le socle, AVANT son <style> en ligne. -------
 * L'ordre n'est pas cosmetique : le reset de core.css redefinit body, p, ul,
 * button et a. Charge apres, il ecraserait les regles de la page.          */
{
  const fautifs = [];
  for (const f of SURFACES) {
    // Les commentaires HTML sont retires d'abord : l'un d'eux cite « <style> »
    // pour expliquer l'ordre de chargement, et le faisait passer pour la vraie
    // balise — le controle accusait alors une page correcte.
    const s = readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const iCore = s.indexOf('tracefab-core.css');
    const iStyle = s.indexOf('<style');
    if (iCore === -1) fautifs.push(`${f} (absent)`);
    else if (iStyle !== -1 && iCore > iStyle) fautifs.push(`${f} (apres le <style>)`);
  }
  controle(
    `les ${SURFACES.length} surfaces chargent tracefab-core.css avant leur style en ligne`,
    fautifs.length === 0, fautifs.join(', '),
  );
}

/* --- 2. Une seule police, celle du systeme. ------------------------------
 * Declarer Inter Tight sans charger la fonte revient a rendre en Inter : le
 * defaut tenait aux deux a la fois, il faut donc verifier les deux.        */
{
  const sansFonte = SURFACES.filter((f) => !/Inter\+Tight/.test(readFileSync(f, 'utf8')));
  controle('les surfaces chargent toutes la fonte Inter Tight', sansFonte.length === 0, sansFonte.join(', '));

  const brutes = SURFACES.filter((f) => /font-family:\s*Inter\s*,/i.test(readFileSync(f, 'utf8')));
  controle('aucune surface ne redeclare « Inter » en dur', brutes.length === 0, brutes.join(', '));
}

/* --- 3. Aucun jeton local ne duplique un jeton du systeme. ---------------
 * Un jeton local n'est acceptable que s'il renvoie au systeme (var(--tf-...))
 * ou s'il est volontairement propre a la surface. Toute autre valeur proche
 * d'un jeton du systeme est une duplication qui va deriver.
 *
 * La liste d'exceptions est explicite : le systeme modelise ses pastels en
 * rgba alors que ces surfaces utilisent des aplats, et il n'offre pas de
 * jeton de filet. Toute nouvelle exception doit etre ajoutee ici
 * sciemment — c'est le but.                                                */
{
  const TOLERES = new Set([
    '--line', '--border-light', '--border-medium',        // pas de jeton de filet dans le socle
    '--green-soft', '--yellow', '--yellow-soft',          // aplats pastel vs rgba du socle
    '--red', '--red-soft', '--primary-soft', '--primary-glow',
    '--status-verified-bg', '--status-certified', '--status-certified-bg',
    '--status-documented', '--status-documented-bg',      // indigo, distinct du bleu du socle
    '--bg-page', '--bg-subtle', '--text-main', '--text-muted',
    '--radius', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-full',
    '--shadow', '--shadow-sm', '--shadow-md', '--shadow-lg',
  ]);

  const core = readFileSync('assets/design-system/tracefab-core.css', 'utf8');
  const racine = core.match(/:root\s*\{([\s\S]*?)\}/)[1];
  const jetons = [...racine.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, k, v]) => [k, v.trim()])
    .filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v));

  const vers = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ecart = (a, b) => Math.hypot(...vers(a).map((x, i) => x - vers(b)[i]));

  const doublons = [];
  for (const f of SURFACES) {
    const s = readFileSync(f, 'utf8');
    const styles = [...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    for (const bloc of [...styles.matchAll(/:root\s*\{([\s\S]*?)\}/g)].map((m) => m[1])) {
      for (const [, k, v] of bloc.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        const val = v.trim();
        if (val.startsWith('var(') || TOLERES.has(k) || !/^#[0-9a-f]{6}$/i.test(val)) continue;
        const proche = jetons.filter(([, cv]) => ecart(val, cv) <= 8).map(([ck]) => ck);
        if (proche.length) doublons.push(`${f} ${k}:${val} ≈ ${proche[0]}`);
      }
    }
  }
  controle('aucun jeton local ne duplique un jeton du socle', doublons.length === 0, doublons.join(' · '));
}

/* --- 4. Aucune chaine de build morte. ------------------------------------
 * Tailwind vivait ici sans une seule directive @tailwind, sans script npm, et
 * sans etre installe — build et 62 tests passaient sans lui. Ce n'etait pas du
 * poids mort inoffensif : sa config declarait une palette forest concurrente
 * (#2d5a3c contre #1d5339) et, avant correction, une police que l'utilisateur
 * avait explicitement ecartee. Une config morte est une contradiction en
 * sommeil.
 *
 * La regle est generale, pas nominative : un outil de build n'a le droit
 * d'exister que s'il est reellement invoque.                               */
{
  const OUTILS = [
    { nom: 'Tailwind', configs: ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.mjs'],
      deps: ['tailwindcss', '@tailwindcss/postcss'], directives: /@tailwind|@apply/ },
    { nom: 'PostCSS', configs: ['postcss.config.js', 'postcss.config.mjs', 'postcss.config.cjs'],
      deps: ['postcss', 'autoprefixer'], directives: null },
  ];
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const declarees = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = Object.values(pkg.scripts || {}).join(' ');
  const sources = execSync('git ls-files "*.css" "*.html" "*.js" "*.ts"', { encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => !f.startsWith('docs/'));

  const morts = [];
  for (const o of OUTILS) {
    const config = o.configs.find((c) => { try { readFileSync(c); return true; } catch { return false; } });
    const dep = o.deps.find((d) => declarees[d]);
    if (!config && !dep) continue;                       // absent : rien a dire
    const invoque = new RegExp(o.deps.map((d) => d.replace(/[/@-]/g, '.')).join('|'), 'i').test(scripts);
    const utilise = o.directives
      ? sources.some((f) => o.directives.test(readFileSync(f, 'utf8')))
      : false;
    if (!invoque && !utilise) {
      morts.push(`${o.nom} (${[config, dep].filter(Boolean).join(' + ')}) : aucun script ne l'invoque`
        + (o.directives ? ' et aucune source ne porte ses directives' : ''));
    }
  }
  controle('aucune chaine de build declaree sans etre invoquee', morts.length === 0, morts.join(' · '));
}

console.log(`\n  ${faits} regle(s) du systeme de design verifiee(s) sur ${SURFACES.length} surfaces.`);
