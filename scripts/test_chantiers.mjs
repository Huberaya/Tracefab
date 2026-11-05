#!/usr/bin/env node
/**
 * Le registre des chantiers doit rester vrai.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `CHANTIERS-RESTANTS.md` s'ouvre sur « établi en interrogeant le dépôt [...]
 * Pas en relisant les en-têtes ». C'etait vrai le jour de sa redaction. Sept
 * commits plus tard, son en-tete annoncait `main = 5b78ac6`, « CI run #26 »
 * et « Neon 33/33 migrations » — trois faits sur quatre etaient faux, dont
 * un compte de migrations qui sous-estimait la production.
 *
 * Un document de pilotage qui se perime en silence est pire qu'absent : on
 * decide dessus. Ce test verifie les affirmations qui ne devraient bouger
 * qu'avec une decision, et laisse de cote celles qui bougent a chaque commit
 * (un SHA n'a rien a faire dans un en-tete : il a ete retire).
 *
 *   npm run test:chantiers
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const REGISTRE = 'docs/experience/CHANTIERS-RESTANTS.md';
const texte = readFileSync(REGISTRE, 'utf8');
let verifies = 0;

function controle(libelle, condition, detail) {
  assert.ok(condition, `${libelle}${detail ? ' — ' + detail : ''}`);
  verifies += 1;
  console.log(`✓ ${libelle}`);
}

/* --- 1. Le compte du depot et l'etat Neon sont distingues. ------------- */
{
  const annonce = texte.match(/Dépôt\s*:\s*(\d+)\s*migrations/);
  assert.ok(annonce, `${REGISTRE} doit annoncer le nombre de migrations du dépôt`);
  const reel = readdirSync('prisma/migrations').filter((d) => /^\d/.test(d)).length;
  controle(
    `compte de migrations du dépôt (${annonce[1]}) = dépôt (${reel})`,
    Number(annonce[1]) === reel,
    `le document annonce ${annonce[1]} migration(s)`,
  );
  const migrationRls = '20261105130000_active_tenant_product_dpp_pef_rls';
  const migrationRlsPresente = readdirSync('prisma/migrations').includes(migrationRls);
  controle(
    'la migration RLS produits/DPP/PEF est référencée dans le registre',
    migrationRlsPresente && texte.includes(migrationRls),
    migrationRlsPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationClaims = '20261105140000_active_tenant_green_claims_rls';
  const migrationClaimsPresente = readdirSync('prisma/migrations').includes(migrationClaims);
  controle(
    'la migration RLS des allégations vertes est référencée dans le registre',
    migrationClaimsPresente && texte.includes(migrationClaims),
    migrationClaimsPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const entete = texte.slice(0, 1000);
  const migrationDpp = '20261105150000_active_tenant_dpp_claims_identity_rls';
  const migrationDppPresente = readdirSync('prisma/migrations').includes(migrationDpp);
  controle(
    'la migration RLS des claims et identités DPP est référencée dans le registre',
    migrationDppPresente && texte.includes(migrationDpp),
    migrationDppPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationDefiners = '20261105170000_active_tenant_security_definer_guards';
  const migrationDefinersPresente = readdirSync('prisma/migrations').includes(migrationDefiners);
  controle(
    'la migration des 19 fonctions SECURITY DEFINER est référencée dans le registre',
    migrationDefinersPresente && texte.includes(migrationDefiners),
    migrationDefinersPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationTcRegistration = '20261105180000_active_tenant_tc_registration_guard';
  const migrationTcRegistrationPresente = readdirSync('prisma/migrations').includes(migrationTcRegistration);
  controle(
    'la migration de garde du tenant actif sur l’enregistrement TC est référencée dans le registre',
    migrationTcRegistrationPresente && texte.includes(migrationTcRegistration),
    migrationTcRegistrationPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationInviteDocumentPassport = '20261105230000_active_tenant_invite_document_passport_guards';
  const migrationInviteDocumentPassportPresente = readdirSync('prisma/migrations').includes(migrationInviteDocumentPassport);
  controle(
    'la migration des gardes invitations/documents/passeports est référencée dans le registre',
    migrationInviteDocumentPassportPresente && texte.includes(migrationInviteDocumentPassport),
    migrationInviteDocumentPassportPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationSupplierQuality = '20261105240000_active_tenant_supplier_quality_guard';
  const migrationSupplierQualityPresente = readdirSync('prisma/migrations').includes(migrationSupplierQuality);
  controle(
    'la migration du calcul de qualité fournisseur est référencée dans le registre',
    migrationSupplierQualityPresente && texte.includes(migrationSupplierQuality),
    migrationSupplierQualityPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationPolicyWorkerClosure = '20261105235900_active_tenant_policy_and_worker_closure';
  const migrationPolicyWorkerClosurePresente = readdirSync('prisma/migrations').includes(migrationPolicyWorkerClosure);
  controle(
    'la migration de fermeture des politiques RLS et des fonctions worker est référencée dans le registre',
    migrationPolicyWorkerClosurePresente && texte.includes(migrationPolicyWorkerClosure),
    migrationPolicyWorkerClosurePresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationSupplierPassportGuards = '20261106000000_active_tenant_supplier_passport_guards';
  const migrationSupplierPassportGuardsPresente = readdirSync('prisma/migrations').includes(migrationSupplierPassportGuards);
  controle(
    'la migration de fermeture des deux fonctions passeport fournisseur est référencée dans le registre',
    migrationSupplierPassportGuardsPresente && texte.includes(migrationSupplierPassportGuards),
    migrationSupplierPassportGuardsPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationQualityCap = '20261105220000_active_tenant_quality_cap_guards';
  const migrationQualityCapPresente = readdirSync('prisma/migrations').includes(migrationQualityCap);
  controle(
    'la migration des gardes CAP qualité est référencée dans le registre',
    migrationQualityCapPresente && texte.includes(migrationQualityCap),
    migrationQualityCapPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationSupplierProfilePassport = '20261105210000_active_tenant_supplier_profile_passport_guards';
  const migrationSupplierProfilePassportPresente = readdirSync('prisma/migrations').includes(migrationSupplierProfilePassport);
  controle(
    'la migration des gardes profil/passeport fournisseur est référencée dans le registre',
    migrationSupplierProfilePassportPresente && texte.includes(migrationSupplierProfilePassport),
    migrationSupplierProfilePassportPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationMaterialCertification = '20261105200000_active_tenant_material_certification_guards';
  const migrationMaterialCertificationPresente = readdirSync('prisma/migrations').includes(migrationMaterialCertification);
  controle(
    'la migration des gardes matières/certifications est référencée dans le registre',
    migrationMaterialCertificationPresente && texte.includes(migrationMaterialCertification),
    migrationMaterialCertificationPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationQualityCollection = '20261105190000_active_tenant_quality_collection_guards';
  const migrationQualityCollectionPresente = readdirSync('prisma/migrations').includes(migrationQualityCollection);
  controle(
    'la migration des gardes qualité/collecte est référencée dans le registre',
    migrationQualityCollectionPresente && texte.includes(migrationQualityCollection),
    migrationQualityCollectionPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const migrationMaterials = '20261105160000_active_tenant_product_materials_rls';
  const migrationMaterialsPresente = readdirSync('prisma/migrations').includes(migrationMaterials);
  controle(
    'la migration RLS des compositions produit-matière est référencée dans le registre',
    migrationMaterialsPresente && texte.includes(migrationMaterials),
    migrationMaterialsPresente ? 'migration présente mais absente du registre' : 'migration absente du dépôt',
  );
  const nonVerifie = /Neon de production\s*:\s*non vérifié/i.test(entete);
  let preuveNeon = '';
  try {
    preuveNeon = readFileSync(
      'docs/security/2026-10-21-production-migration-reconciliation.md',
      'utf8',
    );
  } catch {
    // Sans rapport de preuve, l'état doit rester explicitement non vérifié.
  }
  const verifieAvecPreuve =
    /Neon de production\s*:\s*historique des migrations vérifié en lecture seule/i.test(entete)
    && /db06dca398fe9b39ceecb23b90a0de1cd08910cb/.test(preuveNeon)
    && /Dossiers de migration dans le dépôt de référence\s*\|\s*53/.test(preuveNeon)
    && /Noms distincts avec application réussie\s*\|\s*53/.test(preuveNeon)
    && /Migrations inachevées.*\|\s*0/.test(preuveNeon)
    && /Migrations du dépôt sans application réussie\s*\|\s*0/.test(preuveNeon)
    && /Noms du registre Neon absents du dépôt\s*\|\s*0/.test(preuveNeon);
  controle(
    "l'état des migrations Neon est soit non vérifié, soit vérifié avec une preuve datée",
    nonVerifie || verifieAvecPreuve,
    "ne pas assimiler le contenu de la branche à l'état de production",
  );
}
/* --- 2. Aucun SHA presente comme fait courant dans l'en-tete. ----------
 * Le document a le droit de RACONTER qu'il portait `5b78ac6` et que c'etait
 * une erreur. Il n'a pas le droit d'annoncer « main = <sha> » comme un etat,
 * parce que cet etat est faux au commit suivant.                          */
{
  const entete = texte.slice(0, texte.indexOf('## '));
  const fige = entete.match(/`?main`?\s*[:=]\s*`[0-9a-f]{7,40}`/i);
  controle(
    "l'en-tete ne presente aucun SHA comme etat courant",
    !fige,
    fige ? `trouve « ${fige[0]} » — faux des le commit suivant` : '',
  );
}

/* --- 3. Une seule police d'affichage : decision close de l'utilisateur. -
 * La verification porte sur les fichiers VIVANTS. La documentation a le
 * droit de citer l'ancienne police pour raconter la decision ; une config
 * de build n'a pas ce droit, elle l'appliquerait.                         */
{
  const suivis = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
  // Ce fichier-ci doit citer la police interdite pour pouvoir la chercher. Il
  // s'excluait de fait tant qu'il n'etait pas suivi par git : le controle n'est
  // devenu faux qu'une fois le garde commite, c'est-a-dire apres la derniere
  // execution verte. L'exclusion est donc explicite, pas implicite.
  const vivants = suivis.filter((f) => !f.startsWith('docs/') && !f.endsWith('.md')
    && !f.endsWith('package-lock.json') && f !== 'scripts/test_chantiers.mjs');
  const fautifs = vivants.filter((f) => {
    try { return /Plus Jakarta/i.test(readFileSync(f, 'utf8')); } catch { return false; }
  });
  controle(
    `une seule police d'affichage dans ${vivants.length} fichiers vivants`,
    fautifs.length === 0,
    fautifs.length ? `« Plus Jakarta » subsiste dans ${fautifs.join(', ')}` : '',
  );
}

/* --- 4. Une section qui se declare soldee doit nommer son garde-fou. ----
 * Sans cela, « RÉGLÉ » n'est qu'une affirmation. Avec, c'est une promesse
 * qu'une commande peut contredire.                                        */
{
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  const sections = [...texte.matchAll(/^## (\d+) · (.+)$/gm)];
  assert.ok(sections.length >= 8, 'le registre doit contenir au moins 8 sections numerotees');
  const soldees = sections.filter((m) => /RÉGLÉ|TRAITÉ|TRANCHÉ|VÉRIFIÉ/.test(m[2]));
  assert.ok(soldees.length >= 4, 'au moins quatre sections devraient etre soldees');

  const sansGarde = [];
  for (const m of soldees) {
    const debut = m.index;
    const suivante = texte.indexOf('\n## ', debut + 1);
    const corps = texte.slice(debut, suivante === -1 ? undefined : suivante);
    // Le corps doit citer au moins une commande npm qui existe vraiment.
    const cites = [...corps.matchAll(/`(?:npm run )?(test:[a-z0-9:-]+)`/g)].map((x) => x[1]);
    const reels = cites.filter((c) => Object.prototype.hasOwnProperty.call(scripts, c));
    if (reels.length === 0) sansGarde.push(`${m[1]} (${cites.length ? 'cite ' + cites.join(',') + ' — inexistant' : 'ne cite aucun garde'})`);
  }
  controle(
    `les ${soldees.length} sections soldees nomment un garde-fou existant`,
    sansGarde.length === 0,
    sansGarde.length ? `section(s) ${sansGarde.join(' · ')}` : '',
  );
}

/* --- 5. Le perimetre annonce doit correspondre aux dossiers presents. --- */
{
  const dossiers = readdirSync('docs/experience')
    .filter((f) => /^chantier-\d+/.test(f))
    .map((f) => Number(f.match(/^chantier-(\d+)/)[1]));
  const cites = [...texte.matchAll(/`chantier-(\d+)-[a-z-]+\.md`/g)].map((m) => Number(m[1]));
  const manquants = cites.filter((n) => !dossiers.includes(n));
  controle(
    `les ${cites.length} dossiers de chantier cites existent`,
    manquants.length === 0,
    manquants.length ? `absent(s) : ${manquants.join(', ')}` : '',
  );
}

console.log(`\n${verifies} affirmation(s) du registre verifiee(s) contre le depot.`);
