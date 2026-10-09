#!/usr/bin/env node
/**
 * Toute surface doit etre joignable, ou declaree injoignable exprès.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Quatre pages du site n'avaient aucun lien entrant : /product-intelligence/,
 * /passport/, /operations/ et /invitations/accept/. Elles etaient construites,
 * stylees, traduites, servies — et personne ne pouvait les atteindre en
 * naviguant. /product-intelligence/ est exigee par le cahier des charges.
 *
 * Aucun test ne pouvait le voir : les suites verifiaient ce que contient
 * chaque page, jamais si on peut y arriver. Une page sans lien entrant passe
 * tous les tests de contenu du monde.
 *
 * Trois des quatre etaient des orphelines par accident. La quatrieme ne l'est
 * pas : on arrive sur une invitation par courriel, pas par un menu. La
 * difference entre les deux cas ne se devine pas — elle se declare.
 *
 * Ce test transforme donc « orpheline par negligence » en « non liee par
 * decision ecrite ». Ajouter une page sans lien le fait echouer ; la declarer
 * ci-dessous avec sa raison le fait passer. Le cout d'un oubli devient visible,
 * le cout d'un choix assume reste nul.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname } from 'node:path';

/* Surfaces auxquelles on n'arrive pas par la navigation, et pourquoi. */
const SANS_LIEN_ASSUME = {
  '/invitations/accept/':
    'On y arrive par le lien d un courriel d invitation, porteur d un jeton. '
    + 'Un lien de menu vers une page d acceptation sans jeton n aurait aucun sens.',
  '/operations/':
    'Console interne d exploitation, protegee par Clerk et dependante du service '
    + 'operations. Elle ne s adresse ni aux marques ni aux fournisseurs : elle n a '
    + 'rien a faire dans une navigation client.',
};

const pages = execSync('git ls-files "*.html"', { encoding: 'utf8' })
  .split('\n').filter((p) => p.endsWith('index.html'));

const sources = [
  ...pages,
  ...execSync('git ls-files "assets/js/*.js"', { encoding: 'utf8' }).split('\n').filter(Boolean),
];

const route = (p) => {
  const d = dirname(p);
  return d === '.' ? '/' : `/${d}/`;
};

let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

const contenu = new Map(sources.map((s) => [s, readFileSync(s, 'utf8')]));

console.log(`  ${pages.length} surfaces, ${sources.length} fichiers sources balayes\n`);

const orphelines = [];
for (const page of pages) {
  const r = route(page);
  if (r === '/') continue;                       // la racine est la porte d entree

  let entrants = 0;
  const provenances = [];
  for (const [src, txt] of contenu) {
    if (src === page) continue;
    // href="/x/" dans le HTML, ou "/x/" cite dans un bundle (data-tf-arg, open(), …)
    const motifs = [
      new RegExp(`href=["']${r}["']`, 'g'),
      new RegExp(`["'\`]${r}["'\`]`, 'g'),
      new RegExp(`data-tf-arg=["']${r}["']`, 'g'),
    ];
    const n = motifs.reduce((acc, m) => acc + (txt.match(m) || []).length, 0);
    if (n > 0) { entrants += n; provenances.push(basename(src)); }
  }

  const assume = SANS_LIEN_ASSUME[r];
  if (entrants > 0) {
    if (assume) {
      ko(`${r} est declaree sans lien, mais ${entrants} lien(s) pointent dessus `
        + `(${provenances.join(', ')}) — retirer la declaration ou le lien`);
    } else {
      ok(`${r.padEnd(26)} ${String(entrants).padStart(2)} lien(s) entrant(s) — ${provenances.slice(0, 3).join(', ')}`);
    }
  } else if (assume) {
    ok(`${r.padEnd(26)} sans lien, assume : ${assume.slice(0, 58)}…`);
  } else {
    orphelines.push(r);
    ko(`${r} n a AUCUN lien entrant et n est pas declaree — surface injoignable`);
  }
}

/* La page exigee par le cahier des charges ne peut pas etre declaree injoignable. */
const EXIGEES = ['/product-intelligence/', '/brand-console/', '/supplier-portal/', '/dpp/', '/quality-center/'];
for (const r of EXIGEES) {
  if (SANS_LIEN_ASSUME[r]) {
    ko(`${r} figure au cahier des charges : elle ne peut pas etre declaree sans lien`);
  }
}

console.log();
if (echecs) {
  console.log(`${echecs} probleme(s). Une surface injoignable est une surface qui n existe pas.`);
  if (orphelines.length) {
    console.log('Soit on la relie, soit on ecrit pourquoi elle ne l est pas dans SANS_LIEN_ASSUME.');
  }
  process.exit(1);
}
console.log('Toutes les surfaces sont joignables, ou declarees injoignables avec leur raison.');
