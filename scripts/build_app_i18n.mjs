/* ==========================================================================
   TRACEFAB — consolidation i18n des applications

   Avant : trois catalogues concurrents.
     - assets/i18n/            549 cles, consomme par la landing et product-intelligence
     - brandTranslations       dictionnaire inline de brand-console  (7 langues)
     - translations            dictionnaire inline de supplier-portal (9 langues)
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

/* -- 2. complements de traduction (les 30 cles absentes de pt, tr, zh) --- */
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
  tr: {
    demoUnavailable: 'Demo modunda kullanılamaz — bu işlemi çalıştırmak için TRACEFAB API\'lerini bağlayın.',
    stAcknowledged: 'Bilgi alındı', stActive: 'Aktif', stApproved: 'Onaylandı',
    stAvailable: 'Mevcut', stCancelled: 'İptal edildi', stChangesRequested: 'Değişiklik talep edildi',
    stCompleted: 'Tamamlandı', stDataReady: 'Doğrulamaya hazır', stDeclared: 'Beyan edildi',
    stDeleted: 'Silindi', stDocumented: 'Belgelendi', stDraft: 'Taslak',
    stInProgress: 'Devam ediyor', stInvited: 'Davet edildi', stNeedsReview: 'Gözden geçirilmeli',
    stNotStarted: 'Başlanmadı', stOpen: 'Açık', stReadyToPublish: 'Yayına hazır',
    stRejected: 'Reddedildi', stResolved: 'Çözüldü', stReviewRequired: 'İnceleme gerekli',
    stRevoked: 'Geri alındı', stScanning: 'Taranıyor', stSent: 'Gönderildi',
    stSubmitted: 'Teslim edildi', stSuspended: 'Askıya alındı', stUploaded: 'Kaydedildi',
    stVerified: 'Doğrulandı', stWaived: 'Muafiyet',
  },
  zh: {
    demoUnavailable: '演示模式下不可用 — 请连接 TRACEFAB API 以执行此操作。',
    stAcknowledged: '已确认接收', stActive: '启用', stApproved: '已批准',
    stAvailable: '可用', stCancelled: '已取消', stChangesRequested: '需修改',
    stCompleted: '已完成', stDataReady: '待验证', stDeclared: '已申报',
    stDeleted: '已删除', stDocumented: '已存档', stDraft: '草稿',
    stInProgress: '进行中', stInvited: '已邀请', stNeedsReview: '待复核',
    stNotStarted: '未开始', stOpen: '待处理', stReadyToPublish: '可发布',
    stRejected: '已拒绝', stResolved: '已解决', stReviewRequired: '需审核',
    stRevoked: '已撤销', stScanning: '扫描中', stSent: '已发送',
    stSubmitted: '已提交', stSuspended: '已暂停', stUploaded: '已保存',
    stVerified: '已验证', stWaived: '已豁免',
  },
};

/* -- 3. repartition en portees ------------------------------------------- */
const kc = Object.keys(C.en), kp = Object.keys(P.en);
const common = kc.filter((k) => kp.includes(k));
const divergent = common.filter((k) => C.en[k] !== P.en[k]);
const sharedKeys = common.filter((k) => !divergent.includes(k));
const consoleKeys = kc.filter((k) => !sharedKeys.includes(k));
const portalKeys = kp.filter((k) => !sharedKeys.includes(k));

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'tr', 'zh'];
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
  enSrc = enSrc.replace(/,?\n\n  \/\/ --- portees applicatives[\s\S]*?(?=\n\};)/, '');
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
