/**
 * Les droits du runtime sont DERIVES de ses appels, pas declares a part.
 *
 * ── LE PROBLEME QUE CE MODULE RESOUT ────────────────────────────────────────
 *
 * Plusieurs suites du depot verifient qu'un role ne peut executer que ce dont il
 * a besoin. Chacune le fait en comparant les privileges reels a une LISTE.
 * Une liste tenue a la main est exactement le mecanisme qui a laisse passer le
 * defaut P10.7 : les treize operations systeme etaient PRESENTES dans la liste,
 * donc personne ne regardait ce que les fonctions FAISAIENT. La reponse n'est
 * pas d'ajouter trois noms a trois endroits — c'est de faire dire la liste par
 * le code.
 *
 * ── CE QUE LE DEPOT FAISAIT DEJA, ET QUI SUFFISAIT PRESQUE ──────────────────
 *
 * `scripts/lib/tracefab_runtime_functions.mjs` derive deja deux des trois
 * listes :
 *
 *     API_RUNTIME_FUNCTION_NAMES         <- appels SQL directs dans api/
 *     RLS_POLICY_FUNCTION_NAMES          <- fonctions citees par les politiques RLS
 *     RUNTIME_FUNCTION_DEPENDENCY_NAMES  <- liste ecrite A LA MAIN
 *
 * La troisieme est la porte ouverte : une fonction que l'application appelle
 * n'est vue par aucune derivation des qu'elle n'apparait pas telle quelle dans
 * le code — par exemple parce qu'elle est atteinte par un wrapper.
 *
 * ── LE CAS MESURE (2026-11-05) ──────────────────────────────────────────────
 *
 * `api/_lib/identite-systeme.ts` signe un jeton avec `signerIdentiteSysteme()`,
 * et la route de readiness le fait VERIFIER par la base. Or la verification est
 * ecrite comme un appel qualifie (`public.tracefab_..._jeton_valide($1)`), forme
 * qu'une extraction par prefixe de mot ne retient pas. Deux consequences
 * opposees selon la liste :
 *
 *   - `API_RUNTIME_FUNCTION_NAMES` ne voyait pas la verification
 *     (mesure : `attendues=81 ; observees=82`) ;
 *   - et pourtant la base l'accordait, parce que la readiness l'appelle.
 *
 * Le meme ecart, dans l'autre sens, expliquait la sonde d'exploitation
 * `tracefab_sec_probe_identite_systeme` : inscrite au registre runtime — donc
 * un droit du runtime — alors que l'application ne l'appelle jamais.
 *
 * ── CE QUE CE MODULE VÉRIFIE ────────────────────────────────────────────────
 *
 * Il ne compare pas a une nouvelle liste. Il exige que les trois listes soient
 * DERIVABLES, et refuse tout nom qui n'a pas de source :
 *
 *   R1  chaque nom de API_RUNTIME_FUNCTION_NAMES est cite par un appel dans api/
 *   R2  chaque nom de RLS_POLICY_FUNCTION_NAMES est cite par une politique
 *   R3  chaque nom de RUNTIME_FUNCTION_DEPENDENCY_NAMES est cite par un appel de
 *       api/ ou par un corps de fonction — une dependance sans source est un
 *       droit sans usage
 *   R4  la sonde d'exploitation n'est un droit du runtime dans AUCUNE des trois
 *       listes : c'est un outil d'exploitation, pas un appel applicatif
 *   R5  les deux fonctions de verification systeme sont citees par le code
 *       applicatif, sinon la base les accorderait sans usage
 *
 * R4 et R5 sont les deux assertions qui auraient refuse la version du 05/11.
 * Elles ne nomment aucun fichier de migration : elles parlent du CODE, et
 * tiennent donc pour toute correction future.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_RUNTIME_FUNCTION_NAMES,
  RLS_POLICY_FUNCTION_NAMES,
  RUNTIME_FUNCTION_DEPENDENCY_NAMES,
  RUNTIME_FUNCTION_NAMES,
} from './tracefab_runtime_functions.mjs';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOSSIER_MIGRATIONS = path.join(RACINE, 'prisma', 'migrations');

/**
 * Extraction des appels SQL.
 *
 * Le prefixe `public.` est ACCEPTE — c'est la forme employee par les appels
 * `$queryRaw` qui qualifient leur fonction, et c'est precisement celle qui
 * echappait a l'extraction historique. On ne retient que les suites de
 * minuscules suivies d'une parenthese : `tracefab_x(` et non `tracefab_x`,
 * pour ne pas confondre un nom de table, de colonne ou de variable.
 */
const APPEL = /(?:\bpublic\s*\.\s*)?\b(tracefab_[a-z0-9_]+)\s*\(/g;

const sansCommentaires = (texte) => String(texte)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

/** Fichiers TypeScript de `api/`, commentaires retires. */
function sourcesApi(dir = path.join(RACINE, 'api'), acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entree of fs.readdirSync(dir)) {
    const complet = path.join(dir, entree);
    if (fs.statSync(complet).isDirectory()) sourcesApi(complet, acc);
    else if (/\.ts$/.test(entree)) {
      acc.push({ chemin: path.relative(RACINE, complet), source: sansCommentaires(fs.readFileSync(complet, 'utf8')) });
    }
  }
  return acc;
}

const ajouter = (carte, nom, source) => {
  const cle = nom.toLowerCase();
  if (!carte.has(cle)) carte.set(cle, new Set());
  carte.get(cle).add(source);
};

/** Noms de fonctions SQL cites par chaque fichier de `api/`. */
export function nomsAppelesParApi() {
  const parNom = new Map();
  for (const { chemin, source } of sourcesApi()) {
    for (const m of source.matchAll(APPEL)) ajouter(parNom, m[1], chemin);
  }
  return parNom;
}

/**
 * Noms cites par les expressions de POLITIQUES RLS.
 *
 * C'est la definition exacte de `RLS_POLICY_FUNCTION_NAMES` : une fonction
 * utilisee dans un `USING` ou un `WITH CHECK` doit etre executable par
 * `tracefab_app`, sinon la politique echoue a l'evaluation. On lit donc les
 * blocs `CREATE POLICY ... ;` et non les corps de fonctions.
 */
export function nomsCitesParPolitiques() {
  const parNom = new Map();
  if (!fs.existsSync(DOSSIER_MIGRATIONS)) return parNom;
  for (const dossier of fs.readdirSync(DOSSIER_MIGRATIONS).sort()) {
    const fichier = path.join(DOSSIER_MIGRATIONS, dossier, 'migration.sql');
    if (!fs.existsSync(fichier)) continue;
    const sql = fs.readFileSync(fichier, 'utf8').replace(/--[^\n]*/g, '');
    for (const bloc of sql.matchAll(/CREATE\s+POLICY[\s\S]*?;/gi)) {
      for (const m of bloc[0].matchAll(APPEL)) ajouter(parNom, m[1], dossier);
    }
  }
  return parNom;
}

/** Noms cites par les CORPS de fonctions SQL, dans les migrations. */
export function nomsAppelesParCorps() {
  const parNom = new Map();
  if (!fs.existsSync(DOSSIER_MIGRATIONS)) return parNom;
  for (const dossier of fs.readdirSync(DOSSIER_MIGRATIONS).sort()) {
    const fichier = path.join(DOSSIER_MIGRATIONS, dossier, 'migration.sql');
    if (!fs.existsSync(fichier)) continue;
    const sql = fs.readFileSync(fichier, 'utf8').replace(/--[^\n]*/g, '');
    for (const bloc of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]*?\$[a-z_]*\$[\s\S]*?\$[a-z_]*\$/gi)) {
      for (const m of bloc[0].matchAll(APPEL)) ajouter(parNom, m[1], dossier);
    }
  }
  return parNom;
}

/** Les ecarts aux regles R1..R5, mesures sans base de donnees. */
export function ecartsSansBase() {
  const api = nomsAppelesParApi();
  const politiques = nomsCitesParPolitiques();
  const corps = nomsAppelesParCorps();
  const ecarts = [];

  for (const nom of API_RUNTIME_FUNCTION_NAMES) {
    if (!api.has(nom)) {
      ecarts.push(`R1 ${nom} : declare comme appel de l API, mais aucun appel ne le cite dans api/`);
    }
  }

  for (const nom of RLS_POLICY_FUNCTION_NAMES) {
    if (!politiques.has(nom)) {
      ecarts.push(`R2 ${nom} : declare comme fonction de politique RLS, mais aucune politique ne le cite`);
    }
  }

  for (const nom of RUNTIME_FUNCTION_DEPENDENCY_NAMES) {
    if (!api.has(nom) && !corps.has(nom)) {
      ecarts.push(`R3 ${nom} : declare comme dependance de corps, mais aucune source ne le cite`);
    }
  }

  // R4 — la sonde d'exploitation n'est un droit du runtime dans aucune liste.
  // Exprime en CODE : si elle y figure, c'est qu'elle a ete ajoutee a la main,
  // donc sans appel applicatif.
  const sonde = 'tracefab_sec_probe_identite_systeme';
  const listes = [API_RUNTIME_FUNCTION_NAMES, RLS_POLICY_FUNCTION_NAMES,
    RUNTIME_FUNCTION_DEPENDENCY_NAMES, RUNTIME_FUNCTION_NAMES];
  if (listes.some((liste) => liste.includes(sonde))) {
    ecarts.push(`R4 ${sonde} : la sonde d exploitation figure dans une allowlist runtime`);
  }

  // R5 — la VERIFICATION du jeton systeme a une source applicative. Sans elle,
  // la base l'accorderait sans usage et l'allowlist ne pourrait pas etre
  // derivee : c'etait le defaut mesure le 05/11 (`attendues=81 ; observees=82`).
  const verification = 'tracefab_identite_systeme_jeton_valide';
  if (!api.has(verification)) {
    ecarts.push(`R5 ${verification} : accordee au runtime, mais aucun fichier de api/ ne la cite`);
  }

  // R6 — le PREDICAT `tracefab_identite_systeme()` n'est PAS un droit du
  // runtime. Il est appele depuis les corps des treize operations, qui sont
  // SECURITY DEFINER : il s'execute donc avec les droits de leur proprietaire
  // (`tracefab_worker`), jamais avec ceux de `tracefab_app`. Si l'application le
  // citait directement, ce serait le signe qu'une operation systeme a ete
  // appelee hors de son point de passage — exactement le chemin que P10.7
  // ferme. On refuse donc les deux formes : citer le predicat, ou le declarer
  // comme droit.
  const predicat = 'tracefab_identite_systeme';
  if (api.has(predicat)) {
    ecarts.push(`R6 ${predicat} : le predicat est appele par api/ alors qu il ne doit l etre que dans les corps SECURITY DEFINER (${[...api.get(predicat)].join(', ')})`);
  }
  if (listes.some((liste) => liste.includes(predicat))) {
    ecarts.push(`R6 bis ${predicat} : le predicat figure dans une allowlist runtime`);
  }

  return { ecarts, api, politiques, corps };
}

/** Noms derives du CODE. Sert aux suites a base de donnees, jamais a une liste. */
export function nomsDerivesDuCode() {
  const { api, politiques, corps } = ecartsSansBase();
  return [...new Set([...api.keys(), ...politiques.keys(), ...corps.keys()])].sort();
}
