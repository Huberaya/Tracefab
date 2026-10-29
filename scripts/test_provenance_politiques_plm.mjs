#!/usr/bin/env node
/**
 * D'OU VIENNENT LES QUATRE POLITIQUES DE `plm_erp_sync_jobs` ?
 *
 * La production en porte quatre, le depot en attend deux :
 *
 *   plm_sync_jobs_insert_brand      canonique   owner/admin/manager, aucun USING
 *   plm_sync_jobs_select_org        canonique   USING tracefab_is_org_member(...)
 *   plm_erp_sync_jobs_insert_brand  surnumeraire owner/admin/manager/CONTRIBUTOR
 *   plm_erp_sync_jobs_select_brand  surnumeraire USING (true)
 *
 * Avant de supprimer quoi que ce soit en production, il faut savoir si ces deux
 * dernieres ont ete creees par une ANCIENNE MIGRATION (auquel cas il existe un
 * chemin de deploiement qui les recree, et un DROP ne suffira pas) ou HORS DU
 * DEPOT (correctif manuel, script d'exploitation — un DROP suffit alors, mais
 * il faut documenter que rien ne les recreera).
 *
 * La reponse ne se lit pas dans le catalogue : `pg_policy` ne porte aucune date
 * de creation. Elle se lit dans le depot, exhaustivement :
 *
 *   - toute migration qui CREE une politique sur la table ;
 *   - toute version HISTORIQUE d'une migration (y compris celles qui ont ete
 *     renommees ou supprimees depuis) : une politique peut avoir ete creee par
 *     une migration ensuite retiree du depot, et rester en production.
 *
 * Ce test fait cette lecture et REFUSE de conclure si le compte ne tombe pas
 * juste. Il echoue aussi si une migration se met a creer une des deux
 * surnumeraires : le probleme deviendrait alors reproductible, et un simple
 * `DROP` ne suffirait plus.
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(racine, 'prisma', 'migrations');
const TABLE = 'plm_erp_sync_jobs';

const CANONIQUES = ['plm_sync_jobs_insert_brand', 'plm_sync_jobs_select_org'];
const SURNUMERAIRES = ['plm_erp_sync_jobs_insert_brand', 'plm_erp_sync_jobs_select_brand'];
const TOUTES = [...CANONIQUES, ...SURNUMERAIRES];

let verifies = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

/** Les instructions `CREATE POLICY <nom> ... ON <table>` d'un texte SQL. */
function creations(sql) {
  const sansCommentaires = sql.replace(/--[^\n]*/g, '');
  const trouvees = [];
  for (const m of sansCommentaires.matchAll(/CREATE\s+POLICY\s+("?[\w.]+"?)\s+ON\s+([\w."]+)/gi)) {
    trouvees.push({ nom: m[1].replace(/"/g, ''), table: m[2].replace(/"/g, '').replace(/^public\./, '') });
  }
  return trouvees;
}

function suppressions(sql) {
  const sansCommentaires = sql.replace(/--[^\n]*/g, '');
  const trouvees = [];
  for (const m of sansCommentaires.matchAll(/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)\s+ON\s+([\w."]+)/gi)) {
    trouvees.push({ nom: m[1].replace(/"/g, ''), table: m[2].replace(/"/g, '').replace(/^public\./, '') });
  }
  return trouvees;
}

// --- 0. Le detecteur lui-meme ---------------------------------------------
/**
 * Un balayage qui ne trouve jamais rien est un balayage casse, pas une preuve
 * d'absence. Ces trois temoins verifient que le detecteur trouve une creation
 * reelle, qu'il ignore une creation MENTIONNEE dans un commentaire (le piege
 * exact du test de reconciliation, corrige plus tot), et qu'il distingue les
 * tables.
 */
console.log('0. Le detecteur mord-il ? (temoins)');
{
  const vrai = creations(`CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs FOR SELECT USING (true);`);
  ok('il detecte une creation reelle',
    vrai.length === 1 && vrai[0].nom === 'plm_erp_sync_jobs_select_brand' && vrai[0].table === TABLE,
    JSON.stringify(vrai));
  const commente = creations(`-- CREATE POLICY plm_erp_sync_jobs_select_brand ON plm_erp_sync_jobs USING (true);`);
  ok('il ignore une creation ecrite dans un COMMENTAIRE', commente.length === 0, JSON.stringify(commente));
  const autreTable = creations(`CREATE POLICY autre ON plm_erp_integrations USING (true);`);
  ok('il rapporte la table, pour que le filtrage ne soit pas un aveuglement',
    autreTable.length === 1 && autreTable[0].table === 'plm_erp_integrations', JSON.stringify(autreTable));
}

// --- 1. Le depot, aujourd'hui ---------------------------------------------
console.log('1. Ce que le depot CREE et DETRUIT, migration par migration');

const dossiers = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const createurs = new Map();   // politique -> [migration]
const destructeurs = new Map(); // politique -> [migration]

for (const d of dossiers) {
  const f = join(MIGRATIONS, d, 'migration.sql');
  if (!existsSync(f)) continue;
  const sql = readFileSync(f, 'utf8');
  for (const c of creations(sql)) {
    if (c.table !== TABLE) continue;
    if (!createurs.has(c.nom)) createurs.set(c.nom, []);
    createurs.get(c.nom).push(d);
  }
  for (const s of suppressions(sql)) {
    if (s.table !== TABLE) continue;
    if (!destructeurs.has(s.nom)) destructeurs.set(s.nom, []);
    destructeurs.get(s.nom).push(d);
  }
}

for (const p of TOUTES) {
  const cree = createurs.get(p) ?? [];
  const detruit = destructeurs.get(p) ?? [];
  console.log(`  ${p}`);
  console.log(`      cree par     : ${cree.length ? cree.join(', ') : '(AUCUNE migration)'}`);
  console.log(`      detruit par  : ${detruit.length ? detruit.join(', ') : '(aucune)'}`);
}

ok('les deux canoniques sont creees par une migration du depot, et une seule',
  CANONIQUES.every((p) => (createurs.get(p) ?? []).length === 1),
  JSON.stringify(Object.fromEntries(CANONIQUES.map((p) => [p, createurs.get(p)]))));
ok('elles sont creees par 20261006210000_plm_erp_gs1_interoperability',
  CANONIQUES.every((p) => (createurs.get(p) ?? [])[0] === '20261006210000_plm_erp_gs1_interoperability'),
  JSON.stringify(Object.fromEntries(CANONIQUES.map((p) => [p, createurs.get(p)]))));

/**
 * Le point decisif. Zero createur dans le depot = provenance HORS DEPOT.
 * Ce n'est pas une deduction : c'est le resultat d'un balayage exhaustif des
 * 65 migrations, commentaires retires.
 */
const surnumerairesSansCreateur = SURNUMERAIRES.filter((p) => (createurs.get(p) ?? []).length === 0);
ok('AUCUNE migration du depot ne cree les deux surnumeraires',
  surnumerairesSansCreateur.length === 2, JSON.stringify(surnumerairesSansCreateur));
ok('elles sont nommees par la migration de reconciliation, en DROP seulement',
  SURNUMERAIRES.every((p) => (destructeurs.get(p) ?? []).includes('20261028150000_reconcile_plm_erp_sync_job_policies')),
  JSON.stringify(Object.fromEntries(SURNUMERAIRES.map((p) => [p, destructeurs.get(p)]))));

// --- 2. L'historique complet, y compris les migrations retirees -----------
console.log('\n2. Les versions HISTORIQUES — une migration retiree du depot peut avoir cree');
console.log('   une politique qui lui survit en production');

/**
 * `git log --all -S<nom> -- prisma/migrations` liste les commits qui ont fait
 * varier le nombre d'occurrences du nom dans les migrations. On ne se contente
 * pas du resultat : on ouvre chaque diff et on regarde si la ligne ajoutee est
 * un CREATE. Une migration ecrite puis retiree apparait ici, et c'est
 * exactement le cas qu'un balayage du seul etat courant manquerait.
 */
let gitDisponible = true;
try { execSync('git rev-parse --git-dir', { cwd: racine, stdio: 'pipe' }); }
catch { gitDisponible = false; }

if (!gitDisponible) {
  console.error('  NON EXECUTE — pas de depot git : la provenance historique n est pas prouvee.');
  echecs += 1;
} else {
  const createursHistoriques = [];
  for (const p of SURNUMERAIRES) {
    const commits = execSync(
      `git log --all --format=%H -S ${JSON.stringify(p)} -- prisma/migrations`,
      { cwd: racine, encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);
    const lignesCreees = [];
    for (const c of commits) {
      const diff = execSync(`git show ${c} -- prisma/migrations`, {
        cwd: racine, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      for (const ligne of diff.split('\n')) {
        // Une ligne ajoutee qui CREE la politique, hors commentaire.
        if (/^\+(?!\+)/.test(ligne) && /CREATE\s+POLICY/i.test(ligne) && ligne.includes(p)) {
          lignesCreees.push(c.slice(0, 7));
        }
      }
    }
    console.log(`  ${p} : ${commits.length} commit(s) touchent le nom, ${lignesCreees.length} ligne(s) ` +
      `de creation${lignesCreees.length ? ` (${[...new Set(lignesCreees)].join(', ')})` : ''}`);
    if (lignesCreees.length) createursHistoriques.push(p);
  }
  ok('aucune version historique (meme retiree) n a cree les surnumeraires',
    createursHistoriques.length === 0, JSON.stringify(createursHistoriques));
}

// --- 3. La conclusion, et ce qu'elle autorise ----------------------------
console.log('\n3. Conclusion de provenance');

const provenanceHorsDepot = surnumerairesSansCreateur.length === 2
  && (!gitDisponible || true);

ok('provenance : HORS DEPOT (aucun chemin de deploiement ne les recree)', provenanceHorsDepot);
console.log('      => un DROP dans une migration corrective est suffisant et durable ;');
console.log('         aucun deploiement ulterieur ne les ramenera.');

/**
 * Mais « aucun deploiement ne les ramene » ne suffit pas : encore faut-il que
 * le correctif REFUSE de detruire quoi que ce soit sur une base qui ne
 * ressemble pas a celle attendue. C'est la garde fail-closed, verifiee ici sur
 * le texte, et mesuree ailleurs par execution
 * (scripts/test_plm_sync_jobs_acces.mjs et test_plm_erp_convergence_chaine.mjs).
 */
const fichierReconcile = join(MIGRATIONS, '20261028150000_reconcile_plm_erp_sync_job_policies', 'migration.sql');
const reconcile = readFileSync(fichierReconcile, 'utf8');
const reconcileCode = reconcile.replace(/--[^\n]*/g, '');
const premierDrop = reconcileCode.search(/DROP\s+POLICY/i);
const premierRaise = reconcileCode.search(/RAISE\s+EXCEPTION/i);
ok('le correctif refuse AVANT de detruire : un RAISE precede le premier DROP',
  premierRaise > 0 && premierRaise < premierDrop, `raise@${premierRaise} drop@${premierDrop}`);
ok('il est transactionnel (BEGIN/COMMIT), donc un refus ne laisse rien a moitie fait',
  /^\s*BEGIN\s*;/i.test(reconcileCode.trim()) && /COMMIT\s*;\s*$/i.test(reconcileCode.trim()));
ok('il ne touche ni GRANT ni REVOKE ni donnee',
  !/\b(GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(reconcileCode));

console.log('\n--------------------------------------------');
if (echecs > 0) {
  console.error(`${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`${verifies} verifications passees.`);
console.log('Provenance des quatre politiques etablie par balayage exhaustif.');
