/* ==========================================================================
   TRACEFAB — cles i18n de la veille des certificats (brand-console/).

   Chantier 4 : la vue certifications atterrissait sur un etat vide en
   demonstration, et son panneau "veille des expirations" affirmait en dur
   qu'aucun certificat n'expirait — affirmation qui devient fausse des qu'on
   alimente la vue. Le panneau derive desormais des donnees ; les quelques
   libelles qu'il lui faut sont ajoutes ici plutot qu'ecrits en dur, le
   cahier des charges excluant toute copie metier figee dans les composants.

   Meme mecanique que scripts/build_risk_i18n.mjs : region delimitee par des
   marqueurs dans la portee 'console' de en.js, retiree par recherche
   litterale avant reecriture. Les deux scripts cohabitent, chacun ne
   touchant que sa propre region.

   Usage : node scripts/build_certifications_i18n.mjs [--check]
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const I18N = join(ROOT, 'assets/i18n');
const CHECK = process.argv.includes('--check');
const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];

const DEBUT = '    // --- Veille des certificats ---';
const FIN = '    // --- fin veille des certificats ---';

// cle: [en, fr, de, it, es, nl, pt]
const T = {
  certValid: ['Valid', 'Valide', 'Gültig', 'Valido', 'Válido', 'Geldig', 'Válido'],
  certExpiringSoon: ['Expiring soon', 'Expire bientôt', 'Läuft bald ab', 'In scadenza', 'Caduca pronto', 'Verloopt binnenkort', 'A expirar'],
  certExpired: ['Expired', 'Expiré', 'Abgelaufen', 'Scaduto', 'Caducado', 'Verlopen', 'Expirado'],
  certWatchCount: [
    'certificate(s) expire within 90 days.',
    'certificat(s) expirent sous 90 jours.',
    'Zertifikat(e) laufen binnen 90 Tagen ab.',
    'certificato/i in scadenza entro 90 giorni.',
    'certificado(s) caducan en 90 días.',
    'certifica(a)t(en) verloopt binnen 90 dagen.',
    'certificado(s) expiram em 90 dias.',
  ],
  certWatchNone: [
    'No certificate expires within the next 90 days.',
    "Aucun certificat n'expire dans les 90 prochains jours.",
    'Kein Zertifikat läuft in den nächsten 90 Tagen ab.',
    'Nessun certificato scade nei prossimi 90 giorni.',
    'Ningún certificado caduca en los próximos 90 días.',
    'Geen enkel certificaat verloopt binnen de komende 90 dagen.',
    'Nenhum certificado expira nos próximos 90 dias.',
  ],
  certNextRenewal: ['Next renewal', 'Prochain renouvellement', 'Nächste Erneuerung', 'Prossimo rinnovo', 'Próxima renovación', 'Volgende verlenging', 'Próxima renovação'],
  certEyebrow: ['Standard compliance', 'Conformité aux standards', 'Standardkonformität', 'Conformità agli standard', 'Conformidad con los estándares', 'Standaardconformiteit', 'Conformidade com as normas'],
  certTitle: ['Certifications & audit standards', "Certifications et standards d'audit", 'Zertifizierungen & Auditstandards', 'Certificazioni e standard di audit', 'Certificaciones y estándares de auditoría', 'Certificeringen en auditstandaarden', 'Certificações e normas de auditoria'],
  certLead: [
    'Operating certificates declared across your supplier base, with continuous expiry monitoring.',
    "Certificats d'exploitation déclarés sur votre base fournisseurs, avec veille continue des échéances.",
    'Betriebszertifikate Ihrer Lieferantenbasis, mit laufender Fristenüberwachung.',
    'Certificati operativi dichiarati dalla tua base fornitori, con monitoraggio continuo delle scadenze.',
    'Certificados operativos declarados en su base de proveedores, con seguimiento continuo de vencimientos.',
    'Operationele certificaten uit uw leveranciersbestand, met doorlopende bewaking van vervaldata.',
    'Certificados operacionais declarados na sua base de fornecedores, com vigilância contínua dos prazos.',
  ],
  certDeclare: ['Declare a certificate', 'Déclarer un certificat', 'Zertifikat melden', 'Dichiara un certificato', 'Declarar un certificado', 'Certificaat aanmelden', 'Declarar um certificado'],
  certActiveTitle: ['Certificates on file', 'Certificats en vigueur', 'Hinterlegte Zertifikate', 'Certificati in essere', 'Certificados vigentes', 'Geregistreerde certificaten', 'Certificados em vigor'],
  certColStandard: ['Standard', 'Norme / standard', 'Standard', 'Norma / standard', 'Norma / estándar', 'Norm / standaard', 'Norma / padrão'],
  certColNumber: ['Certificate number', 'Numéro de certificat', 'Zertifikatsnummer', 'Numero di certificato', 'Número de certificado', 'Certificaatnummer', 'Número do certificado'],
  certColIssuer: ['Issuing body', 'Organisme', 'Ausstellende Stelle', 'Ente emittente', 'Organismo emisor', 'Certificerende instantie', 'Organismo emissor'],
  certColExpiry: ['Expiry', 'Expiration', 'Ablauf', 'Scadenza', 'Vencimiento', 'Vervaldatum', 'Validade'],
  certColStatus: ['Status', 'Statut', 'Status', 'Stato', 'Estado', 'Status', 'Estado'],
  certWatchTitle: ['Expiry watch', 'Veille des expirations', 'Fristenüberwachung', 'Monitoraggio scadenze', 'Vigilancia de vencimientos', 'Bewaking vervaldata', 'Vigilância de prazos'],
  certRuleTitle: ['Continuous compliance rule', 'Règle de conformité continue', 'Regel zur laufenden Konformität', 'Regola di conformità continua', 'Regla de conformidad continua', 'Regel voor doorlopende naleving', 'Regra de conformidade contínua'],
  certRuleBody: [
    'TRACEFAB alerts suppliers automatically 90 days before an operating certificate expires.',
    "TRACEFAB alerte automatiquement les fournisseurs 90 jours avant l'expiration d'un certificat d'exploitation.",
    'TRACEFAB benachrichtigt Lieferanten automatisch 90 Tage vor Ablauf eines Betriebszertifikats.',
    'TRACEFAB avvisa automaticamente i fornitori 90 giorni prima della scadenza di un certificato operativo.',
    'TRACEFAB avisa automáticamente a los proveedores 90 días antes de que caduque un certificado operativo.',
    'TRACEFAB waarschuwt leveranciers automatisch 90 dagen voordat een operationeel certificaat verloopt.',
    'A TRACEFAB alerta automaticamente os fornecedores 90 dias antes de expirar um certificado operacional.',
  ],
  certNone: ['No certificate declared yet.', "Aucun certificat déclaré pour l'instant.", 'Noch kein Zertifikat gemeldet.', 'Nessun certificato dichiarato finora.', 'Todavía no hay certificados declarados.', 'Nog geen certificaat aangemeld.', 'Nenhum certificado declarado ainda.'],
  certDaysLeft: ['days left', 'jours restants', 'Tage verbleibend', 'giorni rimanenti', 'días restantes', 'dagen resterend', 'dias restantes'],
};

const keys = Object.keys(T);
const gaps = [];
for (const k of keys) {
  if (T[k].length !== LANGS.length) gaps.push(`${k}: ${T[k].length}/${LANGS.length}`);
  T[k].forEach((v, i) => { if (!v || !String(v).trim()) gaps.push(`${k}.${LANGS[i]} vide`); });
}
console.log(`  portee 'console' (prefixe cert) : ${keys.length} cles x ${LANGS.length} langues`);
if (gaps.length) { gaps.forEach((g) => console.log(`      ${g}`)); process.exit(1); }
console.log('  table complete, aucun trou.');

if (CHECK) { console.log('\n  --check : aucun fichier ecrit.'); process.exit(0); }

const scopeFor = (i) => Object.fromEntries(keys.map((k) => [k, T[k][i]]));

/* --- en.js -------------------------------------------------------------- */
const enPath = join(I18N, 'en.js');
let enSrc = readFileSync(enPath, 'utf8');

const iDebut = enSrc.indexOf(DEBUT);
if (iDebut !== -1) {
  const iFin = enSrc.indexOf(FIN, iDebut);
  if (iFin === -1) throw new Error('marqueur de fin absent : en.js est dans un etat incoherent');
  enSrc = enSrc.slice(0, iDebut) + enSrc.slice(iFin + FIN.length + 1);
}

// Insertion en TETE du bloc console, pas avant son accolade fermante.
// Raison : en fin de bloc il faut garantir une virgule apres l'entree
// precedente, et si celle-ci est une ligne de commentaire (la region posee
// par l'autre generateur), la virgule se retrouve avalee par le commentaire
// et en.js casse. En tete, chaque ligne inseree porte sa propre virgule et
// l'insertion est valide quel que soit le contenu existant.
const ouverture = enSrc.indexOf('\n  console: {');
if (ouverture === -1) throw new Error("bloc 'console' introuvable dans en.js");
const apresAccolade = enSrc.indexOf('{', ouverture) + 1;

const corps = keys.map((k) => `    ${k}: ${JSON.stringify(T[k][0])},`).join('\n');
enSrc = `${enSrc.slice(0, apresAccolade)}\n${DEBUT}\n${corps}\n${FIN}${enSrc.slice(apresAccolade)}`;
writeFileSync(enPath, enSrc);
console.log('\n  ecrit  assets/i18n/en.js');

/* --- locales JSON ------------------------------------------------------- */
LANGS.forEach((lang, i) => {
  if (lang === 'en') return;
  const p = join(I18N, `${lang}.json`);
  const d = JSON.parse(readFileSync(p, 'utf8'));
  d.console = { ...(d.console || {}), ...scopeFor(i) };
  writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`  ecrit  assets/i18n/${lang}.json`);
});
