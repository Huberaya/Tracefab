/* ==========================================================================
   TRACEFAB — portee i18n de quality-center/

   quality-center/ etait la page la plus exposee du depot en matiere d'i18n :
   atteignable depuis trois pages, entierement en francais code en dur, et
   depourvue de tout mecanisme de traduction. Un utilisateur allemand ou
   italien y arrivait depuis une console traduite et tombait sur du francais
   sans recours.

   Ce script injecte la portee 'quality' dans le catalogue unique.
   La langue source est l'anglais, conformement a la regle du produit ; le
   francais existant devient la locale fr.

   Les statuts (ouvert, acquitte, derogation) ne sont PAS redefinis ici :
   ils existent deja dans la portee 'shared' et sont reutilises, sans quoi
   on recreerait la duplication qu'on vient de supprimer.

   Usage : node scripts/build_quality_i18n.mjs [--check]
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const I18N = join(ROOT, 'assets/i18n');
const CHECK = process.argv.includes('--check');
const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];

// cle: [en, fr, de, it, es, nl, pt]
const T = {
  loading: ['Loading the Quality Center…', 'Chargement du Quality Center…', 'Quality Center wird geladen…', 'Caricamento del Quality Center…', 'Cargando el Quality Center…', 'Quality Center wordt geladen…', 'A carregar o Quality Center…'],
  eyebrowBrand: ['Tracefab Quality Center', 'Tracefab Quality Center', 'Tracefab Quality Center', 'Tracefab Quality Center', 'Tracefab Quality Center', 'Tracefab Quality Center', 'Tracefab Quality Center'],
  unavailable: ['Quality unavailable', 'Qualité indisponible', 'Qualität nicht verfügbar', 'Qualità non disponibile', 'Calidad no disponible', 'Kwaliteit niet beschikbaar', 'Qualidade indisponível'],
  retry: ['Try again', 'Réessayer', 'Erneut versuchen', 'Riprova', 'Reintentar', 'Opnieuw proberen', 'Tentar novamente'],
  errBackend: ['The quality service is temporarily unreachable. Your data is intact.', 'Le service qualité est temporairement injoignable. Vos données sont intactes.', 'Der Qualitätsdienst ist vorübergehend nicht erreichbar. Ihre Daten sind unversehrt.', 'Il servizio qualità è temporaneamente irraggiungibile. I suoi dati sono intatti.', 'El servicio de calidad no está disponible temporalmente. Sus datos están intactos.', 'De kwaliteitsdienst is tijdelijk onbereikbaar. Uw gegevens zijn intact.', 'O serviço de qualidade está temporariamente indisponível. Os seus dados estão intactos.'],
  errSignIn: ['Please sign in again to continue.', 'Reconnectez-vous pour continuer.', 'Bitte melden Sie sich erneut an.', 'Effettui di nuovo l’accesso per continuare.', 'Vuelva a iniciar sesión para continuar.', 'Meld u opnieuw aan om door te gaan.', 'Inicie sessão novamente para continuar.'],
  signInTitle: ['Control your data quality.', 'Contrôler la qualité de la donnée.', 'Die Datenqualität steuern.', 'Controllare la qualità del dato.', 'Controlar la calidad del dato.', 'De datakwaliteit beheersen.', 'Controlar a qualidade dos dados.'],
  signInLede: ['Explainable scores, actionable issues and a history of review decisions.', 'Scores explicables, issues actionnables et historique des décisions de revue.', 'Nachvollziehbare Scores, umsetzbare Befunde und eine Historie der Prüfentscheidungen.', 'Punteggi spiegabili, problemi azionabili e storico delle decisioni di revisione.', 'Puntuaciones explicables, incidencias accionables e histórico de decisiones de revisión.', 'Verklaarbare scores, uitvoerbare bevindingen en een historiek van beoordelingsbeslissingen.', 'Pontuações explicáveis, questões acionáveis e histórico das decisões de revisão.'],
  navHome: ['Home', 'Accueil', 'Startseite', 'Home', 'Inicio', 'Home', 'Início'],
  navConsole: ['Brand Console', 'Brand Console', 'Brand Console', 'Brand Console', 'Brand Console', 'Brand Console', 'Brand Console'],
  demoMode: ['Demo mode', 'Mode démo', 'Demomodus', 'Modalità demo', 'Modo demo', 'Demomodus', 'Modo demonstração'],
  eyebrow: ['P1 · data quality', 'P1 · qualité des données', 'P1 · Datenqualität', 'P1 · qualità dei dati', 'P1 · calidad de los datos', 'P1 · datakwaliteit', 'P1 · qualidade dos dados'],
  heroTitle: ['Decide on explainable signals.', 'Décider avec des signaux explicables.', 'Auf Basis nachvollziehbarer Signale entscheiden.', 'Decidere su segnali spiegabili.', 'Decidir con señales explicables.', 'Beslissen op verklaarbare signalen.', 'Decidir com sinais explicáveis.'],
  heroLede: ['A cross-cutting review space for the products and suppliers your organisation can access. Declarative statuses are never turned into a certification.', 'Un espace de revue transversal pour les produits et fournisseurs accessibles à votre organisation. Les statuts déclaratifs ne sont jamais transformés en certification.', 'Ein übergreifender Prüfbereich für die Produkte und Lieferanten, auf die Ihre Organisation zugreifen kann. Deklarative Status werden nie in eine Zertifizierung umgewandelt.', 'Uno spazio di revisione trasversale per i prodotti e i fornitori accessibili alla vostra organizzazione. Gli stati dichiarativi non vengono mai trasformati in una certificazione.', 'Un espacio de revisión transversal para los productos y proveedores accesibles a su organización. Los estados declarativos nunca se convierten en una certificación.', 'Een overkoepelende beoordelingsruimte voor de producten en leveranciers die uw organisatie kan raadplegen. Declaratieve statussen worden nooit omgezet in een certificering.', 'Um espaço de revisão transversal para os produtos e fornecedores acessíveis à sua organização. Os estados declarativos nunca são transformados numa certificação.'],
  refresh: ['Refresh', 'Rafraîchir', 'Aktualisieren', 'Aggiorna', 'Actualizar', 'Vernieuwen', 'Atualizar'],
  metricTotal: ['Visible issues', 'Issues visibles', 'Sichtbare Befunde', 'Problemi visibili', 'Incidencias visibles', 'Zichtbare bevindingen', 'Questões visíveis'],
  metricBlocking: ['Open blocking', 'Bloquantes ouvertes', 'Offene Blocker', 'Bloccanti aperti', 'Bloqueantes abiertas', 'Open blokkerend', 'Bloqueantes abertas'],
  metricWarning: ['Warnings', 'Avertissements', 'Warnungen', 'Avvisi', 'Advertencias', 'Waarschuwingen', 'Avisos'],
  metricOpen: ['To handle', 'À traiter', 'Zu bearbeiten', 'Da trattare', 'Por tratar', 'Te behandelen', 'A tratar'],
  metricAcknowledged: ['Acknowledged', 'Acquittées', 'Bestätigt', 'Prese in carico', 'Reconocidas', 'Bevestigd', 'Reconhecidas'],
  issuesTitle: ['Priority issues', 'Issues prioritaires', 'Vorrangige Befunde', 'Problemi prioritari', 'Incidencias prioritarias', 'Prioritaire bevindingen', 'Questões prioritárias'],
  allSeverities: ['All severities', 'Toutes les sévérités', 'Alle Schweregrade', 'Tutte le gravità', 'Todas las severidades', 'Alle ernstniveaus', 'Todas as severidades'],
  sevBlocking: ['Blocking', 'Bloquantes', 'Blockierend', 'Bloccanti', 'Bloqueantes', 'Blokkerend', 'Bloqueantes'],
  sevInfo: ['Information', 'Information', 'Information', 'Informazione', 'Información', 'Informatie', 'Informação'],
  allStatuses: ['All statuses', 'Tous les statuts', 'Alle Status', 'Tutti gli stati', 'Todos los estados', 'Alle statussen', 'Todos os estados'],
  colSubject: ['Subject', 'Sujet', 'Gegenstand', 'Soggetto', 'Sujeto', 'Onderwerp', 'Assunto'],
  colIssue: ['Issue', 'Issue', 'Befund', 'Problema', 'Incidencia', 'Bevinding', 'Questão'],
  colSeverity: ['Severity', 'Gravité', 'Schweregrad', 'Gravità', 'Severidad', 'Ernst', 'Gravidade'],
  colStatus: ['Status', 'Statut', 'Status', 'Stato', 'Estado', 'Status', 'Estado'],
  colAction: ['Action', 'Action', 'Aktion', 'Azione', 'Acción', 'Actie', 'Ação'],
  actionAck: ['Acknowledge', 'Acquitter', 'Bestätigen', 'Prendere in carico', 'Reconocer', 'Bevestigen', 'Reconhecer'],
  actionWaive: ['Waive', 'Waiver', 'Ausnahme', 'Deroga', 'Exención', 'Ontheffing', 'Derrogação'],
  emptyIssues: ['No issue for these filters.', 'Aucune issue pour ces filtres.', 'Keine Befunde für diese Filter.', 'Nessun problema per questi filtri.', 'Ninguna incidencia para estos filtros.', 'Geen bevindingen voor deze filters.', 'Nenhuma questão para estes filtros.'],
  scoresTitle: ['Latest scores', 'Derniers scores', 'Letzte Scores', 'Ultimi punteggi', 'Últimas puntuaciones', 'Laatste scores', 'Últimas pontuações'],
  emptyScores: ['No score calculated.', 'Aucun score calculé.', 'Kein Score berechnet.', 'Nessun punteggio calcolato.', 'Ninguna puntuación calculada.', 'Geen score berekend.', 'Nenhuma pontuação calculada.'],
  computedOn: ['calculated', 'calculé', 'berechnet', 'calcolato', 'calculado', 'berekend', 'calculado'],
  barCompleteness: ['Completeness', 'Complétude', 'Vollständigkeit', 'Completezza', 'Completitud', 'Volledigheid', 'Completude'],
  barFreshness: ['Freshness', 'Fraîcheur', 'Aktualität', 'Freschezza', 'Frescura', 'Actualiteit', 'Atualidade'],
  barEvidence: ['Evidence', 'Preuves', 'Nachweise', 'Prove', 'Pruebas', 'Bewijs', 'Provas'],
  barConsistency: ['Consistency', 'Cohérence', 'Konsistenz', 'Coerenza', 'Coherencia', 'Consistentie', 'Coerência'],
  noticeAck: ['Issue acknowledged in demonstration mode.', 'Issue acquittée en mode démo.', 'Befund im Demomodus bestätigt.', 'Problema preso in carico in modalità demo.', 'Incidencia reconocida en modo demo.', 'Bevinding bevestigd in demomodus.', 'Questão reconhecida em modo demonstração.'],
  noticeWaive: ['Waiver recorded in demonstration mode.', 'Waiver enregistré en mode démo.', 'Ausnahme im Demomodus erfasst.', 'Deroga registrata in modalità demo.', 'Exención registrada en modo demo.', 'Ontheffing geregistreerd in demomodus.', 'Derrogação registada em modo demonstração.'],
  noticeSaved: ['Action recorded.', 'Action enregistrée.', 'Aktion erfasst.', 'Azione registrata.', 'Acción registrada.', 'Actie geregistreerd.', 'Ação registada.'],
  promptWaive: ['Waiver reason', 'Motif du waiver', 'Grund für die Ausnahme', 'Motivo della deroga', 'Motivo de la exención', 'Reden voor ontheffing', 'Motivo da derrogação'],
  demoIssueEvidence: ['The main data point has no evidence available yet.', 'La donnée principale n’a pas encore de preuve disponible.', 'Für den Hauptdatenpunkt liegt noch kein Nachweis vor.', 'Il dato principale non ha ancora una prova disponibile.', 'El dato principal aún no tiene prueba disponible.', 'Het hoofdgegeven heeft nog geen bewijs beschikbaar.', 'O dado principal ainda não tem prova disponível.'],
  demoIssueSupplier: ['The supplier profile must be renewed.', 'Le profil fournisseur doit être renouvelé.', 'Das Lieferantenprofil muss erneuert werden.', 'Il profilo fornitore deve essere rinnovato.', 'El perfil de proveedor debe renovarse.', 'Het leveranciersprofiel moet worden vernieuwd.', 'O perfil do fornecedor deve ser renovado.'],
};

const keys = Object.keys(T);
const gaps = [];
for (const k of keys) {
  if (T[k].length !== LANGS.length) gaps.push(`${k}: ${T[k].length} valeur(s) pour ${LANGS.length} langues`);
  T[k].forEach((v, i) => { if (!v || !String(v).trim()) gaps.push(`${k}.${LANGS[i]} vide`); });
}

console.log(`  portee 'quality' : ${keys.length} cles x ${LANGS.length} langues`);
console.log("  statuts reutilises depuis 'shared' : stOpen, stAcknowledged, stWaived");
if (gaps.length) {
  console.log(`\n  ${gaps.length} probleme(s) :`);
  gaps.forEach((g) => console.log(`      ${g}`));
  process.exit(1);
}
console.log('  table complete, aucun trou.');

if (CHECK) { console.log('\n  --check : aucun fichier ecrit.'); process.exit(0); }

const scopeFor = (i) => Object.fromEntries(keys.map((k) => [k, T[k][i]]));

// en.js
const enPath = join(I18N, 'en.js');
let enSrc = readFileSync(enPath, 'utf8');
// Le lookahead (?=\n\};) bornait la suppression a la fin de TOUT l'objet :
// le [\s\S]*? paresseux avalait donc chaque racine situee apres celle-ci.
// Tant que cette portee etait la derniere du catalogue, le resultat etait
// juste par accident. On borne desormais sur la fermeture de la portee
// elle-meme (accolade a 2 espaces), ce qui est independant de sa position.
enSrc = enSrc.replace(/,?\n\n  \/\/ --- Quality Center[\s\S]*?\n  \}/, '');
const body = Object.entries(scopeFor(0)).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join(',\n');
enSrc = enSrc.replace(/\n\};\s*$/, `,\n\n  // --- Quality Center ----------------------------------------------------\n  quality: {\n${body}\n  }\n};\n`);
writeFileSync(enPath, enSrc);
console.log('\n  ecrit  assets/i18n/en.js');

LANGS.forEach((lang, i) => {
  if (lang === 'en') return;
  const p = join(I18N, `${lang}.json`);
  const d = JSON.parse(readFileSync(p, 'utf8'));
  d.quality = scopeFor(i);
  writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  console.log(`  ecrit  assets/i18n/${lang}.json`);
});
