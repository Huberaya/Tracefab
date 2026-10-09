#!/usr/bin/env node
/**
 * Aucune page ne montre de chiffres inventes sans le dire.
 *
 * POURQUOI CE TEST EXISTE
 *
 * /passport/ basculait en silence sur un fournisseur fictif quand l'API ne
 * repondait pas, et l'affichait avec « PROFIL AUDITE », « AI VERIFIED »,
 * 92 % de completude et un certificateur nomme — Control Union Certifications
 * B.V., une entreprise qui existe vraiment. Aucune mention de demonstration
 * nulle part.
 *
 * Ce n'est pas un defaut cosmetique. C'est une affirmation fausse au sujet
 * d'un tiers nomme, sur une page publique, dans un produit dont l'argument
 * central est la preuve.
 *
 * Les autres surfaces le faisaient correctement : /dpp/ porte une banniere de
 * demonstration, la console affiche « Demo mode », /product-intelligence/
 * annonce « DEMONSTRATION RECORD ». Le passeport etait le seul a se taire, et
 * rien ne pouvait le signaler.
 *
 * LA REGLE
 *
 * Une page servie sans API affiche des donnees de repli. Si ces donnees
 * contiennent des chiffres ou des mentions de confiance, la page doit porter
 * un marqueur de demonstration visible. Une page qui n'affiche rien
 * d'affirmatif (etat d'erreur, formulaire) n'a rien a declarer.
 */
import { chromium } from 'playwright';

const BASE = process.env.TF_BASE || 'http://127.0.0.1:3000';

const PAGES = ['/', '/dpp/', '/passport/', '/product-intelligence/',
  '/brand-console/', '/supplier-portal/', '/quality-center/', '/operations/'];

/* Mentions de demonstration, dans les sept locales servies. */
const MENTION = /d[ée]monstration|demonstration|demo mode|sample data|sample supplier|donn[ée]es de d[ée]mo|beispiel|dimostrativ|demostraci|demonstratie|fict[ií]|not a real/i;

let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

const navigateur = await chromium.launch();
const page = await navigateur.newPage({ viewport: { width: 1360, height: 900 } });

for (const route of PAGES) {
  await page.goto(BASE + route, { waitUntil: 'load' });
  await page.waitForTimeout(1900);

  const vu = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    return {
      texte: txt,
      // chiffres affirmatifs : pourcentages, scores, grands nombres
      chiffres: (txt.match(/\b\d{1,3}([.,]\d+)?\s?%|\b\d{3,}\b/g) || []).length,
      // mentions de confiance : ce qui engage la credibilite d'un tiers
      confiance: /verified|audited|certified|v[ée]rifi|audit|certifi/i.test(txt),
      marqueurs: document.querySelectorAll('[data-tf-demo]').length,
    };
  });

  const affirme = vu.chiffres > 0 || vu.confiance;
  const declare = vu.marqueurs > 0 || MENTION.test(vu.texte);

  if (!affirme) {
    ok(`${route.padEnd(24)} rien d affirmatif a declarer (etat vide ou erreur)`);
  } else if (declare) {
    ok(`${route.padEnd(24)} ${String(vu.chiffres).padStart(3)} chiffre(s)`
      + `${vu.confiance ? ', mentions de confiance' : ''} — demonstration declaree`
      + ` (${vu.marqueurs} marqueur(s))`);
  } else {
    ko(`${route} affiche ${vu.chiffres} chiffre(s)`
      + `${vu.confiance ? ' et des mentions de confiance' : ''} sans declarer`
      + ' qu il s agit de donnees de demonstration');
  }
}

await navigateur.close();

console.log();
if (echecs) {
  console.log(`${echecs} page(s) presentent des donnees inventees comme des faits.`);
  process.exit(1);
}
console.log('Toute page qui affirme quelque chose dit d ou elle le tient.');
