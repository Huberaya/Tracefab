/**
 * Navigateur de test unique, versionne et epingle.
 *
 * Deux sources, dans cet ordre :
 *
 *   1. `@sparticuz/chromium` (devDependency epinglee) : un BINAIRE unique,
 *      le meme ici et en CI, telecharge par `npm ci` depuis le registre npm —
 *      pas depuis un CDN de navigateur, souvent bloque. C'est la reference de
 *      reproductibilite pour la regression visuelle.
 *
 *   2. Repli : le Chromium installe par Playwright (la version de `playwright`
 *      est aussi epinglee : 1.63.0 = Chromium 153.0.8010.12, memes correctifs
 *      de securite de la branche 15.3).
 *
 * Si les deux echouent, le test echoue : aucun test ne doit se faire passer
 * pour execute sans l'etre.
 *
 * Les options de lancement FIGENT LE RENDU (convention des outils de
 * regression visuelle) : sans rendu du texte, sans LCD, profil couleur sRGB,
 * barres de defilement masquees. Sans elles, la meme page rend differemment
 * selon la version de freetype/fontconfig de la machine — et la comparaison
 * de pixels ne parle plus du code mais de l'OS.
 */
import { chromium as pw } from 'playwright';

const ARGS_DETERMINISME = [
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--disable-font-subpixel-positioning',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
];

export async function launchTestBrowser(options = {}) {
  const traces = [];
  const lancement = { args: ARGS_DETERMINISME, headless: true, ...options };

  try {
    const mod = await import('@sparticuz/chromium');
    const sp = mod.default || mod;
    const executablePath = await sp.executablePath();
    const browser = await pw.launch({ executablePath, ...lancement });
    browser._tfSource = '@sparticuz/chromium (binaire epingle)';
    return browser;
  } catch (e) {
    traces.push(`@sparticuz/chromium : ${e.message}`);
  }

  try {
    const browser = await pw.launch(lancement);
    browser._tfSource = 'chromium playwright (repli)';
    return browser;
  } catch (e) {
    traces.push(`chromium playwright : ${e.message}`);
  }

  throw new Error(
    'aucun navigateur de test disponible :\n  - ' + traces.join('\n  - ')
    + '\nInstaller les dependances (npm ci) ou `npx playwright install chromium`.');
}
