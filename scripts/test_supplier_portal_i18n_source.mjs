#!/usr/bin/env node
/**
 * TRACEFAB Supplier Portal — internationalisation, contrôlée dans le SOURCE.
 *
 * POURQUOI CE TEST EXISTE À CÔTÉ DE test:supplier-portal:i18n
 *   L'autre test monte la page et lit le TEXTE RENDU. C'est nécessaire mais pas
 *   suffisant, et la limite a coûté cher : les vues du portail (profil, sites,
 *   certificats, matériaux, équipe, documents, passeport, demande,
 *   auto-enrôlement) ne se montent qu'après un clic sur `data-view`. Leur texte
 *   n'était donc jamais rendu, jamais inspecté — et la première passe de
 *   migration a pu être déclarée « complète » avec 65 libellés encore en
 *   français dans le fichier.
 *
 *   Pire : cette même passe avait remplacé des MORCEAUX de mots, laissant la
 *   première lettre collée devant l'appel de traduction et supprimant l'espace
 *   séparatrice. Le rendu donnait « complétété », « Site actifif »,
 *   « SSomme de composition calculée :100% ». Un contrôle par mot français ne
 *   peut pas voir ça : `té`, `if`, `sé`, `S` ne sont pas des mots.
 *
 *   Ce test lit donc le fichier, pas le rendu :
 *     A. aucune lettre orpheline collée à un t() ;
 *     B. aucun texte français dans le source, hors exclusions assumées ;
 *     C. toute clé appelée par la page existe dans les neuf dictionnaires ;
 *     D. les exclusions assumées sont toujours là (elles ne doivent pas être
 *        « traduites » par erreur, et la liste ne doit pas pourrir en silence).
 *
 *   npm run test:supplier-portal:i18n-source
 */
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const at = (p) => new URL(p, root);

let failures = 0;
let checks = 0;
function ok(name) { checks++; console.log(`  ok    ${name}`); }
function bad(name, detail) { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); }
function assert(cond, name, detail = 'assertion failed') { cond ? ok(name) : bad(name, detail); }
function eq(actual, expected, name) {
  assert(actual === expected, name, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
}

const LANGUAGES = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'tr', 'zh'];
const html = await readFile(at('supplier-portal/index.html'), 'utf8');
const dictionaries = {};
for (const lang of LANGUAGES) {
  dictionaries[lang] = JSON.parse(await readFile(at(`locales/${lang}/supplier.json`), 'utf8'));
}

/**
 * Mots français à fort signal.
 *
 * Les mots courts ambigus sont EXCLUS volontairement : `et` est un verbe turc
 * (« beyan et »), `des` un article allemand, `un` un mot turc. Une liste qui
 * contient un mot des langues vérifiées produit des faux positifs, et un faux
 * positif rend le test inusable.
 */
const FRENCH_WORDS = new Set([
  'avec', 'séparateur', 'détectée', 'détectées', 'conforme', 'somme', 'composition',
  'calculée', 'enregistré', 'enregistrée', 'ajouté', 'ajoutée', 'créé', 'créée',
  'supprimé', 'supprimée', 'modifié', 'modifiée', 'aucun', 'aucune', 'veuillez',
  'saisir', 'champ', 'champs', 'obligatoire', 'requis', 'requise', 'erreur',
  'échec', 'succès', 'chargement', 'envoyer', 'annuler', 'valider', 'sélectionner',
  'téléverser', 'télécharger', 'rechercher', 'filtrer', 'trier', 'ajouter',
  'supprimer', 'modifier', 'fermer', 'ouvrir', 'masquer', 'afficher', 'terminé',
  'terminée', 'brouillon', 'certificat', 'certificats', 'matériau', 'matériaux',
  'matière', 'matières', 'fournisseur', 'fournisseurs', 'document', 'documents',
  'preuve', 'preuves', 'demande', 'demandes', 'réponse', 'réponses', 'invitation',
  'invitations', 'membre', 'membres', 'équipe', 'qualité', 'recalculer',
  'soumettre', 'soumise', 'renvoyée', 'révoquée', 'démonstration', 'profil',
  'nomenclature', 'composant', 'composants', 'statut', 'expiré', 'expirée',
  'valide', 'invalide', 'vérifié', 'vérifiée', 'résumé', 'détails', 'aperçu',
  'exporter', 'importer', 'actualiser', 'rafraîchir', 'recharger', 'connexion',
  'déconnexion', 'compte', 'paramètres', 'préférences', 'langue', 'aide',
  'avertissement', 'attention', 'opérations', 'opération', 'traitement', 'traité',
  'importation', 'exportation', 'fichier', 'fichiers', 'colonne', 'colonnes',
  'tableau', 'grille', 'recherche', 'résultat', 'résultats', 'élément',
  'éléments', 'nouveau', 'nouvelle', 'ancienne', 'précédent', 'suivant',
  'dernier', 'premier', 'temporaire', 'définitif', 'optionnel', 'optionnelle',
  'facultatif', 'facultative', 'informations', 'libellé', 'valeur', 'source',
  'description', 'commercial', 'usuel', 'lecture', 'seule', 'renvoyer',
  'révoquer', 'manquant', 'manquants', 'manquante', 'analyse', 'actifs',
  'partages', 'attente', 'étape', 'étapes', 'acquitter', 'dispense', 'signaux',
  'explicables', 'décider', 'transformés', 'certification', 'déclaratifs',
  'origine', 'naturel', 'vêtements', 'marques', 'européennes', 'couverture',
  'documentaire', 'mérite', 'revue', 'accès', 'complet', 'uniquement',
  'pourcentages', 'facture', 'rapport', 'entreprise', 'octet', 'octets',
  'disponible', 'disponibles', 'exactes', 'strict', 'publiquement', 'visible',
  'accorder', 'refuser', 'choisir', 'calculer', 'maintenant', 'reconnus',
  'impossible', 'organisation', 'cliente', 'franchie', 'franchies', 'soumission',
  'soumissions', 'nom', 'pays', 'ville', 'adresse', 'adresses', 'code',
  'postal', 'type', 'date', 'expiration', 'texte', 'nombre', 'pourcentage',
  'exemple', 'antivirus', 'lignes', 'ligne',
]);

/* ------------------------------------------------------------------ A ----- */
console.log('\nA. Aucune lettre orpheline collée à un appel de traduction');
/*
 * La première passe de migration remplaçait des morceaux de mots : la lettre
 * initiale restait devant `${t(…)}` (« SSomme… », « ÉÉchéance… ») ou la fin du
 * mot restait derrière (« complété » + « té »). L'espace séparatrice partait au
 * passage. Rendu : « complétété », « Site actifif », « :100% ».
 */
const gluedSuffix = [...html.matchAll(/\$\{t\('[a-z0-9_]+'\)\}([a-zà-ÿ]{1,6})/g)]
  .map((m) => m[0]);
assert(gluedSuffix.length === 0, 'aucun reste de mot après t()', gluedSuffix.join(' | ') || '—');

const orphanPrefix = [...html.matchAll(/([A-Za-zÀ-ÿ])\$\{t\('[a-z0-9_]+'\)\}/g)]
  .map((m) => m[0]);
assert(orphanPrefix.length === 0, 'aucune lettre orpheline avant t()', orphanPrefix.join(' | ') || '—');

/* L'espace séparatrice doit survivre : « clé » suivie directement d'une valeur. */
const noSpace = [...html.matchAll(/\$\{t\('(ui_[a-z0-9_]+)'\)\}\$\{(?:date|esc|moneyless|totalPct)/g)]
  .map((m) => m[1]);
assert(noSpace.length === 0, 'une espace sépare chaque libellé de la valeur qui le suit',
  noSpace.join(', ') || '—');

/* ------------------------------------------------------------------ B ----- */
console.log('\nB. Aucun texte français dans le source, hors exclusions assumées');

/** Découpe le source du fichier en blocs <script> inline. */
function inlineScripts(source) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

const scriptSources = inlineScripts(html);
assert(scriptSources.length >= 1, 'la page contient au moins un bloc <script> inline',
  `${scriptSources.length} bloc(s)`);

/* Une drapeau (indicateur régional) signale un endonyme de langue : non traduisible. */
const hasFlag = (s) => /[\u{1F1E6}-\u{1F1FF}]/u.test(s);

/**
 * Les runs de texte du source : chaque morceau de littéral qui n'est ni une
 * balise ni une expression `${…}`. On travaille sur la SOURCE BRUTE, pas sur
 * `node.text` : celui-ci est « cuit » (échappements résolus) et ses longueurs ne
 * correspondent pas aux positions dans le fichier.
 */
function textRuns(source) {
  const runs = [];
  const sf = ts.createSourceFile('page.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  const inDemo = (n) => {
    let c = n;
    while (c) {
      if (ts.isFunctionDeclaration(c) && c.name && /^demo/i.test(c.name.text)) return true;
      if (ts.isVariableDeclaration(c) && ts.isIdentifier(c.name) && /^demo/i.test(c.name.text)) return true;
      c = c.parent;
    }
    return false;
  };

  const walk = (node) => {
    const k = node.kind;
    const isStr = k === ts.SyntaxKind.StringLiteral
      || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
    const isTpl = k === ts.SyntaxKind.TemplateHead
      || k === ts.SyntaxKind.TemplateMiddle
      || k === ts.SyntaxKind.TemplateTail;
    if (isStr || isTpl) {
      let raw = source.slice(node.getStart(sf), node.getEnd());
      if (isStr) raw = raw.slice(1, raw.length - 1);      /* sans les guillemets */
      const demo = inDemo(node);
      /* découpe sur les balises : ce qui reste est du texte affiché */
      for (const part of raw.split(/(<[^>]*>)/)) {
        if (part.startsWith('<')) continue;
        const body = part.trim();
        if (body.length > 1) runs.push({ body, demo });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return runs;
}

const allRuns = scriptSources.flatMap(textRuns);
assert(allRuns.length > 500, 'le scan voit bien tout le source de la page',
  `${allRuns.length} runs`);

/*
 * EXCLUSIONS ASSUMÉES — chacune est une décision, pas un oubli.
 *   - demoData() : contenu de démonstration, pas du texte d'interface ;
 *   - les clés i18n : `t('ui_nom')` n'est pas du français affiché ;
 *   - les chaînes techniques : sélecteurs, chemins d'API, identifiants ;
 *   - le spec CSV : c'est un FORMAT que le serveur analyse, pas un libellé ;
 *   - les endonymes de langue : « Português » reste « Português » en chinois.
 */
const isKey = (s) => Object.prototype.hasOwnProperty.call(dictionaries.fr, s);
const TECHNICAL = /^[.#\[]/;
const isTechnical = (s) => TECHNICAL.test(s)
  || s.startsWith('/api/')
  || /^[a-zA-Z0-9_.\-:/]+$/.test(s)
  || /^[A-Z0-9_]{2,}$/.test(s)
  || /^(var|function|const|let|return|class|text\/|application\/|image\/|--)/.test(s)
  || /^[a-z]+-[a-z-]+$/.test(s)
  || s === 'use strict'                     /* directive, pas un libellé */
  || s.includes('NumeroLicence')            /* spec CSV analysé par le serveur */
  || hasFlag(s);                            /* endonymes de langue */

/**
 * Ce qui est réellement AFFICHÉ dans un run.
 *
 * Un run peut contenir des morceaux de balisage : une balise qui renferme une
 * expression `${…}` est coupée en deux par le découpage, et ses attributs se
 * retrouvent dans le « texte ». Sans ce nettoyage, `type="date"` faisait passer
 * « type » et « date » pour du français — 18 faux positifs sur 21.
 */
const visible = (s) => s
  .replace(/[a-zA-Z][a-zA-Z0-9-]*\s*=\s*"[^"]*"/g, ' ')   /* attribut complet */
  .replace(/[a-zA-Z][a-zA-Z0-9-]*\s*=\s*"?/g, ' ')         /* attribut coupé par un ${…} */
  .replace(/["']/g, ' ')                                    /* guillemets orphelins */
  .replace(/<[^>]*>?/g, ' ')                                /* balises tronquées */
  .replace(/[{}$`]/g, ' ')                                  /* restes d'expression */
  .replace(/\s+/g, ' ')
  .trim();

const accented = (s) => /[àâäéèêëîïôöùûüçœæÀÂÄÉÈÊËÎÏÔÖÙÛÜÇŒÆ]/.test(s);
const wordsOf = (s) => (s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .match(/[a-z']{2,}/g) || []);

const remaining = [];
for (const run of allRuns) {
  if (run.demo) continue;
  const body = run.body;
  if (isKey(body) || isTechnical(body)) continue;
  const shown = visible(body);
  if (!shown.includes(' ')) continue;       /* un mot isolé : voir le contrôle suivant */
  const hits = wordsOf(shown).filter((w) => FRENCH_WORDS.has(w));
  if (hits.length || accented(shown)) remaining.push({ body: shown.slice(0, 120), hits });
}
assert(remaining.length === 0, 'aucun texte français multivot ne subsiste dans le source',
  remaining.map((r) => `${r.hits.join('/')} :: ${r.body}`).join('\n        ') || '—');

/*
 * Un mot isolé peut être un libellé (« Renvoyer ») ou un identifiant (« fiber »).
 * On ne retient que ceux qui portent un accent OU qui figurent dans la liste,
 * et on exclut les valeurs d'attribut techniques.
 */
const singleRemaining = [];
for (const run of allRuns) {
  if (run.demo) continue;
  const body = run.body;
  if (isKey(body) || isTechnical(body)) continue;
  const shown = visible(body);
  if (shown.includes(' ')) continue;
  const w = shown.toLowerCase();
  if (FRENCH_WORDS.has(w) || accented(shown)) singleRemaining.push(shown);
}
assert(singleRemaining.length === 0, 'aucun libellé français d’un seul mot ne subsiste',
  singleRemaining.join(', ') || '—');

/* ------------------------------------------------------------------ C ----- */
console.log('\nC. Toute clé appelée par la page existe dans les neuf dictionnaires');

/*
 * Extraction volontairement large : `t('…')` et `t("…")`. Les clés construites
 * par concaténation sont invisibles à cette extraction — c'est une limite
 * connue, et c'est justement pourquoi la section B existe à côté.
 */
const calledKeys = new Set();
for (const m of html.matchAll(/[^A-Za-z0-9_$]t\(\s*['"]([a-zA-Z0-9_]+)['"]\s*[,)]/g)) {
  calledKeys.add(m[1]);
}
assert(calledKeys.size > 400, 'l’extraction voit un nombre plausible de clés',
  `${calledKeys.size} clés`);

const missingKeys = [];
const emptyValues = [];
for (const key of calledKeys) {
  for (const lang of LANGUAGES) {
    if (!Object.prototype.hasOwnProperty.call(dictionaries[lang], key)) {
      missingKeys.push(`${key} (${lang})`);
    } else if (!String(dictionaries[lang][key]).trim()) {
      emptyValues.push(`${key} (${lang})`);
    }
  }
}
assert(missingKeys.length === 0, 'aucune clé appelée n’est absente d’un dictionnaire',
  missingKeys.join(', ') || '—');
assert(emptyValues.length === 0, 'aucune valeur n’est vide', emptyValues.join(', ') || '—');

/* Les neuf dictionnaires doivent rester exactement parallèles. */
const refKeys = Object.keys(dictionaries.fr).sort().join('|');
const divergent = LANGUAGES.filter((l) => Object.keys(dictionaries[l]).sort().join('|') !== refKeys);
assert(divergent.length === 0, 'les neuf dictionnaires ont exactement le même jeu de clés',
  divergent.join(', ') || '—');

/* ------------------------------------------------------------------ D ----- */
console.log('\nD. Les exclusions assumées sont toujours en place');
/*
 * Si l'une d'elles disparaît, c'est soit une régression du produit, soit une
 * exclusion qui a pourri en silence et qui masque désormais du vrai texte.
 * Dans les deux cas il faut le savoir.
 */
assert(html.includes('Matiere; Pourcentage; Type; Pays; Standard; NumeroLicence; LotFournisseur'),
  'le spec CSV analysé par le serveur est intact (non traduisible par conception)');
for (const endonym of ['Français', 'Português', 'Türkçe', '中文']) {
  assert(html.includes(endonym), `l’endonyme « ${endonym} » est intact (non traduisible par conception)`);
}
assert(html.includes("'Content-Type'"),
  'l’en-tête HTTP Content-Type n’a pas été pris pour le libellé « Type »');
assert(html.includes('demoData'), 'le contenu de démonstration est toujours isolé dans demoData()');

/* ------------------------------------------------------------------------ */
console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:supplier-portal:i18n-source FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:supplier-portal:i18n-source passed — ${checks} contrôles, 0 échec.`);
