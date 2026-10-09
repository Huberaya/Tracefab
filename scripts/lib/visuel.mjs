/**
 * Capture et comparaison d'images, sans dependance supplementaire.
 *
 * La comparaison se fait dans un canvas du navigateur deja requis par
 * Playwright : ajouter pixelmatch/pngjs pour trois boucles serait une
 * dependance de production de plus a maintenir.
 */

/** Surfaces mesurees : route + vue profonde a ouvrir, comme pour l'accessibilite. */
export const SURFACES = [
  { route: '/' },
  { route: '/brand-console/' },
  { route: '/brand-console/', vue: 'requests' },
  { route: '/brand-console/', vue: 'documents' },
  { route: '/brand-console/', vue: 'certifications' },
  { route: '/brand-console/', vue: 'quality' },
  { route: '/brand-console/', vue: 'dpp' },
  { route: '/brand-console/', vue: 'suppliers' },
  { route: '/brand-console/', vue: 'products' },
  { route: '/supplier-portal/' },
  { route: '/supplier-portal/', vue: 'requests' },
  { route: '/supplier-portal/', vue: 'passport' },
  { route: '/supplier-portal/', vue: 'quality' },
  { route: '/product-intelligence/' },
  { route: '/quality-center/' },
  { route: '/dpp/' },
  { route: '/passport/' },
  { route: '/operations/' },
  { route: '/invitations/accept/' },
];

/**
 * Hauteur maximale capturee.
 *
 * La vue « products » de la console rend 1 249 lignes de tableau sans
 * pagination : 86 543 px, au-dela de ce que Chrome sait capturer, et la
 * capture echouait. Plafonner n'est pas un contournement du defaut — il est
 * consigne au registre — mais une reference ne doit pas dependre du millieme
 * ecran d'un tableau non pagine.
 */
export const HAUTEUR_MAX = 6000;

export const ECRANS = [
  { nom: 'bureau', width: 1280, height: 900 },
  { nom: 'mobile', width: 390, height: 844 },
];

export const nomFichier = (s, ecran) =>
  (s.route.replace(/^\/|\/$/g, '').replace(/\//g, '-') || 'accueil')
  + (s.vue ? `--${s.vue}` : '') + `--${ecran.nom}.png`;

/**
 * Rend une surface dans un etat reproductible.
 *
 * Trois sources de bruit sont neutralisees ici, et c'est le coeur du test :
 * une reference batie sur une page instable fige du bruit et sonne dans le
 * vide a chaque execution.
 */
export async function capturer(nav, base, s, ecran) {
  const pg = await nav.newPage({ viewport: { width: ecran.width, height: ecran.height } });

  // 1. Les fontes distantes ne doivent jamais decider du rendu : selon que le
  //    reseau repond ou non, Inter Tight arrive ou pas, et toute la metrique
  //    du texte change. On rend donc toujours avec la fonte de repli.
  await pg.route('**://fonts.googleapis.com/**', (r) => r.abort());
  await pg.route('**://fonts.gstatic.com/**', (r) => r.abort());

  // 2. Le temps : une page qui affiche une date ou un « il y a 3 min » differe
  //    a chaque execution.
  await pg.addInitScript(() => {
    const T = new Date('2026-01-15T12:00:00Z').getTime();
    const D = Date;
    // eslint-disable-next-line no-global-assign
    Date = class extends D {
      constructor(...a) { return a.length ? new D(...a) : new D(T); }
      static now() { return T; }
    };
    Math.random = () => 0.42;
  });

  await pg.goto(base + s.route, { waitUntil: 'load' });
  await pg.waitForTimeout(900);
  if (s.vue) {
    try { await pg.click(`button[data-view="${s.vue}"]`, { timeout: 4000 }); await pg.waitForTimeout(900); }
    catch { await pg.close(); throw new Error(`vue « ${s.vue} » introuvable sur ${s.route}`); }
  }

  // 3. Les animations : une transition a mi-course rend un pixel different a
  //    chaque passage.
  await pg.addStyleTag({ content:
    `*,*::before,*::after{animation:none!important;transition:none!important;` +
    `animation-duration:0s!important;transition-duration:0s!important;` +
    `caret-color:transparent!important;scroll-behavior:auto!important}` });
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.waitForTimeout(350);

  // Les compteurs animes de l'accueil montent en requestAnimationFrame : fige
  // Date ne les arrete pas, et une capture prise en cours de montee donne une
  // valeur differente a chaque execution (0,003 % d'ecart mesure).
  await pg.evaluate(() => {
    document.querySelectorAll('[data-tf-count]').forEach((el) => {
      const cible = el.getAttribute('data-tf-count');
      if (cible !== null) el.textContent = cible;
    });
  });
  await pg.waitForTimeout(250);

  const hauteur = await pg.evaluate(() => document.documentElement.scrollHeight);
  const png = hauteur > HAUTEUR_MAX
    ? await pg.screenshot({ clip: { x: 0, y: 0, width: ecran.width, height: HAUTEUR_MAX } })
    : await pg.screenshot({ fullPage: true });
  await pg.close();
  return png;
}

/** Compare deux PNG via un canvas. Rend le % de pixels differents. */
export async function comparer(nav, a, b) {
  const pg = await nav.newPage();
  const r = await pg.evaluate(async ([ba, bb]) => {
    const charger = (b64) => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej;
      i.src = 'data:image/png;base64,' + b64;
    });
    const [ia, ib] = await Promise.all([charger(ba), charger(bb)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { dimensions: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    }
    const px = (img) => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, img.width, img.height).data;
    };
    const da = px(ia), db = px(ib);
    let n = 0;
    // Seuil par canal : l'anticrenelage fait varier un pixel de quelques
    // unites sans qu'aucun humain ne voie quoi que ce soit.
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > 12 || Math.abs(da[i+1] - db[i+1]) > 12
       || Math.abs(da[i+2] - db[i+2]) > 12 || Math.abs(da[i+3] - db[i+3]) > 12) n += 1;
    }
    return { pct: (n / (da.length / 4)) * 100, pixels: n, largeur: ia.width, hauteur: ia.height };
  }, [a.toString('base64'), b.toString('base64')]);
  await pg.close();
  return r;
}
