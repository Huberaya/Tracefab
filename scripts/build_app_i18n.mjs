/* ==========================================================================
   TRACEFAB — consolidation i18n des applications

   Avant : trois catalogues concurrents.
     - assets/i18n/            549 cles, consomme par la landing et product-intelligence
     - brandTranslations       dictionnaire inline de brand-console  (7 langues)
     - translations            dictionnaire inline de supplier-portal (7 langues produit)
     - dppLangs                dictionnaire inline de dpp/index.html

   Apres : un seul catalogue, assets/i18n/, servi par le runtime
   assets/js/tf-i18n.js deja utilise par la landing.

   Choix de nommage : les noms de cles d'origine sont CONSERVES et seulement
   prefixes par une portee. Les ~700 sites d'appel des SPA restent donc
   inchanges, seul le resolveur change. C'est ce qui rend la migration sure.

     shared.*   29 libelles de statut + 5 libelles communs
     console.*  18 cles propres a la console + 3 cles de meme nom mais de
                valeur differente de celle du portail
     portal.*   18 cles propres au portail + les 3 memes

   Les trois cles homonymes a valeur divergente (materials, quality,
   documents) sont la raison d'etre des portees : « Materials » cote marque
   est « Materials & Yarns » cote fournisseur. Les fusionner aurait
   silencieusement change la copie d'une des deux applications.

   Usage : node scripts/build_app_i18n.mjs [--check]
     --check  n'ecrit rien, signale seulement les ecarts (utilisable en CI)
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const I18N = join(ROOT, 'assets/i18n');

/* -- 1. extraction des dictionnaires inline ------------------------------ */
function extractBlock(src, varName) {
  const m = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`).exec(src);
  if (!m) return null;
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}

function parseLangs(block) {
  const out = {};
  const langRe = /\n\s{0,16}([a-z]{2})\s*:\s*\{/g;
  let m;
  while ((m = langRe.exec(block))) {
    const lang = m[1];
    const i = block.indexOf('{', m.index);
    let depth = 0, body = '';
    for (let j = i; j < block.length; j++) {
      if (block[j] === '{') depth++;
      else if (block[j] === '}' && --depth === 0) { body = block.slice(i + 1, j); break; }
    }
    out[lang] = {};
    const kvRe = /(\w+)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let kv;
    while ((kv = kvRe.exec(body))) out[lang][kv[1]] = kv[2].replace(/\\"/g, '"');
  }
  return out;
}

const consoleSrc = readFileSync(join(ROOT, 'brand-console/index.html'), 'utf8');
const portalSrc = readFileSync(join(ROOT, 'supplier-portal/index.html'), 'utf8');
const C = parseLangs(extractBlock(consoleSrc, 'brandTranslations') || '{}');
const P = parseLangs(extractBlock(portalSrc, 'translations') || '{}');

if (!C.en || !P.en) {
  console.error('  Dictionnaires inline introuvables. Les SPA ont-elles deja ete migrees ?');
  console.error('  Ce script lit la source d origine ; une fois la migration faite il');
  console.error('  n a plus rien a extraire, ce qui est le comportement attendu.');
  process.exit(CHECK ? 0 : 1);
}

/* -- 2. complements historiques : 30 cles portugaises ajoutees au bundle.
   Chantier 15 : tr/zh ne sont plus des langues produit. ------------------- */
const FILL = {
  pt: {
    demoUnavailable: 'Indisponível no modo de demonstração — conecte as APIs TRACEFAB para executar esta ação.',
    stAcknowledged: 'Reconhecida', stActive: 'Ativo', stApproved: 'Aprovada',
    stAvailable: 'Disponível', stCancelled: 'Cancelada', stChangesRequested: 'Correções solicitadas',
    stCompleted: 'Concluída', stDataReady: 'Pronto para validação', stDeclared: 'Declarado',
    stDeleted: 'Eliminado', stDocumented: 'Documentado', stDraft: 'Rascunho',
    stInProgress: 'Em curso', stInvited: 'Convidado', stNeedsReview: 'A rever',
    stNotStarted: 'Não iniciado', stOpen: 'Aberta', stReadyToPublish: 'Pronto para publicar',
    stRejected: 'Rejeitada', stResolved: 'Resolvida', stReviewRequired: 'Revisão necessária',
    stRevoked: 'Revogado', stScanning: 'A analisar', stSent: 'Enviada',
    stSubmitted: 'Submetida', stSuspended: 'Suspenso', stUploaded: 'Guardado',
    stVerified: 'Verificada', stWaived: 'Derrogação',
  },
};

/* -- 3. repartition en portees ------------------------------------------- */
const kc = Object.keys(C.en), kp = Object.keys(P.en);
const common = kc.filter((k) => kp.includes(k));
const divergent = common.filter((k) => C.en[k] !== P.en[k]);
const sharedKeys = common.filter((k) => !divergent.includes(k));
const consoleKeys = kc.filter((k) => !sharedKeys.includes(k));
const portalKeys = kp.filter((k) => !sharedKeys.includes(k));

/* Chantier 15 — tr et zh retirees du produit (locales a 16 %, jamais
   completees : les proposer aurait fait passer du francais ou de
   l anglais pour du turc ou du chinois). */
const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const gaps = [];

function valueFor(dict, lang, key) {
  if (dict[lang] && dict[lang][key] != null) return dict[lang][key];
  if (FILL[lang] && FILL[lang][key] != null) return FILL[lang][key];
  return null;
}

const built = {};
for (const lang of LANGS) {
  const shared = {}, cons = {}, port = {};
  for (const k of sharedKeys) {
    const v = valueFor(C, lang, k) ?? valueFor(P, lang, k);
    if (v != null) shared[k] = v; else gaps.push(`${lang} shared.${k}`);
  }
  for (const k of consoleKeys) {
    const v = valueFor(C, lang, k);
    if (v != null) cons[k] = v; else if (C.en[k] != null) gaps.push(`${lang} console.${k}`);
  }
  for (const k of portalKeys) {
    const v = valueFor(P, lang, k);
    if (v != null) port[k] = v; else if (P.en[k] != null) gaps.push(`${lang} portal.${k}`);
  }
  built[lang] = { shared, console: cons, portal: port };
}

/* -- 4. rapport ----------------------------------------------------------- */
console.log(`  cles de statut et communes : ${sharedKeys.length}`);
console.log(`  cles console               : ${consoleKeys.length}  (dont ${divergent.length} homonymes divergents)`);
console.log(`  cles portail               : ${portalKeys.length}  (dont ${divergent.length} homonymes divergents)`);
console.log(`  homonymes a valeur divergente, separes a dessein : ${divergent.join(', ')}`);
console.log(`  langues produites          : ${LANGS.join(', ')}`);
for (const lang of LANGS) {
  const b = built[lang];
  const n = Object.keys(b.shared).length + Object.keys(b.console).length + Object.keys(b.portal).length;
  console.log(`    ${lang}: ${n} cles`);
}
if (gaps.length) {
  console.log(`\n  ${gaps.length} traduction(s) encore absente(s) — repli anglais a l execution :`);
  for (const g of gaps.slice(0, 20)) console.log(`      ${g}`);
  if (gaps.length > 20) console.log(`      … et ${gaps.length - 20} autres`);
} else {
  console.log('\n  aucune traduction manquante.');
}

if (CHECK) {
  console.log('\n  --check : aucun fichier ecrit.');
  process.exit(0);
}

/* -- 5. ecriture ---------------------------------------------------------- */
// en.js : insertion des trois portees avant l accolade finale
const enPath = join(I18N, 'en.js');
let enSrc = readFileSync(enPath, 'utf8');
if (/^\s*(shared|console|portal):/m.test(enSrc)) {
  console.log('\n  en.js contient deja les portees applicatives — reecriture.');
  // Le lookahead (?=\n\};) bornait la suppression a la fin de TOUT l'objet :
  // le [\s\S]*? paresseux avalait donc chaque racine situee apres celle-ci.
  // Tant que cette portee etait la derniere du catalogue, le resultat etait
  // juste par accident. On borne desormais sur la fermeture de la portee
  // elle-meme (accolade a 2 espaces), ce qui est independant de sa position.
  // Cette portee en contient trois : on va jusqu'a la fermeture de 'portal'.
  enSrc = enSrc.replace(/,?\n\n  \/\/ --- portees applicatives[\s\S]*?\n  portal: \{[\s\S]*?\n  \}/, '');
}
const fmt = (o, ind) => Object.entries(o)
  .map(([k, v]) => `${ind}${k}: ${JSON.stringify(v)}`).join(',\n');
const enBlock = `,\n\n  // --- portees applicatives (console, portail, DPP public) ---------------\n` +
  `  shared: {\n${fmt(built.en.shared, '    ')}\n  },\n\n` +
  `  console: {\n${fmt(built.en.console, '    ')}\n  },\n\n` +
  `  portal: {\n${fmt(built.en.portal, '    ')}\n  }`;
enSrc = enSrc.replace(/\n\};\s*$/, `${enBlock}\n};\n`);
writeFileSync(enPath, enSrc);
console.log(`\n  ecrit  assets/i18n/en.js`);

for (const lang of LANGS) {
  if (lang === 'en') continue;
  const p = join(I18N, `${lang}.json`);
  const base = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  base.shared = built[lang].shared;
  base.console = built[lang].console;
  base.portal = built[lang].portal;
  writeFileSync(p, JSON.stringify(base, null, 2) + '\n');
  console.log(`  ecrit  assets/i18n/${lang}.json`);
}
