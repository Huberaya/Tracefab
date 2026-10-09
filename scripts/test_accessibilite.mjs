#!/usr/bin/env node
/**
 * Accessibilite : le controle exige apres chaque phase, jamais execute.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Le cahier des charges impose neuf verifications apres chaque phase :
 * construction, types, tests, responsive, regression, **accessibilite**,
 * performance, routes, API. Huit etaient outillees. L'accessibilite ne l'a
 * jamais ete : zero script, sur douze phases.
 *
 * Elle n'a donc pas ete « validee rapidement » — elle n'a jamais ete mesuree
 * une seule fois, sur aucune surface.
 *
 * Ce test passe axe-core sur chaque surface et echoue sur les infractions
 * serieuses ou critiques. Les infractions mineures et moderees sont comptees
 * et affichees, sans bloquer : le but est de tenir une ligne, pas de rendre
 * la suite ingerable d'un coup.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SOURCE_AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = process.env.TF_BASE || 'http://127.0.0.1:3000';

/*
 * Une surface = une route ET, le cas echeant, une vue interne.
 *
 * La premiere version de ce test ne chargeait que la vue par defaut de
 * chaque page. Elle est passee au vert alors que les vues profondes de la
 * console cumulaient douze infractions : un selecteur sans nom accessible,
 * neuf defauts de contraste, et deux bandes a colonnes fixes qui faisaient
 * deborder la page sur mobile. Mesurer la porte d'entree ne mesure rien.
 */
const SURFACES = [
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

/* Seules les infractions serieuses et critiques bloquent. */
const BLOQUANTES = new Set(['serious', 'critical']);

let echecs = 0;
const navigateur = await chromium.launch();
const resume = [];

for (const surface of SURFACES) {
  const route = surface.route + (surface.vue ? ` [${surface.vue}]` : '');
  const page = await navigateur.newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(BASE + surface.route, { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  if (surface.vue) {
    const ouvert = await page.evaluate(async (v) => {
      const b = document.querySelector(`button[data-view="${v}"]`);
      if (!b) return false;
      b.click();
      await new Promise((r) => setTimeout(r, 850));
      return true;
    }, surface.vue);
    if (!ouvert) {
      console.log(`  ECHEC ${route} : vue « ${surface.vue} » introuvable`);
      echecs += 1;
      await page.close();
      continue;
    }
  }
  await page.addScriptTag({ content: SOURCE_AXE });

  const res = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      resultTypes: ['violations'],
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, n: v.nodes.length,
      cible: (v.nodes[0] && v.nodes[0].target && v.nodes[0].target[0]) || '',
    }));
  });
  await page.close();

  const graves = res.filter((v) => BLOQUANTES.has(v.impact));
  const legeres = res.filter((v) => !BLOQUANTES.has(v.impact));
  resume.push({ route, graves: graves.length, legeres: legeres.length });

  if (graves.length) {
    echecs += 1;
    console.log(`  ECHEC ${route}`);
    for (const v of graves) {
      console.log(`         ${v.impact.padEnd(8)} ${v.id} — ${v.n} element(s)  ${String(v.cible).slice(0, 48)}`);
    }
  } else {
    console.log(`  ok    ${route.padEnd(24)} aucune infraction serieuse`
      + (legeres.length ? `  (${legeres.length} moderee(s)/mineure(s))` : ''));
  }
  for (const v of legeres) {
    console.log(`         · ${v.impact.padEnd(8)} ${v.id} — ${v.n} element(s)`);
  }
}

await navigateur.close();

const totalGraves = resume.reduce((a, r) => a + r.graves, 0);
const totalLegeres = resume.reduce((a, r) => a + r.legeres, 0);
console.log(`\n  ${SURFACES.length} surfaces · ${totalGraves} infraction(s) serieuse(s) ou critique(s)`
  + ` · ${totalLegeres} moderee(s) ou mineure(s)`);

if (echecs) {
  console.log(`\n${echecs} surface(s) en infraction serieuse. WCAG 2.1 AA, regles axe-core.`);
  process.exit(1);
}
console.log('\nAucune infraction serieuse ou critique sur WCAG 2.1 AA.');
