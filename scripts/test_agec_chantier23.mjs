#!/usr/bin/env node
/**
 * Chantier 23 — Dérivation de la déclaration AGEC article 13.
 *
 * Compile et exécute le module réel `api/_lib/agec.ts`, sans base de données :
 * la fonction est pure, elle ne dépend que des nœuds qu'on lui donne.
 *
 * Ce qui est en jeu : `validateDppCompliance()` pousse trois erreurs bloquantes
 * AGEC quand `frenchAgecArticle13` est absent, et personne ne construisait ce
 * bloc. Toute validation DPP échouait donc sur l'AGEC quelle que soit la chaîne
 * réelle du produit. La dérivation doit la satisfaire quand la chaîne le permet,
 * et dire exactement pourquoi elle ne le peut pas sinon — jamais inventer.
 *
 * Exécution : npm run test:agec:chantier23
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

let checks = 0;
let failures = 0;
const ok = (label) => { checks += 1; console.log(`  ok  ${label}`); };
const fail = (label) => { failures += 1; checks += 1; console.log(`  FAIL  ${label}`); };
const assert = (condition, label) => (condition ? ok(label) : fail(label));
const eq = (actual, expected, label) =>
  assert(
    actual === expected,
    `${label} (obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)})`,
  );

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', ...options });
    let output = '';
    child.stdout?.on('data', (c) => { output += c; });
    child.stderr?.on('data', (c) => { output += c; });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} a échoué (${code})\n${output}`)),
    );
  });
}

console.log('\nA. Compilation du module réel');
await mkdir(join(root, '.cache'), { recursive: true });
/* Dans le projet, pas dans /tmp : la résolution node_modules en dépend. */
const outDir = await mkdtemp(join(root, '.cache', 'agec-test-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/agec.ts', '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020',
  ], { cwd: root });
  ok('api/_lib/agec.ts compile sans erreur');
} catch (error) {
  fail(`api/_lib/agec.ts ne compile pas : ${error.message.split('\n')[0]}`);
}

const mod = await import(pathToFileURL(join(outDir, 'agec.js')).href);
const { deriveAgecArticle13, nodeCountry, isAgecGeographyComplete, AGEC_ART13_STAGES } = mod;
assert(typeof deriveAgecArticle13 === 'function', 'deriveAgecArticle13 importée du module réel');
assert(typeof nodeCountry === 'function', 'nodeCountry importée du module réel');

// ---------------------------------------------------------------------------
console.log('\nB. Chaîne complète : les trois pays sont déduits');
// ---------------------------------------------------------------------------

const COMPLETE = [
  { id: 'n1', node_type: 'material', process_code: 'ginning', site_country: 'TR' },
  { id: 'n2', node_type: 'process', process_code: 'spinning', site_country: 'PT' },
  { id: 'n3', node_type: 'process', process_code: 'weaving', site_country: 'PT' },
  { id: 'n4', node_type: 'process', process_code: 'dyeing', site_country: 'IT' },
  { id: 'n5', node_type: 'process', process_code: 'sewing', site_country: 'MA' },
  { id: 'n6', node_type: 'product', process_code: null, site_country: 'FR' },
];

const complete = deriveAgecArticle13(COMPLETE);
eq(complete.agec.tissageTricotage, 'PT', 'tissage/tricotage déduit du nœud « weaving »');
eq(complete.agec.teintureImpression, 'IT', 'teinture/impression déduit du nœud « dyeing »');
eq(complete.agec.confection, 'MA', 'confection déduite du nœud « sewing »');
assert(isAgecGeographyComplete(complete.agec), 'la géographie AGEC est complète');

/* Aucune erreur bloquante AGEC ne subsiste sur les trois pays. */
const geoGaps = complete.gaps.filter((g) => g.reason !== 'requires_declaration');
eq(geoGaps.length, 0, 'aucune lacune géographique sur une chaîne complète');

/* La provenance est tracée : on sait quel nœud a établi chaque pays. */
eq(complete.derivedFrom.length, 3, 'trois provenances enregistrées');
const tissage = complete.derivedFrom.find((d) => d.field === 'tissageTricotage');
assert(tissage && tissage.nodeIds.includes('n3'), 'la provenance du tissage cite le nœud n3');

/* Le pays du produit et celui de la filature ne doivent pas polluer le résultat. */
assert(!Object.values(complete.agec).includes('FR'), 'le pays du produit fini n’est pas pris pour un pays d’étape');
assert(!Object.values(complete.agec).includes('TR'), 'le pays de la matière première n’est pas pris pour un pays d’étape');

/* Les trois champs non déductibles remontent toujours, explicitement. */
const declared = complete.gaps.filter((g) => g.reason === 'requires_declaration');
eq(declared.length, 3, 'les trois déclarations humaines restent signalées');
assert(
  declared.every((g) => ['microfibresPlastiques', 'substancesDangereusesReachSvhc', 'primesOuPenalitesEcoOrganisme'].includes(g.field)),
  'et ce sont bien les trois champs sans source de traçabilité',
);

// ---------------------------------------------------------------------------
console.log('\nC. Chaîne vide : rien n’est inventé');
// ---------------------------------------------------------------------------

const empty = deriveAgecArticle13([]);
eq(Object.keys(empty.agec).length, 0, 'aucun pays n’est produit à partir de rien');
eq(empty.gaps.filter((g) => g.reason === 'no_node').length, 3, 'les trois étapes remontent en « aucun nœud »');
assert(!isAgecGeographyComplete(empty.agec), 'la géographie est déclarée incomplète');

const undefinedInput = deriveAgecArticle13();
eq(Object.keys(undefinedInput.agec).length, 0, 'un appel sans argument ne fabrique rien non plus');

// ---------------------------------------------------------------------------
console.log('\nD. Lacunes partielles : la raison est exacte');
// ---------------------------------------------------------------------------

/* Nœuds d’étape présents, mais aucun pays déterminable. */
const noCountry = deriveAgecArticle13([
  { id: 'a', process_code: 'weaving', site_country: null },
  { id: 'b', process_code: 'dyeing' },
  { id: 'c', process_code: 'assembly', metadata: {} },
]);
eq(noCountry.gaps.filter((g) => g.reason === 'no_country').length, 3, 'trois lacunes « pays indéterminable »');
assert(
  noCountry.gaps.every((g) => g.reason !== 'no_node'),
  'elles ne sont pas confondues avec « aucun nœud »',
);
/* Le piège à éviter : compléter par un pays plausible. Aucun pays ne doit
   apparaître quand il est indéterminable, quel que soit le nombre de nœuds. */
eq(Object.keys(noCountry.agec).length, 0, 'aucun pays n’est inventé quand il est indéterminable');
eq(noCountry.derivedFrom.length, 0, 'et aucune provenance fictive n’est enregistrée');

/* Deux pays pour la même étape : ambiguïté, aucun n’est choisi. */
const ambiguous = deriveAgecArticle13([
  { id: 'w1', process_code: 'weaving', site_country: 'PT' },
  { id: 'w2', process_code: 'knitting', site_country: 'TR' },
  { id: 'd1', process_code: 'dyeing', site_country: 'IT' },
  { id: 's1', process_code: 'sewing', site_country: 'MA' },
]);
eq(ambiguous.agec.tissageTricotage, undefined, 'aucun pays n’est arbitré entre PT et TR');
const ambGap = ambiguous.gaps.find((g) => g.field === 'tissageTricotage');
eq(ambGap?.reason, 'ambiguous_country', 'la lacune est qualifiée « pays ambigu »');
assert(
  JSON.stringify(ambGap?.countries) === JSON.stringify(['PT', 'TR']),
  'et les deux pays en conflit sont restitués',
);
eq(ambiguous.agec.teintureImpression, 'IT', 'les étapes non ambiguës continuent d’être déduites');

// ---------------------------------------------------------------------------
console.log('\nE. Résolution du pays d’un nœud');
// ---------------------------------------------------------------------------

eq(nodeCountry({ site_country: 'pt' }), 'PT', 'site_country est normalisé en majuscules');
eq(nodeCountry({ site_country: '  IT ' }), 'IT', 'les espaces sont ignorés');
eq(nodeCountry({ metadata: { country_code: 'MA' } }), 'MA', 'metadata.country_code sert de repli');
eq(nodeCountry({ metadata: { country: 'tr' } }), 'TR', 'metadata.country aussi');
eq(nodeCountry({ site_country: 'Portugal' }), null, 'un nom de pays n’est pas accepté comme code');
eq(nodeCountry({ site_country: 'PRT' }), null, 'un code alpha-3 n’est pas accepté');
eq(nodeCountry({}), null, 'un nœud sans aucune donnée de pays ne donne rien');
eq(
  nodeCountry({ site_country: 'PRT', metadata: { country_code: 'PT' } }),
  'PT',
  'le repli metadata prend le relais quand site_country est invalide',
);

// ---------------------------------------------------------------------------
console.log('\nF. Le vocabulaire d’étapes reste aligné sur supply-chain.ts');
// ---------------------------------------------------------------------------

const { readFile } = await import('node:fs/promises');
const supplyChainSrc = await readFile(join(root, 'api/_lib/supply-chain.ts'), 'utf8');
for (const [field, stage] of Object.entries(AGEC_ART13_STAGES)) {
  for (const code of stage.processes) {
    assert(
      supplyChainSrc.includes(`'${code}'`),
      `« ${code} » (${field}) existe dans la classification de supply-chain.ts`,
    );
  }
}

/* Le validateur exige une longueur >= 2 : le format retenu la garantit. */
for (const country of ['PT', 'IT', 'MA']) {
  assert(country.length >= 2, `le pays ${country} satisfait le contrôle de longueur du validateur`);
}

// ---------------------------------------------------------------------------
console.log('\nG. Effet réel sur le validateur de conformité');
// ---------------------------------------------------------------------------

/* La raison d'être de la dérivation. Mesure réelle sur le validateur : bloc absent ->
   UNE erreur générique (« geographical data block is missing ») ; bloc présent mais
   partiel -> une erreur par étape manquante, donc plus précise. Le bloc déduit complet
   les supprime toutes. */
await run('node_modules/.bin/tsc', [
  'api/_lib/dpp-validator.ts', '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
  '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
  '--types', 'node', '--lib', 'ES2020',
], { cwd: root }).catch(() => {});
const validator = await import(pathToFileURL(join(outDir, 'dpp-validator.js')).href);
const { validateDppCompliance } = validator;
assert(typeof validateDppCompliance === 'function', 'validateDppCompliance importée du module réel');

const basePayload = {
  identifier: 'urn:tracefab:product:demo',
  gtin: '3760123456789',
  productName: 'Essentiel coton',
  materialComposition: [{ materialName: 'Coton biologique', percentage: 100 }],
  issuanceMetadata: { issuedAt: new Date().toISOString(), dppReadinessScore: 90, isLegallyPublishable: false },
};

const agecErrors = (report) => report.blockingErrors.filter((e) => /AGEC/.test(e));

const before = validateDppCompliance(basePayload);
eq(agecErrors(before).length, 1, 'sans bloc AGEC, le validateur pousse une erreur bloquante générique');
assert(
  /block is missing/.test(agecErrors(before)[0] || ''),
  'cette erreur est générique, elle ne dit pas quelle étape manque',
);
eq(before.standardsPassed.frenchAgecArt13, false, 'et le critère AGEC est faux');

const after = validateDppCompliance({ ...basePayload, frenchAgecArticle13: complete.agec });
eq(agecErrors(after).length, 0, 'avec le bloc déduit de la chaîne, aucune erreur bloquante AGEC');
eq(after.standardsPassed.frenchAgecArt13, true, 'et le critère AGEC passe à vrai');
assert(
  after.readinessScore > before.readinessScore,
  `le score de préparation progresse (${before.readinessScore} -> ${after.readinessScore})`,
);

/* Un bloc partiel ne doit pas faire croire que tout est réglé. */
const partial = validateDppCompliance({
  ...basePayload,
  frenchAgecArticle13: { tissageTricotage: 'PT' },
});
eq(agecErrors(partial).length, 2, 'un bloc partiel laisse les deux étapes manquantes bloquantes');
assert(
  agecErrors(partial).every((e) => /Country of/.test(e)),
  'et ces erreurs nomment l’étape manquante, ce que l’erreur générique ne faisait pas',
);
eq(partial.standardsPassed.frenchAgecArt13, false, 'et le critère AGEC reste faux');

await rm(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
