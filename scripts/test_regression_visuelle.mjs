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
 * Le rendu est rendu reproductible dans scripts/lib/visuel.mjs : fontes
 * distantes bloquees, horloge et Math.random figes, animations coupees,
 * compteurs pousses a leur valeur finale. Sans cela la reference figerait du
 * bruit. Mesure de controle avant d'ecrire la premiere reference : deux
 * captures consecutives de chacune des 19 surfaces, ecart 0,000 %.
 */
import { chromium } from 'playwright';
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
 * On mesurait la largeur rendue d'un texte temoin dans les trois familles de
 * repli, en supposant que « si les polices changent, ces largeurs changent ».
 *
 * CETTE SUPPOSITION EST FAUSSE, et la CI l'a montre : sur le runner, les trois
 * largeurs ET la version de Chromium etaient IDENTIQUES a la reference, la
 * garde a donc laisse passer, et la comparaison a releve 2 a 6 % de pixels
 * differents sur 19 surfaces. Des polices metriquement compatibles rendent la
 * meme avance avec une rasterisation differente — crenage, hinting, lissage.
 *
 * On compare donc desormais la rasterisation elle-meme : le temoin est rendu,
 * capture, et hache. Deux environnements dont les pixels different sur ce
 * temoin ne peuvent pas partager une reference en pixels.
 */
const EMPREINTE = join(DOSSIER, '_environnement.json');

async function empreinte(navigateur) {
  const page = await navigateur.newPage();
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
    return { sans: mesurer('sans-serif'), serif: mesurer('serif'), mono: mesurer('monospace') };
  });
  // La rasterisation, pas seulement les metriques — et surtout LES PILES
  // REELLES, pas des familles generiques.
  //
  // Premiere tentative : un temoin en sans-serif / serif / monospace. Le
  // runner a rendu ce temoin au pixel pres comme ici, puis a signale 2 a 6 %
  // d'ecart sur les pages. La raison est dans la pile : les feuilles declarent
  // 'Inter Tight', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI',
  // Helvetica, Arial, sans-serif. Les deux premieres sont bloquees avec les
  // fontes distantes, donc le rendu depend de la resolution d'Helvetica et
  // d'Arial — que fontconfig aliase sur un runner et pas forcement ici. Une
  // sonde en « sans-serif » nu saute justement ces etapes.
  //
  // On lit donc les piles dans la feuille de style et on les rend telles
  // quelles. Si elles changent, l'empreinte change et le test l'annonce.
  const css = readFileSync('assets/design-system/tracefab-core.css', 'utf8');
  const pile = (nom) => {
    const m = new RegExp(`--tf-font-${nom}:([^;]+)`).exec(css);
    if (!m) throw new Error(`pile de polices --tf-font-${nom} introuvable`);
    return m[1].trim();
  };
  const piles = [pile('text'), pile('mono'), 'sans-serif', 'serif', 'monospace'];
  // ET A PLUSIEURS TAILLES, dont de petites.
  //
  // Deuxieme tentative manquee : un temoin uniquement a 64 px. Le runner l'a
  // encore rendu a l'identique. Or la repartition des ecarts le disait : 0,33 %
  // sur l'accueil, compose en tres grands caracteres, contre 2 a 6 % sur les
  // consoles, denses en texte de 11 a 14 px. Les deux machines resolvent bien
  // la meme police (Arial -> Liberation Sans), mais ne l'instruisent pas de la
  // meme facon : le hinting et le lissage ne se voient qu'aux petites tailles,
  // la ou la grille de pixels contraint le glyphe. Un temoin en gros corps est
  // precisement l'endroit ou cette difference ne se voit pas.
  const tailles = [11, 13, 16, 64];
  await page.setViewportSize({ width: 1400, height: 1200 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">
    <div id="t" style="display:inline-block;padding:8px;background:#fff">
      ${piles.flatMap((p) => tailles.map((t) => `<div style="font-size:${t}px;font-family:${p};white-space:nowrap">Traçabilité textile 0123456789 WAVE</div>`)).join('')}
    </div></body></html>`);
  const image = await page.locator('#t').screenshot();
  const rendu = createHash('sha256').update(image).digest('hex').slice(0, 24);
  await page.close();
  return { navigateur: navigateur.version(), largeurs, rendu };
}

const nav = await chromium.launch();
const ENV_COURANT = await empreinte(nav);
// Toujours journalise, y compris quand la garde laisse passer : sans cette
// ligne, un environnement qui coincide a tort reste indetectable dans les
// journaux de CI. C'est ce qui a fait perdre deux cycles.
console.log(`  empreinte de rendu : ${ENV_COURANT.rendu} (Chromium ${ENV_COURANT.navigateur})`);

if (!MAJ && existsSync(EMPREINTE)) {
  const attendu = JSON.parse(readFileSync(EMPREINTE, 'utf8'));
  const memeRendu = JSON.stringify(attendu.largeurs) === JSON.stringify(ENV_COURANT.largeurs)
    && attendu.navigateur === ENV_COURANT.navigateur
    // Ajoute apres l'incident CI : les deux conditions ci-dessus etaient
    // vraies sur le runner alors que le rendu differait de 2 a 6 %.
    && attendu.rendu === ENV_COURANT.rendu;
  if (!memeRendu) {
    await nav.close();
    console.log('\n  TEST NON EXECUTE — environnement de rendu different de la reference.');
    console.log(`    reference : Chromium ${attendu.navigateur} · rendu ${attendu.rendu}`);
    console.log(`    ici       : Chromium ${ENV_COURANT.navigateur} · rendu ${ENV_COURANT.rendu}`);
    console.log('\n  Les polices systeme de repli ne sont pas les memes : comparer des');
    console.log('  pixels ici n\'apprendrait rien sur le code. AUCUNE verification');
    console.log('  visuelle n\'a donc eu lieu. Pour couvrir cette machine, rejouer la');
    console.log('  reference avec « npm run test:regression -- --maj » puis la relire.\n');
    // Sortie 0 assumee : rendre rouge une machine saine n'apprendrait rien.
    // Ce message est desormais VISIBLE dans les journaux de CI, le test
    // n'etant plus exclu de la boucle.
    // (ancien commentaire conserve ci-dessous pour memoire)
    // Sortie 0 assumee : ce test etait volontairement hors de la boucle CI
    // (voir .github/workflows/ci.yml). Le rendre rouge ici punirait une
    // machine saine. Le message ci-dessus dit sans ambiguite que rien n'a
    // ete verifie.
    process.exit(0);
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
      console.log(`  ECHEC ${nom} — capture impossible : ${err.message}`);
      echecs += 1;
      continue;
    }

    if (MAJ) {
      writeFileSync(chemin, png);
      ecrits += 1;
      continue;
    }

    if (!existsSync(chemin)) {
      console.log(`  ECHEC ${nom} — aucune reference. Lancer « npm run test:regression -- --maj ».`);
      echecs += 1; nouveaux += 1;
      continue;
    }

    const d = await comparer(nav, readFileSync(chemin), png);
    compares += 1;
    if (d.dimensions) {
      console.log(`  ECHEC ${nom} — la page a change de taille : ${d.dimensions}`);
      echecs += 1;
    } else if (d.pct > SEUIL_PCT) {
      console.log(`  ECHEC ${nom} — ${d.pct.toFixed(3)} % des pixels different `
        + `(${d.pixels} sur ${d.largeur}x${d.hauteur}), seuil ${SEUIL_PCT} %`);
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
