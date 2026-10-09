#!/usr/bin/env node
/**
 * Le registre des chantiers doit rester vrai.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `CHANTIERS-RESTANTS.md` s'ouvre sur « établi en interrogeant le dépôt [...]
 * Pas en relisant les en-têtes ». C'etait vrai le jour de sa redaction. Sept
 * commits plus tard, son en-tete annoncait `main = 5b78ac6`, « CI run #26 »
 * et « Neon 33/33 migrations » — trois faits sur quatre etaient faux, dont
 * un compte de migrations qui sous-estimait la production.
 *
 * Un document de pilotage qui se perime en silence est pire qu'absent : on
 * decide dessus. Ce test verifie les affirmations qui ne devraient bouger
 * qu'avec une decision, et laisse de cote celles qui bougent a chaque commit
 * (un SHA n'a rien a faire dans un en-tete : il a ete retire).
 *
 *   npm run test:chantiers
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const REGISTRE = 'docs/experience/CHANTIERS-RESTANTS.md';
const texte = readFileSync(REGISTRE, 'utf8');
let verifies = 0;

function controle(libelle, condition, detail) {
  assert.ok(condition, `${libelle}${detail ? ' — ' + detail : ''}`);
  verifies += 1;
  console.log(`✓ ${libelle}`);
}

/* --- 1. Le compte de migrations annonce doit etre celui du depot. ------- */
{
  const annonce = texte.match(/Neon\s*:\s*(\d+)\/(\d+)\s*migrations/);
  assert.ok(annonce, `${REGISTRE} doit annoncer un compte de migrations Neon`);
  const reel = readdirSync('prisma/migrations').filter((d) => /^\d/.test(d)).length;
  controle(
    `compte de migrations annonce (${annonce[1]}) = depot (${reel})`,
    Number(annonce[1]) === reel && Number(annonce[2]) === reel,
    `le document annonce ${annonce[1]}/${annonce[2]}`,
  );
}

/* --- 2. Aucun SHA presente comme fait courant dans l'en-tete. ----------
 * Le document a le droit de RACONTER qu'il portait `5b78ac6` et que c'etait
 * une erreur. Il n'a pas le droit d'annoncer « main = <sha> » comme un etat,
 * parce que cet etat est faux au commit suivant.                          */
{
  const entete = texte.slice(0, texte.indexOf('## '));
  const fige = entete.match(/`?main`?\s*[:=]\s*`[0-9a-f]{7,40}`/i);
  controle(
    "l'en-tete ne presente aucun SHA comme etat courant",
    !fige,
    fige ? `trouve « ${fige[0]} » — faux des le commit suivant` : '',
  );
}

/* --- 3. Une seule police d'affichage : decision close de l'utilisateur. -
 * La verification porte sur les fichiers VIVANTS. La documentation a le
 * droit de citer l'ancienne police pour raconter la decision ; une config
 * de build n'a pas ce droit, elle l'appliquerait.                         */
{
  const suivis = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
  // Ce fichier-ci doit citer la police interdite pour pouvoir la chercher. Il
  // s'excluait de fait tant qu'il n'etait pas suivi par git : le controle n'est
  // devenu faux qu'une fois le garde commite, c'est-a-dire apres la derniere
  // execution verte. L'exclusion est donc explicite, pas implicite.
  const vivants = suivis.filter((f) => !f.startsWith('docs/') && !f.endsWith('.md')
    && !f.endsWith('package-lock.json') && f !== 'scripts/test_chantiers.mjs');
  const fautifs = vivants.filter((f) => {
    try { return /Plus Jakarta/i.test(readFileSync(f, 'utf8')); } catch { return false; }
  });
  controle(
    `une seule police d'affichage dans ${vivants.length} fichiers vivants`,
    fautifs.length === 0,
    fautifs.length ? `« Plus Jakarta » subsiste dans ${fautifs.join(', ')}` : '',
  );
}

/* --- 4. Une section qui se declare soldee doit nommer son garde-fou. ----
 * Sans cela, « RÉGLÉ » n'est qu'une affirmation. Avec, c'est une promesse
 * qu'une commande peut contredire.                                        */
{
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  const sections = [...texte.matchAll(/^## (\d+) · (.+)$/gm)];
  assert.ok(sections.length >= 8, 'le registre doit contenir au moins 8 sections numerotees');
  const soldees = sections.filter((m) => /RÉGLÉ|TRAITÉ|TRANCHÉ|VÉRIFIÉ/.test(m[2]));
  assert.ok(soldees.length >= 4, 'au moins quatre sections devraient etre soldees');

  const sansGarde = [];
  for (const m of soldees) {
    const debut = m.index;
    const suivante = texte.indexOf('\n## ', debut + 1);
    const corps = texte.slice(debut, suivante === -1 ? undefined : suivante);
    // Le corps doit citer au moins une commande npm qui existe vraiment.
    const cites = [...corps.matchAll(/`(?:npm run )?(test:[a-z0-9:-]+)`/g)].map((x) => x[1]);
    const reels = cites.filter((c) => Object.prototype.hasOwnProperty.call(scripts, c));
    if (reels.length === 0) sansGarde.push(`${m[1]} (${cites.length ? 'cite ' + cites.join(',') + ' — inexistant' : 'ne cite aucun garde'})`);
  }
  controle(
    `les ${soldees.length} sections soldees nomment un garde-fou existant`,
    sansGarde.length === 0,
    sansGarde.length ? `section(s) ${sansGarde.join(' · ')}` : '',
  );
}

/* --- 5. Le perimetre annonce doit correspondre aux dossiers presents. --- */
{
  const dossiers = readdirSync('docs/experience')
    .filter((f) => /^chantier-\d+/.test(f))
    .map((f) => Number(f.match(/^chantier-(\d+)/)[1]));
  const cites = [...texte.matchAll(/`chantier-(\d+)-[a-z-]+\.md`/g)].map((m) => Number(m[1]));
  const manquants = cites.filter((n) => !dossiers.includes(n));
  controle(
    `les ${cites.length} dossiers de chantier cites existent`,
    manquants.length === 0,
    manquants.length ? `absent(s) : ${manquants.join(', ')}` : '',
  );
}

console.log(`\n${verifies} affirmation(s) du registre verifiee(s) contre le depot.`);
