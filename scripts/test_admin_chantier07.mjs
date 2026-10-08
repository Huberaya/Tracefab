#!/usr/bin/env node
/**
 * CHANTIER ADMIN 07 — Campagnes et Leads (§1), les deux dernières entrées du §1.
 *
 * Ce test exécute les modules RÉELS compilés (`crm-funnel.ts`,
 * `crm-funnel-load.ts`) avec un client de transaction simulé, analyse la
 * migration avec le VRAI parseur PostgreSQL quand il est disponible, et rend
 * l'interface RÉELLE dans jsdom avec le vrai dictionnaire lu sur disque.
 *
 *   A.  compilation ;
 *   B.  l'empreinte de doublon (§8) ;
 *   C.  parseLeadInput ;
 *   D.  parseCampaignInput ;
 *   E.  planPromotion — l'historique conservé (§14) ;
 *   F.  measureCampaign / summarizeCampaigns — le piège de la moyenne ;
 *   G.  le chargeur partagé ;
 *   H.  migration — additive, non destructive, isolée, syntaxe PostgreSQL ;
 *   I.  routes — lecture/écriture, journal, refus ;
 *   J.  réutilisation — un seul chargeur, un seul `rate` ;
 *   K.  i18n ;
 *   L.  interface — 18 entrées, promotion, modaux.
 *
 *   npm run test:admin:chantier07
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from 'jsdom';

const { JSDOM, VirtualConsole } = pkg;

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => join(root, p);
let checks = 0;
let failures = 0;
const notes = [];
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const bad = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d ?? 'assertion failed'}`); };
const check = (fn, label) => {
  try { fn(); ok(label); } catch (e) { bad(label, e?.message); }
};
const eq = (a, e, l) => check(() => {
  if (a !== e) throw new Error(`attendu ${JSON.stringify(e)}, obtenu ${JSON.stringify(a)}`);
}, l);
const isTrue = (cond, l, d) => check(() => {
  if (!cond) throw new Error(d || 'condition fausse');
}, l);
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });

/* -------------------------------------------------------------------------- */
console.log('\nA. Compilation des modules réels');
/* -------------------------------------------------------------------------- */

await mkdir(at('.cache'), { recursive: true });
const outDir = await mkdtemp(at('.cache/admin07-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/crm-funnel.ts', 'api/_lib/crm-funnel-load.ts',
    '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('crm-funnel.ts et crm-funnel-load.ts compilent');
} catch (e) {
  bad('les modules Admin 07 ne compilent pas', e.message.slice(0, 400));
}

const F = await import(pathToFileURL(join(outDir, 'crm-funnel.js')).href);
const L = await import(pathToFileURL(join(outDir, 'crm-funnel-load.js')).href);

const funnelSrc = await readFile(at('api/_lib/crm-funnel.ts'), 'utf8');
eq(/^import\s/m.test(funnelSrc), false,
  'crm-funnel.ts n\'importe rien : la décision reste exécutable sans client Prisma');

/* -------------------------------------------------------------------------- */
console.log('\nB. L\'empreinte de doublon (§8)');
/* -------------------------------------------------------------------------- */

const key = F.leadDuplicateKey;
eq(key({ email: ' Contact@ACME.com ', company_name: 'Acme' }), 'email:contact@acme.com',
  'l\'email prime, normalisé en minuscules et débarrassé de ses espaces');
eq(key({ website: 'https://www.ACME.com/produits?x=1', company_name: 'Autre' }), 'web:acme.com',
  'à défaut d\'email, le domaine seul : ni schéma, ni www, ni chemin, ni requête');
eq(key({ company_name: '  Acme   Textile ' }), 'name:acme textile',
  'à défaut de tout, le nom normalisé');
eq(key({}), null,
  'une ligne sans rien d\'identifiant renvoie null : on refuse plutôt que de fabriquer une clé');
eq(key({ email: 'pas-un-email', company_name: 'Acme' }), 'name:acme',
  'un email malformé n\'est pas utilisé comme identité — il descend au niveau suivant');

/* LE PRÉFIXE. Sans lui, « acme.com » saisi comme nom et « acme.com » saisi comme
   site produiraient la même clé et fusionneraient deux réalités distinctes. */
eq(key({ company_name: 'acme.com' }) !== key({ website: 'acme.com' }), true,
  'le préfixe empêche un nom et un domaine homonymes de fusionner');
eq(key({ email: 'a@b.co' }), key({ email: 'A@B.CO' }), true,
  'la même adresse dans deux casse donne la même clé : c\'est le même prospect');
eq(key({ website: 'acme.com' }), key({ website: 'https://acme.com/x' }), true,
  'le même site sous deux formes donne la même clé');

/* -------------------------------------------------------------------------- */
console.log('\nC. parseLeadInput');
/* -------------------------------------------------------------------------- */

const pl = F.parseLeadInput;
eq(pl({ company_name: 'X', status: 'converted' }).errors.includes('status_converted_not_settable'), true,
  '« converted » ne se décrète pas : seule la promotion l\'écrit, avec l\'entreprise créée');
eq(pl({ company_name: 'X', status: 'discarded' }).errors.includes('discard_reason_required'), true,
  'écarter sans raison est refusé : personne ne saurait plus tard pourquoi');
eq(pl({ company_name: 'X', status: 'discarded', discard_reason: 'doublon' }).errors.length, 0,
  'écarter avec une raison passe');
eq(pl({ company_name: 'X', status: 'pas-un-statut' }).errors.includes('status_invalid'), true,
  'un statut inconnu est refusé');
eq(pl({ company_name: '' }).errors.includes('company_name_required'), true,
  'un nom vide est refusé');
eq(pl({ company_name: 'X', email: 'pas-un-email' }).errors.includes('email_invalid'), true,
  'un email malformé est refusé');
eq(pl({ company_name: 'X', website: 'http://' }).errors.includes('website_invalid'), true,
  'un site invalide est refusé');
eq(pl({ company_name: 'X', country_code: 'FRA' }).errors.includes('country_code_invalid'), true,
  'un code pays à trois lettres est refusé');
eq(pl({ company_name: 'X', country_code: 'fr' }).data.country_code, 'FR',
  'un code pays valide est normalisé en majuscules');
eq(pl({ company_name: 'X', campaign_id: 'pas-un-uuid' }).errors.includes('campaign_id_must_be_uuid'), true,
  'un identifiant de campagne malformé est refusé');
eq(pl({ company_name: 'X', campaign_id: { $ne: null } }).errors.length > 0, true,
  'un opérateur de requête est refusé');

/* §9 — la date de collecte. */
eq(pl({ company_name: 'X' }).data.collected_at, undefined,
  'collectée absente reste ABSENTE : la remplir avec now() affirmerait une fraîcheur jamais observée');
eq(pl({ company_name: 'X', collected_at: '2026-03-05' }).data.collected_at, '2026-03-05T00:00:00.000Z',
  'une date de collecte fournie est conservée telle quelle');
eq(pl({ company_name: 'X', collected_at: 'pas-une-date' }).errors.includes('collected_at_invalid'), true,
  'une date illisible est refusée');
eq(pl({ company_name: 'X', email: null }).data.email, null,
  'un null explicite vide le champ : sans cela une correction serait impossible');
eq(pl({ company_name: 'X', email: 'x' }).data, null,
  'une erreur annule TOUTE la ligne, pas seulement le champ fautif');

/* -------------------------------------------------------------------------- */
console.log('\nD. parseCampaignInput');
/* -------------------------------------------------------------------------- */

const pc = F.parseCampaignInput;
eq(pc({ name: 'C' }).errors.length, 0, 'un nom seul suffit à créer une campagne');
eq(pc({ name: '' }).errors.includes('name_required'), true, 'un nom vide est refusé');
eq(pc({ name: 'C', channel: 'pigeon' }).errors.includes('channel_invalid'), true,
  'un canal hors liste est refusé');
eq(pc({ name: 'C', channel: 'webinar' }).data.channel, 'webinar', 'un canal de la liste passe');
eq(pc({ name: 'C', status: 'archived' }).errors.includes('status_invalid'), true,
  'un statut hors liste est refusé');
eq(pc({ name: 'C', starts_at: '2026-06-01', ends_at: '2026-01-01' }).errors.includes('ends_before_starts'), true,
  'une fenêtre inversée est refusée : la durée calculée serait négative');
eq(pc({ name: 'C', starts_at: '2026-01-01', ends_at: '2026-06-01' }).errors.length, 0,
  'une fenêtre correcte passe');
eq(pc({ name: 'C', budget_eur: -1 }).errors.includes('budget_eur_invalid'), true,
  'un budget négatif est refusé');
eq(pc({ name: 'C', budget_eur: 'abc' }).errors.includes('budget_eur_invalid'), true,
  'un budget non numérique est refusé');
eq(pc({ name: 'C', budget_eur: '1500' }).data.budget_eur, 1500, 'un budget numérique en chaîne est converti');
eq(pc({ name: 'C', starts_at: 'pas-une-date' }).errors.includes('starts_at_invalid'), true,
  'une date de début illisible est refusée');

/* -------------------------------------------------------------------------- */
console.log('\nE. planPromotion — l\'historique conservé (§14)');
/* -------------------------------------------------------------------------- */

const NEW_ID = '11111111-2222-4333-8444-555555555555';
const lead = {
  id: 'l1', company_name: 'Acme Textile', website: 'acme.com', country_code: 'FR',
  city: 'Lyon', sector: 'Fashion', campaign_id: '6f1e2d3c-4b5a-4968-8796-a5b4c3d2e1f0',
  source: 'salon', source_detail: 'Première Vision', collected_at: '2026-03-05T00:00:00.000Z',
  status: 'qualified',
};
const plan = F.planPromotion(lead, NEW_ID);
eq(plan.errors.length, 0, 'une piste qualifiée se promeut sans erreur');
eq(plan.company.id, NEW_ID, 'l\'entreprise reçoit l\'identifiant fourni');
eq(plan.company.name, 'Acme Textile', 'le nom est repris');
eq(plan.company.stage, 'new', 'l\'entreprise entre au début du pipeline, pas à un stade supposé');
eq(plan.company.source, 'salon', 'la source est RECOPIÉE telle quelle');
eq(plan.company.source_detail, 'Première Vision', 'le détail de source est recopié');
eq(plan.company.collected_at, '2026-03-05T00:00:00.000Z',
  'la date de collecte survit à la promotion : sans elle, la donnée devient indatable (§9)');
eq(plan.company.campaign_id, lead.campaign_id, 'l\'attribution à la campagne survit');
eq(plan.company.industry, 'Fashion', '« sector » devient « industry » : traduction de schéma, pas de donnée');
eq(plan.lead.status, 'converted', 'la piste passe à « converted »');
eq(plan.lead.converted_company_id, NEW_ID, 'la piste reçoit l\'identifiant de l\'entreprise');
isTrue(typeof plan.lead.converted_at === 'string' && !Number.isNaN(Date.parse(plan.lead.converted_at)),
  'la date de conversion est écrite');
eq('delete' in plan || plan.deleted === true, false,
  'la piste n\'est PAS supprimée : c\'est la seule trace de l\'origine du client');

/* Un champ absent ne doit pas écraser. */
const sparse = F.planPromotion({ id: 'l2', company_name: 'Seul', status: 'new' }, NEW_ID);
eq('website' in sparse.company, false,
  'un champ absent n\'est pas écrit en null : il n\'écraserait pas ce qu\'un opérateur a déjà saisi');
eq(sparse.errors.length, 0, 'une piste minimale se promeut');

eq(F.planPromotion({ ...lead, converted_company_id: 'x' }, NEW_ID).errors.includes('lead_already_converted'), true,
  'une piste déjà promue est refusée : deux clics ne doivent pas créer deux clients');
eq(F.planPromotion({ ...lead, status: 'converted' }, NEW_ID).errors.includes('lead_already_converted'), true,
  'le statut « converted » seul suffit à refuser');
eq(F.planPromotion({ ...lead, status: 'discarded' }, NEW_ID).errors.includes('lead_discarded_not_promotable'), true,
  'écarter puis promouvoir est refusé : contourner une décision la rendrait illisible');
eq(F.planPromotion(lead, 'pas-un-uuid').errors.includes('company_id_must_be_uuid'), true,
  'un identifiant d\'entreprise malformé est refusé');
eq(F.planPromotion({ id: 'l3', company_name: '' }, NEW_ID).errors.includes('lead_company_name_required'), true,
  'une piste sans nom ne se promeut pas');

/* -------------------------------------------------------------------------- */
console.log('\nF. measureCampaign — le piège de la moyenne de taux');
/* -------------------------------------------------------------------------- */

const mc = F.measureCampaign;
const empty = mc([], []);
eq(empty.leads, 0, 'une liste vide ne lève pas');
eq(empty.promotionRate, null, 'un taux sur un échantillon vide est null, jamais 0');
eq(empty.customerRate, null, 'idem pour le taux de clients');
eq(mc(null, null).leads, 0, 'null ne lève pas');

const four = mc(
  [{ status: 'converted', converted_company_id: 'c1' }, { status: 'converted', converted_company_id: 'c2' },
    { status: 'discarded' }, { status: 'new' }],
  [{ stage: 'customer' }, { stage: 'demo' }],
);
eq(four.leads, 4, 'quatre pistes comptées');
eq(four.promoted, 2, 'deux promotions');
eq(four.discarded, 1, 'un écart');
eq(four.decided, 3, 'trois décisions : les pistes encore « new » ne comptent pas');
eq(four.promotionRate, 66.7, '2 promotions sur 3 décisions = 66,7 %');
eq(four.customers, 1, 'un client');
eq(four.customerRate, 50, '1 client sur 2 promotions = 50 %');
eq(mc([{ status: 'new' }, { status: 'contacted' }], []).promotionRate, null,
  'rien de décidé → taux null : une campagne en cours n\'est pas une campagne à 0 %');

/* LE FAIT BAT LA DÉCLARATION. */
eq(mc([{ status: 'converted' }], []).promoted, 0,
  'un statut « converted » SANS entreprise ne compte pas : le statut est une déclaration, l\'identifiant est un fait');

/* LE PIÈGE. La moyenne de taux n\'est pas le taux des sommes. */
const a = mc([{ status: 'converted', converted_company_id: 'x' }], [{ stage: 'customer' }]);
const b = mc([...Array.from({ length: 8 }, () => ({ status: 'discarded' })),
  { status: 'converted', converted_company_id: 'y' }], [{ stage: 'new' }]);
eq(a.promotionRate, 100, 'campagne A : 1 promotion sur 1 décision = 100 %');
eq(b.promotionRate, 11.1, 'campagne B : 1 promotion sur 9 décisions = 11,1 %');
const naive = (a.promotionRate + b.promotionRate) / 2;
const aggregated = F.summarizeCampaigns([a, b]).promotionRate;
eq(aggregated, 20, 'l\'agrégat réel est 2 promotions sur 10 décisions = 20 %');
isTrue(Math.abs(naive - aggregated) > 30,
  `la moyenne naïve (${naive.toFixed(1)} %) s'écarte de plus de 30 points de la réalité (${aggregated} %) — c'est précisément ce que le résumé doit éviter`);
eq(F.summarizeCampaigns([a, b]).leads, 10, 'le résumé compte les pistes');
eq(F.summarizeCampaigns([]).promotionRate, null, 'un résumé vide n\'invente pas de taux');
eq(F.summarizeCampaigns(null).campaigns, 0, 'null ne lève pas');

/* -------------------------------------------------------------------------- */
console.log('\nG. Le chargeur partagé');
/* -------------------------------------------------------------------------- */

let groupByCalls = 0;
const stubTx = {
  crm_leads: {
    groupBy: async (args) => {
      groupByCalls += 1;
      if (args.by.length === 2) {
        return [
          { campaign_id: 'A', status: 'converted', _count: { _all: 2 } },
          { campaign_id: 'A', status: 'discarded', _count: { _all: 1 } },
          { campaign_id: 'A', status: 'new', _count: { _all: 1 } },
          { campaign_id: 'B', status: 'converted', _count: { _all: 1 } },
        ];
      }
      return [{ campaign_id: 'A', _count: { _all: 2 } }];
    },
  },
  /* Les deux tables sont comptées : ne compter que crm_leads ferait passer
     trois agrégations pour deux. */
  crm_companies: { groupBy: async () => { groupByCalls += 1; return [{ campaign_id: 'A', _count: { _all: 1 } }]; } },
};

const metrics = await L.loadCampaignMetrics(stubTx, 'org1', ['A', 'B', 'C']);
eq(groupByCalls, 3, 'exactement trois agrégations pour trois campagnes — pas de N+1');
eq(metrics.get('A').leads, 4, 'campagne A : quatre pistes');
eq(metrics.get('A').promoted, 2, 'campagne A : deux promotions');
eq(metrics.get('A').promotionRate, 66.7, 'campagne A : 66,7 %');
eq(metrics.get('A').customers, 1, 'campagne A : un client');
eq(metrics.get('B').promoted, 0,
  'campagne B : le statut dit « converted » mais aucune entreprise n\'existe — zéro promotion');
eq(metrics.get('B').promotionRate, null,
  'campagne B : rien de réellement décidé, donc taux null');
eq(metrics.get('C').leads, 0, 'campagne C : aucune piste');
eq(metrics.get('C').promotionRate, null, 'campagne C : taux null, pas 0 %');
eq((await L.loadCampaignMetrics(stubTx, 'org1', [])).size, 0, 'aucune campagne → aucune requête');
eq(L.emptyCampaignMetrics().promotionRate, null, 'les métriques vides portent des taux null');

const connLib = await readFile(at('api/_lib/crm-funnel-load.ts'), 'utf8');
const connCode = stripComments(connLib);
isTrue(/measureCampaign\(/.test(connCode),
  'le chargeur délègue les taux à measureCampaign : il ne les recalcule pas');
eq(/Math\.round\([\s\S]*?\/[\s\S]*?\)\s*\/\s*10/.test(connCode), false,
  'aucun calcul de pourcentage dans le chargeur : une seconde formule divergerait');
eq((connCode.match(/findMany/g) || []).length, 0, 'aucun findMany : tout passe par groupBy');

/* -------------------------------------------------------------------------- */
console.log('\nH. Migration');
/* -------------------------------------------------------------------------- */

const migPath = 'prisma/migrations/20261008200000_admin_acquisition_funnel/migration.sql';
const mig = await readFile(at(migPath), 'utf8');
isTrue(/CREATE TABLE IF NOT EXISTS crm_campaigns/.test(mig), 'crm_campaigns est créée de façon idempotente');
isTrue(/CREATE TABLE IF NOT EXISTS crm_leads/.test(mig), 'crm_leads est créée de façon idempotente');
eq(/DROP TABLE|DELETE FROM|TRUNCATE|DROP COLUMN/i.test(mig), false,
  'aucune opération destructive : rien d\'existant n\'est supprimé');
isTrue(/CREATE TYPE crm_campaign_channel AS ENUM/.test(mig), 'le type canal est créé');
isTrue(/CREATE TYPE crm_lead_status AS ENUM/.test(mig), 'le type statut de piste est créé');
isTrue(/EXCEPTION WHEN duplicate_object THEN NULL/.test(mig),
  'la création de type est idempotente, comme dans les migrations précédentes');
isTrue(/ALTER TABLE crm_companies\s+ADD COLUMN IF NOT EXISTS campaign_id UUID;/.test(mig),
  'campaign_id est ajouté à crm_companies, nullable et idempotent');

/* Aucune clé étrangère, conformément à tout le bloc CRM. */
eq(/FOREIGN KEY|REFERENCES/.test(mig), false,
  'aucune clé étrangère : tout le bloc CRM s\'en passe et valide à l\'écriture. Introduire la première ici créerait une incohérence et une cascade jamais examinée');

/* Aucun index partiel : Prisma ne sait pas les exprimer, donc ce serait une
   dérive invisible entre le schéma et la base. */
eq(/CREATE INDEX[\s\S]*?WHERE/.test(mig), false,
  'aucun index partiel : un index présent en base mais absent du schéma est une dérive que plus personne ne détecte');
isTrue(/CONSTRAINT uq_crm_campaigns_org_name UNIQUE/.test(mig),
  'l\'unicité du nom est une CONTRAINTE, pas un index : c\'est ce que @@unique attend');
isTrue(/CONSTRAINT uq_crm_leads_org_duplicate UNIQUE/.test(mig),
  'l\'empreinte de doublon est unique par organisation');

/* Isolation. */
isTrue(/ALTER TABLE crm_campaigns\s+ENABLE ROW LEVEL SECURITY/.test(mig), 'crm_campaigns : RLS activée');
isTrue(/ALTER TABLE crm_campaigns\s+FORCE ROW LEVEL SECURITY/.test(mig),
  'crm_campaigns : RLS FORCÉE — sans FORCE, le propriétaire contourne ses propres politiques');
isTrue(/ALTER TABLE crm_leads\s+FORCE ROW LEVEL SECURITY/.test(mig), 'crm_leads : RLS forcée');
eq((mig.match(/tracefab_is_platform_org/g) || []).length, 6,
  'les quatre politiques exigent tracefab_is_platform_org (6 occurrences : les deux FOR ALL portent USING et WITH CHECK)');
isTrue(/CREATE POLICY crm_leads_modify[\s\S]{0,400}WITH CHECK/.test(mig),
  'la politique d\'écriture porte un WITH CHECK : l\'insertion est contrôlée, pas seulement la lecture');

/* Syntaxe vérifiée par le VRAI parseur PostgreSQL, quand il est disponible. */
const venvPython = at('.cache/pgvenv/bin/python');
const probe = spawnSync(venvPython, ['-c', 'import pglast'], { cwd: root });
if (probe.status === 0) {
  const parsed = spawnSync(venvPython, ['-c', `
from pglast import parser
import glob
bad = []
n = 0
for f in sorted(glob.glob('prisma/migrations/20261008*admin*/migration.sql')):
    try:
        n += len(parser.parse_sql(open(f, encoding='utf-8').read()))
    except parser.ParseError as e:
        bad.append((f, str(e)))
print('OK' if not bad else 'FAIL', n, bad)
`], { cwd: root, encoding: 'utf8' });
  const out = (parsed.stdout || '').trim();
  isTrue(out.startsWith('OK'), `les migrations CRM sont analysées sans erreur par le parseur PostgreSQL (${out})`);
} else {
  notes.push('parseur PostgreSQL (pglast) indisponible : la syntaxe des migrations n\'a été vérifiée que structurellement. À refaire avec .cache/pgvenv.');
  console.log('  note  parseur PostgreSQL indisponible — vérification structurelle uniquement');
}

const schema = await readFile(at('prisma/schema.prisma'), 'utf8');
isTrue(/model crm_campaigns \{/.test(schema), 'le schéma porte crm_campaigns');
isTrue(/model crm_leads \{/.test(schema), 'le schéma porte crm_leads');
eq((schema.match(/^model /gm) || []).length, 53, '53 modèles : les deux tables ajoutées, rien d\'autre');
eq((schema.match(/^enum /gm) || []).length, 40, '40 enums : les trois types ajoutés, rien d\'autre');
/* Toute contrainte de la migration doit être déclarée dans le schéma. */
for (const c of ['uq_crm_campaigns_org_name', 'uq_crm_leads_org_duplicate',
  'idx_crm_campaigns_org_status', 'idx_crm_leads_org_status', 'idx_crm_leads_org_campaign',
  'idx_crm_leads_converted', 'idx_crm_companies_campaign']) {
  isTrue(schema.includes(`"${c}"`), `« ${c} » est déclaré dans le schéma : aucune dérive base/schéma`);
}

/* -------------------------------------------------------------------------- */
console.log('\nI. Routes');
/* -------------------------------------------------------------------------- */

const campaignsRoute = await readFile(at('api/_routes/admin/campaigns.ts'), 'utf8');
const campaignDetail = await readFile(at('api/_routes/admin/campaigns/[campaignId].ts'), 'utf8');
const leadsRoute = await readFile(at('api/_routes/admin/leads.ts'), 'utf8');
const leadDetail = await readFile(at('api/_routes/admin/leads/[leadId].ts'), 'utf8');
const promoteRoute = await readFile(at('api/_routes/admin/leads/[leadId]/promote.ts'), 'utf8');

for (const [name, src, allowed] of [
  ['campaigns.ts', campaignsRoute, "['GET', 'POST']"],
  ['campaigns/[id].ts', campaignDetail, "['GET', 'PATCH']"],
  ['leads.ts', leadsRoute, "['GET', 'POST']"],
  ['leads/[id].ts', leadDetail, "['GET', 'PATCH']"],
  ['leads/[id]/promote.ts', promoteRoute, "['POST']"],
]) {
  isTrue(src.includes(`methodNotAllowed(res, ${allowed})`), `${name} n'autorise que ${allowed}`);
  isTrue(/requirePlatformAdmin/.test(src), `${name} exige le rôle Admin`);
  isTrue(/isAdminAccessDenied\(error\)[\s\S]*403/.test(src), `${name} renvoie 403 à un non-admin`);
  eq(/\$queryRawUnsafe|\$executeRawUnsafe/.test(src), false, `${name} ne construit aucun SQL concaténé`);
}

/* Aucune suppression : la provenance doit survivre. */
for (const [name, src] of [['campaigns/[id].ts', campaignDetail], ['leads/[id].ts', leadDetail]]) {
  eq(/method === 'DELETE'|\.delete\(/.test(src), false,
    `${name} ne supprime rien : supprimer ferait perdre la provenance des clients issus`);
}

/* Le journal d'audit couvre les écritures. */
const auditSrc = await readFile(at('api/_lib/crm-audit.ts'), 'utf8');
isTrue(/'crm_campaign', 'crm_lead'/.test(auditSrc),
  'crm_campaign et crm_lead sont des entités journalisables');
isTrue(/crm_campaign: \[/.test(auditSrc) && /crm_lead: \[/.test(auditSrc),
  'les deux entités ont une liste de champs suivis');
for (const [name, src] of [['campaigns.ts', campaignsRoute], ['campaigns/[id].ts', campaignDetail],
  ['leads.ts', leadsRoute], ['leads/[id].ts', leadDetail], ['promote.ts', promoteRoute]]) {
  isTrue(/auditAdmin\(/.test(src), `${name} journalise ses écritures`);
}
isTrue(/entity: 'crm_lead', action: 'converted'/.test(promoteRoute),
  'la promotion est journalisée comme conversion, pas comme simple mise à jour');

/* Doublons et liens invalides. */
/* `existing` est aussi un nom de variable dans cette route : affirmer sa simple
   présence ne prouverait rien sur la réponse. */
isTrue(/409, \{ error: 'crm_lead_duplicate', existing: outcome\.duplicate \}/.test(leadsRoute),
  'un doublon renvoie 409 AVEC la ligne existante : sans elle, l\'opérateur ne peut pas juger');
isTrue(/leadDuplicateKey/.test(leadsRoute), 'l\'empreinte est calculée par le module pur, pas recopiée');
isTrue(/lead_not_identifiable/.test(leadsRoute),
  'une ligne sans rien d\'identifiant est refusée plutôt que d\'être créée en double invisible');
isTrue(/crm_campaign_not_linkable/.test(leadsRoute) && /crm_campaign_not_linkable/.test(leadDetail),
  'une campagne inexistante ou invisible est refusée : sans clé étrangère, c\'est la seule protection');
isTrue(/'P2002'/.test(leadsRoute),
  'la contrainte unique reste un filet : deux créations concurrentes passent le test préalable');

/* La promotion : deux écritures, une transaction. */
const promoteCode = stripComments(promoteRoute);
const createAt = promoteCode.indexOf('crm_companies.create(');
const updateAt = promoteCode.indexOf('crm_leads.update(');
isTrue(createAt > 0 && updateAt > createAt,
  'l\'entreprise est créée puis la piste marquée, dans la même transaction');
eq((promoteCode.match(/withTracefabUserContext/g) || []).length >= 1, true,
  'la promotion passe par le contexte transactionnel');
isTrue(/randomUUID\(\)/.test(promoteCode),
  'l\'identifiant est tiré AVANT toute écriture : les préconditions sont validées avant, pas après un rollback');
isTrue(/planPromotion/.test(promoteCode), 'la promotion délègue la décision au module pur');
/* La garde est vérifiée sur sa forme réelle : `race: true` figure aussi dans
   l'annotation de type, et `lead_already_converted` dans la réponse. */
isTrue(/if \(fresh\?\.converted_company_id\) return \{ race: true as const \}/.test(promoteCode),
  'une relecture dans la transaction attrape la promotion concurrente : deux clics ne créent pas deux clients');
/* Le code d'erreur seul ne prouve rien : il subsisterait dans un bloc mort.
   C'est la condition qui doit être vivante. */
isTrue(/if \(plan\.errors\.length\) \{\s*return json\(res, 422, \{ error: 'lead_not_promotable'/.test(promoteCode),
  'une piste non promouvable est refusée en 422 par une condition réellement évaluée');
const guardAt = promoteCode.indexOf('if (plan.errors.length)');
const createAt2 = promoteCode.indexOf('crm_companies.create(');
isTrue(guardAt > 0 && guardAt < createAt2,
  'la garde précède la création : les préconditions sont validées AVANT toute écriture');

/* L'identité d'une piste est figée. */
isTrue(/lead_identity_immutable/.test(leadDetail),
  'nom, email et site ne sont plus modifiables : les corriger permettrait d\'ajouter le même prospect deux fois');

/* Le routeur. */
const routerSrc = await readFile(at('api/index.ts'), 'utf8');
const patterns = [...routerSrc.matchAll(/\{ pattern: \/\^(.*?)\/, params: \[([^\]]*)\], load: \(\) => import\('\.\/(_routes\/[^']+)'\)/g)]
  .map((m) => ({ re: new RegExp(`^${m[1]}`), params: m[2], load: m[3] }));
isTrue(patterns.length >= 159, `le routeur déclare au moins 159 motifs (obtenu ${patterns.length})`);
for (const [path, expect, params] of [
  ['admin/campaigns', '_routes/admin/campaigns.js', ''],
  ['admin/campaigns/abc', '_routes/admin/campaigns/[campaignId].js', "'campaignId'"],
  ['admin/leads', '_routes/admin/leads.js', ''],
  ['admin/leads/xyz', '_routes/admin/leads/[leadId].js', "'leadId'"],
  ['admin/leads/xyz/promote', '_routes/admin/leads/[leadId]/promote.js', "'leadId'"],
]) {
  const hit = patterns.find((p) => p.re.test(path));
  eq(hit ? hit.load : null, expect, `${path} atteint ${expect}`);
  eq(hit ? hit.params : null, params, `${path} expose les paramètres ${params || '(aucun)'}`);
}
eq(patterns.filter((p) => /^admin\\\/\(\[\^\\\/\]\+\)\$$/.test(p.re.source)).length, 0,
  'aucun motif à segment joker unique sous admin/ ne peut avaler les nouvelles routes');

/* -------------------------------------------------------------------------- */
console.log('\nJ. Réutilisation');
/* -------------------------------------------------------------------------- */

const page = await readFile(at('admin/index.html'), 'utf8');
eq((page.match(/function rate\(/g) || []).length, 0,
  'aucun second `rate` n\'est redéfini : celui des pilotes existe déjà');
eq((page.match(/const rate = /g) || []).length, 1, 'un seul `rate` dans toute la console');
isTrue(/const ratePct = /.test(page),
  'les taux décimaux ont leur variante : `rate` arrondit, ce qui ferait perdre 66,7 en 67 sur de petits échantillons');
eq((page.match(/loadCampaignMetrics|loadCampaigns/g) || []).length >= 2, true,
  'la liste et le détail passent par le même chemin de chargement');
isTrue(/metricsSource: 'computed'/.test(campaignsRoute),
  'la liste dit que les métriques sont calculées, pas stockées');
isTrue(/metricsSource: 'computed'/.test(campaignDetail), 'le détail le dit aussi');
/* Le COMMENT explique justement pourquoi aucun compteur n'est stocké : il cite
   donc le mot. Affirmer son absence sans retirer les commentaires ferait passer
   l'assertion pour la mauvaise raison. */
const migCode = mig.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^--.*$/gm, '');
eq(/leads_count|promoted_count/.test(migCode), false,
  'aucun compteur stocké : un nombre enregistré divergerait dès la première suppression');
isTrue(/leads_count/.test(mig),
  'et le COMMENT explique ce refus — l\'assertion ci-dessus ne passe pas parce que le texte a disparu');

/* -------------------------------------------------------------------------- */
console.log('\nK. i18n');
/* -------------------------------------------------------------------------- */

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
const onDiskBefore = {};
for (const lang of LANGS) {
  onDiskBefore[lang] = await readFile(at(`locales/${lang}/admin.json`), 'utf8');
  dicts[lang] = JSON.parse(onDiskBefore[lang]);
  isTrue(Object.keys(dicts[lang]).length >= 573,
    `${lang} : au moins 573 clés (obtenu ${Object.keys(dicts[lang]).length})`);
}
const ref = Object.keys(dicts.en).sort().join('|');
for (const lang of LANGS) {
  eq(Object.keys(dicts[lang]).sort().join('|'), ref, `${lang} : même jeu de clés que en`);
}

/* Le builder est la source unique. Il est exécuté APRÈS la lecture ci-dessus puis
   comparé : exécuter avant masquerait une altération des fichiers sur disque. */
try {
  await run('python3', ['scripts/build_admin_locales.py'], { cwd: root });
  ok('le builder régénère sans erreur : les trois familles dynamiques sont déclarées');
  const drifted = [];
  for (const lang of LANGS) {
    if ((await readFile(at(`locales/${lang}/admin.json`), 'utf8')) !== onDiskBefore[lang]) drifted.push(lang);
  }
  eq(drifted.join(','), '', `le builder reproduit exactement les fichiers présents (dérive : ${drifted.join(', ') || 'aucune'})`);
} catch (e) {
  bad('le builder échoue — une famille concaténée n\'est pas déclarée', String(e.message).slice(-300));
}

const NEW07 = ['nav.campaigns', 'nav.leads', 'campaigns.subtitle', 'campaigns.rateHint',
  'campaigns.budgetHint', 'campaigns.promotionRate', 'campaigns.customerRate',
  'leads.subtitle', 'leads.hint', 'leads.identityHint', 'leads.collectedHint',
  'leads.provenanceHint', 'leads.duplicateFound', 'leads.promote'];
for (const k of NEW07) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][k] === 'string' && dicts[lang][k].trim().length > 0,
      `${lang} : « ${k} » traduit et non vide`);
  }
}
for (const ch of ['email', 'linkedin', 'phone', 'event', 'webinar', 'referral', 'partner', 'content', 'other']) {
  isTrue(typeof dicts.fr[`campaigns.channel.${ch}`] === 'string', `fr : canal « ${ch} » traduit`);
}
for (const st of ['draft', 'planned', 'running', 'paused', 'completed', 'cancelled']) {
  isTrue(typeof dicts.fr[`campaigns.status.${st}`] === 'string', `fr : statut de campagne « ${st} » traduit`);
}
for (const st of ['new', 'contacted', 'qualified', 'converted', 'discarded']) {
  isTrue(typeof dicts.fr[`leads.status.${st}`] === 'string', `fr : statut de piste « ${st} » traduit`);
}
isTrue(dicts.fr['campaigns.rateHint'].length > 80,
  'l\'explication « taux non mesuré » n\'est pas tronquée en français');
isTrue(dicts.de['leads.collectedHint'].length > 80,
  'l\'explication de la date de collecte n\'est pas tronquée en allemand');
for (const lang of LANGS) {
  isTrue(!/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(JSON.stringify(dicts[lang])),
    `${lang} : aucun caractère CJK`);
}
/* Le garde de chantier01 : aucune valeur multilingue laissée en anglais. */
const untranslated = [];
for (const lang of LANGS.filter((l) => l !== 'en')) {
  for (const k of Object.keys(dicts.en)) {
    if (dicts[lang][k] === dicts.en[k] && /[a-z]/i.test(dicts.en[k]) && dicts.en[k].split(' ').length > 1) {
      untranslated.push(`${lang}:${k}`);
    }
  }
}
eq(untranslated.length, 0, 'aucune entrée multilingue laissée en anglais', untranslated.slice(0, 4).join(', '));

/* -------------------------------------------------------------------------- */
console.log('\nL. Interface');
/* -------------------------------------------------------------------------- */

const stub = `<script>window.TracefabI18n = {
  isReady: true, init: async () => true, setLanguage: async () => true,
  t: (k) => window.__DICT[k] || k,
};</script>`;
const booted = (dict, lang) => page
  .replace('<script src="/i18n-core.js"></script>', stub)
  .replace('</head>', `<script>window.__DICT = ${JSON.stringify(dict)};
    localStorage.setItem('tracefab.lang', ${JSON.stringify(lang)});</script></head>`);

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(String(e?.message || e)));
virtualConsole.on('error', (...a) => pageErrors.push(a.join(' ')));

const dom = new JSDOM(booted(dicts.fr, 'fr'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://tracefab.example/admin/?demo', virtualConsole,
});
const { window } = dom;
const { document } = window;
const settle = () => new Promise((r) => setTimeout(r, 200));
await settle();
await settle();

const view_ = () => document.getElementById('app').textContent || '';
const click = (el) => {
  if (!el) throw new Error('élément introuvable');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
const go = async (v) => {
  const el = document.querySelector(`[data-view="${v}"]`);
  if (!el) throw new Error(`navigation introuvable : ${v}`);
  click(el);
  await settle();
  await settle();
};

eq(pageErrors.length, 0, 'aucune erreur JavaScript au démarrage', pageErrors.slice(0, 3).join(' | '));

/* §1 — les 18 entrées sont réelles. */
const ALL18 = ['dashboard', 'prospects', 'pipeline', 'leads', 'opportunities', 'contacts',
  'campaigns', 'tasks', 'activities', 'emails', 'notes', 'meetings', 'pilots',
  'customers', 'suppliers', 'analytics', 'usage', 'settings'];
eq(document.querySelectorAll('[data-view]').length, 18,
  `§1 : exactement 18 entrées de navigation (obtenu ${document.querySelectorAll('[data-view]').length})`);
for (const v of ALL18) {
  isTrue(!!document.querySelector(`[data-view="${v}"]`), `§1 : « ${v} » est une entrée réelle`);
}
eq(/const SOON = \[\];/.test(page), true, '§1 : plus aucune entrée n\'est marquée « à venir »');
eq(/'Leads'/.test(page.match(/const SOON = \[[^\]]*\]/)?.[0] || ''), false, '§1 : « Leads » n\'est plus à venir');
eq(/'Campaigns'/.test(page.match(/const SOON = \[[^\]]*\]/)?.[0] || ''), false, '§1 : « Campaigns » n\'est plus à venir');

for (const v of ALL18) {
  pageErrors.length = 0;
  await go(v);
  eq(pageErrors.length, 0, `la vue « ${v} » s'affiche sans erreur`, pageErrors.slice(0, 1).join(' | '));
}

/* Campagnes. */
await go('campaigns');
isTrue(view_().includes('Première Vision 2026'), '§1 : la campagne mesurée est nommée');
isTrue(view_().includes('66,7'), '§1 : le taux décimal est affiché avec sa décimale, pas arrondi');
isTrue(view_().includes(dicts.fr['common.notMeasured']),
  '§1 : une campagne sans décision affiche « non mesuré », pas 0 %');
isTrue(view_().includes(dicts.fr['campaigns.rateHint']),
  '§1 : il est expliqué que « non mesuré » n\'est pas zéro');
/* Détail de campagne. */
click(document.querySelector('[data-campaign]'));
await settle();
await settle();
isTrue(/Première Vision 2026/.test(view_()), '§1 : le détail de la campagne s\'affiche');
isTrue(/Tissage du Rhône/.test(view_()), '§1 : le détail liste les pistes de la campagne');
eq(pageErrors.length, 0, '§1 : le détail de campagne ne produit aucune erreur');

/* Pistes. */
await go('leads');
isTrue(view_().includes('Maison Verte'), '§1 : la piste est nommée');
isTrue(view_().includes(dicts.fr['leads.status.converted']), '§1 : le statut « converti » est traduit');
isTrue(view_().includes(dicts.fr['leads.status.discarded']), '§1 : le statut « écarté » est traduit');
isTrue(view_().includes('salon'), '§1 : la provenance est affichée');
isTrue(view_().includes(dicts.fr['leads.hint']),
  '§1 : il est dit qu\'une piste n\'est pas une entreprise');

/* La promotion n'est offerte que là où elle a un sens. */
const promotable = [...document.querySelectorAll('[data-promote]')].map((b) => b.dataset.promote);
eq(promotable.length, 3, '§1 : trois pistes sont promouvables (sur six : deux converties, une écartée)');
eq(promotable.includes('l4'), false, '§1 : une piste écartée ne propose pas de promotion');
eq(promotable.includes('l1'), false, '§1 : une piste déjà convertie ne propose pas de promotion');

click(document.querySelector('[data-lead]'));
await settle();
await settle();
isTrue(/Maison Verte/.test(view_()), '§1 : le détail de la piste s\'affiche');
isTrue(view_().includes(dicts.fr['leads.provenanceHint']),
  '§1 : il est dit qu\'un prospect sans provenance ne peut pas être évalué');
eq(pageErrors.length, 0, '§1 : le détail de piste ne produit aucune erreur');

/* Modaux. */
await go('campaigns');
click(document.getElementById('new-campaign'));
await settle();
eq(document.querySelectorAll('[id^=cp-]').length, 10, '§1 : le formulaire de campagne expose ses dix champs');
isTrue(document.getElementById('app').textContent.includes(dicts.fr['campaigns.budgetHint']),
  '§1 : le formulaire dit que le budget est déclaré, pas constaté');
isTrue(!!document.querySelector('.modalbox[role="dialog"][aria-modal="true"]'),
  '§1 : le modal de campagne est annoncé comme dialogue (accessibilité)');

await go('leads');
click(document.getElementById('new-lead'));
await settle();
await settle();
eq(document.querySelectorAll('[id^=ld-]').length, 14, '§1 : le formulaire de piste expose ses quatorze champs');
const campSel = document.getElementById('ld-campaign_id');
isTrue(!!campSel, '§1 : le sélecteur de campagne existe sur le formulaire de piste');
eq(campSel ? campSel.options.length : 0, 5, '§1 : il propose « aucune campagne » + les quatre campagnes');
eq(campSel ? campSel.options[0].value : null, '', '§1 : la première option détache de toute campagne');
isTrue(document.getElementById('app').textContent.includes(dicts.fr['leads.identityHint']),
  '§1 : il est expliqué pourquoi nom, email et site sont figés');
isTrue(document.getElementById('app').textContent.includes(dicts.fr['leads.collectedHint']),
  '§1 : il est expliqué que la date de collecte n\'est pas la date d\'import');

/* Aucune classe sans règle CSS. */
const css = page.slice(0, page.indexOf('</style>'));
const jsBlock = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).filter((b) => b.trim()).pop();
const usedClasses = new Set([...jsBlock.matchAll(/class="([a-zA-Z0-9 \-]+)"/g)]
  .flatMap((m) => m[1].split(' ')));
const definedClasses = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9\-]*)/g)].map((m) => m[1]));
const naked = [...usedClasses].filter((c) => !definedClasses.has(c));
eq(naked.join(','), '', `aucune classe utilisée sans règle CSS (nu : ${naked.join(', ') || 'aucune'})`);
const varsUsed = new Set([...page.matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map((m) => m[1]));
const varsDefined = new Set([...page.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
const nakedVars = [...varsUsed].filter((v) => !varsDefined.has(v));
eq(nakedVars.join(','), '', `aucune variable CSS indéfinie (nu : ${nakedVars.join(', ') || 'aucune'})`);

/* -------------------------------------------------------------------------- */

if (notes.length) {
  console.log('\nNotes (vérifications non effectuées, sans défaut de code) :');
  for (const n of notes) console.log(`  - ${n}`);
}
console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
