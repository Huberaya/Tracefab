/**
 * Test de regression visuelle.
 *
 * C'est le dernier des neuf controles exiges apres chaque phase, et le seul
 * qui etait reste a zero script. Les autres gardes verifient une regle connue
 * a l'avance : des jetons, du contraste, des routes, des cles i18n. Celui-ci
 * repond a la seule question qu'aucune regle ne couvre — « quelque chose
 * a-t-il bouge que personne n'a voulu ? » — en comparant le rendu a une
 * reference validee.
 *
 *   npm run test:regression         compare au dossier de reference
 *   npm run test:regression -- --maj  reecrit la reference (acte volontaire)
 *
 * La reference est versionnee : une evolution de rendu se relit en revue sous
 * forme d'images modifiees, ce qui est precisement l'intention.
 *
 * Elle est generee DANS l'environnement de comparaison (la CI), via le
 * workflow `figer-reference-visuelle` (workflow_dispatch) qui rejoue --maj et
 * pousse les images sur la branche. La pile de rasterisation (freetype,
 * fontconfig) n'est pas la meme d'une machine a l'autre : un --maj local
 * figerait la CI sur un rendu etranger et la ferait rougir sans cause au
 * code. Un --maj local reste utile pour inspecter un changement — il ne doit
 * pas etre committé.
 *
 * Le rendu est rendu reproductible dans scripts/lib/visuel.mjs : fontes
 * distantes bloquees, horloge et Math.random figes, animations coupees,
 * compteurs pousses a leur valeur finale. Sans cela la reference figerait du
 * bruit. Mesure de controle avant d'ecrire la premiere reference : deux
 * captures consecutives de chacune des 19 surfaces, ecart 0,000 %.
 *
 * DEPUIS 20261009 : les fontes sont STATIQUES (assets/css/fonts.css) et le
 * navigateur de test est epingle (scripts/lib/launch_chromium.mjs :
 * @sparticuz/chromium en devDependency exacte, repli Chromium Playwright
 * 153.0.8010.12 via playwright fige en 1.63.0). Le rendu ne depend plus ni
 * d'un CDN de fontes, ni d'un telechargement de navigateur, ni des polices
 * systeme de la machine : l'empattement entre le poste et la CI est celui
 * que couvre le seuil, plus la variation d'environnement.
 */
import { launchTestBrowser } from './lib/launch_chromium.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SURFACES, ECRANS, capturer, comparer, nomFichier } from './lib/visuel.mjs';

const BASE = process.env.TF_BASE_URL || 'http://localhost:3000';
const DOSSIER = 'tests/regression/reference';
const MAJ = process.argv.includes('--maj');

/**
 * Seuil. L'anticrenelage du texte fait deja varier quelques pixels d'une
 * machine a l'autre ; en dessous de ce seuil on ne voit rien a l'oeil. Au
 * dessus, c'est un deplacement de bloc, un changement de couleur ou de
 * typographie — exactement ce qu'on veut attraper.
 */
const SEUIL_PCT = 0.10;

mkdirSync(DOSSIER, { recursive: true });

/**
 * Empreinte de l'environnement de rendu.
 *
 * Une reference en pixels n'a de sens que dans l'environnement qui l'a
 * produite. Les fontes distantes sont bloquees pour la stabilite, mais le
 * repli retombe sur les polices SYSTEME, qui different d'une machine a
 * l'autre. Un meme code rend donc differemment ici et sur un runner, et le
 * test rougit pour une raison etrangere au code — c'est exactement ce qui
 * est arrive sur la CI.
 *
 * Depuis les fontes statiques, on mesure la largeur reellement rendue d'un
 * texte temoin dans les familles versionnees (Inter Tight, JetBrains Mono).
 * C'est le signal direct : si les woff2 versionnes ne sont pas servis (repli
 * systeme), ces largeurs changent — et la comparaison de pixels n'aurait
 * alors plus aucun sens.
 */
const EMPREINTE = join(DOSSIER, '_environnement.json');

async function empreinte(navigateur) {
  const page = await navigateur.newPage();
  // Les fontes STATIQUES sont chargees depuis la page locale : leur largeur
  // rendue est identique partout ou le woff2 versionne est servi. Si une
  // largeur bouge, c'est que la fonte attendue n'a pas ete servie (repli
  // systeme) — comparer des pixels n'aurait alors aucun sens.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const largeurs = await page.evaluate(() => {
    const mesurer = (famille) => {
      const el = document.createElement('span');
      el.textContent = 'Traçabilité textile 0123456789 WAVE';
      el.style.cssText = `position:absolute;white-space:nowrap;font:100px ${famille}`;
      document.body.appendChild(el);
      const l = Math.round(el.getBoundingClientRect().width * 100) / 100;
      el.remove();
      return l;
    };
    return {
      interTight: mesurer("'Inter Tight'"),
      jetbrainsMono: mesurer("'JetBrains Mono'"),
    };
  });

  // Temoin de rasterisation : un rendu fixe, hashé. Il ne depend que de la
  // pile graphique (freetype/fontconfig/Skia) — pas du contenu des pages.
  // Si le hash change, la comparaison de pixels parlerait de la machine, pas
  // du code : le test se declare alors NON EXECUTE plutot que de mentir.
  await page.setContent(
    `<link rel="stylesheet" href="${BASE}/assets/css/fonts.css">`
    + '<div id="temoin" style="width:420px;padding:8px;background:#fff;color:#111">'
    + '<p style="font-family:Inter Tight;font-size:22px;font-weight:600;margin:0">Traçabilité textile 0123456789 WAVE</p>'
    + '<p style="font-family:\'JetBrains Mono\';font-size:15px;margin:6px 0 0">TC-00941 · 60% Coton · 1.23 kg CO₂e</p>'
    + '<p style="font-family:serif;font-size:18px;margin:6px 0 0">abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ</p>'
    + '</div>',
    { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const temoinPng = await page.screenshot({ clip: { x: 0, y: 0, width: 420, height: 130 } });
  const temoin = createHash('sha256').update(temoinPng).digest('hex').slice(0, 16);
  await page.close();
  return { navigateur: navigateur.version(), source: navigateur._tfSource || '?', largeurs, temoin };
}


/**
 * En CI, les journaux de job ne sont pas lisibles depuis l'API : seules les
 * annotations le sont. Tout diagnostic doit donc passer par ::error:: /
 * ::notice:: — sans quoi un echec revient sans cause visible.
 */
function annoter(niveau, message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::${niveau}::${message.replace(/\r?\n/g, ' ')}`);
  }
  console.log(message);
}

const nav = await launchTestBrowser();
const ENV_COURANT = await empreinte(nav);
annoter('notice', `regression visuelle : Chromium ${ENV_COURANT.navigateur} via ${ENV_COURANT.source} · temoin ${ENV_COURANT.temoin} · largeurs ${JSON.stringify(ENV_COURANT.largeurs)}`);

if (!MAJ && existsSync(EMPREINTE)) {
  const attendu = JSON.parse(readFileSync(EMPREINTE, 'utf8'));
  // La famille du navigateur doit correspondre (153.0.8010) ; le niveau
  // correctif (153.0.8010.0 vs 153.0.8010.12) porte des correctifs de
  // securite qui ne changent pas le rendu, et l'ecarter ici reintroduirait
  // le faux-saut qu'on supprime.
  const famille = (v) => String(v).split('.').slice(0, 3).join('.');
  const memeRendu = JSON.stringify(attendu.largeurs) === JSON.stringify(ENV_COURANT.largeurs)
    && famille(attendu.navigateur) === famille(ENV_COURANT.navigateur)
    && (!attendu.temoin || attendu.temoin === ENV_COURANT.temoin);
  if (!memeRendu) {
    await nav.close();
    annoter('error', `regression visuelle NON EXECUTEE — pile de rendu differente de la reference (reference Chromium ${attendu.navigateur} / ici ${ENV_COURANT.navigateur} via ${ENV_COURANT.source}, temoin ${attendu.temoin || '?'} vs ${ENV_COURANT.temoin}) — la reference se fige avec le workflow « figer-reference-visuelle » ; un --maj local ne doit pas etre committé`);
    console.log('\n  TEST NON EXECUTE — environnement de rendu different de la reference.');
    console.log(`    reference : Chromium ${attendu.navigateur} · largeurs ${JSON.stringify(attendu.largeurs)}`);
    console.log(`    ici       : Chromium ${ENV_COURANT.navigateur} · largeurs ${JSON.stringify(ENV_COURANT.largeurs)}`);
    console.log('\n  Les fontes statiques ne rendent pas comme attendu, ou la famille du');
    console.log('  navigateur a change : comparer des pixels n\'apprendrait rien sur le');
    console.log('  code. AUCUNE verification visuelle n\'a donc eu lieu. Pour couvrir');
    console.log('  cette machine, rejouer la reference avec');
    console.log('  « npm run test:regression -- --maj » puis la relire.\n');
    // Sortie 2 = NON EXECUTE. La regle du depot s'applique desormais ici
    // aussi : un test qui ne s'est pas execute ne vaut pas un test qui passe.
    // Avec les fontes statiques et le navigateur epingle, ce cas ne survient
    // plus en CI — seulement sur une machine dont le rendu est hors perimetre.
    process.exit(2);
  }
}
let echecs = 0, compares = 0, ecrits = 0, nouveaux = 0;
const vus = new Set();

for (const s of SURFACES) {
  for (const ecran of ECRANS) {
    const nom = nomFichier(s, ecran);
    vus.add(nom);
    const chemin = join(DOSSIER, nom);
    let png;
    try {
      png = await capturer(nav, BASE, s, ecran);
    } catch (err) {
      annoter('error', `regression visuelle : ${nom} — capture impossible : ${err.message}`);
      echecs += 1;
      continue;
    }

    if (MAJ) {
      writeFileSync(chemin, png);
      ecrits += 1;
      continue;
    }

    if (!existsSync(chemin)) {
      annoter('error', `regression visuelle : ${nom} — aucune reference. Lancer « npm run test:regression -- --maj ».`);
      echecs += 1; nouveaux += 1;
      continue;
    }

    const d = await comparer(nav, readFileSync(chemin), png);
    compares += 1;
    if (d.dimensions) {
      annoter('error', `regression visuelle : ${nom} — la page a change de taille : ${d.dimensions}`);
      echecs += 1;
    } else if (d.pct > SEUIL_PCT) {
      annoter('error', `regression visuelle : ${nom} — ${d.pct.toFixed(3)} % des pixels different (${d.pixels} sur ${d.largeur}x${d.hauteur}), seuil ${SEUIL_PCT} %`);
      echecs += 1;
    } else if (d.pct > 0) {
      console.log(`  ok    ${nom}  ${d.pct.toFixed(3)} % (sous le seuil)`);
    } else {
      console.log(`  ok    ${nom}`);
    }
  }
}

await nav.close();

if (MAJ) {
  writeFileSync(EMPREINTE, `${JSON.stringify(ENV_COURANT, null, 2)}\n`);
  console.log(`\n  ${ecrits} reference(s) ecrite(s) dans ${DOSSIER}/`);
  console.log(`  empreinte de rendu : Chromium ${ENV_COURANT.navigateur}`);
  console.log('  Relire les images modifiees avant de commiter : c est la revue.');
  process.exit(0);
}

// Une reference orpheline signale une surface retiree sans que la reference
// ait suivi. Silencieux, cela laisse croire a une couverture qui n'existe plus.
const orphelines = readdirSync(DOSSIER).filter((f) => f.endsWith('.png') && !vus.has(f));
if (orphelines.length) {
  console.log(`\n  ECHEC ${orphelines.length} reference(s) sans surface correspondante : ${orphelines.join(', ')}`);
  echecs += orphelines.length;
}

console.log(`\n  ${compares} surface(s) comparee(s) a la reference`
  + (nouveaux ? ` · ${nouveaux} sans reference` : ''));
console.log(echecs
  ? `\n${echecs} ecart(s). Si le changement est voulu : npm run test:regression -- --maj`
  : '\nAucune regression visuelle.');
process.exit(echecs ? 1 : 0);
