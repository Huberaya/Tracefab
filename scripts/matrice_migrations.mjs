#!/usr/bin/env node
/**
 * Matrice des 65 migrations : le decompte est RECALCULE, jamais recopie.
 *
 * Le mandat interdit de reprendre « 54 appliquees + 9 absentes + 2 annulees »
 * comme un acquis. Cette matrice le refait donc depuis l'etat courant du depot,
 * et echoue si l'arithmetique ne ferme plus.
 *
 * CE QUI EST MESURE ICI, ET CE QUI EST REPRIS
 *
 *   mesure   : le nombre de migrations du depot, leurs empreintes SHA-256
 *              (Prisma hache le contenu de `migration.sql`), l'absence de
 *              prefixe d'horodatage en double, et la presence effective des
 *              migrations citees comme en ecart ;
 *   repris   : le STATUT D'HISTORIQUE de chaque migration, qui vient d'une
 *              lecture de `_prisma_migrations` en production. Ce script ne se
 *              connecte a rien : il qualifie ce qu'il ne peut pas relire.
 *
 * Une migration « attestee » l'est par une lecture du 28/10, pas par ce script.
 * La colonne « effets observes » ne dit donc jamais « identique » : elle dit
 * « mesure », « deduit » ou « NON PROUVE ».
 *
 *   node scripts/matrice_migrations.mjs            matrice lisible
 *   node scripts/matrice_migrations.mjs --markdown tableau Markdown
 *   node scripts/matrice_migrations.mjs --verifier sortie 1 si derive
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ECARTS, CATALOGUE, HORS_BANDE, BORNE_RELEVE } from './lib/ecarts_migrations.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const dossier = join(racine, 'prisma', 'migrations');

/**
 * Les ecarts, NOMMES par la reconciliation du 28/10 sur `_prisma_migrations`.
 * `historique` : ANNULEE (ligne `rolled_back_at`) ou ABSENTE (aucune ligne).
 * `effets` : ce que la production porte, avec sa NATURE.
 */


/**
 * LES TROIS NIVEAUX, ET POURQUOI ILS NE SE CONFONDENT PAS.
 *
 * Le mandat demande de distinguer trois choses, et les confondre est l'erreur
 * qui a coute le plus cher de ce chantier :
 *
 *   a) `historique` : ce que `_prisma_migrations` ATTESTE (une ligne terminee,
 *      annulee, ou rien du tout) ;
 *   b) `catalogue`  : ce que les objets et politiques de la production
 *      MONTRENT, quand on les a lus ;
 *   c) `sql`        : le contenu du fichier du depot, qui dit ce que la
 *      migration FERAIT si elle etait jouee.
 *
 * Une migration absente de l'historique ne prouve pas que ses effets sont
 * absents (b peut etre present sans a). Une migration attestee ne prouve pas
 * que ses effets sont la (a sans b). Et le SQL du depot ne dit rien de l'un ni
 * de l'autre : il dit ce qui se passerait au prochain deploiement (c).
 *
 * STATUTS — quatre valeurs, jamais « identique » par defaut :
 *   CONFORME      a et b disent la meme chose, et c'est ce qu'on attend
 *   DIVERGENCE    a et b se contredisent, ou b contredit l'attendu du depot
 *   NON PROUVE    b n'a pas ete lu — on ne sait pas
 *   A QUALIFIER   b a ete lu mais ne tranche pas (objet partage entre deux
 *                 migrations, effet indistinguable d'une autre source)
 */


const STATUTS = new Set(['CONFORME', 'DIVERGENCE', 'NON PROUVE', 'A QUALIFIER', 'NON DEPLOYEE']);

/**
 * Les cinq migrations appliquees HORS BANDE (`applied_steps_count = 0` alors
 * que `finished_at` est renseigne) : executees par un lanceur du depot, puis
 * marquees par `resolve --applied`. Le SQL est celui du fichier ; l'execution
 * n'est pas passee par Prisma.
 */


// --- 1. Lecture mesuree du depot -----------------------------------------
const migrations = readdirSync(dossier, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const empreinte = (nom) => {
  const f = join(dossier, nom, 'migration.sql');
  if (!existsSync(f)) return null;
  return createHash('sha256').update(readFileSync(f)).digest('hex');
};

// Est « nouvelle » toute migration posterieure au dernier releve, qui n'est ni
// un ecart de derive ni une hors bande. Regle derivee, pas liste recopiee : une
// migration ajoutee demain est classee sans qu'on retouche ce script.
const NOUVELLES = {};
for (const n of migrations) {
  if (!ECARTS[n] && !HORS_BANDE[n] && n > BORNE_RELEVE) NOUVELLES[n] = true;
}

const lignes = migrations.map((nom) => {
  const sha = empreinte(nom);
  const ecart = ECARTS[nom];
  const horsBande = HORS_BANDE[nom];
  const nouvelle = NOUVELLES[nom];
  let historique;
  if (ecart) historique = ecart.historique;
  else if (nouvelle) historique = 'NOUVELLE (jamais deployee)';
  else if (horsBande) historique = 'APPLIQUEE HORS BANDE';
  else historique = 'APPLIQUEE';
  return {
    nom,
    sha,
    historique,
    objet: ecart?.objet ?? (nouvelle ? 'migration ecrite apres le releve du 28/10' : null) ?? (horsBande ? `cree ${horsBande.join(', ')}` : '—'),
    effets: ecart?.effets ?? (nouvelle ? ['NON DEPLOYEE', 'aucune ligne _prisma_migrations : posterieure au releve'] : null) ?? (horsBande ? ['MESURE', 'les 12 tables existent en production (lecture du 28/10)'] : ['NON PROUVE', 'aucune mesure ciblee']),
    suite: ecart?.suite ?? (nouvelle ? 'appliquable seule ; depend d une decision sur les migrations jumelles' : null) ?? (horsBande ? 'schema equivalent, non prouve ; controle cible souhaitable' : '—'),
    catalogue: ecart ? CATALOGUE[nom]?.catalogue
      : nouvelle ? 'ABSENTE — jamais deployee, aucune ligne _prisma_migrations'
      : (horsBande ? 'PRESENT MESURE — les 12 tables existent en production' : 'NON LU'),
    statut: ecart ? CATALOGUE[nom]?.statut
      : nouvelle ? 'NON DEPLOYEE'
      : (horsBande ? 'A QUALIFIER' : 'NON PROUVE'),
  };
});

// --- 2. Controles de coherence -------------------------------------------
const erreurs = [];

const compter = (h) => lignes.filter((l) => l.historique === h).length;
const nouvelles = compter('NOUVELLE (jamais deployee)');
const appliquees = compter('APPLIQUEE');
const horsBande = compter('APPLIQUEE HORS BANDE');
const annulees = compter('ANNULEE');
const absentes = compter('ABSENTE');

const total = lignes.length;
// Le TOTAL n'est pas fige : il augmente a chaque migration ajoutee, et le
// figer transformait une livraison normale en echec. Ce qui doit rester fige,
// ce sont les FAITS de production : 11 ecarts, 5 hors bande.
if (appliquees + horsBande + annulees + absentes + nouvelles !== total) {
  erreurs.push(`l arithmetique ne ferme pas : ${appliquees}+${horsBande}+${annulees}+${absentes}+${nouvelles} != ${total}`);
}
// Les onze ECARTS de derive restent onze : une migration neuve n'en est pas un.
if (annulees + absentes !== 11) erreurs.push(`${annulees + absentes} ecarts nommes, 11 attendus`);
if (nouvelles === 0) erreurs.push('aucune migration posterieure au releve : la regle de classement ne s applique pas');
if (total < 65) erreurs.push(`le depot ne contient plus que ${total} migrations : une a disparu`);
if (horsBande !== 5) erreurs.push(`${horsBande} migrations hors bande, 5 attendues`);

// Les migrations citees comme en ecart doivent exister : sinon la matrice
// decrit un depot qui n'existe plus.
for (const nom of Object.keys(ECARTS)) {
  if (!migrations.includes(nom)) erreurs.push(`ecart cite mais absent du depot : ${nom}`);
}
for (const nom of Object.keys(HORS_BANDE)) {
  if (!migrations.includes(nom)) erreurs.push(`hors bande cite mais absent du depot : ${nom}`);
}

// Les trois niveaux doivent etre renseignes pour chaque ecart, sinon la matrice
// affiche un vide que le lecteur lira comme « conforme ».
for (const nom of Object.keys(ECARTS)) {
  const c = CATALOGUE[nom];
  if (!c) erreurs.push(`ecart sans niveau catalogue : ${nom}`);
  else if (!STATUTS.has(c.statut)) erreurs.push(`statut inconnu pour ${nom} : ${c.statut}`);
  if (c && (!c.catalogue || c.catalogue.trim() === '')) erreurs.push(`catalogue vide pour ${nom}`);
}
// Le niveau « historique » et le niveau « catalogue » ne doivent pas etre
// fusionnes : un ecart dont les deux se contredisent doit porter DIVERGENCE.
for (const l of lignes) {
  if (l.statut === 'CONFORME' && (l.historique === 'ABSENTE' || l.catalogue === 'NON LU')) {
    erreurs.push(`CONFORME incompatible avec un historique absent ou un catalogue non lu : ${l.nom}`);
  }
}

// Une empreinte nulle = un dossier sans migration.sql : la matrice serait vide
// pour cette ligne sans que rien ne le signale.
for (const l of lignes) if (!l.sha) erreurs.push(`migration.sql illisible : ${l.nom}`);

/**
 * Prefixes d'horodatage en double.
 *
 * Quatre paires existent dans le depot, anterieures a ce chantier. Elles ne
 * bloquent pas `migrate deploy` (Prisma ordonne sur le NOM du dossier, pas sur
 * le prefixe), et les retirer reviendrait a reecrire l'historique — interdit.
 * Elles sont donc DECLAREES, pas tolerees en silence : la liste ci-dessous est
 * exacte, et toute cinquieme paire fait echouer ce script. C'est ce qui a
 * manque le 28/10, quand une collision `20261028150000` a mis la CI en echec
 * alors que quatre collisions dormaient deja dans le depot.
 */
const PREFIXES_DOUBLES_CONNUS = [
  '20261006120000',
  '20261006200000',
  '20261006220000',
  '20261017120000',
];
const prefixes = migrations.map((m) => m.slice(0, 14));
const doubles = [...new Set(prefixes.filter((p, i) => prefixes.indexOf(p) !== i))].sort();
for (const d of doubles) {
  if (!PREFIXES_DOUBLES_CONNUS.includes(d)) {
    erreurs.push(`NOUVEAU prefixe d horodatage en double : ${d}`);
  }
}
for (const d of PREFIXES_DOUBLES_CONNUS) {
  if (!doubles.includes(d)) {
    erreurs.push(`prefixe declare en double mais unique dans le depot : ${d} (liste a mettre a jour)`);
  }
}

// --- 3. Sorties -----------------------------------------------------------
if (process.argv.includes('--markdown')) {
  console.log('| # | Migration | Empreinte (12) | (a) Historique Prisma | (b) Catalogue observe | (c) SQL attendu | Nature | Statut | Suite |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  lignes.forEach((l, i) => {
    console.log(`| ${i + 1} | \`${l.nom}\` | \`${(l.sha ?? '').slice(0, 12)}\` | ${l.historique} | ${l.catalogue} | ${l.objet} | **${l.effets[0]}** | **${l.statut}** | ${l.suite} |`);
  });
} else {
  console.log('Matrice des migrations — etat recalcule depuis le depot\n');
  console.log(`  migrations du depot            : ${total}`);
  console.log(`  appliquees (attestees)         : ${appliquees}`);
  console.log(`    dont hors bande              : ${horsBande}`);
  console.log(`  annulees (rolled_back_at)      : ${annulees}`);
  console.log(`  absentes de l historique       : ${absentes}`);
  console.log(`  ecarts nommes                  : ${annulees + absentes}`);
  console.log(`  nouvelles (jamais deployees)   : ${nouvelles}`);
  console.log(`  arithmetique                   : ${appliquees + horsBande} + ${annulees} + ${absentes} + ${nouvelles} = ${total}`);
  console.log(`  prefixes en double (connus)    : ${doubles.length} / ${PREFIXES_DOUBLES_CONNUS.length} declares`);
  const mesures = lignes.filter((l) => l.effets[0] === 'MESURE').length;
  const deduits = lignes.filter((l) => l.effets[0] === 'DEDUIT').length;
  for (const st of ['CONFORME', 'DIVERGENCE', 'NON PROUVE', 'A QUALIFIER', 'NON DEPLOYEE']) {
    console.log(`  statut ${st.padEnd(11)}: ${lignes.filter((l) => l.statut === st).length}`);
  }
  // Les effets se comptent sur les 65 migrations CONCERNEES par le releve du
  // 28/10 : une migration ecrite apres n'a pas d'effet « non prouve », elle a
  // simplement jamais ete deployee.
  const concernes = total - nouvelles;
  console.log(`\n  effets MESURES      : ${mesures}`);
  console.log(`  effets DEDUITS      : ${deduits}`);
  console.log(`  effets NON PROUVES  : ${concernes - mesures - deduits}  (sur ${concernes})`);
  console.log('\n  (le statut d historique vient d une lecture de production ;');
  console.log('   il n est pas relu par ce script, qui ne se connecte a rien)');
}

if (erreurs.length > 0) {
  console.error('\nDIVERGENCES :');
  for (const e of erreurs) console.error(`  - ${e}`);
  process.exit(1);
}
if (!process.argv.includes('--markdown')) {
  console.log('\nLa matrice ferme : 65 migrations, 11 ecarts, 5 hors bande,');
  console.log('aucun nouveau prefixe en double.');
}
