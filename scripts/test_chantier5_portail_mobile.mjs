/* ==========================================================================
   TRACEFAB — chantier 5 : le premier ecran du portail fournisseur.

   En 390x844, les 14 elements cliquables au-dessus de la ligne de flottaison
   etaient TOUS de la navigation : aucune action de contenu. Le persona
   Fournisseur doit « savoir immediatement quoi faire » ; il voyait des
   onglets, deux listes deroulantes de reglage et une accroche.

   Deux defauts se tenaient la main :

   1. La mise en page. Le chrome (banniere, marque, nav, fil d'Ariane, deux
      selecteurs) et une accroche de 265 px repoussaient le seul panneau
      actionnable sous la ligne.

   2. Le panneau lui-meme. Il affirmait en dur « Fiche Entreprise (100%) »,
      « Sites GPS (100%) », « Certificats (100%) » a cote d'un total de 72 %,
      et parlait de « 3 etapes » en n'en montrant qu'une. Remonter un panneau
      incoherent au-dessus de la ligne aurait aggrave le probleme : il derive
      desormais de state.quality.score.

   Ce test verrouille les deux, plus la langue par defaut : le portail forcait
   'fr' et ignorait ?lang=, alors que la langue source du produit est
   l'anglais.

   Usage : node scripts/test_chantier5_portail_mobile.mjs
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['fr', 'de', 'it', 'es', 'nl', 'pt'];

let ko = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { console.log(`  OK    ${label}`); } else { ko += 1; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

const page = readFileSync(join(ROOT, 'supplier-portal/index.html'), 'utf8');

function corpsDe(nom) {
  const i = page.indexOf(`function ${nom}(`);
  if (i === -1) return '';
  let d = 0;
  for (let k = page.indexOf('{', i); k < page.length; k += 1) {
    if (page[k] === '{') d += 1;
    else if (page[k] === '}') { d -= 1; if (d === 0) return page.slice(i, k + 1); }
  }
  return '';
}

const panneau = corpsDe('spProgressPanel');
const dims = corpsDe('spDimensions');
const vue = corpsDe('overview');

/* --- 1. le panneau derive, il n'affirme plus ---------------------------- */
ok(panneau.length > 0, 'spProgressPanel() existe');
ok(dims.length > 0, 'spDimensions() existe');
ok(/state\.quality\?\.score/.test(dims), 'les dimensions sont lues dans state.quality.score');
ok(!/Fiche Entreprise \(100%\)/.test(page), 'la pastille « Fiche Entreprise (100%) » en dur a disparu');
ok(!/Sites de Production GPS \(100%\)/.test(page), 'la pastille « Sites GPS (100%) » en dur a disparu');
ok(!/Certificats GOTS & OEKO-TEX \(100%\)/.test(page), 'la pastille « Certificats (100%) » en dur a disparu');
ok(!/Complétez les 3 étapes/.test(page), 'la phrase annoncant « 3 etapes » a disparu');
ok(/sort\(\(a, b\) => a\.valeur - b\.valeur\)/.test(panneau), 'le point faible est calcule, pas choisi');
ok(/SP_SEUIL/.test(panneau) && /const SP_SEUIL = \d+/.test(page), 'le seuil d\'alerte est nomme et unique');

/* --- 2. une action de contenu existe et mene quelque part --------------- */
ok(/sp-focus-btn/.test(panneau), 'le panneau porte un bouton d\'action principal');
ok(/goView\('\$\{faible\.vue\}'\)/.test(panneau), 'le bouton mene a la vue qui corrige le point faible');
ok(/class="sp-check-pill[^"]*"[\s\S]{0,180}onclick="goView\('\$\{d\.vue\}'\)/.test(panneau),
  'chaque pastille est cliquable vers sa vue');

/* Les gestionnaires en ligne s'evaluent dans la portee globale : l'application
   vit dans une IIFE, donc goView doit y etre expose, sinon le clic jette
   « ReferenceError: state is not defined » et la navigation est morte. */
ok(/window\.goView = goView/.test(page), 'goView est expose a la portee globale');
ok(/<button type="button"/.test(panneau), 'pastilles et action sont de vrais boutons (clavier, lecteur d\'ecran)');

/* --- 3. etat vide : aucune invention quand le score est absent ---------- */
ok(/if \(!dims\.length\)/.test(panneau), 'un etat explicite subsiste quand aucune dimension n\'est chargee');
ok(/spNoScore/.test(panneau), 'cet etat passe par le catalogue');

/* --- 4. la mise en page mobile degraisse le chrome ---------------------- */
const mq = page.slice(page.indexOf('Chantier 5 — en 390x844'));
ok(mq.length > 0, 'le bloc responsive du chantier 5 existe');
ok(/\.sp-hero-sub \{ display: none; \}/.test(mq), 'le paragraphe d\'accroche est retire sur mobile');
ok(/\.topbar \.crumb[^}]*display: none/.test(mq), 'le fil d\'Ariane, qui repete l\'onglet actif, est retire');
ok(/\.top-actions \{ width: 100%/.test(mq), 'langue et organisation tiennent sur une ligne');

// Regression de cascade : le bloc doit se trouver APRES les regles .sp-*,
// sinon padding et font-size sont ecrases par les regles de base et la
// compaction n'a aucun effet (seuls les display:none passaient).
ok(page.indexOf('Chantier 5 — en 390x844') > page.lastIndexOf('.sp-progress-pct span'),
  'le bloc responsive est place apres les regles .sp-* qu\'il surcharge');

/* --- 5. langue : plus de repli francais impose -------------------------- */
ok(!/localStorage\.getItem\('tracefab_lang'\) : null\) \|\| 'fr'/.test(page),
  "la langue par defaut n'est plus forcee a 'fr'");
ok(/window\.TF_I18N \? window\.TF_I18N\.lang : null/.test(page),
  'la langue suit TF_I18N, qui lit ?lang et le stockage partage');

/* --- 6. typographie du deux-points -------------------------------------- */
ok(/sp2pts/.test(panneau), 'le deux-points suit la typographie de la langue');
ok(!/t\('spWeakest'\)\)\} : /.test(panneau), 'plus d\'espace avant deux-points impose a toutes les langues');

/* --- 7. couverture i18n du premier ecran -------------------------------- */
// Trois voies d'appel : t('spX') litteral, labelKey des dimensions, et la
// table SP_CHAMPS. Ne compter que la premiere sous-estime la couverture et
// laisserait les libelles de dimensions hors du controle.
const clesUtilisees = [...new Set([
  ...[...page.matchAll(/t\('(sp[A-Z][A-Za-z]*)'\)/g)].map((m) => m[1]),
  ...[...page.matchAll(/labelKey: '(sp[A-Z][A-Za-z]*)'/g)].map((m) => m[1]),
  ...[...page.matchAll(/: '(spField[A-Za-z]*)'/g)].map((m) => m[1]),
])];
ok(clesUtilisees.length >= 16, 'le premier ecran consomme le catalogue', `${clesUtilisees.length} cle(s)`);
ok([...page.matchAll(/labelKey: '(sp[A-Z][A-Za-z]*)'/g)].length === 4,
  'les 4 dimensions passent par le catalogue');

const en = readFileSync(join(ROOT, 'assets/i18n/en.js'), 'utf8');
const absentes = clesUtilisees.filter((k) => !new RegExp(`\\b${k}:`).test(en));
ok(absentes.length === 0, 'toutes les cles sp* existent dans en.js', absentes.join(', '));

for (const lang of LANGS) {
  const d = JSON.parse(readFileSync(join(ROOT, `assets/i18n/${lang}.json`), 'utf8'));
  // t() resout 'portal.<cle>' puis retombe sur 'shared.<cle>'.
  const valeur = (k) => (d.portal || {})[k] || (d.shared || {})[k];
  const trous = clesUtilisees.filter((k) => !valeur(k) || !String(valeur(k)).trim());
  ok(trous.length === 0, `cles sp* completes en ${lang}`, trous.slice(0, 4).join(', '));
}

/* --- 8. aucune phrase en dur dans ce qui est au-dessus de la ligne ------ */
const horsLigne = page.slice(page.indexOf('<div class="sp-hero-card">'), page.indexOf('<!-- 4 Core Supplier Action Modules -->'));
const phrases = [...horsLigne.matchAll(/>([^<>{}$]{18,})</g)]
  .map((m) => m[1].trim())
  .filter((t) => /[a-zA-Z]{4,}\s+[a-zA-Z]{4,}/.test(t));
ok(phrases.length === 0, 'aucune phrase en dur au-dessus de la ligne de flottaison',
  phrases.slice(0, 3).join(' | '));
ok(!/Mode démonstration — ouvrez/.test(page), 'la banniere de demonstration passe par le catalogue');

/* --- 9. le generateur est idempotent et n'empiete pas ------------------- */
const gen = readFileSync(join(ROOT, 'scripts/build_portal_overview_i18n.mjs'), 'utf8');
ok(gen.includes('indexOf(DEBUT)'), 'build_portal_overview_i18n.mjs retire sa region avant reecriture');
ok(gen.includes('apresAccolade'), 'il insere en tete de bloc (cohabitation avec les autres generateurs)');
ok(gen.includes("indexOf('\\n  portal: {')") || gen.includes('portal: {'),
  'il ecrit dans la portee portal, pas console');

/* --- 10. le reste de overview() n'a pas ete casse ----------------------- */
ok(/sp-actions-grid/.test(vue), 'la grille des 4 modules d\'action est intacte');
ok(/spProgressPanel\(\)/.test(vue), 'la vue appelle le panneau');

console.log(ko === 0 ? '\n  chantier 5 : premier ecran du portail actionnable.' : `\n  chantier 5 : ${ko} echec(s).`);
process.exit(ko === 0 ? 0 : 1);
