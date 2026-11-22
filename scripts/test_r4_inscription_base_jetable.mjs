#!/usr/bin/env node
/**
 * R4 (P10.2) — la base créée par `reinitialiser_base_jetable` est INSCRITE.
 *
 * LE DÉFAUT QUE CE TEST FERME
 *
 * `reinitialiser_base_jetable` créait une base `tf_*` sans jamais appeler
 * `enregistrerRessource`. `nettoyer_ressources_jetables` ne détruit que ce
 * qu'un triplet (nom, OID, `system_identifier`) autorise : une base créée sans
 * trace était donc une ORPHELINE DÉFINITIVE. Mesure P10.1 : base `tf_p101_z`
 * créée, manifeste vide, `nettoyer` répond « aucun enregistrement : rien a
 * reprendre ».
 *
 * CE QUE CE TEST AJOUTE À `test_reprise_ressources_jetables.mjs`
 *
 * R6 (déjà couvert) prouve que la REPRISE fonctionne sur un manifeste écrit à
 * la main. R4 prouve que le CREATEUR écrit ce manifeste — c'est la moitié qui
 * manquait, et sans elle la reprise n'avait jamais rien à reprendre sur les
 * bases produites par l'outil lui-même.
 *
 * SCÉNARIOS
 *
 *   1. création nominale          → base créée ET inscrite (nom, OID, cluster,
 *                                   hôte, instant de démarrage du créateur)
 *   2. échec pendant la création  → la base est détruite : rien ne survit
 *   3. interruption avant reprise → l'orpheline est visible par `nettoyer`
 *   4. SIGKILL après création     → aucun `finally` n'a tourné ; la reprise ne
 *                                   dispose QUE des données durables
 *   5. reprise                    → `nettoyer --confirmer` détruit et prouve
 *   6. deux exécutions successives→ la seconde ne trouve plus rien
 *   7. créateur encore vivant     → ressource CONSERVÉE, puis reprise après
 *                                   sa mort (le PID seul ne suffit pas)
 *   8. balayage final             → aucune base de test résiduelle
 *
 * PRÉREQUIS : une base JETABLE désignée par DATABASE_URL, déjà propriétaire du
 * cluster. Le script crée et détruit des bases `tf_r4_*` sur ce cluster.
 *
 * Sorties : 0 conforme · 1 défaut · 2 prérequis manquant.
 */
import './lib/garde_import.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { deriverUrl } from './lib/ephemeral-db.mjs';
import { reinitialiserBaseJetable, detruireBaseProuvee } from './lib/base_jetable.mjs';
import { lireManifeste } from './lib/manifeste_jetable.mjs';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.env.DATABASE_URL;
const TRAVAIL = mkdtempSync(join(tmpdir(), 'r4-inscription-'));

let vertes = 0;
const rouges = [];
function verifier(libelle, condition, detail) {
  if (condition) {
    vertes += 1;
    console.log(`    ok    ${libelle}`);
  } else {
    rouges.push(libelle);
    console.log(`    ECHEC ${libelle}${detail ? ` — observé : ${detail}` : ''}`);
  }
}

const manifesteDe = (scenario) => join(TRAVAIL, `${scenario}.jsonl`);

function nettoyer(manifeste, { confirmer = false } = {}) {
  const args = [join(RACINE, 'scripts', 'nettoyer_ressources_jetables.mjs'), '--manifeste', manifeste];
  if (confirmer) args.push('--confirmer');
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, DATABASE_URL: URL, TF_MANIFESTE: manifeste },
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: r.status, sortie: `${r.stdout || ''}${r.stderr || ''}` };
}

const admin = new pg.Client({
  connectionString: deriverUrl(URL, 'postgres'),
  ssl: sslDepuisUrl(URL),
});
await admin.connect();

async function oidDe(nom) {
  const { rows } = await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [nom]);
  return rows.length === 0 ? null : String(rows[0].oid);
}

async function basesR4() {
  const { rows } = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'tf\\_r4\\_%' ORDER BY 1");
  return rows.map((r) => r.datname);
}

async function dropBrut(nom) {
  if (await oidDe(nom)) await admin.query(`DROP DATABASE IF EXISTS "${nom}" WITH (FORCE)`);
}

/** Écrit un enfant qui appelle le VRAI helper, puis meurt comme demandé. */
function ecrireEnfant(nomFichier, corps) {
  const chemin = join(TRAVAIL, nomFichier);
  writeFileSync(chemin, corps, 'utf8');
  return chemin;
}

const ENTETE = `import { reinitialiserBaseJetable } from ${JSON.stringify(join(RACINE, 'scripts', 'lib', 'base_jetable.mjs'))};\n`;
const restes = new Set();

try {
  const avant = await basesR4();
  console.log(`  bases tf_r4_* présentes au départ : ${avant.length === 0 ? 'aucune' : avant.join(', ')}`);

  // ---------------------------------------------------------------- 1
  console.log('\n  1. création nominale : la base est créée ET inscrite');
  {
    const nom = 'tf_r4_nominale';
    restes.add(nom);
    const man = manifesteDe('1-nominal');
    process.env.TF_MANIFESTE = man;
    const r = await reinitialiserBaseJetable({ urlProprietaire: URL, nom });

    const e = lireManifeste(man).find((x) => x.genre === 'base' && x.nom === nom);
    verifier('une entrée est inscrite au manifeste', Boolean(e), 'aucune entrée');
    verifier('l entrée porte l OID réel de la base', e?.oid === String(r.oidApres), `${e?.oid} vs ${r.oidApres}`);
    const sysid = (await admin.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier;
    verifier('l entrée porte le system_identifier du cluster', e?.systemIdentifier === String(sysid), e?.systemIdentifier);
    verifier('l entrée porte l hôte et l instant de démarrage du créateur',
      Boolean(e?.hote) && Boolean(e?.pid_debut), `hote=${e?.hote} pid_debut=${e?.pid_debut}`);
    verifier('le retour du helper confirme l inscription', r.tracee === true);

    await detruireBaseProuvee({ urlProprietaire: URL, nom, oid: r.oidApres });
    verifier('la base est détruite par le chemin prouvé (OID relevé)', (await oidDe(nom)) === null);
    restes.delete(nom);
  }

  // ---------------------------------------------------------------- 2
  console.log('\n  2. échec pendant la création : rien ne survit');
  {
    const nom = 'tf_r4_echec';
    // Manifeste impossible à écrire : /proc n'accepte aucune création de fichier.
    process.env.TF_MANIFESTE = '/proc/manifeste-impossible.jsonl';
    let message = '';
    try {
      await reinitialiserBaseJetable({ urlProprietaire: URL, nom });
    } catch (e) {
      message = e.message;
    }
    verifier('la création échoue explicitement quand la trace est impossible',
      /NON inscrite au manifeste/.test(message), message.slice(0, 140) || 'aucune erreur');
    verifier('la base n a PAS été laissée derrière (fail-closed)', (await oidDe(nom)) === null);
  }

  // ---------------------------------------------------------------- 3, 4, 5, 6
  console.log('\n  3+4+5+6. SIGKILL après création, puis reprise');
  {
    const nom = 'tf_r4_sigkill';
    restes.add(nom);
    const man = manifesteDe('4-sigkill');
    const enfant = ecrireEnfant('enfant_sigkill.mjs', `${ENTETE}
const r = await reinitialiserBaseJetable({ urlProprietaire: process.env.DATABASE_URL, nom: process.env.TF_NOM });
console.log('CREEE ' + r.oidApres);
process.kill(process.pid, 'SIGKILL');
`);
    const res = spawnSync(process.execPath, [enfant], {
      env: { ...process.env, DATABASE_URL: URL, TF_MANIFESTE: man, TF_NOM: nom },
      encoding: 'utf8', timeout: 120000,
    });
    const oid = (res.stdout || '').match(/CREEE (\d+)/)?.[1];
    verifier('l enfant a créé la base puis est mort par SIGKILL', Boolean(oid), res.stdout || res.stderr);
    verifier('la base survit à l interruption (aucun nettoyage n a pu tourner)',
      (await oidDe(nom)) === String(oid));

    const entrees = lireManifeste(man);
    verifier('la trace durable existe malgré le SIGKILL', entrees.some((x) => x.nom === nom),
      `${entrees.length} entrée(s)`);

    const sim = nettoyer(man);
    verifier('3. nettoyer voit l orpheline en simulation',
      new RegExp(`→ base ${nom}`).test(sim.sortie), sim.sortie.split('\n').slice(-4).join(' | '));
    verifier('3. la simulation ne détruit rien', (await oidDe(nom)) !== null);

    const conf = nettoyer(man, { confirmer: true });
    verifier('5. la reprise détruit l orpheline',
      conf.code === 0 && /destruction prouvee/.test(conf.sortie),
      `exit=${conf.code} ${conf.sortie.split('\n').slice(-3).join(' | ')}`);
    verifier('5. la base a réellement disparu', (await oidDe(nom)) === null);

    const encore = nettoyer(man, { confirmer: true });
    verifier('6. seconde exécution : plus rien à reprendre, sortie 0',
      encore.code === 0 && /rien a reprendre|deja absente/.test(encore.sortie),
      `exit=${encore.code} ${encore.sortie.split('\n').slice(-2).join(' | ')}`);
    restes.delete(nom);
  }

  // ---------------------------------------------------------------- 7
  console.log('\n  7. créateur vivant : ressource CONSERVÉE, puis reprise après sa mort');
  {
    const nom = 'tf_r4_vivante';
    restes.add(nom);
    const man = manifesteDe('7-vivante');
    const enfant = ecrireEnfant('enfant_vivant.mjs', `${ENTETE}
const r = await reinitialiserBaseJetable({ urlProprietaire: process.env.DATABASE_URL, nom: process.env.TF_NOM });
console.log('CREEE ' + r.oidApres);
setInterval(() => {}, 1000);
`);
    const proc = spawn(process.execPath, [enfant], {
      env: { ...process.env, DATABASE_URL: URL, TF_MANIFESTE: man, TF_NOM: nom },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const oid = await new Promise((resolve) => {
      let tampon = '';
      proc.stdout.on('data', (d) => {
        tampon += d.toString();
        const m = tampon.match(/CREEE (\d+)/);
        if (m) resolve(m[1]);
      });
      setTimeout(() => resolve(null), 60000);
    });
    verifier('l enfant vit et détient une base inscrite', Boolean(oid), `oid=${oid}`);

    const res = nettoyer(man, { confirmer: true });
    verifier('la reprise CONSERVE la ressource vivante',
      res.code === 0 && /CONSERVEES/.test(res.sortie), res.sortie.split('\n').slice(-4).join(' | '));
    verifier('la base vivante est toujours là', (await oidDe(nom)) === String(oid));

    proc.kill('SIGKILL');
    await new Promise((resolve) => proc.on('exit', resolve));
    const apres = nettoyer(man, { confirmer: true });
    verifier('créateur mort, la même reprise détruit la base',
      apres.code === 0 && /destruction prouvee/.test(apres.sortie),
      apres.sortie.split('\n').slice(-3).join(' | '));
    verifier('la base vivante a disparu après reprise', (await oidDe(nom)) === null);
    restes.delete(nom);
  }
} catch (e) {
  console.log(`\n  INTERRUPTION — ${e.message}`);
  rouges.push(`interruption : ${e.message}`);
} finally {
  console.log('\n  8. balayage final : aucune base de test résiduelle');
  for (const nom of restes) await dropBrut(nom).catch(() => {});
  const restants = await basesR4();
  verifier('aucune base tf_r4_* ne subsiste', restants.length === 0, restants.join(', '));
  await admin.end().catch(() => {});
}

console.log('\n  --------------------------------------------');
console.log(`  ${vertes}/${vertes + rouges.length} assertions vertes`);
if (rouges.length > 0) {
  console.log(`  en échec : ${rouges.join(' · ')}\n`);
  process.exit(1);
}
console.log('  ok — les bases jetables créées par l outil sont inscrites et reprenables.\n');
process.exit(0);
