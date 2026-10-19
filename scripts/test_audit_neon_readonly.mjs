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
import { assertThrowawayDb } from './lib/require-throwaway-db.mjs';

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

// La suite ouvre une connexion et TENTE une ecriture (probe) pour prouver que
// le serveur la refuse. La session est posee en lecture seule juste apres, mais
// une cible non jetable ne doit pas etre jointe du tout : la garde de cible du
// depot tranche avant la connexion, exactement comme pour les autres suites.
assertThrowawayDb({ purpose: 'scripts/test_audit_neon_readonly.mjs' });

const TLS = /sslmode=(require|verify|prefer)/.test(URL);
const db = new pg.Client({ connectionString: URL, ssl: TLS ? { rejectUnauthorized: true } : undefined });
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

// ---------------------------------------------------------------------------
// D. Les requetes nommees exactes (Q1..Q6) repondent, avec assertions dures
// ---------------------------------------------------------------------------
// Un rapport « genere » n est pas une preuve. On execute la meme liste
// blanche de requetes que l audit (REQUETES), et on exige de leurs resultats
// ce que le mode operateur attend pour conclure — pas seulement leur presence.
console.log('\n  D. les requetes nommees repondent avec des invariants durs\n');

{
  const debutBloc = source.indexOf('const REQUETES');
  const finBloc = source.indexOf('const PREFIXES_AUTORISEES');
  const blocRequetesAudit = (debutBloc >= 0 && finBloc > debutBloc) ? source.slice(debutBloc, finBloc) : '';
  const nomsAttendus = ['identite', 'lecture_seule', 'roles', 'tables_rls', 'resume_rls',
    'fonctions_publiques', 'resume_fonctions', 'migrations', 'defaut_fonctions', 'proprietaire_tables'];
  const requetes = new Map();
  for (const nom of nomsAttendus) {
    const motif = new RegExp(`${nom}:\\s*\`([\\s\\S]*?)\``);
    const m = blocRequetesAudit.match(motif);
    if (!m) ko(`requete nommee « ${nom} » introuvable dans la liste blanche : Q1..Q6 sans objet`);
    else requetes.set(nom, m[1]);
  }

  const dbD = new pg.Client({ connectionString: URL, ssl: TLS ? { rejectUnauthorized: true } : undefined });
  await dbD.connect();
  await dbD.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  const res = {};
  for (const [nom, sql] of requetes) {
    try {
      res[nom] = await dbD.query(sql);
    } catch (error) {
      ko(`la requete nommee « ${nom} » a echoue : ${String(error.message).split('\n')[0]}`);
    }
  }

  // Invariants durs — ce que le mode operateur utilise pour trancher.
  if (res.migrations) {
    const ratees = res.migrations.rows.filter((r) => r.appliquee !== true);
    ratees.length === 0
      ? ok(`Q1 : ${res.migrations.rows.length} migration(s), toutes rapportees appliquees`)
      : ko(`Q1 : ${ratees.length} migration(s) non appliquees : ${ratees.map((r) => r.migration_name).join(', ')}`);
  }
  if (res.roles) {
    const noms = res.roles.rows.map((r) => r.rolname);
    (noms.includes('tracefab_app') && noms.includes('postgres'))
      ? ok(`Q2 : ${noms.length} role(s) hors pg_*, avec tracefab_app et postgres`)
      : ko(`Q2 : roles attendus absents (rolnames : ${noms.slice(0, 6).join(', ')}...)`);
    const contournants = res.roles.rows.filter((r) => r.rolbypassrls === true && !['postgres'].includes(r.rolname));
    contournants.length === 0
      ? ok('Q2 : aucun role hors postgres ne possede BYPASSRLS')
      : ko(`Q2 : BYPASSRLS chez ${contournants.map((r) => r.rolname).join(', ')}`);
  }
  if (res.resume_rls) {
    // Exception unique et documentee : _prisma_migrations est la table de
    // metadonnees de Prisma (pas de donnees applicatives, jamais exposee par
    // l API). Toute AUTRE table sans RLS est un echec.
    const r = res.resume_rls.rows[0];
    r.tables > 0 && r.sans_rls <= 1
      ? ok(`Q3 : ${r.tables} table(s) publique(s), ${r.sans_rls} sans RLS (attendu : _prisma_migrations au plus)`)
      : ko(`Q3 : tables=${r.tables}, sans_rls=${r.sans_rls} (attendu : >0 tables et au plus _prisma_migrations sans RLS)`);
    if (res.tables_rls) {
      const hors = res.tables_rls.rows.filter((t) => t.rls_activee !== true && t.table_name !== '_prisma_migrations');
      hors.length === 0
        ? ok('Q3 : aucune table hors _prisma_migrations n est sans RLS')
        : ko(`Q3 : table(s) applicative(s) sans RLS : ${hors.map((t) => t.table_name).join(', ')}`);
    }
    r.rls_forcee >= r.tables - 1
      ? ok('Q3 : RLS forcee sur toutes les tables applicatives')
      : ko(`Q3 : RLS forcee sur ${r.rls_forcee}/${r.tables} tables`);
  }
  if (res.resume_fonctions) {
    const r = res.resume_fonctions.rows[0];
    r.secdef_publiques === 0
      ? ok(`Q4 : ${r.total} fonction(s), ${r.security_definer} SECURITY DEFINER, 0 executable(s) par PUBLIC`)
      : ko(`Q4 : ${r.secdef_publiques} fonction(s) SECURITY DEFINER executable(s) par PUBLIC`);
  }
  if (res.tables_rls) {
    const sansPolitique = res.tables_rls.rows.filter((r) => r.table_name !== '_prisma_migrations'
      && (r.rls_activee !== true || Number(r.politiques) === 0));
    sansPolitique.length === 0
      ? ok(`Q5 : chaque table applicative du schema public porte au moins une politique`)
      : ko(`Q5 : table(s) sans politique : ${sansPolitique.slice(0, 5).map((r) => r.table_name).join(', ')}`);
  }
  if (res.migrations && res.identite) {
    ok(`Q6 : cible examinee ${res.identite.rows[0].base} sous ${String(res.identite.rows[0].version).split(' ').slice(0, 2).join(' ')}`);
  }

  await dbD.end();
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Audit en lecture seule : OK.' : `Audit en lecture seule : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
