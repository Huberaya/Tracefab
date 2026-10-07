/* ==========================================================================
   TRACEFAB — cles i18n de la vue Risk (brand-console/).

   La vue Risk est exigee par le cahier des charges (nav : ... Quality, Risk,
   DPP ...) et etait absente de la console. Ses libelles sont ajoutes a la
   portee 'console' existante, consommee par bt() : bt('riskTitle') resout
   console.riskTitle.

   Les cles sont prefixees risk* plutot que regroupees dans une portee
   dediee, pour deux raisons : bt() ne resout que 'console.' et 'shared.',
   et la vue appartient bien au domaine console.

   Le bloc insere dans en.js est delimite par des marqueurs, ce qui rend le
   script idempotent : il retire la region precedente avant de la reecrire.

   Usage : node scripts/build_risk_i18n.mjs [--check]
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const I18N = join(ROOT, 'assets/i18n');
const CHECK = process.argv.includes('--check');
const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];

const DEBUT = '    // --- Risk & exposure (vue Risk) ---';
const FIN = '    // --- fin Risk & exposure ---';

// cle: [en, fr, de, it, es, nl, pt]
const T = {
  // navigation
  risk: ['Risk', 'Risque', 'Risiko', 'Rischio', 'Riesgo', 'Risico', 'Risco'],
  riskViewLabel: ['Risk & Exposure', 'Risque & Exposition', 'Risiko & Exposition', 'Rischio & Esposizione', 'Riesgo y Exposición', 'Risico & Blootstelling', 'Risco & Exposição'],

  // en-tete
  riskEyebrow: ['RISK & EXPOSURE', 'RISQUE & EXPOSITION', 'RISIKO & EXPOSITION', 'RISCHIO & ESPOSIZIONE', 'RIESGO Y EXPOSICIÓN', 'RISICO & BLOOTSTELLING', 'RISCO & EXPOSIÇÃO'],
  riskTitle: ['Where are you exposed?', 'Où êtes-vous exposé ?', 'Wo sind Sie exponiert?', 'Dove siete esposti?', '¿Dónde está expuesto?', 'Waar loopt u risico?', 'Onde está exposto?'],
  riskLead: [
    'Exposure is derived from the supplier, country, product and data-collection signals already held in TRACEFAB. It is an operational indicator meant to prioritise work — not a certification, an audit result or a legal assessment.',
    "L'exposition est dérivée des signaux fournisseurs, pays, produits et collecte déjà présents dans TRACEFAB. C'est un indicateur opérationnel destiné à prioriser le travail — ni une certification, ni un résultat d'audit, ni une évaluation juridique.",
    'Die Exposition wird aus den bereits in TRACEFAB vorhandenen Lieferanten-, Länder-, Produkt- und Erhebungssignalen abgeleitet. Sie ist ein operativer Indikator zur Priorisierung — keine Zertifizierung, kein Auditergebnis und keine rechtliche Bewertung.',
    "L'esposizione è derivata dai segnali su fornitori, paesi, prodotti e raccolta dati già presenti in TRACEFAB. È un indicatore operativo per dare priorità al lavoro — non una certificazione, un esito di audit o una valutazione giuridica.",
    'La exposición se deriva de las señales de proveedores, países, productos y recogida de datos ya presentes en TRACEFAB. Es un indicador operativo para priorizar el trabajo, no una certificación, un resultado de auditoría ni una evaluación jurídica.',
    'De blootstelling wordt afgeleid uit de leveranciers-, land-, product- en verzamelsignalen die al in TRACEFAB aanwezig zijn. Het is een operationele indicator om werk te prioriteren — geen certificering, auditresultaat of juridische beoordeling.',
    'A exposição é derivada dos sinais de fornecedores, países, produtos e recolha de dados já presentes no TRACEFAB. É um indicador operacional para priorizar o trabalho — não uma certificação, um resultado de auditoria nem uma avaliação jurídica.',
  ],
  riskNotCertification: ['Indicator, not a certification', 'Indicateur, pas une certification', 'Indikator, keine Zertifizierung', 'Indicatore, non una certificazione', 'Indicador, no una certificación', 'Indicator, geen certificering', 'Indicador, não uma certificação'],
  riskRecompute: ['Recompute', 'Recalculer', 'Neu berechnen', 'Ricalcola', 'Recalcular', 'Herberekenen', 'Recalcular'],

  // indicateurs
  riskIndex: ['Exposure index', "Indice d'exposition", 'Expositionsindex', 'Indice di esposizione', 'Índice de exposición', 'Blootstellingsindex', 'Índice de exposição'],
  riskSuppliersAtRisk: ['Suppliers flagged', 'Fournisseurs signalés', 'Markierte Lieferanten', 'Fornitori segnalati', 'Proveedores señalados', 'Gemarkeerde leveranciers', 'Fornecedores sinalizados'],
  riskProductsExposed: ['Products exposed', 'Produits exposés', 'Exponierte Produkte', 'Prodotti esposti', 'Productos expuestos', 'Blootgestelde producten', 'Produtos expostos'],
  riskCriticalSignals: ['Critical signals', 'Signaux critiques', 'Kritische Signale', 'Segnali critici', 'Señales críticas', 'Kritieke signalen', 'Sinais críticos'],
  riskOutOf100: ['out of 100', 'sur 100', 'von 100', 'su 100', 'sobre 100', 'van 100', 'em 100'],

  // paliers
  riskBandLow: ['Low', 'Faible', 'Niedrig', 'Basso', 'Bajo', 'Laag', 'Baixo'],
  riskBandModerate: ['Moderate', 'Modéré', 'Moderat', 'Moderato', 'Moderado', 'Gematigd', 'Moderado'],
  riskBandElevated: ['Elevated', 'Élevé', 'Erhöht', 'Elevato', 'Elevado', 'Verhoogd', 'Elevado'],
  riskBandHigh: ['High', 'Fort', 'Hoch', 'Alto', 'Alto', 'Hoog', 'Alto'],

  // dimensions
  riskDimTitle: ['Exposure by dimension', 'Exposition par dimension', 'Exposition nach Dimension', 'Esposizione per dimensione', 'Exposición por dimensión', 'Blootstelling per dimensie', 'Exposição por dimensão'],
  riskDimConcentration: ['Supplier concentration', 'Concentration fournisseurs', 'Lieferantenkonzentration', 'Concentrazione fornitori', 'Concentración de proveedores', 'Leveranciersconcentratie', 'Concentração de fornecedores'],
  riskDimGeography: ['Geographic exposure', 'Exposition géographique', 'Geografische Exposition', 'Esposizione geografica', 'Exposición geográfica', 'Geografische blootstelling', 'Exposição geográfica'],
  // Ces barres mesurent l'EXPOSITION : 100% = totalement expose. Un libelle
  // positif ('fiabilite des donnees') y disait donc l'inverse de la valeur.
  riskDimData: ['Data gaps', 'Lacunes de données', 'Datenlücken', 'Lacune nei dati', 'Lagunas de datos', 'Datahiaten', 'Lacunas de dados'],
  riskDimCollection: ['Collection delays', 'Retards de collecte', 'Erhebungsverzug', 'Ritardi di raccolta', 'Retrasos de recogida', 'Vertraging in verzameling', 'Atrasos na recolha'],
  riskDimTraceability: ['Origin gaps', 'Origine non déclarée', 'Fehlende Herkunft', 'Origine non dichiarata', 'Origen no declarado', 'Ontbrekende herkomst', 'Origem não declarada'],

  // registre
  riskRegisterTitle: ['Risk register', 'Registre des risques', 'Risikoregister', 'Registro dei rischi', 'Registro de riesgos', 'Risicoregister', 'Registo de riscos'],
  riskRegisterNote: ['Every line links to the view where it is fixed.', 'Chaque ligne mène à la vue où elle se corrige.', 'Jede Zeile führt zur Ansicht, in der sie behoben wird.', 'Ogni riga porta alla vista in cui si corregge.', 'Cada línea lleva a la vista donde se corrige.', 'Elke regel leidt naar de weergave waar hij wordt opgelost.', 'Cada linha leva à vista onde se corrige.'],
  riskColSeverity: ['Severity', 'Gravité', 'Schweregrad', 'Gravità', 'Gravedad', 'Ernst', 'Gravidade'],
  riskColCategory: ['Category', 'Catégorie', 'Kategorie', 'Categoria', 'Categoría', 'Categorie', 'Categoria'],
  riskColSubject: ['Subject', 'Objet', 'Gegenstand', 'Oggetto', 'Objeto', 'Onderwerp', 'Objeto'],
  riskColSignal: ['Signal', 'Signal', 'Signal', 'Segnale', 'Señal', 'Signaal', 'Sinal'],
  riskColAction: ['Action', 'Action', 'Aktion', 'Azione', 'Acción', 'Actie', 'Ação'],

  riskSevCritical: ['Critical', 'Critique', 'Kritisch', 'Critico', 'Crítico', 'Kritiek', 'Crítico'],
  riskSevHigh: ['High', 'Fort', 'Hoch', 'Alto', 'Alto', 'Hoog', 'Alto'],
  riskSevMedium: ['Medium', 'Moyen', 'Mittel', 'Medio', 'Medio', 'Gemiddeld', 'Médio'],
  riskSevLow: ['Low', 'Faible', 'Niedrig', 'Basso', 'Bajo', 'Laag', 'Baixo'],

  riskCatSupplier: ['Supplier', 'Fournisseur', 'Lieferant', 'Fornitore', 'Proveedor', 'Leverancier', 'Fornecedor'],
  riskCatProduct: ['Product', 'Produit', 'Produkt', 'Prodotto', 'Producto', 'Product', 'Produto'],
  riskCatCollection: ['Collection', 'Collecte', 'Erhebung', 'Raccolta', 'Recogida', 'Verzameling', 'Recolha'],
  riskCatMaterial: ['Material', 'Matière', 'Material', 'Materiale', 'Material', 'Materiaal', 'Material'],
  riskCatGeography: ['Geography', 'Géographie', 'Geografie', 'Geografia', 'Geografía', 'Geografie', 'Geografia'],

  // signaux
  riskSigConcentration: ['Supplier base concentrated in a single country', 'Base fournisseurs concentrée sur un seul pays', 'Lieferantenbasis auf ein einziges Land konzentriert', 'Base fornitori concentrata in un solo paese', 'Base de proveedores concentrada en un solo país', 'Leveranciersbestand geconcentreerd in één land', 'Base de fornecedores concentrada num único país'],
  riskSigInactive: ['Supplier relationship is not active', "La relation fournisseur n'est pas active", 'Lieferantenbeziehung ist nicht aktiv', 'La relazione con il fornitore non è attiva', 'La relación con el proveedor no está activa', 'Leveranciersrelatie is niet actief', 'A relação com o fornecedor não está ativa'],
  riskSigNoCountry: ['Supplier has no declared country', 'Fournisseur sans pays déclaré', 'Lieferant ohne angegebenes Land', 'Fornitore senza paese dichiarato', 'Proveedor sin país declarado', 'Leverancier zonder opgegeven land', 'Fornecedor sem país declarado'],
  riskSigIncomplete: ['Product data below the completion threshold', 'Données produit sous le seuil de complétude', 'Produktdaten unter der Vollständigkeitsschwelle', 'Dati prodotto sotto la soglia di completezza', 'Datos de producto por debajo del umbral de completitud', 'Productgegevens onder de volledigheidsdrempel', 'Dados do produto abaixo do limiar de completude'],
  riskSigNotReady: ['Product data not validated', 'Données produit non validées', 'Produktdaten nicht validiert', 'Dati prodotto non convalidati', 'Datos de producto no validados', 'Productgegevens niet gevalideerd', 'Dados do produto não validados'],
  riskSigOverdue: ['Data request past its due date', "Demande de données échue", 'Datenanfrage überfällig', 'Richiesta dati scaduta', 'Solicitud de datos vencida', 'Gegevensverzoek over de vervaldatum', 'Pedido de dados vencido'],
  riskSigStalled: ['Data request below expected completion', 'Demande de données en retard de complétion', 'Datenanfrage unter dem erwarteten Fortschritt', 'Richiesta dati sotto il completamento atteso', 'Solicitud de datos por debajo del avance esperado', 'Gegevensverzoek onder de verwachte voortgang', 'Pedido de dados abaixo da conclusão esperada'],
  riskSigNoOrigin: ['Material without declared origin country', "Matière sans pays d'origine déclaré", 'Material ohne angegebenes Herkunftsland', 'Materiale senza paese di origine dichiarato', 'Material sin país de origen declarado', 'Materiaal zonder opgegeven land van herkomst', 'Material sem país de origem declarado'],

  // geographie
  riskGeoTitle: ['Country concentration', 'Concentration par pays', 'Länderkonzentration', 'Concentrazione per paese', 'Concentración por país', 'Landconcentratie', 'Concentração por país'],
  riskGeoNote: ['Share of the supplier base per country.', 'Part de la base fournisseurs par pays.', 'Anteil der Lieferantenbasis je Land.', 'Quota della base fornitori per paese.', 'Cuota de la base de proveedores por país.', 'Aandeel van het leveranciersbestand per land.', 'Quota da base de fornecedores por país.'],
  riskGeoUnknown: ['Not declared', 'Non déclaré', 'Nicht angegeben', 'Non dichiarato', 'No declarado', 'Niet opgegeven', 'Não declarado'],

  // etats et actions
  riskEmpty: ['No exposure detected in the data currently loaded.', "Aucune exposition détectée dans les données chargées.", 'In den geladenen Daten wurde keine Exposition festgestellt.', 'Nessuna esposizione rilevata nei dati caricati.', 'No se ha detectado exposición en los datos cargados.', 'Geen blootstelling gedetecteerd in de geladen gegevens.', 'Nenhuma exposição detetada nos dados carregados.'],
  riskEmptyNote: ['This view reads the suppliers, products, materials and data requests already loaded in the console.', 'Cette vue lit les fournisseurs, produits, matières et demandes déjà chargés dans la console.', 'Diese Ansicht liest die bereits in der Konsole geladenen Lieferanten, Produkte, Materialien und Anfragen.', 'Questa vista legge fornitori, prodotti, materiali e richieste già caricati nella console.', 'Esta vista lee los proveedores, productos, materiales y solicitudes ya cargados en la consola.', 'Deze weergave leest de reeds in de console geladen leveranciers, producten, materialen en verzoeken.', 'Esta vista lê os fornecedores, produtos, materiais e pedidos já carregados na consola.'],
  riskOpen: ['Open', 'Ouvrir', 'Öffnen', 'Apri', 'Abrir', 'Openen', 'Abrir'],
  riskBasisTitle: ['How this is computed', 'Comment ce score est calculé', 'Wie dies berechnet wird', 'Come viene calcolato', 'Cómo se calcula', 'Hoe dit wordt berekend', 'Como é calculado'],
  riskBasisBody: [
    'Each dimension is scored from the records loaded in the console, then weighted into a single index. No external rating, no inferred data: a dimension with no records scores zero and says so.',
    "Chaque dimension est notée à partir des enregistrements chargés dans la console, puis pondérée en un indice unique. Aucune notation externe, aucune donnée inférée : une dimension sans enregistrement vaut zéro et l'indique.",
    'Jede Dimension wird aus den in der Konsole geladenen Datensätzen bewertet und dann zu einem Index gewichtet. Kein externes Rating, keine abgeleiteten Daten: Eine Dimension ohne Datensätze ergibt null und weist darauf hin.',
    "Ogni dimensione è valutata a partire dai record caricati nella console, poi ponderata in un indice unico. Nessun rating esterno, nessun dato dedotto: una dimensione senza record vale zero e lo indica.",
    'Cada dimensión se puntúa a partir de los registros cargados en la consola y se pondera en un índice único. Sin calificación externa ni datos inferidos: una dimensión sin registros puntúa cero y lo indica.',
    'Elke dimensie wordt gescoord op basis van de in de console geladen records en vervolgens gewogen tot één index. Geen externe rating, geen afgeleide gegevens: een dimensie zonder records scoort nul en vermeldt dat.',
    'Cada dimensão é pontuada a partir dos registos carregados na consola e depois ponderada num índice único. Sem notação externa nem dados inferidos: uma dimensão sem registos pontua zero e indica-o.',
  ],
  riskNoRecords: ['no records', 'aucun enregistrement', 'keine Datensätze', 'nessun record', 'sin registros', 'geen records', 'sem registos'],
};

const keys = Object.keys(T);
const gaps = [];
for (const k of keys) {
  if (T[k].length !== LANGS.length) gaps.push(`${k}: ${T[k].length}/${LANGS.length}`);
  T[k].forEach((v, i) => { if (!v || !String(v).trim()) gaps.push(`${k}.${LANGS[i]} vide`); });
}
console.log(`  portee 'console' (prefixe risk) : ${keys.length} cles x ${LANGS.length} langues`);
if (gaps.length) { gaps.forEach((g) => console.log(`      ${g}`)); process.exit(1); }
console.log('  table complete, aucun trou.');

if (CHECK) { console.log('\n  --check : aucun fichier ecrit.'); process.exit(0); }

const scopeFor = (i) => Object.fromEntries(keys.map((k) => [k, T[k][i]]));

/* --- en.js : insertion dans le bloc console, entre marqueurs ------------- */
const enPath = join(I18N, 'en.js');
let enSrc = readFileSync(enPath, 'utf8');

// Retrait d'une region precedente (idempotence). Recherche litterale : une
// regex construite par interpolation sur ces marqueurs est trop fragile, et
// une erreur d'echappement y casse silencieusement en.js a la 2e execution.
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
