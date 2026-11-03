#!/usr/bin/env node
/**
 * P10.6 — LA CHAÎNE DE MIGRATIONS EST-ELLE REJOUABLE DANS UN MÊME CLUSTER ?
 *
 * LE DÉFAUT QUE CE TEST EMPÊCHE DE REVENIR (D5, mesuré le 02/11/2026)
 *
 * La migration `20261028120100` fait, en § 6, `GRANT tracefab_worker TO
 * current_user`, puis § 6 bis le `REVOKE`. PostgreSQL refuse cette révocation
 * dès qu'un AUTRE rôle est membre de `tracefab_worker` : `2BP01 dependent
 * privileges exist`. Or le rattrapage `apres` de l'exécution précédente créait
 * exactement ce membre. Résultat mesuré : la chaîne passait UNE fois par
 * cluster, puis TOUTE nouvelle base jetable échouait — et les suites qui créent
 * leur propre base tombaient en cascade (`test_privileges_role_app`,
 * `test_provisioning_role_app`, `test_verrou_cluster`).
 *
 * La correction vit dans l'OUTIL (`preparerAppartenance`), pas dans la
 * migration publiée. Ce test vérifie les deux :
 *
 *   R1  registre : toute entrée qui accorde une appartenance (`apres`) doit
 *       fournir un bloc `avant`, sinon la chaîne n'est rejouable qu'une fois
 *       par cluster ;
 *   R2  registre : le bloc `avant` ne peut pas révoquer le rôle exécutant
 *       lui-même, et il borne les membres qu'il retire à un motif ;
 *   R3  `preparerAppartenance` est idempotente (deux appels, même état) ;
 *   R4  elle RÉVOQUE un membre `tracefab_*` hors périmètre, et le cluster
 *       revient à l'état attendu ;
 *   R5  elle LÈVE sur un membre étranger au lieu de le retirer en silence ;
 *   R6  la chaîne complète s'applique sur une base VIERGE d'un cluster où elle
 *       s'est déjà appliquée ailleurs — c'est la mesure du défaut D5 ;
 *   R7  la base de travail est détruite, l'appartenance finale est conforme
 *       (exécutant membre, `tracefab_app` membre de rien, aucun `tf_*`).
 *
 * Sortie : 0 conforme · 1 régression · 2 non exécuté · 3 refus de cible.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { verrouillerCluster } from './lib/ephemeral-db.mjs';
import { MIGRATIONS_ASSISTEES, exigeAssistance, preparerAppartenance } from './lib/migrations_assistees.mjs';
import { fonctionsCibles, propriétairesInjoignables } from './lib/preflight_proprietaires.mjs';

const urlAdmin = (process.env.DATABASE_URL || '').trim();
if (!urlAdmin) {
  console.error('  NON EXECUTE — DATABASE_URL est requise.');
  process.exit(2);
}
const hote = (() => { try { return new URL(urlAdmin).hostname; } catch { return ''; } })();
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote)) {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}).`);
  process.exit(3);
}
const url = new URL(urlAdmin);
const roleExecutant = decodeURIComponent(url.username) || 'postgres';

let echecs = 0;
let assertions = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

// ---------------------------------------------------------------------------
// R1/R2 — cohérence du registre, sans toucher à aucune base
// ---------------------------------------------------------------------------
console.log('  -- registre des migrations assistées');
for (const [nom, entree] of Object.entries(MIGRATIONS_ASSISTEES)) {
  if (entree.apres) {
    ok(Boolean(entree.avant),
      `R1 ${nom} accorde une appartenance et fournit donc un bloc « avant »`,
      entree.avant ? 'présent' : 'ABSENT — la chaîne ne serait rejouable qu une fois');
    ok(Boolean(entree.raison) && entree.raison.length > 40,
      `R1 ${nom} documente la mesure qui justifie son assistance`,
      `${(entree.raison || '').length} caractères`);
  }
  if (entree.avant) {
    const { appartenance, conserver, motifAutorise } = entree.avant;
    ok(Boolean(appartenance) && Boolean(conserver) && Boolean(motifAutorise),
      `R2 ${nom} : appartenance, conserver et motifAutorise sont tous déclarés`,
      `${appartenance} · ${conserver} · ${motifAutorise}`);
    ok(!String(conserver).includes('%ROLE%') || !String(appartenance).startsWith(String(conserver)),
      `R2 ${nom} : le bloc « avant » ne révoque pas l exécutant`,
      String(conserver));
    ok(/^\^.*\$$/.test(String(motifAutorise || '')),
      `R2 ${nom} : le motif d appartenance est ancré (aucun rôle étranger retiré par accident)`,
      String(motifAutorise));
  }
}
ok(exigeAssistance('ce_nom_n_existe_pas') === false,
  'R2 une migration hors registre n est PAS assistée (pas de bascule silencieuse)');

// ---------------------------------------------------------------------------
// R3/R4/R5 — comportement de la préparation, sur le cluster réel
// ---------------------------------------------------------------------------
const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-p106-rejouable' });
await admin.connect();

const nomAssistee = Object.keys(MIGRATIONS_ASSISTEES).find((n) => MIGRATIONS_ASSISTEES[n].avant);
console.log('  -- préparation d appartenance');
let rolesSondes = [];
try {
  if (!nomAssistee) {
    ok(false, 'R3 aucune migration assistée avec bloc « avant » à mesurer');
  } else {
    const cible = MIGRATIONS_ASSISTEES[nomAssistee].avant.appartenance;
    const etat = async () => (await admin.query(
      `SELECT r.rolname FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid = m.member
         JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
        WHERE c.rolname = $1 ORDER BY 1`, [cible])).rows.map((r) => r.rolname);

    const r3a = await preparerAppartenance(admin, nomAssistee, roleExecutant);
    const etatA = await etat();
    const r3b = await preparerAppartenance(admin, nomAssistee, roleExecutant);
    const etatB = await etat();
    ok(JSON.stringify(etatA) === JSON.stringify(etatB),
      'R3 preparerAppartenance est idempotente (second appel sans effet)',
      `premier=${r3a.revoques.length} révoqué(s) · second=${r3b.revoques.length}`);
    ok(etatB.every((m) => m === roleExecutant),
      'R3 après préparation, seul l exécutant peut rester membre (rien d autre n est épargné)',
      etatB.join(', ') || 'aucun membre');

    // R4 : on pose deux membres `tracefab_*` de sonde, la préparation doit les retirer.
    // Le motif du registre n accepte que des minuscules et des soulignés :
    // la sonde doit rester dans le périmètre, sinon elle mesure le refus (R5).
    const lettres = () => randomBytes(3).toString('hex').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]);
    for (const suffixe of ['a', 'b']) {
      const nom = `tracefab_sonde_${suffixe}_${lettres()}`;
      await admin.query(`CREATE ROLE ${nom}`);
      await admin.query(`GRANT ${cible} TO ${nom}`);
      rolesSondes.push(nom);
    }
    const avant = await etat();
    const r4 = await preparerAppartenance(admin, nomAssistee, roleExecutant);
    const apres = await etat();
    ok(!apres.some((m) => rolesSondes.includes(m)) && r4.revoques.length >= 2,
      'R4 les membres tracefab_* hors périmètre sont révoqués (chaîne rejouable)',
      `avant=${avant.join(',')} · après=${apres.join(',') || 'aucun'}`);

    // R4 bis (P10.7) : un membre SUPERUSER est RETIRÉ sans refus.
    //
    // Mesuré le 02/11 : sur un cluster partagé, `apres` avait accordé
    // `tracefab_worker` à `postgres` lors d'une exécution précédente. La
    // préparation, qui ne retirait que les rôles `tracefab_*`, refusait alors la
    // chaîne au rang 61 — pour un rôle dont l'appartenance n'est PAS une
    // frontière de privilège (il peut tout s'accorder lui-même). Le retirer
    // n'ôte aucune capacité ; le garder rendait la chaîne non rejouable.
    const superRole = `p107_super_${randomBytes(3).toString('hex')}`;
    await admin.query(`CREATE ROLE ${superRole} SUPERUSER`);
    await admin.query(`GRANT ${cible} TO ${superRole}`);
    rolesSondes.push(superRole);
    let refusSuper = null;
    let revoqueSuper = [];
    try {
      revoqueSuper = (await preparerAppartenance(admin, nomAssistee, roleExecutant)).revoques;
    } catch (e) {
      refusSuper = e.message;
    }
    ok(refusSuper === null && revoqueSuper.includes(superRole),
      'R4 bis un membre SUPERUSER est retiré sans refus (son appartenance n est pas une frontière)',
      refusSuper || `révoqué : ${revoqueSuper.join(', ') || 'aucun'}`);

    // R5 : un membre étranger doit FAIRE ÉCHOUER la préparation.
    const etranger = `p106_etranger_${randomBytes(2).toString('hex')}`;
    await admin.query(`CREATE ROLE ${etranger}`);
    await admin.query(`GRANT ${cible} TO ${etranger}`);
    rolesSondes.push(etranger);
    let leve = false;
    let message = '';
    try {
      await preparerAppartenance(admin, nomAssistee, roleExecutant);
    } catch (e) {
      leve = true;
      message = (e.message || '').slice(0, 60);
    }
    ok(leve, 'R5 un membre étranger fait ÉCHOUER la préparation au lieu d être retiré', message || 'aucune erreur');
    const toujours = (await etat()).includes(etranger);
    ok(toujours, 'R5 le membre étranger est CONSERVÉ (on ne révoque pas ce qu on n a pas accordé)', etranger);
  }
} finally {
  // Purge des rôles de sonde : d'abord leurs appartenances, puis le rôle.
  for (const nom of rolesSondes) {
    await admin.query(`DROP OWNED BY ${nom}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${nom}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// R8 — préflight de PROPRIÉTÉ des fonctions visées (défaut D6, mesuré)
//
// `CREATE OR REPLACE FUNCTION` exige d'être le propriétaire. Une chaîne jouée
// par le rôle de migration ne peut donc remplacer que les fonctions qu'il a
// créées ; sur une base où elles appartiennent à un autre rôle, l'échec
// tomberait au MILIEU de la chaîne. Le préflight doit refuser AVANT, sur la
// seule foi du catalogue — et ne rien refuser quand l'exécutant est le
// propriétaire.
// ---------------------------------------------------------------------------
console.log('  -- préflight de propriété des fonctions');
{
  const sql = `CREATE OR REPLACE FUNCTION public.tracefab_current_user_id() RETURNS uuid
               LANGUAGE sql AS 'SELECT NULL::uuid';
               CREATE OR REPLACE FUNCTION public.tracefab_fonction_a_venir() RETURNS int
               LANGUAGE sql AS 'SELECT 1';`;
  const cibles = fonctionsCibles(sql);
  ok(cibles.length === 2 && cibles[0] === 'tracefab_current_user_id',
    'R8 les fonctions visées sont lues dans le fichier de migration', cibles.join(', '));

  const pourAdmin = await propriétairesInjoignables(
    admin, roleExecutant, [{ nom: 'sonde', sql }],
  );
  ok(pourAdmin.length === 0,
    'R8 le propriétaire des fonctions n est pas bloqué (aucun faux refus)',
    pourAdmin.map((e) => e.fonction).join(', ') || 'aucun écart');

  const pourMigrator = await propriétairesInjoignables(
    admin, 'tracefab_migrator', [{ nom: 'sonde', sql }],
  );
  const attendu = pourMigrator.some((e) => e.fonction === 'tracefab_current_user_id' && e.proprietaire === 'postgres');
  ok(attendu,
    'R8 un exécutant qui ne peut pas endosser le propriétaire est REFUSÉ avant la chaîne',
    pourMigrator.map((e) => `${e.fonction}→${e.proprietaire}`).join(', ') || 'aucun écart');
  ok(!pourMigrator.some((e) => e.fonction === 'tracefab_fonction_a_venir'),
    'R8 une fonction qui n existe pas encore n est pas un écart (création légitime)',
    pourMigrator.map((e) => e.fonction).join(', '));

  const assistee = await propriétairesInjoignables(
    admin, 'tracefab_migrator', [{ nom: 'sonde', sql, assistee: true }],
  );
  ok(assistee.length === 0,
    'R8 une migration déclarée assistée n est pas préemptée par le préflight (élévation bornée)',
    assistee.map((e) => e.fonction).join(', ') || 'aucun écart');
}

// ---------------------------------------------------------------------------
// R6/R7 — la chaîne complète, sur une base VIERGE du même cluster
// ---------------------------------------------------------------------------
console.log('  -- chaîne complète sur une base vierge du même cluster');
const baseTravail = `tracefab_p106_rejouable_${randomBytes(3).toString('hex')}`;
const urlBase = new URL(urlAdmin);
urlBase.pathname = `/${baseTravail}`;

// Cette suite provisionne un rôle sur un cluster PARTAGÉ avec les autres
// suites : elle prend donc le verrou de cluster autour du provisioning, comme
// `test_p105_roles_et_migrations.mjs`. Le verrou est RELÂCHÉ avant d'appeler
// `migrer_fidelement.mjs`, qui prend le sien : un verrou consultatif n'est pas
// réentrant, et le garder ici ferait attendre la chaîne jusqu'au délai
// (mesuré : 600 s, aucune sortie).
let verrou = null;
try {
  await admin.query(`CREATE DATABASE ${baseTravail}`);
  ok(true, 'R6 base de travail créée', baseTravail);

  // Le rôle applicatif est un objet de CLUSTER : il préexiste ici, ce qui est
  // exactement la situation d'une seconde base jetable.
  let bootstrap;
  try {
    verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
    bootstrap = spawnSync(process.execPath, ['scripts/bootstrap_app_role.mjs'], {
      env: { ...process.env, DATABASE_URL: urlBase.toString(), TF_APP_PASSWORD: process.env.TF_APP_PASSWORD || 'p106_jetable' },
      encoding: 'utf8',
    });
  } finally {
    if (verrou) { await verrou.relacher(); verrou = null; }
  }
  ok(bootstrap.status === 0, 'R6 rôle applicatif disponible avant la chaîne',
    (bootstrap.stderr || bootstrap.stdout || '').trim().split('\n').pop() || `code ${bootstrap.status}`);

  const chaine = spawnSync(process.execPath, ['scripts/migrer_fidelement.mjs'], {
    env: { ...process.env, DATABASE_URL: urlBase.toString(), TF_ALLOW_WRITE: 'oui' },
    encoding: 'utf8',
  });
  const sortie = `${chaine.stdout || ''}${chaine.stderr || ''}`.trim().split('\n');
  ok(chaine.status === 0, 'R6 la chaîne s applique sur une base neuve d un cluster déjà migré (défaut D5)',
    chaine.status === 0 ? sortie.filter((l) => /appliquee\(s\)/.test(l)).pop() : sortie.filter((l) => /ECHEC/.test(l)).slice(-1)[0]);

  const client = new pg.Client({ connectionString: urlBase.toString(), ssl: sslDepuisUrl(urlBase.toString()) });
  await client.connect();
  try {
    const appliquees = (await client.query(
      'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows[0].n;
    ok(appliquees >= 60, 'R6 toutes les migrations sont appliquées', `${appliquees} migration(s)`);

    const membres = (await client.query(
      `SELECT r.rolname FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid = m.member
         JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
        WHERE c.rolname = 'tracefab_worker' ORDER BY 1`)).rows.map((r) => r.rolname);
    ok(membres.length === 1 && membres[0] === roleExecutant,
      'R7 appartenance finale conforme : seul l exécutant est membre de tracefab_worker',
      membres.join(', ') || 'aucun');

    const appMembre = (await client.query(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid = m.member
        WHERE r.rolname = 'tracefab_app'`)).rows[0].n;
    ok(appMembre === 0, 'R7 tracefab_app n hérite d aucune appartenance', `${appMembre} appartenance(s)`);

    const attributs = (await client.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_catalog.pg_roles
        WHERE rolname IN ('tracefab_app', 'tracefab_worker') ORDER BY 1`)).rows;
    ok(attributs.length === 2 && attributs.every((r) => !r.rolsuper && !r.rolbypassrls),
      'R7 aucun rôle runtime n est SUPERUSER ni BYPASSRLS',
      attributs.map((r) => `${r.rolname}:${r.rolsuper ? 'SUPER' : 'ok'}/${r.rolbypassrls ? 'BYPASS' : 'ok'}`).join(' '));
  } finally {
    await client.end();
  }
} catch (e) {
  ok(false, 'R6 la chaîne a pu être mesurée', (e.message || '').split('\n')[0].slice(0, 80));
} finally {
  // R7 — la base de travail disparaît, quoi qu'il arrive.
  const destruction = await admin.query(
    `SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
      WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`, [baseTravail]).catch(() => ({ rows: [] }));
  void destruction;
  await admin.query(`DROP DATABASE IF EXISTS ${baseTravail} WITH (FORCE)`).catch((e) => {
    console.error(`  info  destruction de ${baseTravail} : ${e.message}`);
  });
  const restantes = (await admin.query(
    'SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [baseTravail])).rows[0].n;
  ok(restantes === 0, 'R7 la base de travail est détruite (aucune base résiduelle)', `${restantes} restante(s)`);
  if (verrou) await verrou.relacher();
}

await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  P10.6 rejouabilite de la chaine : ${assertions} assertions — rejouable dans un meme cluster.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
