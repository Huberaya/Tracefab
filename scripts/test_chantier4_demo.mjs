/* ==========================================================================
   TRACEFAB — chantier 4 : les vues DPP et Certifications en demonstration.

   En mode ?demo, ces deux vues atterrissaient sur un etat vide :
     - dppView() renvoie tot un selecteur de produit tant que
       state.selectedDppProduct est absent, et demoData() ne le posait pas ;
     - certificationsConsoleView() mappe state.certifications, jamais seme.
   Resultat : 357 et 531 caracteres de contenu, contre ~2000 pour les vues
   voisines. Les deux vues qui portent la promesse reglementaire etaient
   justement les deux vides.

   Ce test verrouille les graines, leur coherence interne, et surtout le fait
   que la veille des expirations DERIVE des donnees. La version precedente
   affirmait en dur qu'aucun certificat n'expirait sous 60 jours : une prose
   figee qui enonce un fait sur les donnees devient fausse des que les
   donnees existent. C'est la regression que ce test doit empecher.

   Usage : node scripts/test_chantier4_demo.mjs
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pageSource } from './lib/page_source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['fr', 'de', 'it', 'es', 'nl', 'pt'];

let ko = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { console.log(`  OK    ${label}`); } else { ko += 1; console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

const page = pageSource('brand-console/index.html');

/** Corps d'une fonction, delimite par comptage d'accolades. */
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

const demo = corpsDe('demoData');
const vueCert = corpsDe('certificationsConsoleView');

/* --- 1. les graines existent -------------------------------------------- */
ok(/state\.certifications\s*=\s*\[/.test(demo), 'demoData() seme state.certifications');
ok(/state\.selectedDppProduct\s*=/.test(demo), 'demoData() seme state.selectedDppProduct');
ok(/state\.dpp\s*=\s*\{/.test(demo), 'demoData() seme state.dpp');

const certs = [...demo.matchAll(/\{\s*standard:/g)].length;
ok(certs >= 4, 'au moins 4 certificats de demonstration', `${certs} trouve(s)`);

/* --- 2. les echeances sont relatives, donc jamais perimees -------------- */
ok(/Date\.now\(\)\s*\+\s*n\s*\*\s*86400000/.test(demo),
  'les echeances sont calculees a partir de Date.now()');
const datesDures = [...demo.matchAll(/expires:\s*'20\d\d-/g)].length;
ok(datesDures === 0, 'aucune date d\'expiration ecrite en dur', `${datesDures} trouvee(s)`);

/* --- 3. coherence interne du bloc DPP ----------------------------------- */
const nb = (re) => { const m = demo.match(re); return m ? Number(m[1]) : NaN; };
const score = nb(/completionScore:\s*(\d+)/);
const total = nb(/totalRequirements:\s*(\d+)/);
const atteintes = nb(/metRequirements:\s*(\d+)/);
const bloquantes = nb(/blockingCount:\s*(\d+)/);
const manquants = [...demo.matchAll(/\{\s*key:\s*'[^']+',\s*label(?:Key)?:/g)].length;
const blocTrue = [...demo.matchAll(/blocking:\s*true/g)].length;

ok(score === 88, 'score DPP = 88 %, valeur annoncee par le KPI de la vue d\'ensemble', `trouve ${score}`);
ok(atteintes < total, 'la preparation est imparfaite : la vue montre aussi ce qui manque', `${atteintes}/${total}`);
ok(total - atteintes === manquants,
  'le nombre d\'exigences non satisfaites egale le nombre de champs manquants',
  `${total} - ${atteintes} != ${manquants}`);
ok(bloquantes === blocTrue, 'blockingCount egale le nombre de champs bloquants', `${bloquantes} vs ${blocTrue}`);
ok(/canMarkReadyToPublish:\s*false/.test(demo) && /isReadyToPublish:\s*false/.test(demo),
  'le passeport n\'est pas declare publiable tant qu\'il reste un bloquant');

const piliers = ['identification', 'composition', 'traceability', 'quality'];
ok(piliers.every((p) => new RegExp(`${p}:\\s*\\{`).test(demo)), 'les 4 piliers normatifs sont semes');

/* --- 4. la preparation n'est jamais presentee comme une certification --- */
ok(!/certifier le passeport/.test(page),
  'aucune formulation « certifier le passeport » (la preparation n\'est pas une certification)');

/* --- 5. la veille des expirations derive des donnees -------------------- */
ok(!/Aucun certificat n[’']expire dans les \d+ prochains jours/.test(page),
  'la phrase « aucun certificat n\'expire » n\'est plus ecrite en dur');
ok(/certJours\(c\)\s*<=\s*90/.test(vueCert), 'le seuil de veille est applique aux donnees reelles');
ok(/bientot\.length/.test(vueCert), 'le compte affiche est derive de la liste filtree');
ok((page.match(/function certStatut\(/g) || []).length === 1, 'certStatut() definie une fois');
ok((page.match(/const certJours =/g) || []).length === 1, 'certJours() definie une fois');
ok(!/status-approved">Valide</.test(page), 'le statut du certificat n\'est plus la pastille figee « Valide »');
ok(/certStatut\(c\)/.test(vueCert), 'le tableau appelle le statut derive');
ok(/certs\.length\s*\?/.test(vueCert), 'un etat vide explicite subsiste quand aucun certificat n\'est charge');

/* --- 6. couverture i18n des nouvelles cles ------------------------------ */
const clesUtilisees = [...new Set([...page.matchAll(/bt\('(cert[A-Za-z]+)'\)/g)].map((m) => m[1]))];
ok(clesUtilisees.length >= 15, 'la vue consomme le catalogue', `${clesUtilisees.length} cle(s)`);

const en = readFileSync(join(ROOT, 'assets/i18n/en.js'), 'utf8');
const absentesEn = clesUtilisees.filter((k) => !new RegExp(`\\b${k}:`).test(en));
ok(absentesEn.length === 0, 'toutes les cles cert* existent dans en.js', absentesEn.join(', '));

// bt() resout 'console.<cle>' puis retombe sur 'shared.<cle>' : une cle
// presente dans l'une OU l'autre portee est servie. Le test doit suivre ce
// contrat, sinon il signale a tort les cles historiquement rangees dans
// 'shared' (certifications, par exemple).
for (const lang of LANGS) {
  const d = JSON.parse(readFileSync(join(ROOT, `assets/i18n/${lang}.json`), 'utf8'));
  const sc = d.console || {};
  const sh = d.shared || {};
  const valeur = (k) => sc[k] || sh[k];
  const trous = clesUtilisees.filter((k) => !valeur(k) || !String(valeur(k)).trim());
  ok(trous.length === 0, `cles cert* completes en ${lang}`, trous.slice(0, 4).join(', '));
}

/* --- 7. aucune phrase metier en dur dans la vue ------------------------- */
const phrases = [...vueCert.matchAll(/>([^<>{}$]{18,})</g)]
  .map((m) => m[1].trim())
  .filter((t) => /[a-zA-Z]{4,}\s+[a-zA-Z]{4,}/.test(t));
ok(phrases.length === 0, 'aucune phrase en dur dans certificationsConsoleView()',
  phrases.slice(0, 3).join(' | '));

/* --- 8. le generateur est idempotent et n'empiete pas sur Risk ---------- */
const gen = readFileSync(join(ROOT, 'scripts/build_certifications_i18n.mjs'), 'utf8');
ok(gen.includes('indexOf(DEBUT)'), 'build_certifications_i18n.mjs retire sa region avant reecriture');
ok(gen.includes('Veille des certificats') && !gen.includes('Risk & exposure'),
  'le generateur ne touche que sa propre region');
const genRisk = readFileSync(join(ROOT, 'scripts/build_risk_i18n.mjs'), 'utf8');
ok(genRisk.includes('apresAccolade'), 'les deux generateurs inserent en tete de bloc (cohabitation sure)');

// --- Arbitrage du 7 octobre 2026 : les KPI derivent des donnees ---
// La vue d ensemble annoncait 1 248 produits et 86 fournisseurs quand l etat
// n en portait que 2 et 1. Les enregistrements sont desormais reellement
// semes et les compteurs les comptent. Ces assertions empechent le retour en
// arriere vers des litteraux.
ok(/function demoEchelle\(\)/.test(page), 'le generateur a l echelle existe');
ok(/function demoAgregats\(\)/.test(page), 'les agregats derives existent');
ok(/const ag = demoAgregats\(\);/.test(page), 'la vue d ensemble lit les agregats');
// Les cibles ont quitte la console pour assets/js/tf-demo-figures.js : elles
// etaient nommees une fois ici, mais l'accueil en portait sa propre copie dans
// le catalogue i18n. « Une fois » ne vaut que si c'est une fois POUR TOUTES LES
// SURFACES. On verifie donc le lien, pas le litteral.
const CHIFFRES_SRC = readFileSync(join(ROOT, 'assets/js/tf-demo-figures.js'), 'utf8');
const CHIFFRES_VAL = JSON.parse(CHIFFRES_SRC.slice(CHIFFRES_SRC.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
ok(CHIFFRES_VAL.fournisseurs === 86 && CHIFFRES_VAL.produits === 1248 && CHIFFRES_VAL.sites === 214,
  'la source unique porte les cibles du cahier des charges');
ok(/CIBLE_FOURNISSEURS\s*=\s*CHIFFRES\.fournisseurs/.test(page)
  && /CIBLE_PRODUITS\s*=\s*CHIFFRES\.produits/.test(page)
  && /CIBLE_SITES\s*=\s*CHIFFRES\.sites/.test(page),
  'la console lit les cibles depuis la source unique, elle ne les redeclare pas');
ok(!/CIBLE_(FOURNISSEURS|PRODUITS|SITES)\s*=\s*\d/.test(page),
  'aucune cible reecrite en litteral dans la console');
// Les taux etaient, eux, echantillonnes : r() < 0.84 sur 1 248 produits donnait
// 85,3 %. La calibration ramene la mesure sur la cible apres tirage.
ok(/function calibrerTaux\(\)/.test(page) && /\n\s*calibrerTaux\(\);/.test(page),
  'les taux sont calibres sur la cible, pas laisses au tirage');
for (const litteral of ['<strong>1 248</strong>', '<strong>86</strong>', '<strong>214</strong>',
                        '<strong>18 pays</strong>', '<strong>92.4%</strong>', '<strong>142</strong>']) {
  ok(!page.includes(litteral), `aucun KPI ecrit en dur : ${litteral}`);
}
ok(/demoAlea\(20260407\)/.test(page), 'le generateur est deterministe, graine fixe');

console.log(ko === 0 ? '\n  chantier 4 : vues DPP et Certifications alimentees.' : `\n  chantier 4 : ${ko} echec(s).`);
process.exit(ko === 0 ? 0 : 1);
