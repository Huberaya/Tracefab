#!/usr/bin/env node
/**
 * Preuve que l'audit en lecture seule ne peut pas ecrire.
 *
 * Un script d'audit qui affirme etre en lecture seule n'est pas un script en
 * lecture seule. Cette suite le verifie de trois facons independantes :
 *
 *   A. STATIQUE — le source ne contient aucune instruction d'ecriture, et la
 *      liste blanche ne peut pas en accueillir une sans que le script refuse
 *      de demarrer.
 *   B. SERVEUR — la lecture seule est appliquee par PostgreSQL, pas promise
 *      par le script. On le prouve en TENTANT une ecriture : elle doit etre
 *      refusee par le serveur, avec le message qui le dit.
 *   C. FUITES — le rapport produit ne contient aucune chaine de connexion,
 *      aucun identifiant, aucun hote.
 *
 * La partie B exige une base. Sans DATABASE_URL, elle sort en code 2 — un
 * controle qui n'a pas tourne n'est pas un controle qui passe.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(ROOT, 'scripts', 'audit_neon_readonly.mjs');

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

// ---------------------------------------------------------------------------
// A. Statique
// ---------------------------------------------------------------------------
console.log('\n  A. le source ne contient aucune ecriture\n');

const source = readFileSync(AUDIT, 'utf8');

// On n'analyse pas le fichier entier : on analyse ce qui part REELLEMENT vers
// la base, c'est-a-dire les requetes de l'objet REQUETES. Un texte d'aide
// affiche par console.log n'est jamais execute ; le compter comme une
// ecriture ferait echouer le controle pour une raison fausse, et un controle
// qui crie a tort finit par etre desactive.
const debutRequetes = source.indexOf('const REQUETES');
const finRequetes = source.indexOf('const PREFIXES_AUTORISEES');
if (debutRequetes < 0 || finRequetes < 0 || finRequetes <= debutRequetes) {
  ko('la liste de requetes REQUETES est introuvable : le controle statique ne peut pas conclure');
} else {
  const bloc = source.slice(debutRequetes, finRequetes);
  const requetes = [...bloc.matchAll(/`([^`]*)`/gs)].map((m) => m[1]);

  if (requetes.length === 0) {
    ko('aucune requete extraite de REQUETES : le controle serait vide de sens');
  } else {
    ok(`${requetes.length} requete(s) extraite(s) de la liste blanche`);

    const ECRITURES = [
      [/INSERT\s+INTO/i, 'INSERT'],
      [/UPDATE\s+[\w".]+\s+SET/i, 'UPDATE'],
      [/DELETE\s+FROM/i, 'DELETE'],
      [/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|ROLE|POLICY|INDEX|FUNCTION|TRIGGER|SCHEMA|TYPE)/i, 'CREATE'],
      [/DROP\s+(?:TABLE|ROLE|POLICY|FUNCTION|TRIGGER|SCHEMA|TYPE|DATABASE)/i, 'DROP'],
      [/ALTER\s+(?:TABLE|ROLE|DEFAULT\s+PRIVILEGES|POLICY)/i, 'ALTER'],
      [/\bGRANT\s+/i, 'GRANT'],
      [/\bREVOKE\s+/i, 'REVOKE'],
      [/set_config\s*\(/i, 'set_config (ecriture de parametre de session)'],
    ];

    const ecrivantes = [];
    const horsListe = [];
    for (const requete of requetes) {
      for (const [motif, nom] of ECRITURES) {
        if (motif.test(requete)) ecrivantes.push(nom);
      }
      const premier = requete.trim().split(/\s+/)[0].toLowerCase();
      if (!['select', 'with', 'show', 'table'].includes(premier)) horsListe.push(premier);
    }

    ecrivantes.length === 0
      ? ok('aucune des requetes envoyees a la base n ecrit')
      : ko(`requetes ecrivantes : ${[...new Set(ecrivantes)].join(', ')}`);

    horsListe.length === 0
      ? ok('les quatre formes autorisees seulement : SELECT, WITH, SHOW, TABLE')
      : ko(`formes hors liste blanche : ${[...new Set(horsListe)].join(', ')}`);
  }
}

const listeBlanche = source.includes('PREFIXES_AUTORISEES') && source.includes("['select', 'with', 'show', 'table']");
listeBlanche
  ? ok('liste blanche de requetes presente, limitee a SELECT / WITH / SHOW / TABLE')
  : ko('liste blanche absente ou modifiee');

const appliqueLectureSeule = /SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY/.test(source);
appliqueLectureSeule
  ? ok('la session est ouverte en lecture seule')
  : ko('la session n est pas ouverte en lecture seule');

const controleFuite = source.includes('REFUS D AFFICHER');
controleFuite
  ? ok('un controle de non-divulgation relit le rapport avant de l imprimer')
  : ko('aucun controle de non-divulgation');

// ---------------------------------------------------------------------------
// B. Le serveur applique la lecture seule
// ---------------------------------------------------------------------------
console.log('\n  B. la lecture seule est appliquee par le serveur\n');

const URL = process.env.DATABASE_URL;
if (!URL || !URL.trim()) {
  console.log('  NON EXECUTE — DATABASE_URL absent : la partie serveur ne peut pas tourner.');
  console.log('  Un controle qui n a pas tourne ne vaut pas un controle qui passe : sortie 2.\n');
  process.exit(2);
}

const TLS = /sslmode=(require|verify|prefer)/.test(URL);
const db = new pg.Client({ connectionString: URL, ssl: TLS ? { rejectUnauthorized: false } : undefined });
await db.connect();
await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

const etat = (await db.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
etat === 'on'
  ? ok('le serveur rapporte default_transaction_read_only = on')
  : ko(`le serveur rapporte default_transaction_read_only = ${etat}`);

// La tentative d'ecriture est l'epreuve. Elle ne peut pas reussir : si elle
// reussissait, le test echouerait et la table sonde serait supprimee.
let refusee = false;
let message = '';
try {
  await db.query('CREATE TABLE tracefab_readonly_probe (x integer)');
} catch (error) {
  refusee = true;
  message = String(error.message);
}
if (refusee && /read-only transaction/i.test(message)) {
  ok('une ecriture est refusee par PostgreSQL : « read-only transaction »');
} else if (refusee) {
  ko(`une ecriture est refusee, mais pour une autre raison : ${message.split('\n')[0]}`);
} else {
  ko('UNE ECRITURE A REUSSI : la lecture seule n est pas appliquee');
  await db.query('DROP TABLE IF EXISTS tracefab_readonly_probe');
}

await db.end();

// ---------------------------------------------------------------------------
// C. Le rapport ne divulgue rien
// ---------------------------------------------------------------------------
console.log('\n  C. le rapport produit ne divulgue rien\n');

const execution = spawnSync(process.execPath, [AUDIT], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env },
});
const sortie = `${execution.stdout || ''}${execution.stderr || ''}`;

if (execution.status !== 0) {
  ko(`l audit sort en code ${execution.status} alors que la base repond`);
  console.log(sortie.split('\n').slice(-12).join('\n'));
} else {
  ok('l audit s execute et sort en code 0');
}

let url;
try { url = new globalThis.URL(URL); } catch { url = null; }

const fuites = [];
if (sortie.includes('postgresql://')) fuites.push('schema postgresql://');
if (sortie.includes('postgres://')) fuites.push('schema postgres://');
if (sortie.includes('sslmode=')) fuites.push('parametre sslmode');
if (url?.password && url.password.length >= 12 && sortie.includes(url.password)) fuites.push('mot de passe');
if (url?.hostname && url.hostname.includes('.')
    && !['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(url.hostname)
    && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
    && sortie.includes(url.hostname)) fuites.push('hote');

fuites.length === 0
  ? ok('aucune chaine de connexion, aucun identifiant, aucun hote dans le rapport')
  : ko(`divulgation detectee : ${fuites.join(', ')}`);

// Le rapport doit tout de meme constater l essentiel : sinon il serait
// « sur » parce qu il est vide.
const attendus = [
  ['role effectif', /role effectif\s*:/],
  ['RLS activee/forcee', /avec RLS activee/],
  ['fonctions SECURITY DEFINER', /SECURITY DEFINER/],
  ['migrations appliquees', /migrations referencees/],
];
for (const [nom, motif] of attendus) {
  motif.test(sortie) ? ok(`le rapport constate : ${nom}`) : ko(`le rapport ne constate pas : ${nom}`);
}

// ---------------------------------------------------------------------------
// D. La cible declaree est respectee : aucun repli silencieux
// ---------------------------------------------------------------------------
console.log('\n  D. la cible declaree est respectee\n');

{
  // `URL` est ici le nom de la variable d'environnement : le constructeur
  // global est donc atteint explicitement, faute de quoi `new URL(...)` leve.
  let nomBase = null;
  try {
    const u = new globalThis.URL(URL);
    nomBase = decodeURIComponent((u.pathname || '').replace(/^\//, ''));
  } catch { /* signale juste en dessous */ }

  if (!nomBase) {
    ko('nom de base illisible : le controle de cible ne peut pas conclure');
  } else {
    // La bonne cible declaree : le rapport doit etre produit.
    const bon = spawnSync(process.execPath, [AUDIT, `--expect-database=${nomBase}`],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
    bon.status === 0
      ? ok(`--expect-database=${nomBase} — rapport produit`)
      : ko(`--expect-database=${nomBase} sort en code ${bon.status} alors que la cible correspond`);

    // La mauvaise cible declaree : aucun rapport ne doit sortir.
    const cibleFausse = `${nomBase}_cible_qui_n_existe_pas`;
    const mauvais = spawnSync(process.execPath, [AUDIT, `--expect-database=${cibleFausse}`],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
    const sortieMauvaise = `${mauvais.stdout || ''}${mauvais.stderr || ''}`;
    if (mauvais.status !== 3) {
      ko(`une cible declaree fausse sort en code ${mauvais.status}, attendu 3`);
    } else if (/RLS sur le schema public/.test(sortieMauvaise)) {
      ko('un rapport a ete produit malgre une cible declaree fausse');
    } else {
      ok('une cible declaree fausse est refusee (exit 3) sans produire de rapport');
    }

    // Et le nom de la base jointe doit apparaitre : l audit identifie ce qu il
    // a examine, sans divulguer la chaine de connexion.
    sortie.includes(nomBase)
      ? ok('l audit nomme la base examinee sans imprimer la chaine de connexion')
      : ko('l audit n identifie pas la base examinee');
  }
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Audit en lecture seule : OK.' : `Audit en lecture seule : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
