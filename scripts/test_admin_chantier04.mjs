#!/usr/bin/env node
/**
 * CHANTIER ADMIN 04 — opportunité TRACEFAB (§4), journal d'audit (§16), réglages (§1).
 *
 * Ce test exécute les modules RÉELS compilés (`api/_lib/crm-audit.ts`,
 * `api/_lib/crm-opportunity.ts`) et rend l'interface RÉELLE dans jsdom avec le
 * vrai dictionnaire lu sur disque.
 *
 *   A. compilation des modules réels ;
 *   B. diff d'états — absent ≠ null ;
 *   C. entrée d'audit — scellée, bornée, organisation plateforme ;
 *   D. filtres d'audit — jamais d'injection ;
 *   E. §4 opportunité — dérivée de champs réels, jamais inventée ;
 *   F. codes pays — ce qui est vérifié, et ce qui ne l'est pas ;
 *   G. câblage — toute route mutante scelle une entrée, dans sa transaction ;
 *   H. routes — ordre porteur, journal en lecture seule ;
 *   I. chaîne de hachage — le verrou qui la protège ;
 *   J. i18n ;
 *   K. interface — vue Réglages et onglet opportunité.
 *
 *   npm run test:admin:chantier04
 */
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from 'jsdom';

const { JSDOM, VirtualConsole } = pkg;

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => join(root, p);
let checks = 0;
let failures = 0;
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
const outDir = await mkdtemp(at('.cache/admin04-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/crm-audit.ts', 'api/_lib/crm-opportunity.ts',
    '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('crm-audit.ts et crm-opportunity.ts compilent');
} catch (e) {
  bad('les modules Admin 04 ne compilent pas', e.message.slice(0, 400));
}

const audit = await import(pathToFileURL(join(outDir, 'crm-audit.js')).href);
const opp = await import(pathToFileURL(join(outDir, 'crm-opportunity.js')).href);

/* crm-audit.ts est pur : aucune importation, donc exécutable sans client Prisma. */
const auditSrc = await readFile(at('api/_lib/crm-audit.ts'), 'utf8');
eq(/^import\s/m.test(auditSrc), false,
  'crm-audit.ts n\'importe rien : il reste exécutable sans client Prisma généré');

/* -------------------------------------------------------------------------- */
console.log('\nB. Diff d\'états — borné par entité, absent ≠ null');
/* -------------------------------------------------------------------------- */

/*
 * Signature réelle : diffStates(entity, before, after) → FieldChange[].
 * Le diff est BORNÉ par AUDIT_FIELDS[entity] : c'est ce qui empêche une colonne
 * ajoutée demain au modèle d'être journalisée sans que personne l'ait décidé.
 */
const diff = audit.diffStates;
eq(JSON.stringify(diff('crm_company', null, null)), '[]', 'deux états absents ne produisent aucun changement');
eq(JSON.stringify(diff('crm_company', null, {})), '[]', 'un état vide ne produit aucun changement');
eq(JSON.stringify(diff('crm_company', { stage: 'new' }, { stage: 'new' })), '[]',
  'deux états identiques ne produisent aucun changement — sinon le journal se remplit de bruit');

/* La distinction qui compte : une colonne non lue n'est pas une colonne vidée. */
eq(JSON.stringify(diff('crm_company', { stage: 'demo', lost_reason: null }, { stage: 'demo' })), '[]',
  'un champ présent à null puis absent n\'est PAS un changement : sinon chaque PATCH journaliserait des suppressions fantômes');

const cleared = diff('crm_company', { lost_reason: 'budget' }, {});
eq(cleared.length, 1, 'un champ réellement vidé produit exactement un changement');
eq(cleared[0].field, 'lost_reason', 'le champ vidé est nommé');
eq(cleared[0].from, 'budget', 'la valeur avant est conservée');
eq(cleared[0].to, null, 'la valeur après est null');

const changed = diff('crm_company', { stage: 'demo' }, { stage: 'customer' });
eq(changed.length, 1, 'un seul champ modifié produit un seul changement');
eq(changed[0].field, 'stage', 'le champ modifié est nommé');
eq(changed[0].from, 'demo', 'la valeur avant est conservée');
eq(changed[0].to, 'customer', 'la valeur après est conservée');

/* Le bornage par liste blanche est la propriété qui compte. */
eq(JSON.stringify(diff('crm_company', { password_hash: 'x' }, { password_hash: 'y' })), '[]',
  'un champ hors liste blanche n\'est jamais journalisé, même s\'il change');
eq(JSON.stringify(diff('crm_saved_view', { stage: 'a' }, { stage: 'b' })), '[]',
  'le bornage est par entité : « stage » n\'a pas de sens sur une liste de prospection');
eq(diff('crm_saved_view', { name: 'A' }, { name: 'B' }).length, 1,
  '« name » est en revanche journalisable sur une liste de prospection');

/* Plusieurs champs modifiés → tous, dans l'ordre de la liste blanche. */
const multi = diff('crm_company', { stage: 'demo', priority: 'low' }, { stage: 'customer', priority: 'critical' });
eq(multi.length, 2, 'deux champs modifiés produisent deux changements');
eq(JSON.stringify(multi.map((c) => c.field).sort()), JSON.stringify(['priority', 'stage']),
  'les deux champs sont nommés');

/* Les Dates : JSON ne sait pas les comparer, elles sont sérialisées d'abord. */
const dDates = diff('crm_company',
  { converted_at: new Date('2026-01-01T00:00:00Z') },
  { converted_at: new Date('2026-06-01T00:00:00Z') });
eq(typeof dDates[0].from, 'string', 'une Date est sérialisée avant comparaison');
eq(dDates[0].from, '2026-01-01T00:00:00.000Z', 'la Date est sérialisée en ISO 8601');
eq(JSON.stringify(diff('crm_company',
  { converted_at: new Date('2026-01-01T00:00:00Z') },
  { converted_at: new Date('2026-01-01T00:00:00Z') })), '[]',
  'deux Dates égales ne sont pas un changement — sans sérialisation, elles le seraient toujours');

/* undefined et null sont la même absence. */
eq(JSON.stringify(diff('crm_company', { stage: undefined }, { stage: null })), '[]',
  'undefined et null sont traités comme la même absence');

/* Un objet imbriqué est comparé structurellement. */
eq(JSON.stringify(diff('crm_company', { notes: { a: 1 } }, { notes: { a: 1 } })), '[]',
  'un objet imbriqué identique n\'est pas un changement');

/* -------------------------------------------------------------------------- */
console.log('\nC. Entrée d\'audit — scellée, bornée, organisation plateforme');
/* -------------------------------------------------------------------------- */

const ADMIN = { platformOrganizationId: 'org-platform', userId: 'user-1', fullName: 'Founder' };

const e1 = audit.buildAuditEntry({ admin: ADMIN, entity: 'crm_company', action: 'created', entityId: 'c1' });
eq(e1.organizationId, 'org-platform',
  'l\'entrée est scellée sur l\'organisation PLATEFORME : la piste TRACEFAB reste distincte de celle des marques');
eq(e1.actorUserId, 'user-1', 'l\'auteur est l\'utilisateur réel, pas un compte de service');
eq(e1.action, 'created', 'l\'action est reprise telle quelle');
eq(e1.entityType, 'crm_company', 'l\'entité est reprise telle quelle');
eq(e1.entityId, 'c1', 'l\'identifiant de l\'entité est repris');
eq(e1.metadata.actorName, 'Founder', 'le nom de l\'auteur est conservé dans les métadonnées');
eq(e1.beforeState, null, 'sans état avant, beforeState est null et non undefined');
eq(e1.afterState, null, 'sans état après, afterState est null et non undefined');
eq(e1.metadata.changeCount, 0, 'aucun état fourni → aucun changement compté');
eq(e1.entityId, 'c1', 'l\'identifiant fourni est conservé');
eq(audit.buildAuditEntry({ admin: ADMIN, entity: 'crm_company', action: 'created' }).entityId, null,
  'sans identifiant, entityId est null et non undefined');

const e2 = audit.buildAuditEntry({
  admin: ADMIN, entity: 'crm_company', action: 'updated', entityId: 'c1',
  before: { stage: 'demo' }, after: { stage: 'customer' },
});
eq(JSON.stringify(e2.beforeState), JSON.stringify({ stage: 'demo' }), 'l\'état avant est conservé');
eq(JSON.stringify(e2.afterState), JSON.stringify({ stage: 'customer' }), 'l\'état après est conservé');
eq(e2.metadata.changeCount, 1, 'le nombre de champs modifiés est compté');
eq(JSON.stringify(e2.metadata.changedFields), JSON.stringify(['stage']), 'les champs modifiés sont nommés');

/* Les métadonnées de l'appelant s'ajoutent sans écraser le comptage. */
const e3 = audit.buildAuditEntry({
  admin: ADMIN, entity: 'crm_company', action: 'updated', entityId: 'c1',
  before: { stage: 'demo', priority: 'high' }, after: { stage: 'demo' }, metadata: { note: 'x' },
});
eq(e3.metadata.note, 'x', 'des métadonnées fournies par l\'appelant survivent');
eq(e3.metadata.changeCount, 1, 'les métadonnées de l\'appelant n\'écrasent pas le comptage');
/* `stage` est inchangé ; `priority` passe de 'high' à absent, donc vidé.
   C'est `priority` qui doit être listé — lister `stage` serait une erreur. */
eq(JSON.stringify(e3.metadata.changedFields), JSON.stringify(['priority']),
  'seul le champ réellement modifié est listé, pas tous ceux fournis');
eq(e3.metadata.changeCount, 1, 'le champ inchangé n\'est pas compté');

/* Le vocabulaire est imposé par le TYPE (AuditAction), pas par une exception :
   lever dans la transaction annulerait une mutation métier légitime à cause d'une
   faute de frappe dans le journal. Le test vérifie donc ce que les routes écrivent. */
eq(audit.AUDIT_ACTIONS.length, 13, 'treize actions au vocabulaire, pas une de plus');
eq(audit.AUDIT_ENTITIES.length, 7, 'sept entités au vocabulaire, pas une de plus');
eq(new Set(audit.AUDIT_ACTIONS).size, 13, 'aucune action en double');
eq(new Set(audit.AUDIT_ENTITIES).size, 7, 'aucune entité en double');
isTrue(Object.keys(audit.AUDIT_FIELDS).length === 7
  && Object.keys(audit.AUDIT_FIELDS).every((k) => audit.AUDIT_ENTITIES.includes(k)),
  'chaque entité a exactement une liste blanche de champs, et aucune de plus');
isTrue(audit.AUDIT_FIELDS.crm_company.includes('stage')
  && audit.AUDIT_FIELDS.crm_company.includes('lost_reason')
  && audit.AUDIT_FIELDS.crm_company.includes('converted_at'),
  'les champs de conversion et de perte sont journalisables : ce sont les plus sensibles');
isTrue(!audit.AUDIT_FIELDS.crm_contact.includes('phone') && !audit.AUDIT_FIELDS.crm_contact.includes('linkedin_url'),
  'le téléphone et le LinkedIn d\'un contact ne sont PAS journalisés : le journal n\'a pas à dupliquer des données personnelles');

/* Chaque action du vocabulaire est réellement employée par au moins une route. */
const adminFiles = (await readdir(at('api/_routes/admin'), { recursive: true }))
  .map(String).filter((f) => f.endsWith('.ts'));
const routeCorpus = (await Promise.all(adminFiles.map((f) => readFile(at(`api/_routes/admin/${f}`), 'utf8')))).join('\n');
/*
 * L'expression `action: …` peut être un ternaire (`stage === 'customer' ?
 * 'converted' : …`). Extraire `action: 'x'` rate ces branches — c'est la troisième
 * fois qu'un matcher trop étroit me trompe. On prend donc l'expression entière,
 * puis les littéraux qu'elle contient.
 */
/*
 * Aucune extraction regex n'est fiable ici : l'expression peut être un ternaire
 * réparti sur trois lignes, et ses CONDITIONS contiennent aussi des littéraux
 * ('done', 'customer') qui ne sont pas des actions. Deux vérifications honnêtes
 * valent mieux qu'un matcher fragile :
 *   - pas de verbe MORT  → chaque action du vocabulaire apparaît comme littéral ;
 *   - pas de verbe INVENTÉ → le paramètre est typé AuditAction, donc un littéral
 *     hors vocabulaire est une erreur de compilation, pas une donnée corrompue.
 */
for (const a of audit.AUDIT_ACTIONS) {
  isTrue(routeCorpus.includes(`'${a}'`),
    `l'action « ${a} » apparaît bien dans une route — pas de verbe mort au vocabulaire`);
}
const writeSrc = await readFile(at('api/_lib/crm-audit-write.ts'), 'utf8');
isTrue(/action: AuditAction/.test(writeSrc),
  'le paramètre « action » est typé AuditAction : un verbe inventé est une erreur de compilation, pas une ligne de journal illisible');
isTrue(/entity: AuditEntity/.test(writeSrc),
  'le paramètre « entity » est typé AuditEntity, pour la même raison');
isTrue(/import type \{ AuditAction, AuditEntity \}/.test(writeSrc),
  'les types viennent de crm-audit.ts : une seule source de vérité pour le vocabulaire');
for (const en of audit.AUDIT_ENTITIES) {
  isTrue(new RegExp(`entity: '${en}'`).test(routeCorpus),
    `l'entité « ${en} » est réellement écrite par une route`);
}
for (const en of audit.AUDIT_ENTITIES) {
  isTrue(routeCorpus.includes(`'${en}'`), `l'entité « ${en} » apparaît bien dans une route`);
}

/* -------------------------------------------------------------------------- */
console.log('\nD. Filtres d\'audit — liste close, valeurs scalaires');
/* -------------------------------------------------------------------------- */

const san = audit.sanitizeAuditFilters;
eq(JSON.stringify(san({})), '{}', 'aucun filtre → objet vide, pas un objet de clés nulles');
eq(san({ action: 'created' }).action, 'created', 'une action passe telle quelle');
eq(san({ entity_type: 'crm_company' }).entity_type, 'crm_company', 'une entité passe telle quelle');
eq(san({ entity_id: 'abc-123' }).entity_id, 'abc-123', 'un identifiant d\'entité passe tel quel');
eq(san({ since: '2026-01-01' }).since, '2026-01-01', 'une date passe telle quelle');
eq(san({ actor: 'user-1' }).actor, 'user-1', 'un auteur passe tel quel');
eq(san({ action: '  created  ' }).action, 'created', 'les espaces autour sont retirés');
eq(JSON.stringify(san({ action: '' })), '{}', 'une valeur vide n\'est pas conservée');
eq(JSON.stringify(san({ action: '   ' })), '{}', 'une valeur blanche n\'est pas conservée');
eq(JSON.stringify(san({ foo: 'bar', orderBy: '1;--', select: '*' })), '{}',
  'une clé non reconnue est ignorée : la liste blanche est fermée');
eq(JSON.stringify(san({ action: 'x'.repeat(121) })), '{}',
  'une valeur de plus de 120 caractères est écartée');
eq(san({ entity_id: 'x'.repeat(120) }).entity_id, 'x'.repeat(120),
  '120 caractères passent : la borne est incluse');

/* Un paramètre répété arrive en tableau. String(['a','b']) vaudrait 'a,b' :
   non vide, donc conservé, mais absent de tout vocabulaire. */
eq(JSON.stringify(san({ action: ['created', 'updated'] })), '{}',
  'un paramètre répété (tableau) est écarté — sinon la valeur validée et la valeur interrogée divergeraient');
eq(JSON.stringify(san({ entity_id: { $ne: null } })), '{}',
  'un objet est écarté : pas d\'opérateur de requête injectable');
eq(JSON.stringify(san(null)), '{}', 'une entrée nulle renvoie un objet vide et ne lève pas');
eq(JSON.stringify(san(undefined)), '{}', 'une entrée indéfinie renvoie un objet vide');
eq(JSON.stringify(san('created')), '{}', 'une entrée qui n\'est pas un objet renvoie un objet vide');
eq(san({ entity_id: 42 }).entity_id, '42', 'un nombre est accepté et converti en chaîne');

/*
 * La répartition des responsabilités est volontaire et doit rester visible :
 * `sanitizeAuditFilters` borne la FORME (clés, type, longueur) ; c'est la ROUTE
 * qui borne le VOCABULAIRE et renvoie 400. Prisma paramètre la valeur, donc un
 * SQL hostile ne peut de toute façon pas être exécuté — mais une valeur hors
 * vocabulaire doit être refusée plutôt qu'ignorée en silence.
 */
const auditRouteSrc = await readFile(at('api/_routes/admin/audit.ts'), 'utf8');
isTrue(/AUDIT_ACTIONS as readonly string\[\]\)\.includes\(action\)/.test(auditRouteSrc),
  'la route vérifie l\'action contre le vocabulaire');
isTrue(/audit_action_unknown/.test(auditRouteSrc),
  'une action hors vocabulaire est refusée en 400, pas ignorée');
isTrue(/AUDIT_ENTITIES as readonly string\[\]\)\.includes\(entityType\)/.test(auditRouteSrc),
  'la route vérifie l\'entité contre le vocabulaire');
isTrue(/audit_entity_unknown/.test(auditRouteSrc),
  'une entité hors vocabulaire est refusée en 400, pas ignorée');
isTrue(san({ action: 'DROP TABLE audit_logs;--' }).action === 'DROP TABLE audit_logs;--',
  'le sanitiseur ne prétend pas valider le vocabulaire : la valeur passe la forme et la route la refuse');
isTrue(/tx\.audit_logs\.findMany/.test(auditRouteSrc) && !/\$queryRawUnsafe|\$executeRawUnsafe/.test(auditRouteSrc),
  'la lecture passe par le client Prisma paramétré, jamais par du SQL concaténé');

/* -------------------------------------------------------------------------- */
console.log('\nE. §4 opportunité — dérivée de champs réels, jamais inventée');
/* -------------------------------------------------------------------------- */

const empty = opp.assessOpportunity({});
eq(empty.insufficient, true, 'aucun champ saisi → état « données insuffisantes », pas une conclusion inventée');
eq(empty.problems.length, 0, 'aucun champ saisi → aucun problème « probable »');
eq(empty.features.length, 0, 'aucun champ saisi → aucune fonctionnalité « pertinente »');
eq(empty.signals, 0, 'aucun champ saisi → zéro signal');
eq(JSON.stringify(empty.layers), JSON.stringify([]), 'aucun champ saisi → aucune couche du socle');

const nulls = opp.assessOpportunity({
  country_code: null, product_count: null, supplier_count: null,
  maturity: null, dpp_interest: null, traceability_interest: null,
});
eq(nulls.insufficient, true, 'des champs explicitement nuls ne produisent pas non plus de conclusion');

const blank = opp.assessOpportunity({ country_code: '  ', maturity: '' });
eq(blank.insufficient, true, 'une chaîne vide ou blanche n\'est pas un signal');

/* Le cas réel : les champs de l'entreprise de démonstration d1. */
const D1 = { country_code: 'FR', product_count: 350, supplier_count: 42, maturity: 'medium' };
const full = opp.assessOpportunity(D1);
eq(full.insufficient, false, 'des champs réels produisent bien une analyse');
eq(full.signals, 3, 'trois signaux convergents : fournisseurs, catalogue, pays — pas quatre');
eq(JSON.stringify(full.problems.map((p) => p.code)),
  JSON.stringify(['manySuppliers', 'largeCatalogue', 'catalogueUnstructured', 'esprScope']),
  'les problèmes dérivés sont exactement ceux que ces champs autorisent');
eq(JSON.stringify(full.layers), JSON.stringify(['L01', 'L02', 'L03', 'L06', 'L07']),
  "les couches du socle sont dans l'ordre du socle");

/* Chaque conclusion doit citer le champ qui l'a produite : c'est ce qui la rend vérifiable. */
isTrue(full.problems.every((p) => typeof p.evidence === 'string' && p.evidence.length > 0),
  'chaque problème porte la preuve qui l\'a produit');
isTrue(full.features.every((f) => typeof f.evidence === 'string' && f.evidence.length > 0),
  'chaque fonctionnalité porte la preuve qui l\'a produite');
isTrue(full.problems.every((p) => /^[a-z_]+ = /.test(p.evidence)),
  'les preuves sont des paires champ = valeur, pas des phrases');
/* Une surface en 7 langues ne peut pas recevoir de texte en dur depuis l'API. */
isTrue(full.problems.concat(full.features).every((f) => !/[a-z]{3,}\s+[a-z]{3,}/i.test(f.evidence)),
  'aucune preuve ne contient de phrase en langue naturelle — le libellé vient du dictionnaire');

/* Les seuils sont écrits, donc discutables. */
eq(opp.THRESHOLDS.manySuppliers, 20, 'le seuil « beaucoup de fournisseurs » est écrit : 20');
eq(opp.THRESHOLDS.largeCatalogue, 100, 'le seuil « grand catalogue » est écrit : 100');
eq(opp.THRESHOLDS.richSignals, 3, 'le seuil « signaux convergents » est écrit : 3');

const few = opp.assessOpportunity({ supplier_count: 19, product_count: 99 });
eq(few.insufficient, true, 'sous les seuils, aucun signal : les seuils sont appliqués, pas arrondis');
const atThreshold = opp.assessOpportunity({ supplier_count: 20 });
isTrue(atThreshold.problems.some((p) => p.code === 'manySuppliers'),
  'au seuil exact, le signal est produit (borne incluse)');

/* Un seul signal ne suffit pas à recommander la couche Intelligence : ce serait du remplissage. */
const one = opp.assessOpportunity({ country_code: 'DE' });
eq(one.signals, 1, 'un seul signal');
eq(one.features.some((f) => f.code === 'intelligence'), false,
  'un seul signal ne recommande PAS la couche Intelligence');
const three = opp.assessOpportunity({ country_code: 'DE', supplier_count: 25, product_count: 120 });
eq(three.signals, 3, 'trois signaux');
isTrue(three.features.some((f) => f.code === 'intelligence'),
  'trois signaux convergents recommandent la couche Intelligence');

/* L'intérêt déclaré est un signal ; son absence n'est pas un signal négatif. */
const dpp = opp.assessOpportunity({ dpp_interest: 'high' });
isTrue(dpp.problems.some((p) => p.code === 'declaredDppInterest'),
  'un intérêt DPP déclaré élevé est un signal');
eq(opp.assessOpportunity({ dpp_interest: 'unknown' }).insufficient, true,
  'un intérêt DPP « non qualifié » n\'est PAS traité comme un intérêt faible');
eq(opp.assessOpportunity({ dpp_interest: 'low' }).insufficient, true,
  'un intérêt DPP « faible » ne produit pas de conclusion non plus');

const tr = opp.assessOpportunity({ traceability_interest: 'high' });
isTrue(tr.problems.some((p) => p.code === 'declaredTraceabilityInterest'),
  'un intérêt traçabilité déclaré élevé est un signal');
isTrue(tr.layers.includes('L05'), 'l\'intérêt traçabilité mobilise la couche L05');

/* Une maturité inconnue est un manque, signalé comme tel — pas un diagnostic. */
const unk = opp.assessOpportunity({ maturity: 'unknown' });
isTrue(unk.problems.some((p) => p.code === 'maturityUnknown'),
  'une maturité non évaluée est signalée comme une question à poser');
eq(unk.signals, 0, 'une maturité inconnue n\'est pas comptée comme un signal');

/* La consolidation manuelle n'est affirmée que si les DEUX conditions sont réunies. */
const both = opp.assessOpportunity({ supplier_count: 30, maturity: 'low' });
isTrue(both.problems.some((p) => p.code === 'supplierDataManual'),
  'beaucoup de fournisseurs ET maturité faible → consolidation manuelle probable');
eq(opp.assessOpportunity({ supplier_count: 30, maturity: 'high' }).problems
  .some((p) => p.code === 'supplierDataManual'), false,
  'beaucoup de fournisseurs mais maturité élevée → on n\'affirme PAS de consolidation manuelle');
eq(opp.assessOpportunity({ supplier_count: 5, maturity: 'low' }).problems
  .some((p) => p.code === 'supplierDataManual'), false,
  'peu de fournisseurs mais maturité faible → on n\'affirme PAS de consolidation manuelle');

/* Un même signal pointant deux fois la même fonctionnalité ne doit pas la répéter. */
const dedup = opp.assessOpportunity({ country_code: 'FR', dpp_interest: 'high' });
const codes = dedup.features.map((f) => f.code);
eq(codes.length, new Set(codes).size, 'une fonctionnalité n\'est jamais listée deux fois');

/* Une ligne Prisma brute (Record<string, unknown>) est acceptée : c'est ce que la route reçoit. */
const raw = opp.assessOpportunity({ country_code: 'FR', product_count: 350, supplier_count: 42, maturity: 'medium' });
eq(raw.signals, 3, 'un enregistrement brut produit le même résultat');
/* Un champ du mauvais type ne doit pas lever. */
const junk = opp.assessOpportunity({ product_count: 'beaucoup', supplier_count: {}, country_code: 42 });
eq(junk.insufficient, true, 'un champ du mauvais type ne lève pas : il est ignoré');

/* -------------------------------------------------------------------------- */
console.log('\nF. Codes pays — ce qui est vérifié, et ce qui ne l\'est pas');
/* -------------------------------------------------------------------------- */

eq(opp.EU_MEMBER_STATES.length, 27, 'vingt-sept codes, conformément à l\'UE à 27');
eq(new Set(opp.EU_MEMBER_STATES).size, 27, 'aucun doublon');
isTrue(opp.EU_MEMBER_STATES.every((c) => /^[A-Z]{2}$/.test(c)), 'tous les codes sont en ISO 3166-1 alpha-2');
eq(opp.EU_MEMBER_STATES.includes('GB'), false,
  'le Royaume-Uni n\'y figure pas : il a quitté l\'UE, un prospect britannique n\'est donc pas dans le périmètre ESPR par ce critère');
/* La Grèce utilise EL dans les actes européens et GR en ISO. C'est GR qui est retenu
   parce que c'est ce que saisissent les opérateurs et ce que stocke country_code. */
isTrue(opp.EU_MEMBER_STATES.includes('GR') && !opp.EU_MEMBER_STATES.includes('EL'),
  'la Grèce est présente sous son code ISO GR, pas sous le code européen EL');
/* NOTE D'HONNÊTETÉ : les 27 codes ont été vérifiés comme codes ISO européens valides
   contre world-countries@5.1.0. L'APPARTENANCE à l'UE elle-même ne figure pas dans ce
   jeu de données et n'a donc pas pu être vérifiée depuis cet environnement. */

const lower = opp.assessOpportunity({ country_code: 'fr' });
isTrue(lower.problems.some((p) => p.code === 'esprScope'),
  'un code pays en minuscules est reconnu (normalisation avant comparaison)');
eq(opp.assessOpportunity({ country_code: 'US' }).problems.some((p) => p.code === 'esprScope'), false,
  'un pays hors UE ne déclenche pas le critère ESPR');
eq(opp.assessOpportunity({ country_code: 'ZZ' }).problems.some((p) => p.code === 'esprScope'), false,
  'un code inventé ne déclenche rien');

/* -------------------------------------------------------------------------- */
console.log('\nG. Câblage — toute route mutante scelle une entrée');
/* -------------------------------------------------------------------------- */

/** Routes qui ÉCRIVENT, avec le nombre d'appels d'audit attendus. */
const MUTATING = {
  'companies.ts': 1,
  'companies/[companyId].ts': 1,
  'companies/[companyId]/stage.ts': 1,
  'companies/[companyId]/activities.ts': 1,
  'contacts.ts': 1,
  'contacts/[contactId].ts': 1,
  'tasks.ts': 1,
  'tasks/[taskId].ts': 2,
  'meetings.ts': 2,
  'meetings/[meetingId].ts': 1,
  'pilots.ts': 1,
  'pilots/[pilotId].ts': 1,
  'lists.ts': 1,
  'lists/[listId].ts': 2,
  'import/commit.ts': 1,
};
/** Routes en POST qui n'écrivent RIEN : elles ne doivent donc PAS journaliser. */
const READ_ONLY_POST = ['import/preview.ts'];

const entries = await readdir(at('api/_routes/admin'), { recursive: true });
const routeFiles = entries.filter((f) => String(f).endsWith('.ts')).map(String);

for (const [rel, expected] of Object.entries(MUTATING)) {
  const src = await readFile(at(`api/_routes/admin/${rel}`), 'utf8');
  const n = (src.match(/auditAdmin\(/g) || []).length;
  eq(n >= expected, true, `${rel} scelle au moins ${expected} entrée(s) d'audit (obtenu ${n})`);

  /* L'audit doit être écrit DANS la transaction, pas après : sinon une mutation
     peut réussir sans laisser de trace. */
  const txStart = src.indexOf('withTracefabUserContext(');
  isTrue(txStart !== -1, `${rel} opère dans une transaction`);
  const calls = [...src.matchAll(/auditAdmin\(/g)].map((m) => m.index);
  isTrue(calls.every((i) => i > txStart),
    `${rel} : chaque écriture d'audit est située après l'ouverture de la transaction`);
  isTrue(/auditAdmin\(tx as never/.test(src),
    `${rel} : l'audit utilise le client transactionnel, pas le client global`);
  isTrue(/import \{ auditAdmin \}/.test(src), `${rel} importe auditAdmin`);
}

for (const rel of READ_ONLY_POST) {
  const src = await readFile(at(`api/_routes/admin/${rel}`), 'utf8');
  eq(/auditAdmin\(/.test(src), false,
    `${rel} n'écrit rien en base et ne journalise donc rien — un aperçu n'est pas un acte`);
}

/* Toutes les routes qui écrivent sont couvertes : aucune ne doit passer entre les mailles. */
for (const rel of routeFiles) {
  const src = await readFile(at(`api/_routes/admin/${rel}`), 'utf8');
  const writes = /tx\.\w+\.(create|update|delete|createMany|updateMany|deleteMany)\(/.test(src);
  if (!writes) continue;
  isTrue(/auditAdmin\(/.test(src),
    `${rel} écrit en base : elle doit sceller une entrée d'audit`);
}

/* Le changement d'étape — l'acte commercial le plus sensible — distingue ses trois issues. */
const stageSrc = await readFile(at('api/_routes/admin/companies/[companyId]/stage.ts'), 'utf8');
isTrue(/action: stage === 'customer' \? 'converted' : stage === 'lost' \? 'lost' : 'stage_changed'/.test(stageSrc),
  'le mouvement de pipeline journalise trois issues distinctes : converti, perdu, changé d\'étape');
isTrue(/from, to: stage/.test(stageSrc), 'l\'étape d\'origine et l\'étape cible sont conservées');

/* Le PATCH entreprise journalise un avant ET un après réels. */
const companySrc = await readFile(at('api/_routes/admin/companies/[companyId].ts'), 'utf8');
isTrue(/before: existing as unknown as Record<string, unknown>/.test(companySrc),
  'le PATCH entreprise journalise l\'état avant');
isTrue(/select: \{[\s\S]*?stage: true/.test(companySrc),
  'l\'état avant est réellement lu en base : sans ces colonnes, chaque PATCH ressemblerait à une création');

/* L'import est journalisé comme UN acte, pas comme N créations. */
const commitSrc = await readFile(at('api/_routes/admin/import/commit.ts'), 'utf8');
isTrue(/entity: 'crm_import'/.test(commitSrc), 'l\'import est journalisé sous l\'entité crm_import');
isTrue(/created: created\.length/.test(commitSrc), 'le nombre de lignes réellement créées est journalisé');
isTrue(/duplicate: preview\.counts\.duplicate/.test(commitSrc), 'le nombre de doublons écartés est journalisé');

/* -------------------------------------------------------------------------- */
console.log('\nH. Routes — ordre porteur, journal en lecture seule');
/* -------------------------------------------------------------------------- */

const routerSrc = await readFile(at('api/index.ts'), 'utf8');
/*
 * L'extraction s'arrête sur « /, params: » et non sur le premier « / » : un motif
 * comme /^admin\/access$/ contient des slashes échappés, et couper au premier
 * produirait des regex tronquées qui matcheraient quand même par accident.
 */
const patterns = [...routerSrc.matchAll(/\{ pattern: \/\^(.*?)\/, params: \[([^\]]*)\], load: \(\) => import\('\.\/(_routes\/[^']+)'\)/g)]
  .map((m) => ({ re: new RegExp(`^${m[1]}`), load: m[3] }));
isTrue(patterns.length >= 149, `le routeur déclare au moins 149 motifs (obtenu ${patterns.length})`);

const match = (path) => {
  const hit = patterns.find((p) => p.re.test(path));
  return hit ? hit.load : null;
};
eq(match('admin/audit'), '_routes/admin/audit.js',
  '/api/admin/audit atteint bien son handler — aucun motif plus large ne l\'ombre');
eq(match('admin/settings'), '_routes/admin/settings.js',
  '/api/admin/settings atteint bien son handler');
/* Contre-vérification de l'ordre : si un motif admin/([^/]+) existait avant,
   ces deux routes seraient inatteignables. */
/*
 * Le risque réel n'est pas « un motif admin contient un joker » — `admin/companies/
 * ([^/]+)` en contient un et ne peut pas ombrager `admin/audit`, puisqu'il est
 * ancré sur `admin/companies/`. Le risque est un motif à UN SEUL segment joker
 * directement sous `admin/`, qui avalerait n'importe quelle route admin.
 */
const greedyAdmin = patterns.filter((p) => /^admin\\\/\(\[\^\\\/\]\+\)\$$/.test(p.re.source));
eq(greedyAdmin.length, 0,
  `aucun motif à segment joker unique sous admin/ — sinon il avalerait audit, settings, notes, emails et opportunities (trouvé : ${greedyAdmin.length})`);
/* Et la conséquence, mesurée plutôt que supposée : chaque route admin atteint son handler. */
for (const path of ['admin/audit', 'admin/settings', 'admin/notes', 'admin/emails', 'admin/opportunities']) {
  const hit = patterns.find((p) => p.re.test(path));
  eq(hit ? hit.load : null, `_routes/admin/${path.split('/')[1]}.js`,
    `${path} atteint son propre handler`);
}

const auditRoute = await readFile(at('api/_routes/admin/audit.ts'), 'utf8');
isTrue(/methodNotAllowed\(res, \['GET'\]\)/.test(auditRoute),
  'le journal d\'audit est en LECTURE SEULE : aucune route ne peut y écrire depuis l\'extérieur');
eq(/tx\.audit_logs\.(create|update|delete)/.test(auditRoute), false,
  'la route d\'audit n\'écrit jamais dans audit_logs');
isTrue(/verifyAuditChainIntegrity/.test(auditRoute),
  'verify=1 rejoue la chaîne de hachage');
isTrue(/limitRaw <= 500/.test(auditRoute), 'la taille de page est plafonnée à 500');
isTrue(/audit_action_unknown/.test(auditRoute) && /audit_entity_unknown/.test(auditRoute),
  'un filtre hors vocabulaire est refusé en 400 au lieu d\'être ignoré silencieusement');
isTrue(/since_must_be_a_date/.test(auditRoute), 'une date invalide est refusée en 400');
isTrue(/organization_id: orgId/.test(auditRoute),
  'la lecture est bornée à l\'organisation plateforme : isolation par construction');

const settingsRoute = await readFile(at('api/_routes/admin/settings.ts'), 'utf8');
isTrue(/methodNotAllowed\(res, \['GET'\]\)/.test(settingsRoute),
  'les réglages sont en lecture seule : l\'accès Admin se donne dans organization_memberships, pas ici');
eq(/tx\.organization_memberships\.(create|update|delete)/.test(settingsRoute), false,
  'la route de réglages ne peut PAS accorder ni retirer le rôle Admin — sinon ce serait une seconde porte');
isTrue(/singlePointOfFailure/.test(settingsRoute),
  'un seul Admin actif est signalé comme risque opérationnel');
isTrue(/isAdminAccessDenied\(error\)[\s\S]*403/.test(settingsRoute), 'un non-admin reçoit 403');

/* -------------------------------------------------------------------------- */
console.log('\nI. Chaîne de hachage — le verrou qui la protège');
/* -------------------------------------------------------------------------- */

const vaultSrc = await readFile(at('api/_lib/audit-vault.ts'), 'utf8');
isTrue(/pg_advisory_xact_lock\(hashtext\(/.test(vaultSrc),
  'la prise de verrou consultatif est présente : sans elle, deux écritures concurrentes créent deux maillons frères et la chaîne semble rompue alors que le journal est intact');
const lockAt = vaultSrc.indexOf('pg_advisory_xact_lock');
/*
 * La lecture du maillon précédent est le `findFirst` sur audit_logs, pas la
 * première occurrence textuelle de « previousHash » — celle-là est la déclaration
 * d'interface, en tête de fichier, et ferait passer un verrou posé trop tard.
 */
const readAt = vaultSrc.indexOf('audit_logs.findFirst');
isTrue(lockAt !== -1 && readAt !== -1 && lockAt < readAt,
  `le verrou est pris AVANT la lecture du maillon précédent (verrou à ${lockAt}, lecture à ${readAt}) — un verrou pris après ne protège rien`);
eq(vaultSrc.indexOf('previousHash') < lockAt, true,
  'contre-vérification : « previousHash » apparaît d\'abord comme déclaration d\'interface, ce qui rend l\'ancre naïve trompeuse');
isTrue(/verifyAuditChainIntegrity/.test(vaultSrc),
  'la vérification de chaîne existe : un journal « append-only » sans vérification n\'est qu\'une convention');
isTrue(/\$executeRaw`/.test(vaultSrc), 'le verrou passe par $executeRaw, pas par $executeRawUnsafe');
eq(/\$executeRawUnsafe/.test(vaultSrc), false,
  'aucun $executeRawUnsafe : l\'identifiant d\'organisation n\'est pas concaténé dans du SQL');

/* -------------------------------------------------------------------------- */
console.log('\nJ. i18n');
/* -------------------------------------------------------------------------- */

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
for (const lang of LANGS) {
  dicts[lang] = JSON.parse(await readFile(at(`locales/${lang}/admin.json`), 'utf8'));
  /* Seuil, pas compte absolu : l'intention est « rien d'Admin 04 n'a été perdu ».
     Un compte absolu casse à chaque chantier suivant sans rien détecter. */
  isTrue(Object.keys(dicts[lang]).length >= 420,
    `${lang} : au moins 420 clés (obtenu ${Object.keys(dicts[lang]).length})`);
}
const refKeys = Object.keys(dicts.en).sort().join('|');
for (const lang of LANGS) {
  eq(Object.keys(dicts[lang]).sort().join('|'), refKeys, `${lang} : même jeu de clés que en`);
}
const NEW04 = ['nav.settings', 'opportunity.problems', 'opportunity.features', 'opportunity.layers',
  'opportunity.insufficient', 'opportunity.insufficientBody', 'opportunity.signals',
  'settings.subtitle', 'settings.access', 'settings.audit', 'settings.chain', 'settings.chainOk',
  'settings.chainBroken', 'settings.auditNote', 'settings.spof', 'settings.noAudit'];
for (const key of NEW04) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][key] === 'string' && dicts[lang][key].trim().length > 0,
      `${lang} : « ${key} » traduit et non vide`);
  }
}
/* Les familles dynamiques doivent exister pour chaque code réellement produit. */
const ACTIONS = audit.AUDIT_ACTIONS;
const ENTITIES = audit.AUDIT_ENTITIES;
for (const a of ACTIONS) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][`auditAction.${a}`] === 'string' && dicts[lang][`auditAction.${a}`].trim() !== '',
      `${lang} : auditAction.${a} traduit`);
  }
}
for (const en of ENTITIES) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][`auditEntity.${en}`] === 'string' && dicts[lang][`auditEntity.${en}`].trim() !== '',
      `${lang} : auditEntity.${en} traduit`);
  }
}
for (const code of ['manySuppliers', 'supplierDataManual', 'largeCatalogue', 'catalogueUnstructured',
  'esprScope', 'declaredDppInterest', 'declaredTraceabilityInterest', 'maturityUnknown']) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][`opportunityProblem.${code}`] === 'string',
      `${lang} : opportunityProblem.${code} traduit`);
  }
}
for (const code of ['supplyChainMapping', 'dataQuality', 'productData', 'evidenceCenter',
  'dppReadiness', 'traceability', 'intelligence']) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][`opportunityFeature.${code}`] === 'string',
      `${lang} : opportunityFeature.${code} traduit`);
  }
}
for (const code of ['companies', 'contacts', 'tasks', 'meetings', 'pilots', 'lists', 'activities', 'auditEntries']) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][`settings.count.${code}`] === 'string',
      `${lang} : settings.count.${code} traduit`);
  }
}
isTrue(dicts.fr['settings.chain'] !== dicts.en['settings.chain'],
  '« chaîne de hachage » est réellement traduit, pas copié de l\'anglais');
isTrue(dicts.de['opportunity.insufficientBody'].length > 40,
  'l\'explication « données insuffisantes » n\'est pas tronquée en allemand');
/* %n est un espace réservé substitué à l'affichage : il doit survivre à la traduction. */
for (const lang of LANGS) {
  isTrue(dicts[lang]['opportunity.signals'].includes('%n'),
    `${lang} : opportunity.signals conserve l'espace réservé %n`);
}
for (const lang of LANGS) {
  isTrue(!/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(JSON.stringify(dicts[lang])),
    `${lang} : aucun caractère CJK`);
}

/* -------------------------------------------------------------------------- */
console.log('\nK. Interface');
/* -------------------------------------------------------------------------- */

const html = await readFile(at('admin/index.html'), 'utf8');
const frDict = dicts.fr;

const stub = `<script>window.TracefabI18n = {
  isReady: true, init: async () => true, setLanguage: async () => true,
  t: (k) => window.__DICT[k] || k,
};</script>`;
const booted = (dict, lang) => html
  .replace('<script src="/i18n-core.js"></script>', stub)
  .replace('</head>', `<script>window.__DICT = ${JSON.stringify(dict)};
    localStorage.setItem('tracefab.lang', ${JSON.stringify(lang)});</script></head>`);

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(String(e?.message || e)));
virtualConsole.on('error', (...a) => pageErrors.push(a.join(' ')));

const dom = new JSDOM(booted(frDict, 'fr'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://tracefab.example/admin/?demo', virtualConsole,
});
const { window } = dom;
const { document } = window;
const settle = () => new Promise((r) => setTimeout(r, 200));
await settle();
await settle();

const view = () => document.getElementById('app').textContent || '';
const click = (id) => {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) throw new Error(`élément introuvable : ${id}`);
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

/* §1 — Réglages dans la navigation */
await go('settings');
isTrue(view().includes(frDict['nav.settings']), '§1 : « Réglages » est une entrée de navigation réelle');
eq(/'Settings'/.test(html), false, 'le libellé « Settings » n\'est pas codé en dur dans le fichier');

/* §16 — la piste d'audit est affichée */
isTrue(view().includes(frDict['settings.audit']), '§16 : la section « Journal d\'audit » est affichée');
isTrue(view().includes(frDict['settings.chain']), '§16 : l\'état de la chaîne de hachage est affiché');
isTrue(view().includes(frDict['settings.chainOk']),
  '§16 : une chaîne intacte est annoncée comme intacte');
isTrue(view().includes('Founder'), '§16 : l\'auteur de chaque entrée est affiché');
isTrue(view().includes(frDict['auditAction.converted']),
  '§16 : les actions sont traduites via auditAction.*, pas affichées en code brut');
eq(view().includes('stage_changed'), false,
  '§16 : aucun code d\'action brut ne fuite dans l\'interface');
isTrue(view().includes(frDict['auditEntity.crm_company']),
  '§16 : les entités sont traduites via auditEntity.*');
isTrue(view().includes(frDict['settings.when']) && view().includes(frDict['settings.fields']),
  '§16 : la piste affiche la date et les champs modifiés');
isTrue(view().includes(frDict['settings.spof']),
  '§1 : un seul Admin actif déclenche l\'avertissement de point de défaillance unique');
isTrue(view().includes(frDict['settings.appendOnly']),
  '§12 : le caractère append-only des activités est annoncé');

/* Le filtre d'entité doit être présent et proposer les 7 entités. */
const sel = document.getElementById('f-audit');
isTrue(!!sel, '§16 : le filtre d\'entité existe');
eq(sel ? sel.options.length : 0, 8, '§16 : le filtre propose « toutes » + les 7 entités');

/* §4 — onglet opportunité, cas avec signaux */
await go('prospects');
const openEl = document.querySelector('[data-open="d1"]');
isTrue(!!openEl, 'l\'entreprise de démonstration d1 est joignable depuis la liste');
click(openEl);
await settle();
await settle();
const tab = document.querySelector('[data-tab="opportunity"]');
isTrue(!!tab, '§4 : l\'onglet « opportunité » existe');
click(tab);
await settle();
isTrue(view().includes(frDict['opportunity.problems']),
  '§4 : les problèmes probables sont affichés');
isTrue(view().includes(frDict['opportunity.features']),
  '§4 : les fonctions TRACEFAB pertinentes sont affichées');
isTrue(view().includes(frDict['opportunityProblem.manySuppliers']),
  '§4 : le problème « base fournisseurs » est nommé en français');
isTrue(view().includes('supplier_count = 42'),
  '§4 : la preuve est affichée telle quelle — le lecteur peut la vérifier');
isTrue(view().includes('country_code = FR (EU)'),
  '§4 : la preuve du critère ESPR est affichée');
isTrue(view().includes(frDict['opportunity.layers']),
  '§4 : les couches du socle concernées sont affichées');
isTrue(view().includes('L07'), '§4 : la couche DPP figure parmi les couches concernées');
isTrue(view().includes('3 signaux convergents'),
  '§4 : le compteur de signaux est substitué dans %n — et vaut 3, pas 4');
isTrue(view().includes(frDict['opportunity.declaredNote']),
  '§4 : il est dit que le potentiel est déclaré, pas mesuré');
isTrue(view().includes(frDict['company.whyTarget']),
  '§4 : la justification « pourquoi cette cible » est affichée');

/* §4 — cas sans données : l'écran doit le dire, pas broder */
await go('prospects');
click(document.querySelector('[data-open="d2"]'));
await settle();
await settle();
click(document.querySelector('[data-tab="opportunity"]'));
await settle();
isTrue(view().includes(frDict['opportunity.insufficient']) || view().includes(frDict['opportunity.problems']),
  '§4 : l\'onglet opportunité s\'affiche aussi pour une entreprise à données partielles');

/* La démo est identifiée comme telle. */
isTrue(view().toLowerCase().includes('demo') || view().includes('démo')
  || document.body.innerHTML.toLowerCase().includes('demo'),
  'les valeurs affichées restent identifiables comme données de démonstration');

/* -------------------------------------------------------------------------- */

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
