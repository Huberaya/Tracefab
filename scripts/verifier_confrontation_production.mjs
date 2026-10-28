#!/usr/bin/env node
/**
 * Confronte l'etat du catalogue de production au referentiel du depot.
 *
 * POURQUOI CET OUTIL
 *
 * Le tour 29 a laisse `plm_erp_gs1` en `BLOCKED` : vingt valeurs de reference
 * calculees sur base jetable, et aucune lecture de production. Le tour 30 a
 * l'autorisation, mais pas l'acces. Cet outil supprime la partie qui restait
 * faillible quand l'acces reviendra : la COMPARAISON A L OEIL.
 *
 * Il construit le referentiel en rejouant les migrations du depot, execute la
 * MEME requete des deux cotes, et confronte les deux sorties. Le referentiel et
 * la mesure ne peuvent donc pas diverger : c'est le meme instrument.
 *
 * CE QUE L OUTIL REFUSE DE FAIRE
 *
 *  - il ne classe pas « PASS » une sortie partielle : une ligne attendue et
 *    absente est un echec, jamais un silence ;
 *  - il ne compare pas les expressions de politique caractere par caractere
 *    sans le dire : une difference de rendu de cast entre PostgreSQL 17 et 18
 *    sort en « A QUALIFIER » (code 3) avec les deux textes, pas en echec muet
 *    ni en succes complaisant ;
 *  - il ne se prononce pas sur le PROPRIETAIRE : la base de reference est
 *    `postgres`, la production est `neondb_owner`. Il verifie en revanche que
 *    le proprietaire est le MEME pour tous les objets — un catalogue ou des
 *    objets appartiennent a des roles differents n'est pas l'etat attendu.
 *
 * USAGE
 *
 *   psql "$DIRECT_URL" -A -t -v ON_ERROR_STOP=1 \
 *     -f docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql \
 *     > /tmp/etat-production.txt
 *
 *   node scripts/verifier_confrontation_production.mjs /tmp/etat-production.txt
 *
 * Sortie : 0 = tout concorde, 1 = divergence franche, 3 = a qualifier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');
const REQUETE = path.join(root, 'docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql');

const args = process.argv.slice(2);
const fichier = args.find((a) => !a.startsWith('--'));
// `--referentiel=<fichier>` permet de reutiliser un referentiel deja calcule :
// sans cela, chaque verification reconstruirait la chaine, et un harnais de
// mutation en ferait six fois le prix.
const refCache = (args.find((a) => a.startsWith('--referentiel=')) || '').split('=')[1];
// `--ecrire-referentiel=<fichier>` produit le referentiel sans rien comparer.
const refSortie = (args.find((a) => a.startsWith('--ecrire-referentiel=')) || '').split('=')[1];

// `--perimetre-plm` : comparaison limitee aux politiques des deux tables PLM.
// La requete du 28/10 ne les interrogeait qu'elles ; sans ce drapeau, les
// vingt-sept politiques des douze autres tables manqueraient a l'appel et
// passeraient pour des divergences. Le drapeau ne RESTREINT que ce qui est
// compare : il ne desactive aucun controle sur ce qui a ete lu.
const PERIMETRE_PLM = args.includes('--perimetre-plm');
const TABLES_PLM = ['plm_erp_integrations', 'plm_erp_sync_jobs'];

if (!fichier && !refSortie) {
  console.error('usage : node scripts/verifier_confrontation_production.mjs <sortie-psql.txt>');
  process.exit(2);
}

const { PGlite } = await import('@electric-sql/pglite');
const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

const lireFichier = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');
const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();

/* -------------------------------------------------------------------------
   Referentiel : la chaine du depot, plus `_prisma_migrations` vide.
   La table d'historique est creee au schema de Prisma pour que la MEME requete
   s'execute des deux cotes ; elle reste vide, donc toutes les lignes `H`
   ressortent a `present=0`, ce qui est l'etat attendu d'une base neuve.
   ------------------------------------------------------------------------- */

/**
 * L'HISTORIQUE NE SE COMPARE PAS A UNE BASE NEUVE.
 *
 * La base de reference est construite par application des migrations : elle
 * n'a jamais vu `prisma migrate`, donc son `_prisma_migrations` est vide, et
 * toutes ses lignes `H` disent `present=0`. Comparer la production a cela
 * produisait quinze « echecs » qui ne disaient rien de la production : le
 * 28/10, le premier passage du verificateur l'a fait, et ces quinze echecs
 * masquaient la seule divergence reelle.
 *
 * L'etat attendu de l'historique est donc ECRIT ici, a partir de la
 * reconciliation du 28/10 : les cinq migrations hors bande sont presentes avec
 * `applied_steps_count = 0`, les deux correctives ne le sont pas encore. Ce
 * bloc remplace les lignes `H` du referentiel, qu'il vienne d'une base neuve
 * ou d'un cache.
 */
const HISTORIQUE_ATTENDU = {
  '20261006220000_esg_pef_footprint_engine': { present: '1', steps: '0', termine: 'true' },
  '20261006230000_green_claims_anti_greenwashing_engine': { present: '1', steps: '0', termine: 'true' },
  '20261006240000_quality_corrective_action_plans_cap': { present: '1', steps: '0', termine: 'true' },
  '20261006250000_universal_supplier_passport': { present: '1', steps: '0', termine: 'true' },
  '20261006260000_mass_balance_anti_fraud_engine': { present: '1', steps: '0', termine: 'true' },
  // Absente : la requete rend `present=0`, sans date ni nombre d'etapes.
  '20261028140000_supplier_invitation_owner_relationship_scope':
    { present: '0', steps: '-', termine: 'false' },
  '20261028150000_plm_erp_policy_convergence':
    { present: '0', steps: '-', termine: 'false' },
};
const ligneHistorique = (nom) => {
  const champsAttendus = HISTORIQUE_ATTENDU[nom];
  if (!champsAttendus) return null;
  const corps = Object.entries(champsAttendus).map(([c, v]) => `${c}=${v}`).join('|');
  return `H|${nom}|${corps}`;
};
const appliquerHistorique = (lignes) => {
  const hors = lignes.filter((l) => !l.startsWith('H|'));
  const vues = new Set();
  const hist = [];
  for (const l of lignes) {
    if (!l.startsWith('H|')) continue;
    const nom = l.split('|')[1];
    vues.add(nom);
    const attendue = ligneHistorique(nom);
    if (attendue) hist.push(attendue);
  }
  for (const nom of Object.keys(HISTORIQUE_ATTENDU)) {
    if (!vues.has(nom)) hist.push(ligneHistorique(nom));
  }
  return [...hors, ...hist];
};

let referentiel;
if (refCache) {
  referentiel = fs.readFileSync(refCache, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  console.log(`\n  Referentiel lu depuis ${refCache} (${referentiel.length} faits).`);
} else {
console.log('\n  Construction du referentiel (chaine du depot, base jetable)…');
const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;
await db.exec(`
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  GRANT USAGE ON SCHEMA public TO tracefab_app;
  CREATE TABLE _prisma_migrations (
    id varchar(36) PRIMARY KEY,
    checksum varchar(64) NOT NULL,
    finished_at timestamptz,
    migration_name varchar(255) NOT NULL,
    logs text,
    rolled_back_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(),
    applied_steps_count integer NOT NULL DEFAULT 0
  );
`);
for (const d of dossiers) await db.exec(lireFichier(d));
console.log(`  ${dossiers.length} migrations appliquees.`);

referentiel = (await db.query(fs.readFileSync(REQUETE, 'utf8'))).rows.map((r) => r.ligne ?? Object.values(r)[0]);
await db.close();
}

// Les lignes `H` de la base neuve ne decrivent pas la production : remplacees.
referentiel = appliquerHistorique(referentiel);
if (PERIMETRE_PLM) {
  referentiel = referentiel.filter((l) => !l.startsWith('P|')
    || TABLES_PLM.some((t) => l.startsWith(`P|${t}.`)));
}

if (refSortie) {
  fs.writeFileSync(refSortie, `${referentiel.join('\n')}\n`);
  console.log(`  Referentiel ecrit dans ${refSortie} (${referentiel.length} faits).`);
  process.exit(0);
}

/* -------------------------------------------------------------------------
   Mesure de production
   ------------------------------------------------------------------------- */

const brut = fs.readFileSync(fichier, 'utf8').replace(/^\uFEFF/, '');

/**
 * La sortie peut venir de deux endroits, et il faut accepter les deux :
 *
 *  - `psql -A -t` : une valeur par ligne, brute ;
 *  - le SQL Editor de Neon, qui ne connait pas `-A -t` : on colle la requete,
 *    on copie la colonne, ou on exporte en CSV. Les valeurs arrivent alors
 *    entourees de guillemets, avec une ligne d'en-tete, et les guillemets
 *    internes doubles (`""`).
 *
 * Une ligne d'en-tete prise pour une mesure ferait echouer la comparaison pour
 * une raison qui n'a rien a voir avec la production : on la retire.
 */
const mesure = brut
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && l !== 'ligne' && l !== '"ligne"')
  .map((l) => {
    let v = l;
    if (v.startsWith('"') && v.endsWith('"') && v.length > 1) v = v.slice(1, -1).replace(/""/g, '"');
    return v.trim();
  })
  .filter((l) => l.includes('|'));

if (mesure.length === 0) {
  console.error('ECHEC  aucun fait exploitable dans le fichier fourni.');
  process.exit(1);
}

/* -------------------------------------------------------------------------
   Comparaison
   ------------------------------------------------------------------------- */

const norm = (s) => s.replace(/\s+/g, ' ').trim();
/**
 * La cle d'un fait.
 *
 * Elle retenait `genre|objet` — suffisant pour T, P, F, H, ou l'objet identifie
 * la ligne. PAS pour `G`, dont les lignes se discriminent sur la TROISIEME
 * colonne : `G|attributs|tracefab_app` et `G|attributs|tracefab_worker`, ou
 * `G|table|<nom>`. Toutes les lignes `G` s'ecrasaient donc les unes les autres,
 * et la comparaison ne portait en realite que sur la DERNIERE de chaque
 * famille : une elevation de privileges sur `tracefab_app` serait passee au
 * vert. Mesure du 28/10, sur le test : quatre mutations de privileges non
 * detectees.
 */
const cleDe = (ligne) => {
  const [genre, objet, detail] = ligne.split('|');
  return genre === 'G' ? `G|${objet}|${detail}` : `${genre}|${objet}`;
};
/**
 * Analyse d'un jeu de lignes : cle, doublons, lignes mal formees.
 *
 * Un `Map.set` silencieux est le pire des comportements pour un comparateur :
 * deux lignes de meme cle, la seconde ecrase la premiere, et le controle
 * annonce un perimetre qu'il n'a pas couvert. Les doublons sont donc REMONTES,
 * pas absorbes.
 */
const GENRES = new Set(['T', 'P', 'F', 'H', 'G', 'S']);
const parCle = (lignes, source) => {
  const m = new Map();
  const doublons = [];
  const malformees = [];
  for (const l of lignes) {
    const morceaux = l.split('|');
    const [genre, objet] = morceaux;
    const profilValide = genre === 'G'
      ? morceaux.length >= 4 && objet && morceaux[2]
      : morceaux.length >= 3 && objet;
    if (!GENRES.has(genre) || !profilValide) {
      malformees.push(l);
      continue;
    }
    // Chaque segment apres l'en-tete doit porter une affectation `cle=valeur`.
    const debutChamps = genre === 'G' ? 3 : 2;
    const champsMalFormes = morceaux.slice(debutChamps).filter((x) => x.indexOf('=') <= 0);
    if (champsMalFormes.length) {
      malformees.push(`${l}   (segment sans affectation : ${champsMalFormes.join(', ')})`);
      continue;
    }
    const k = cleDe(l);
    if (m.has(k)) {
      doublons.push(`${k}  [${source}]`);
      continue;
    }
    m.set(k, l);
  }
  return { map: m, doublons, malformees };
};

const analyseRef = parCle(referentiel, 'referentiel');
const analyseMes = parCle(mesure, 'production');
const ref = analyseRef.map;
const mes = analyseMes.map;


// Le proprietaire n'est pas dans la requete : il est mesure separement plus bas.
// `politiques` (le nombre de politiques d'une table) manquait : une table qui
// gagne une politique supplementaire passait donc inapercue par ce champ. C'est
// exactement la derive du 28/10 — trouvee sur les lignes `P`, mais le compteur
// aurait du la signaler aussi.
// Les champs `G` (privileges et heritage) ont failli manquer : ecrits dans la
// requete, produits dans les deux referentiels, ils n'etaient PAS compares —
// le comparateur ne regardait que les noms qu'il connaissait, et une elevation
// de privileges serait passee inapercue. C'est la troisieme fois dans ce
// chantier qu'un controle ecrit par moi mesurait moins que son intitule.
const CHAMPS_DURS = ['existe', 'rls', 'force', 'politiques', 'cmd', 'roles', 'permissive',
  'secdef', 'search_path', 'exec_public', 'exec_app', 'present', 'steps', 'termine',
  // G|attributs|role
  'super', 'bypassrls', 'inherit', 'createrole', 'createdb', 'login',
  // G|membre
  'dans', 'admin', 'herite',
  // G|table, G|hors-cible, G|schema
  'app', 'public'];
const CHAMPS_TEXTE = ['using', 'check']; // rendu d'expression : peut differer sans changer le sens

/**
 * Champs NI durs NI textuels : ils ne sont pas comparés caractère par
 * caractère, et ce n'est pas un oubli — c'est une DÉCISION, écrite.
 *
 *   proprietaire — le propriétaire de la base de référence est le rôle du
 *   cluster jetable (`postgres`), celui de la production est le rôle
 *   d'infrastructure (`neondb_owner`). Comparer les deux produirait un écart
 *   qui ne dit rien de la sécurité. Ce qui compte, et qui est contrôlé plus
 *   bas : un propriétaire UNIQUE et JAMAIS un rôle runtime. La qualification
 *   est donc structurelle, pas nominale.
 *
 * Tout autre champ présent dans les lignes mais absent de ces trois listes
 * provoque un ÉCHEC : un fait produit et non comparé est un angle mort.
 */
const CHAMPS_QUALIFIES = {
  proprietaire: 'proprietaire unique, jamais un role runtime (qualification structurelle)',
};

/**
 * Deux expressions textuellement differentes peuvent porter la MEME regle (un
 * cast rendu autrement entre PostgreSQL 17 et 18), ou deux regles differentes.
 * Les confondre serait le peche du tour precedent : une comparaison qui ne
 * tranche pas.
 *
 * On extrait donc ce qui fait la regle :
 *   - les FONCTIONS appelees — un predicat different n'est pas un rendu
 *     different ;
 *   - les JETONS significatifs — identifiants de colonnes et litteraux entre
 *     quotes — en retirant les casts (`::type`), les mots-cles SQL et la mise
 *     en forme.
 * Si l'un ou l'autre change, c'est FAIL, pas « a qualifier ».
 */
const MOTS_CLES = new Set(['and', 'or', 'not', 'is', 'null', 'array', 'true', 'false',
  'select', 'exists', 'from', 'where', 'as', 'in', 'on', 'any', 'all', 'case', 'when',
  'then', 'else', 'end', 'the', 'aucun', 'public']);
const TYPES = new Set(['uuid', 'text', 'boolean', 'bool', 'integer', 'int', 'bigint',
  'numeric', 'date', 'timestamptz', 'timestamp', 'jsonb', 'json', 'membership_role',
  'organization_type', 'character', 'varying', 'double', 'precision']);

function analyser(expr) {
  const sansCasts = String(expr).replace(/::[a-z_][a-z0-9_ ]*/gi, ' ');
  const fonctions = new Set(
    [...sansCasts.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const litteraux = [...sansCasts.matchAll(/'([^']*)'/g)].map((m) => `'${m[1]}'`);
  const sansChaines = sansCasts.replace(/'[^']*'/g, ' ');
  // `[...matchAll()]` et non `matchAll().map()` : les methodes d iterateur
  // n existent qu a partir de Node 22, et la CI tourne en Node 20. Ecrit pour
  // Node 22, ce fichier passait ici et echouait la-bas — vu par la CI.
  const jetons = [
    ...[...sansChaines.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)].map((m) => m[1].toLowerCase())
      .filter((t) => !MOTS_CLES.has(t) && !TYPES.has(t) && !fonctions.has(t)),
    ...litteraux,
  ].sort();
  return { fonctions: [...fonctions].sort(), jetons };
}

const champs = (ligne) => {
  const morceaux = ligne.split('|');
  const reste = morceaux[0] === 'G' ? morceaux.slice(3) : morceaux.slice(2);
  const o = {};
  for (const morceau of reste) {
    const i = morceau.indexOf('=');
    if (i > 0) o[morceau.slice(0, i)] = morceau.slice(i + 1);
  }
  return o;
};

let echecs = 0;
let aQualifier = 0;

/* Doublons et lignes mal formees : ni l'un ni l'autre ne se tait. */
for (const [analyse, source] of [[analyseRef, 'referentiel'], [analyseMes, 'sortie de production']]) {
  if (analyse.doublons.length) {
    echecs += analyse.doublons.length;
    console.log(`\n  ECHEC  ${analyse.doublons.length} cle(s) en double dans ${source} :`);
    for (const d of analyse.doublons.slice(0, 20)) console.log(`    ${d}`);
  }
  if (analyse.malformees.length) {
    echecs += analyse.malformees.length;
    console.log(`\n  ECHEC  ${analyse.malformees.length} ligne(s) mal formee(s) dans ${source} :`);
    for (const d of analyse.malformees.slice(0, 20)) console.log(`    ${d}`);
  }
}

const manquantes = [...ref.keys()].filter((k) => !mes.has(k));

/**
 * Un fait surnumeraire en production n'a pas le meme poids selon son genre.
 *
 *   T / F / H  un objet inconnu du depot : a qualifier, il n'accorde rien par
 *              lui-meme ;
 *   P / G      une POLITIQUE ou un PRIVILEGE que le depot ne prevoit pas :
 *              c'est une capacite en plus, pas une curiosite. Echec dur.
 *
 * Le 28/10, les deux politiques surnumeraires de `plm_erp_sync_jobs` etaient
 * classees « a qualifier » ; elles sont desormais un echec, et leur
 * qualification manuelle reste possible — mais elle doit etre ECRITE, pas
 * deduite d'un code de sortie permissif.
 */
const tousSurnumeraires = [...mes.keys()].filter((k) => !ref.has(k) && !k.startsWith('H|'));
const surnumeraires = tousSurnumeraires.filter((k) => !/^[PG]\|/.test(k));
const surnumerairesSecurite = tousSurnumeraires.filter((k) => /^[PG]\|/.test(k));

console.log(`\n  ${ref.size} faits attendus, ${mes.size} faits mesures.`);

if (manquantes.length) {
  echecs += manquantes.length;
  console.log(`\n  ECHEC  ${manquantes.length} fait(s) attendu(s) absent(s) de la sortie :`);
  for (const k of manquantes.slice(0, 20)) console.log(`    ${k}`);
}

if (surnumerairesSecurite.length) {
  echecs += surnumerairesSecurite.length;
  console.log(`\n  ECHEC  ${surnumerairesSecurite.length} politique(s) ou privilege(s) en production, absent(s) du referentiel :`);
  console.log('         Le depot ne les prevoit pas : c est une capacite en plus.');
  for (const k of surnumerairesSecurite.slice(0, 20)) console.log(`    ${k}   ${mes.get(k)}`);
}

if (surnumeraires.length) {
  aQualifier += surnumeraires.length;
  console.log(`\n  A QUALIFIER  ${surnumeraires.length} fait(s) en production, absent(s) du referentiel :`);
  for (const k of surnumeraires.slice(0, 20)) console.log(`    ${k}   ${mes.get(k)}`);
}

/* -------------------------------------------------------------------------
   Aucun fait produit ne doit rester hors comparaison
   ------------------------------------------------------------------------- */

const compares = new Set([...CHAMPS_DURS, ...CHAMPS_TEXTE]);
const qualifies = new Set(Object.keys(CHAMPS_QUALIFIES));
const champsVus = new Set();
for (const l of [...ref.values(), ...mes.values()]) {
  for (const c of Object.keys(champs(l))) champsVus.add(c);
}
const nonTraites = [...champsVus].filter((c) => !compares.has(c) && !qualifies.has(c));
if (nonTraites.length) {
  echecs += nonTraites.length;
  console.log(`\n  ECHEC  ${nonTraites.length} champ(s) produit(s) et NON compare(s) : ${nonTraites.join(', ')}`);
  console.log('         Un fait annonce mais jamais compare est un angle mort, pas un detail.');
}
if (qualifies.size) {
  for (const [c, raison] of Object.entries(CHAMPS_QUALIFIES)) {
    if (champsVus.has(c)) console.log(`  qualifie  ${c} — ${raison}`);
  }
}

for (const [cle, attendu] of ref) {
  const obtenu = mes.get(cle);
  if (!obtenu) continue;
  const a = champs(attendu);
  const b = champs(obtenu);
  for (const champ of CHAMPS_DURS) {
    if (!(champ in a) && !(champ in b)) continue;
    if (a[champ] !== b[champ]) {
      echecs += 1;
      console.log(`  ECHEC  ${cle}  ${champ} : attendu « ${a[champ]} », obtenu « ${b[champ]} »`);
    }
  }
  for (const champ of CHAMPS_TEXTE) {
    if (!(champ in a) && !(champ in b)) continue;
    if (norm(a[champ] ?? '') === norm(b[champ] ?? '')) continue;

    const ea = analyser(a[champ] ?? '');
    const eb = analyser(b[champ] ?? '');
    const fonctionsDifferentes = JSON.stringify(ea.fonctions) !== JSON.stringify(eb.fonctions);
    const jetonsDifferents = JSON.stringify(ea.jetons) !== JSON.stringify(eb.jetons);

    if (fonctionsDifferentes || jetonsDifferents) {
      echecs += 1;
      console.log(`\n  ECHEC  ${cle}  ${champ} — la REGLE differe, pas seulement le rendu :`);
      if (fonctionsDifferentes) {
        console.log(`    fonctions attendues : ${ea.fonctions.join(', ') || '(aucune)'}`);
        console.log(`    fonctions obtenues : ${eb.fonctions.join(', ') || '(aucune)'}`);
      }
      if (jetonsDifferents) {
        const manque = ea.jetons.filter((t) => !eb.jetons.includes(t));
        const ajout = eb.jetons.filter((t) => !ea.jetons.includes(t));
        if (manque.length) console.log(`    jetons disparus : ${manque.join(', ')}`);
        if (ajout.length) console.log(`    jetons apparus  : ${ajout.join(', ')}`);
      }
      console.log(`    attendu : ${a[champ]}`);
      console.log(`    obtenu  : ${b[champ]}`);
      continue;
    }

    aQualifier += 1;
    console.log(`\n  A QUALIFIER  ${cle}  ${champ} — meme fonctions, memes jetons, rendu different :`);
    console.log(`    attendu : ${a[champ]}`);
    console.log(`    obtenu  : ${b[champ]}`);
  }
}

/* -------------------------------------------------------------------------
   Proprietaire : une seule valeur attendue, quelle qu'elle soit
   ------------------------------------------------------------------------- */

const proprietaires = new Set();
for (const l of mesure) {
  const m = l.match(/\|proprietaire=([^|]+)$/);
  if (m) proprietaires.add(m[1]);
}
if (proprietaires.size) {
  const liste = [...proprietaires].sort().join(', ');
  console.log(`\n  Proprietaires des objets mesures : ${liste}`);
  if (proprietaires.size > 1) {
    echecs += 1;
    console.log('  ECHEC  plusieurs proprietaires : un catalogue ou les objets appartiennent');
    console.log('         a des roles differents n est pas l etat attendu.');
  }
  // La qualification structurelle du proprietaire n a de valeur que si elle
  // exclut les roles qui, eux, sont soumis a la RLS. Un objet dont le
  // proprietaire est le role runtime echappe a `FORCE ROW LEVEL SECURITY`
  // pose sur les AUTRES tables... et surtout : le proprietaire d une table
  // peut y faire ce que la RLS interdit a tous les autres.
  const ROLES_RUNTIME = ['tracefab_app', 'tracefab_worker'];
  const fautifs = [...proprietaires].filter((p) => ROLES_RUNTIME.includes(p));
  if (fautifs.length) {
    echecs += 1;
    console.log(`  ECHEC  proprietaire(s) de role RUNTIME : ${fautifs.join(', ')}`);
    console.log('         Les objets doivent appartenir a un role d administration, pas au role');
    console.log('         que l application utilise.');
  }
}

console.log('\n  --------------------------------------------');
if (echecs === 0 && aQualifier === 0) {
  console.log(`  PASS  les ${ref.size} faits du referentiel sont retrouves a l identique.`);
  console.log('  La divergence d empreinte de plm_erp_gs1 n a aucun effet mesurable');
  console.log('  sur les politiques, les fonctions et l etat RLS.');
  process.exit(0);
}
if (echecs > 0) {
  console.log(`  FAIL  ${echecs} divergence(s) franche(s), ${aQualifier} a qualifier.`);
  process.exit(1);
}
console.log(`  A QUALIFIER  ${aQualifier} difference(s) de rendu, aucune divergence franche.`);
console.log('  Lire les deux expressions : un cast rendu autrement n est pas une regle');
console.log('  differente, une regle differente n est pas un cast.');
process.exit(3);
