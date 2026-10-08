/* ==========================================================================
   TRACEFAB — cles i18n du premier ecran du portail fournisseur.

   Chantier 5 : en 390x844, les 14 elements cliquables au-dessus de la ligne
   de flottaison etaient TOUS de la navigation. Le fournisseur doit « savoir
   immediatement quoi faire » ; il ne voyait que des onglets, deux listes
   deroulantes de reglage et une accroche.

   Le panneau de progression remonte au-dessus de la ligne. Il affirmait en
   dur « Fiche Entreprise (100%) », « Sites GPS (100%) », « Certificats
   (100%) » tout en annonçant 72 % — trois 100 % et un 72 %, et une phrase
   parlant de « 3 etapes » quand une seule etait montree. Il lit desormais
   state.quality.score, qui porte deja les dimensions calculees.

   Perimetre volontairement limite a ce qui est visible au premier ecran sur
   mobile. Le reste de overview() (cartes d'action, statistiques, demandes,
   import BOM) reste en dur : c'est le point 7 du backlog. Traduire a moitie
   un ecran est pire que pas du tout, mais la ligne de flottaison est une
   frontiere nette et defendable.

   Usage : node scripts/build_portal_overview_i18n.mjs [--check]
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const I18N = join(ROOT, 'assets/i18n');
const CHECK = process.argv.includes('--check');
/* Chantier 15 : langues produit complètes uniquement. */
const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];

const DEBUT = '    // --- Premier ecran du portail (chantier 5) ---';
const FIN = '    // --- fin premier ecran du portail ---';

// cle: [en, fr, de, it, es, nl, pt]
const T = {
  spDemoBanner: [
    'Demonstration mode — the figures below are demonstration data. Open ?demo=0 to connect Clerk and the Tracefab APIs.',
    'Mode démonstration — les chiffres ci-dessous sont des données de démonstration. Ouvrez ?demo=0 pour connecter Clerk et les APIs Tracefab.',
    'Demomodus — die folgenden Zahlen sind Demonstrationsdaten. Öffnen Sie ?demo=0, um Clerk und die Tracefab-APIs zu verbinden.',
    'Modalità dimostrativa — i dati seguenti sono dimostrativi. Apri ?demo=0 per collegare Clerk e le API Tracefab.',
    'Modo demostración — las cifras siguientes son datos de demostración. Abra ?demo=0 para conectar Clerk y las API de Tracefab.',
    'Demonstratiemodus — onderstaande cijfers zijn demonstratiegegevens. Open ?demo=0 om Clerk en de Tracefab-APIs te verbinden.',
    'Modo demonstração — os números abaixo são dados de demonstração. Abra ?demo=0 para ligar o Clerk e as APIs Tracefab.'
  ],
  spHeroTag: [
    'Shared supplier vault · EU trade secrets directive',
    "Coffre-fort fournisseur mutualisé · directive UE secret d'affaires",
    'Gemeinsamer Lieferantentresor · EU-Geschäftsgeheimnis-Richtlinie',
    'Caveau fornitori condiviso · direttiva UE segreti commerciali',
    'Bóveda de proveedores compartida · directiva UE secretos comerciales',
    'Gedeelde leverancierskluis · EU-richtlijn bedrijfsgeheimen',
    'Cofre de fornecedores partilhado · diretiva UE segredos comerciais'
  ],
  spHeroTitle: [
    'Your data. Your profile. Reusable across all your customers.',
    'Vos données. Votre profil. Réutilisables auprès de tous vos clients.',
    'Ihre Daten. Ihr Profil. Für alle Ihre Kunden wiederverwendbar.',
    'I tuoi dati. Il tuo profilo. Riutilizzabili per tutti i tuoi clienti.',
    'Sus datos. Su perfil. Reutilizables para todos sus clientes.',
    'Uw data. Uw profiel. Herbruikbaar voor al uw klanten.',
    'Os seus dados. O seu perfil. Reutilizáveis para todos os seus clientes.'
  ],
  spHeroSub: [
    'Upload your certificates and production sites once into your encrypted vault. Share proof of compliance instantly, without disclosing your prices, exclusive subcontractors or margins.',
    'Téléversez vos certificats et sites de production une seule fois dans votre coffre-fort chiffré. Partagez instantanément la preuve de conformité sans divulguer vos prix, sous-traitants exclusifs ou marges.',
    'Laden Sie Zertifikate und Produktionsstätten einmalig in Ihren verschlüsselten Tresor. Teilen Sie Konformitätsnachweise sofort, ohne Preise, exklusive Subunternehmer oder Margen offenzulegen.',
    'Carica una sola volta certificati e siti produttivi nel tuo caveau cifrato. Condividi subito la prova di conformità senza rivelare prezzi, subappaltatori esclusivi o margini.',
    'Suba sus certificados y centros de producción una sola vez a su bóveda cifrada. Comparta la prueba de conformidad al instante, sin revelar precios, subcontratistas exclusivos ni márgenes.',
    'Upload uw certificaten en productielocaties één keer naar uw versleutelde kluis. Deel direct het nalevingsbewijs zonder prijzen, exclusieve onderaannemers of marges prijs te geven.',
    'Carregue os seus certificados e unidades de produção uma só vez no seu cofre cifrado. Partilhe a prova de conformidade de imediato, sem revelar preços, subcontratados exclusivos ou margens.'
  ],
  spProfileTitle: [
    'Your compliance profile',
    'Votre profil de conformité',
    'Ihr Konformitätsprofil',
    'Il tuo profilo di conformità',
    'Su perfil de conformidad',
    'Uw nalevingsprofiel',
    'O seu perfil de conformidade'
  ],
  spComplete: ['complete', 'complété', 'vollständig', 'completo', 'completado', 'volledig', 'completo'
  ],
  spWeakest: [
    'Weakest area',
    'Point le plus faible',
    'Schwächster Bereich',
    'Punto più debole',
    'Punto más débil',
    'Zwakste onderdeel',
    'Ponto mais fraco'
  ],
  spFixNow: ['Fix this now', 'Corriger maintenant', 'Jetzt beheben', 'Correggi ora', 'Corregir ahora', 'Nu verhelpen', 'Corrigir agora'
  ],
  spAllOnTarget: [
    'Every area is on target. Nothing needs your attention.',
    "Toutes les dimensions sont au niveau attendu. Rien n'attend votre intervention.",
    'Alle Bereiche liegen im Zielbereich. Nichts erfordert Ihre Aufmerksamkeit.',
    'Tutte le dimensioni sono al livello atteso. Nulla richiede il tuo intervento.',
    'Todas las dimensiones están en el nivel esperado. Nada requiere su atención.',
    'Alle onderdelen liggen op niveau. Er is niets dat uw aandacht vraagt.',
    'Todas as dimensões estão no nível esperado. Nada exige a sua intervenção.'
  ],
  spDimCompleteness: ['Profile completeness', 'Complétude du profil', 'Profilvollständigkeit', 'Completezza del profilo', 'Integridad del perfil', 'Volledigheid profiel', 'Completude do perfil'
  ],
  spDimFreshness: ['Data freshness', 'Fraîcheur des données', 'Datenaktualität', 'Freschezza dei dati', 'Actualidad de los datos', 'Actualiteit van data', 'Atualidade dos dados'
  ],
  spDimDocumentation: ['Evidence coverage', 'Couverture documentaire', 'Nachweisabdeckung', 'Copertura documentale', 'Cobertura documental', 'Bewijsdekking', 'Cobertura documental'
  ],
  spDimConsistency: ['Data consistency', 'Cohérence des données', 'Datenkonsistenz', 'Coerenza dei dati', 'Coherencia de los datos', 'Dataconsistentie', 'Coerência dos dados'
  ],
  spMissingField: ['Missing', 'Manquant', 'Fehlt', 'Mancante', 'Falta', 'Ontbreekt', 'Em falta'
  ],
  spFieldRslReport: ['an RSL test report', "un rapport d'essais RSL", 'ein RSL-Prüfbericht', 'un rapporto di prova RSL', 'un informe de ensayo RSL', 'een RSL-testrapport', 'um relatório de ensaio RSL'
  ],
  spFieldActiveSite: ['an active production site', 'un site de production actif', 'eine aktive Produktionsstätte', 'un sito produttivo attivo', 'un centro de producción activo', 'een actieve productielocatie', 'uma unidade de produção ativa'
  ],
  spNoScore: [
    'Your compliance score will appear once your first data has been submitted.',
    'Votre score de conformité apparaîtra dès la première donnée transmise.',
    'Ihr Konformitätswert erscheint, sobald die ersten Daten übermittelt wurden.',
    'Il tuo punteggio di conformità apparirà dopo il primo invio di dati.',
    'Su puntuación de conformidad aparecerá tras el primer envío de datos.',
    'Uw nalevingsscore verschijnt zodra de eerste gegevens zijn ingediend.',
    'A sua pontuação de conformidade surgirá após o primeiro envio de dados.'
  ],
};

const keys = Object.keys(T);
const gaps = [];
for (const k of keys) {
  if (T[k].length !== LANGS.length) gaps.push(`${k}: ${T[k].length}/${LANGS.length}`);
  T[k].forEach((v, i) => { if (!v || !String(v).trim()) gaps.push(`${k}.${LANGS[i]} vide`); });
}
console.log(`  portee 'portal' (prefixe sp) : ${keys.length} cles x ${LANGS.length} langues`);
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

// Insertion en TETE du bloc portal, jamais avant son accolade fermante :
// en fin de bloc il faudrait garantir une virgule apres l'entree precedente,
// et si celle-ci est une ligne de commentaire posee par un autre generateur,
// la virgule s'y trouve avalee et en.js casse. Voir le chantier 4.
const ouverture = enSrc.indexOf('\n  portal: {');
if (ouverture === -1) throw new Error("bloc 'portal' introuvable dans en.js");
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
  d.portal = { ...(d.portal || {}), ...scopeFor(i) };
  writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`  ecrit  assets/i18n/${lang}.json`);
});
