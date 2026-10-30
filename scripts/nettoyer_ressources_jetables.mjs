#!/usr/bin/env node
/**
 * Reprise apres interruption brutale — ressources jetables orphelines (R6).
 *
 * CE QUE CE SCRIPT NE FAIT PAS
 *
 * Il ne supprime RIEN sur la foi d'un prefixe. Un `DROP` pilote par un motif
 * `tf_%` transformerait une reprise en effaceur : n'importe quelle base nommee
 * `tf_…` par un humain, une restauration ou une autre suite y passerait.
 *
 * CE QU'IL EXIGE
 *
 * Chaque destruction est autorisee par un TRIPLET enregistre au moment de la
 * creation (voir `lib/manifeste_jetable.mjs`) :
 *
 *   — le `system_identifier` du cluster doit etre CELUI d'aujourd'hui ;
 *   — le nom doit figurer au manifeste ;
 *   — l'OID relu en direct doit etre EXACTEMENT celui du manifeste.
 *
 * Une base renommee, recreee ou appartenant a un autre cluster est refusee. Un
 * refus porte sur l'ensemble du lot : on ne detruit pas la moitie de ce qu'on a
 * su prouver, on s'arrete et on explique.
 *
 * USAGE
 *
 *   node scripts/nettoyer_ressources_jetables.mjs                  # simulation
 *   node scripts/nettoyer_ressources_jetables.mjs --confirmer     # destruction
 *   node scripts/nettoyer_ressources_jetables.mjs --manifeste /tmp/x.jsonl
 *
 * VARIABLES
 *   DATABASE_URL   cible jetable (obligatoire, reclassifiee ici)
 *   TF_MANIFESTE   chemin du manifeste (defaut : <tmp>/tracefab-jetables.jsonl)
 *
 * SORTIES
 *   0  rien a faire, ou destruction prouvee terminee
 *   1  echec inattendu
 *   2  refus de la garde de cible (aucune connexion metier)
 *   3  verification refusee : AUCUNE ressource touchee
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { classifyTarget, requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { deriverUrl, avecVerrouDeCluster, identiteServeur } from './lib/ephemeral-db.mjs';
import { cheminManifeste, lireManifeste } from './lib/manifeste_jetable.mjs';

const argv = process.argv.slice(2);
const confirmer = argv.includes('--confirmer');
const iManifeste = argv.indexOf('--manifeste');
const manifeste = iManifeste === -1 ? cheminManifeste() : argv[iManifeste + 1];

/** Bases et roles qu'aucune reprise ne touchera, meme cites au manifeste. */
const PROTEGES = new Set([
  'postgres', 'template0', 'template1', 'tracefab_test', 'tracefab_compteurs_debit',
  'tracefab_app', 'tracefab_worker', 'neondb', 'neondb_owner',
]);
const NOM_JETABLE = /^tf_[a-z0-9_]+$/;

const ident = (v) => '"' + String(v).replace(/"/g, '""') + '"';

const urlProprietaire = (process.env.DATABASE_URL || '').trim();
if (!urlProprietaire) {
  console.error('  REFUS — DATABASE_URL absent : la reprise a besoin d une cible classee.');
  process.exit(2);
}

const verdict = classifyTarget(urlProprietaire);
if (!verdict.allowed) {
  console.error(`  REFUS — cible non jetable (${verdict.code}) : ${verdict.reason}`);
  process.exit(2);
}
requireThrowawayDb({ variables: ['DATABASE_URL'], purpose: 'reprise des ressources jetables', exitOnFailure: true });

const urlMaintenance = deriverUrl(urlProprietaire, 'postgres');
if (!classifyTarget(urlMaintenance).allowed) {
  console.error('  REFUS — la connexion de maintenance n est pas classable comme jetable.');
  process.exit(2);
}

const admin = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await admin.connect();

let code = 0;
try {
  const identite = await identiteServeur(admin);
  console.log(`  cluster  : system_identifier=${identite.systemIdentifier} ${identite.adresse}:${identite.port}`);
  console.log(`  manifeste: ${manifeste}`);
  console.log(`  mode     : ${confirmer ? 'DESTRUCTION (--confirmer)' : 'simulation (defaut)'}\n`);

  const entrees = lireManifeste(manifeste);
  if (entrees.length === 0) {
    console.log('  aucun enregistrement : rien a reprendre, rien a detruire.');
    process.exit(0);
  }

  // Derniere entree par (genre, nom) : un nom reutilise ne doit pas etre
  // confondu avec sa vie anterieure.
  const derniere = new Map();
  for (const e of entrees) derniere.set(`${e.genre}:${e.nom}`, e);

  const aDetruire = [];
  const refus = [];
  const dejaAbsentes = [];

  for (const e of derniere.values()) {
    const cle = `${e.genre}:${e.nom}`;
    if (PROTEGES.has(e.nom)) {
      refus.push(`${cle} — nom protege : jamais detruit par une reprise`);
      continue;
    }
    if (!NOM_JETABLE.test(e.nom)) {
      refus.push(`${cle} — nom hors format jetable (tf_[a-z0-9_]+)`);
      continue;
    }
    if (e.systemIdentifier !== identite.systemIdentifier) {
      refus.push(`${cle} — enregistre sur le cluster ${e.systemIdentifier}, pas sur celui-ci`);
      continue;
    }

    if (e.genre === 'base') {
      const { rows } = await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [e.nom]);
      if (rows.length === 0) { dejaAbsentes.push(cle); continue; }
      if (String(rows[0].oid) !== e.oid) {
        refus.push(`${cle} — OID actuel ${rows[0].oid} ≠ OID cree ${e.oid} (base recreee : pas la notre)`);
        continue;
      }
      aDetruire.push(e);
    } else if (e.genre === 'role') {
      const { rows } = await admin.query(`
        SELECT r.oid,
               (SELECT count(*)::int FROM pg_shdepend d
                 WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid
                   AND d.deptype = 'o') AS objets
          FROM pg_roles r WHERE r.rolname = $1`, [e.nom]);
      if (rows.length === 0) { dejaAbsentes.push(cle); continue; }
      if (String(rows[0].oid) !== e.oid) {
        refus.push(`${cle} — OID actuel ${rows[0].oid} ≠ OID cree ${e.oid} (role recree : pas le notre)`);
        continue;
      }
      if (rows[0].objets > 0) {
        refus.push(`${cle} — le role possede ${rows[0].objets} objet(s) : destruction refusee`);
        continue;
      }
      aDetruire.push(e);
    } else {
      refus.push(`${cle} — genre inconnu (${e.genre})`);
    }
  }

  if (refus.length > 0) {
    console.log('  REFUS — le lot n est pas entierement prouve : AUCUNE ressource touchee.\n');
    for (const r of refus) console.log(`    ✗ ${r}`);
    code = 3;
  } else if (aDetruire.length === 0) {
    console.log('  rien a reprendre.');
    for (const c of dejaAbsentes) console.log(`    · ${c} — deja absente`);
  } else {
    for (const e of aDetruire) {
      console.log(`    → ${e.genre} ${e.nom} (oid=${e.oid}, cree le ${e.cree_le ?? '?'} par ${e.createur ?? '?'})`);
    }
    for (const c of dejaAbsentes) console.log(`    · ${c} — deja absente`);

    if (!confirmer) {
      console.log('\n  simulation : rien n a ete detruit. Relancer avec --confirmer pour appliquer.');
    } else {
      await avecVerrouDeCluster({ urlProprietaire, urlMaintenance }, async () => {
        for (const e of aDetruire) {
          if (e.genre === 'base') {
            await admin.query(`DROP DATABASE ${ident(e.nom)} WITH (FORCE)`);
          } else {
            await admin.query(`DROP ROLE ${ident(e.nom)}`);
          }
          console.log(`    ✓ ${e.genre} ${e.nom} detruit`);
        }
      });

      // Preuve d'absence : ce qui reste serait un mensonge du journal.
      for (const e of aDetruire) {
        const [base, role] = e.genre === 'base'
          ? [(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [e.nom])).rowCount,
            (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [e.nom])).rowCount]
          : [(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [e.nom])).rowCount,
            (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [e.nom])).rowCount];
        if (base !== 0 || role !== 0) {
          throw new Error(`${e.genre} ${e.nom} toujours present apres destruction`);
        }
      }
      console.log(`\n  destruction prouvee : ${aDetruire.length} ressource(s), absence verifiee.`);
    }
  }
} catch (e) {
  console.error(`  ECHEC — ${e.code ?? ''} ${String(e.message).split('\n')[0]}`);
  code = e.exitCode === 3 ? 3 : 1;
} finally {
  await admin.end().catch(() => {});
}

process.exit(code);
