#!/usr/bin/env node
/**
 * Le typage de l'API comme signal de régression, malgré le client Prisma absent.
 *
 * `npm run api:typecheck` remonte 90 erreurs dans cet environnement. Les 90 sont
 * des conséquences d'une seule cause : le client Prisma n'est pas généré
 * (`npx prisma generate` échoue sur binaries.prisma.sh, hors des hôtes autorisés).
 * Le stub `node_modules/.prisma/client` ne déclare ni `Prisma.TransactionClient`,
 * ni `$queryRaw`, ni `$transaction` :
 *
 *   - `tx: Prisma.TransactionClient` devient un type d'erreur, donc le paramètre
 *     de `products.map(...)` retombe en `unknown`  → TS2339 ;
 *   - `prisma.$transaction(...)` n'est pas typé, donc `withTracefabUserContext`
 *     renvoie `Promise<any>`, donc `documents` vaut `any`, donc
 *     `documents.reduce<Record<string, number>>` lève TS2347.
 *
 * Les deux mécanismes ont été vérifiés par expérience : donner à `tx` un
 * `$queryRaw<R>` correctement typé fait disparaître les quatre TS2339 de
 * `catalog/audit-export.ts:63` ; et `reduce<T>` sur un tableau typé ne produit
 * aucune erreur, là où le même appel sur un `any` produit exactement TS2347.
 *
 * Conclusion : il n'y a rien à corriger dans le code. En revanche, 90 lignes de
 * bruit noient toute erreur nouvelle — `tsc` ne protège plus de rien. Ce test
 * fige l'ensemble connu et échoue dès qu'il bouge.
 *
 *   npm run test:typecheck:baseline          vérifie
 *   npm run test:typecheck:baseline -- --write   régénère la baseline
 *
 * La clé d'une erreur est `fichier | code | message`, SANS numéro de ligne :
 * ajouter une ligne en tête d'un fichier décalerait toutes les positions et
 * ferait échouer le test sans qu'aucune erreur n'ait changé. Les occurrences
 * sont comptées, donc deux erreurs identiques dans un même fichier restent
 * distinguables.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const BASELINE = new URL('scripts/typecheck-baseline.json', root);
const write = process.argv.includes('--write');

/** Lance tsc et renvoie sa sortie brute. Un échec de tsc est le cas nominal. */
function runTypecheck() {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'api:typecheck'], { cwd: root.pathname, stdio: 'pipe' });
    let out = '';
    child.stdout?.on('data', (c) => { out += c; });
    child.stderr?.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const { code, out } = await runTypecheck();

/*
 * Garde-fou : un `tsc` introuvable sort en 127 sans aucune ligne « error TS »,
 * ce qui se lirait comme « zéro erreur ». Ce piège s'est déjà produit.
 */
if (code === 127 || /tsc: not found|command not found/i.test(out)) {
  console.error('  FAIL  tsc n’a pas pu s’exécuter — le résultat ne prouve rien');
  process.exit(1);
}
if (!existsSync(new URL('node_modules/typescript/package.json', root))) {
  console.error('  FAIL  typescript n’est pas installé (node_modules absent ?) — lancer npm ci');
  process.exit(1);
}

/** `api/x.ts(12,5): error TS2339: message` → `api/x.ts | TS2339 | message` */
const parse = (text) => {
  const counts = new Map();
  for (const line of text.split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line.trim());
    if (!m) continue;
    /*
     * Les messages de tsc contiennent des chemins absolus
     * (`/home/x/Tracefab/node_modules/.prisma/...`). Sans normalisation, la
     * baseline ne serait valable que sur la machine qui l'a produite.
     */
    const message = m[5].replaceAll(root.pathname.replace(/\/$/, ''), '<root>');
    const key = `${m[1]} | ${m[4]} | ${message}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
};

/*
 * LE CLIENT PEUT ÊTRE GÉNÉRÉ, OU PAS — ET LE TEST DOIT LE SAVOIR
 *
 * Les 90 erreurs de la baseline n'existent que parce que le client Prisma est un
 * placeholder. Depuis `npm run prisma:generate:offline` il peut être généré hors
 * ligne ; `api:typecheck` remonte alors 0 erreur.
 *
 * Deux issues possibles, aucune tolérance dans les deux :
 *   - client généré  → zéro erreur exigé. Une erreur est une régression réelle,
 *     plus du bruit attribuable à un client absent.
 *   - client absent  → l'ensemble figé doit être reproduit à l'identique.
 *
 * Sans cette distinction, générer le client ferait échouer le test pour un
 * progrès — et l'assouplir pour le laisser passer retirerait toute protection.
 */
async function clientIsGenerated() {
  const { statSync } = await import('node:fs');
  try {
    const dts = new URL('node_modules/.prisma/client/index.d.ts', root);
    /* Le placeholder fait quelques dizaines d'octets ; un client typé, plusieurs
       mégaoctets. Le seuil distingue les deux sans dépendre d'une version. */
    return statSync(dts).size > 1_000_000;
  } catch {
    return false;
  }
}
const generated = await clientIsGenerated();
console.log(`  client Prisma : ${generated ? 'généré (0 erreur attendue)' : 'placeholder (baseline figée)'}`);

const current = parse(out);
const currentTotal = [...current.values()].reduce((a, b) => a + b, 0);

if (write) {
  const payload = {
    _comment:
      'Ensemble figé des erreurs de `npm run api:typecheck` lorsque le client Prisma ' +
      'n\'est PAS généré. Toutes proviennent du placeholder .prisma/client ; voir ' +
      'l\'en-tête de scripts/test_typecheck_baseline.mjs. Régénérer avec ' +
      '`npm run test:typecheck:baseline -- --write` après avoir corrigé une erreur. ' +
      'Client généré, cette baseline est ignorée : zéro erreur est alors exigé.',
    _generatedAt: new Date().toISOString(),
    _total: currentTotal,
    errors: Object.fromEntries([...current.entries()].sort()),
  };
  await writeFile(BASELINE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`  baseline écrite : ${currentTotal} erreurs dans scripts/typecheck-baseline.json`);
  process.exit(0);
}

let checks = 0;
let failures = 0;
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const bad = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d}`); };
const assert = (c, l, d) => (c ? ok(l) : bad(l, d ?? 'assertion failed'));

console.log('\nA. Le typage s’exécute réellement');
/*
 * « Il y a des erreurs » n'est une preuve que lorsque le client est absent :
 * c'est ce qui garantit que tsc a vraiment analysé l'API. Client généré, c'est
 * l'inverse qu'on exige — et la preuve que tsc a tourné vient alors du fait que
 * la commande s'est exécutée sans erreur de lancement.
 */
if (generated) {
  assert(
    currentTotal === 0,
    'client généré : le typage de l’API ne remonte aucune erreur',
    `${currentTotal} erreur(s) — avec un client généré, ce sont de vraies régressions :\n        ` +
      [...current.keys()].slice(0, 8).join('\n        '),
  );
} else {
  assert(currentTotal > 0, `tsc a produit des erreurs analysables (${currentTotal})`, 'sortie vide : le test ne prouverait rien');
}
assert(
  /\bnpx tsc\b|\btsc --noEmit\b/.test(out) || currentTotal > 0 || generated,
  'la commande de typage est bien celle du dépôt',
);

if (generated) {
  console.log('\nB–D. Baseline sans objet : le client est généré, zéro erreur est déjà exigé en A.');
  console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
  process.exit(failures === 0 ? 0 : 1);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
} catch (error) {
  bad('la baseline est lisible', String(error.message));
  console.log(`\nÉCHEC — ${checks - failures}/${checks} vérifications`);
  process.exit(1);
}
const expected = new Map(Object.entries(baseline.errors));
const expectedTotal = [...expected.values()].reduce((a, b) => a + b, 0);

console.log('\nB. Aucune erreur nouvelle');
const appeared = [...current.entries()].filter(([k, n]) => (expected.get(k) || 0) < n);
assert(
  appeared.length === 0,
  'aucune erreur de typage n’est apparue depuis la baseline',
  appeared.map(([k, n]) => `${k} (x${n})`).join('\n        '),
);

console.log('\nC. Aucune erreur n’a disparu sans mise à jour de la baseline');
const vanished = [...expected.entries()].filter(([k, n]) => (current.get(k) || 0) < n);
assert(
  vanished.length === 0,
  'l’ensemble connu est toujours reproduit à l’identique',
  `${vanished.length} entrée(s) ont disparu — la baseline masque peut-être un progrès réel. ` +
    'Vérifier puis régénérer avec --write.\n        ' +
    vanished.slice(0, 8).map(([k]) => k).join('\n        '),
);

console.log('\nD. Cohérence de la baseline');
assert(
  baseline._total === expectedTotal,
  `le total déclaré (${baseline._total}) correspond au contenu (${expectedTotal})`,
);
assert(
  expectedTotal === currentTotal,
  `le total courant (${currentTotal}) correspond à la baseline (${expectedTotal})`,
);
assert(
  [...current.keys()].every((k) => k.startsWith('api/')),
  'toutes les erreurs portent sur api/ (le périmètre de api:typecheck)',
);

/* La cause doit rester identifiable : si un jour prisma generate réussit,
   la quasi-totalité disparaît et il faut le voir, pas le laisser passer. */
const prismaLinked = [...expected.keys()].filter((k) =>
  /Prisma|@prisma\/client|type 'unknown'|Untyped function calls/.test(k),
).length;
assert(
  prismaLinked === expected.size,
  `les ${expected.size} erreurs connues sont toutes rattachées au client Prisma absent`,
  `${expected.size - prismaLinked} entrée(s) ne le sont pas — les examiner une par une`,
);

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
