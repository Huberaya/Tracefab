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

const nav = await chromium.launch();
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
  console.log(`\n  ${ecrits} reference(s) ecrite(s) dans ${DOSSIER}/`);
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
