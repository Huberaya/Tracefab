#!/usr/bin/env node
/**
 * Epreuve COMPORTEMENTALE du rapport d'ecarts de privileges.
 *
 * Le test statique scripts/test_lire_disponibilite_role_app.mjs verifie que le
 * script compare a la liste declaree. Il ne prouve pas que la comparaison
 * DETECTE quelque chose. Ce script le prouve en provoquant les deux ecarts sur
 * une base jetable, en mesurant la sortie, puis en restaurant l'etat initial.
 *
 * Pourquoi les deux sens :
 *   - sur-privilege  : du DML accorde sur une table absente de la liste. C'est
 *     le cas dangereux — une route pourrait ecrire hors du perimetre prevu.
 *   - sous-privilege : une table declaree sans DML. Sur une cible distante,
 *     c'est le plus souvent le signe d'une base en retard de migrations, et le
 *     rapport doit le dire au lieu de le noyer dans un total.
 *
 * Un test qui ne verifierait que le sens « tout va bien » passerait au vert
 * avec un rapport muet. Les deux controles negatifs sont donc obligatoires.
 *
 * Lance via scripts/run-db-suite.mjs : la garde de cible s'applique.
 * Sortie : 0 = tout vert, 1 = au moins un echec.
 */
import process from 'node:process';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { TABLES_ECRITURE_DIRECTE } from './lib/tracefab_app_role.mjs';

const ICI = dirname(fileURLToPath(import.meta.url));
const LECTEUR = resolve(ICI, 'lire-disponibilite-role-app.mjs');

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\n  NON EXECUTE — DATABASE_URL est absente.\n');
  process.exit(2);
}
const ROLE = process.env.TF_CIBLE_ROLE || 'tracefab_app';

let vertes = 0;
const echecs = [];
const ok = (m) => { vertes++; console.log(`  ok    ${m}`); };
const ko = (m) => { echecs.push(m); console.log(`  ECHEC ${m}`); };
const verifier = (c, m) => (c ? ok(m) : ko(m));

const admin = new pg.Client({ connectionString: url });
await admin.connect();

// --- Choix des tables temoins, depuis l'etat reel de la base ---
const tables = (await admin.query(`
  SELECT c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
  ORDER BY 1`)).rows.map((r) => r.relname);

const declares = new Set(TABLES_ECRITURE_DIRECTE);
const temoinDeclare = TABLES_ECRITURE_DIRECTE.find((t) => tables.includes(t));
const temoinHorsListe = tables.find((t) => !declares.has(t));

if (!temoinDeclare || !temoinHorsListe) {
  console.log('  NON EXECUTE — impossible de choisir deux tables temoins distinctes.');
  await admin.end();
  process.exit(2);
}

const privileges = async (table) => {
  const r = await admin.query(
    `SELECT has_table_privilege($1, $2, 'INSERT') i,
            has_table_privilege($1, $2, 'UPDATE') u,
            has_table_privilege($1, $2, 'DELETE') d`,
    [ROLE, `public.${table}`],
  );
  return r.rows[0];
};
// `table` vient du catalogue, `ROLE` de l'environnement : les deux sont
// encadres et leurs guillemets doubles sont doubles, comme le fait quote_ident.
const ident = (nom) => `"${String(nom).replace(/"/g, '""')}"`;
const appliquer = async (table, accorder) => {
  const deja = (await privileges(table)).i;
  if (deja === accorder) return; // deja dans l'etat voulu : ne rien toucher
  await admin.query(
    `${accorder ? 'GRANT' : 'REVOKE'} INSERT, UPDATE, DELETE ON public.${ident(table)}`
      + ` ${accorder ? 'TO' : 'FROM'} ${ident(ROLE)}`,
  );
};

// --- Etat initial : c'est lui qui sera restaure, pas une hypothese ---
const avant = {
  declaree: await privileges(temoinDeclare),
  horsListe: await privileges(temoinHorsListe),
};

const executer = () =>
  new Promise((finir) => {
    const fils = spawn(process.execPath, [LECTEUR], { env: process.env });
    let sortie = '';
    fils.stdout.on('data', (d) => { sortie += d; });
    fils.stderr.on('data', (d) => { sortie += d; });
    fils.on('close', (code) => finir({ code, sortie }));
  });

console.log('');
console.log('  Rapport d\'ecarts de privileges — epreuve comportementale');
console.log(`  temoin declare    : ${temoinDeclare}`);
console.log(`  temoin hors liste : ${temoinHorsListe}`);
console.log('  --------------------------------------------');

try {
  // 0. Le role doit exister : sinon le lecteur echoue et le test doit le dire.
  const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
  if (role.rowCount === 0) {
    ko(`le role ${ROLE} n'existe pas sur cette cible — rien a mesurer`);
    throw new Error('role absent');
  }
  ok(`le role ${ROLE} existe sur la cible`);

  // 1. Etat nominal : aucun ecart, verdict propre.
  const nominal = await executer();
  verifier(nominal.code === 0, `etat nominal : sortie ${nominal.code} (attendu 0)`);
  verifier(!/ECART/.test(nominal.sortie), 'etat nominal : aucun ECART signale');
  verifier(
    /ecriture directe mesuree sur (\d+) table\(s\) — la liste declaree en compte (\d+)/.test(nominal.sortie)
      && nominal.sortie.match(/mesuree sur (\d+) table\(s\) — la liste declaree en compte (\d+)/)[1]
        === nominal.sortie.match(/mesuree sur (\d+) table\(s\) — la liste declaree en compte (\d+)/)[2],
    'etat nominal : le compte mesure egale le compte declare',
  );

  // 2. Controle negatif — sur-privilege.
  await appliquer(temoinHorsListe, true);
  const sur = await executer();
  verifier(/ECART : DML accorde hors liste declaree/.test(sur.sortie), 'sur-privilege : l\'ECART est signale');
  verifier(
    sur.sortie.includes(temoinHorsListe),
    `sur-privilege : la table en cause est nommee (${temoinHorsListe})`,
  );
  verifier(
    /aucun obstacle cote privileges, mais \d+ ecart\(s\)/.test(sur.sortie),
    'sur-privilege : le verdict distingue ecart et obstacle',
  );
  verifier(sur.code === 0, `sur-privilege : sortie ${sur.code} — un ecart ne bloque pas le script`);

  // 3. Controle negatif — sous-privilege.
  await appliquer(temoinHorsListe, false);
  await appliquer(temoinDeclare, false);
  const sous = await executer();
  verifier(/ECART : \d+ table\(s\) de la liste declaree sans DML/.test(sous.sortie), 'sous-privilege : l\'ECART est signale');
  verifier(sous.sortie.includes(temoinDeclare), `sous-privilege : la table en cause est nommee (${temoinDeclare})`);
  verifier(/1 inattendue\(s\)/.test(sous.sortie), 'sous-privilege : l\'absence est classee inattendue');

  // 4. Restauration a l'etat reel mesure au depart.
  await appliquer(temoinHorsListe, avant.horsListe.i);
  await appliquer(temoinDeclare, avant.declaree.i);
  const apres = {
    declaree: await privileges(temoinDeclare),
    horsListe: await privileges(temoinHorsListe),
  };
  verifier(
    avant.declaree.i === apres.declaree.i && avant.horsListe.i === apres.horsListe.i,
    'les privileges des deux temoins sont restaures a l\'etat mesure au depart',
  );

  // 5. Le retour au nominal doit se voir, sinon la restauration n'a rien prouve.
  const retour = await executer();
  verifier(retour.code === 0 && !/ECART/.test(retour.sortie), 'apres restauration : plus aucun ECART');
} catch (erreur) {
  ko(`execution interrompue : ${erreur.message}`);
} finally {
  // Filet : meme si une assertion a leve, on ne laisse pas la base modifiee.
  try {
    await appliquer(temoinHorsListe, avant.horsListe.i);
    await appliquer(temoinDeclare, avant.declaree.i);
  } catch { /* la cible a pu disparaitre entre-temps */ }
  await admin.end();
}

const total = vertes + echecs.length;
console.log('  --------------------------------------------');
if (echecs.length === 0) {
  console.log(`  ${vertes}/${total} assertions vertes`);
  console.log('  ok — les deux ecarts sont detects, nommes, et l\'etat est restaure.');
  console.log('');
  process.exit(0);
}
console.log(`  ${vertes}/${total} assertions vertes, ${echecs.length} echec(s).`);
console.log('');
process.exit(1);
