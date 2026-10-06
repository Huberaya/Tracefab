// TRACEFAB Universal Auto-Translation System
// Automatically translates every text node and placeholder in real time across the entire DOM
// for EN, FR, DE, IT, ES, NL, PT without hardcoding every single view manually.

(function () {
  const GLOSSARY = {
    // Nav & General
    "Vue d’ensemble": { en: "Overview", de: "Übersicht", it: "Panoramica", es: "Resumen", nl: "Overzicht", pt: "Visão geral" },
    "Produits": { en: "Products", de: "Produkte", it: "Prodotti", es: "Productos", nl: "Producten", pt: "Produtos" },
    "Fournisseurs": { en: "Suppliers", de: "Lieferanten", it: "Fornitori", es: "Proveedores", nl: "Leveranciers", pt: "Fornecedores" },
    "Matières": { en: "Materials", de: "Materialien", it: "Materiali", es: "Materiales", nl: "Materialen", pt: "Materiais" },
    "Matières & Fibres": { en: "Materials & Fibers", de: "Materialien & Fasern", it: "Materiali & Fibre", es: "Materiales y Fibras", nl: "Materialen & Vezels", pt: "Materiais & Fibras" },
    "Traçabilité": { en: "Traceability", de: "Rückverfolgbarkeit", it: "Tracciabilità", es: "Trazabilidad", nl: "Traceerbaarheid", pt: "Rastreabilidade" },
    "Supply Chain & Traçabilité": { en: "Supply Chain & Traceability", de: "Lieferkette & Rückverfolgbarkeit", it: "Filiera & Tracciabilità", es: "Cadena de Suministro y Trazabilidad", nl: "Toeleveringsketen & Traceerbaarheid", pt: "Cadeia de Fornecimento & Rastreabilidade" },
    "Demandes de données": { en: "Data Requests", de: "Datenanfragen", it: "Richieste Dati", es: "Solicitudes de Datos", nl: "Gegevensaanvragen", pt: "Pedidos de Dados" },
    "Questionnaires": { en: "Questionnaires", de: "Fragebögen", it: "Questionari", es: "Cuestionarios", nl: "Vragenlijsten", pt: "Questionários" },
    "Créateur de Questionnaires": { en: "Questionnaire Builder", de: "Fragebogen-Editor", it: "Creazione Questionari", es: "Creador de Cuestionarios", nl: "Vragenlijst-Maker", pt: "Criador de Questionários" },
    "Documents": { en: "Documents", de: "Dokumente", it: "Documenti", es: "Documentos", nl: "Documenten", pt: "Documentos" },
    "Preuves & Documents": { en: "Evidence & Documents", de: "Nachweise & Dokumente", it: "Prove & Documenti", es: "Evidencias y Documentos", nl: "Bewijzen & Documenten", pt: "Evidências & Documentos" },
    "Certifications": { en: "Certifications", de: "Zertifikate", it: "Certificazioni", es: "Certificaciones", nl: "Certificeringen", pt: "Certificações" },
    "Qualité & Conformité": { en: "Quality & Compliance", de: "Qualität & Konformität", it: "Qualità & Conformità", es: "Calidad y Cumplimiento", nl: "Kwaliteit & Naleving", pt: "Qualidade & Conformidade" },
    "Passeport DPP": { en: "DPP Passport", de: "DPP-Pass", it: "Passaporto DPP", es: "Pasaporte DPP", nl: "DPP-Paspoort", pt: "Passaporte DPP" },
    "Passeport Numérique (DPP Readiness)": { en: "Digital Product Passport (DPP Readiness)", de: "Digitaler Produktpass (DPP-Bereitschaft)", it: "Passaporto Digitale (Idoneità DPP)", es: "Pasaporte Digital (Preparación DPP)", nl: "Digitaal Productpaspoort (DPP-Gereedheid)", pt: "Passaporte Digital (Prontidão DPP)" },
    "Rapports & Audits": { en: "Reports & Audits", de: "Berichte & Audits", it: "Rapporti & Audit", es: "Informes y Auditorías", nl: "Rapporten & Audits", pt: "Relatórios & Auditorias" },
    "Paramètres": { en: "Settings", de: "Einstellungen", it: "Impostazioni", es: "Configuración", nl: "Instellingen", pt: "Definições" },
    "Console Principale": { en: "Main Console", de: "Hauptkonsole", it: "Console Principale", es: "Consola Principal", nl: "Hoofdconsole", pt: "Consola Principal" },
    "Collecte & Conformité": { en: "Collection & Compliance", de: "Erfassung & Konformität", it: "Raccolta & Conformità", es: "Recopilación y Cumplimiento", nl: "Verzameling & Naleving", pt: "Recolha & Conformidade" },
    "Gouvernance": { en: "Governance", de: "Governance", it: "Governance", es: "Gobernanza", nl: "Governance", pt: "Governança" },
    "+ Nouvelle demande": { en: "+ New Request", de: "+ Neue Anfrage", it: "+ Nuova Richiesta", es: "+ Nueva Solicitud", nl: "+ Nieuwe Aanvraag", pt: "+ Novo Pedido" },
    "Déconnexion": { en: "Sign Out", de: "Abmelden", it: "Disconnetti", es: "Cerrar sesión", nl: "Uitloggen", pt: "Terminar sessão" },
    "Se déconnecter": { en: "Sign Out", de: "Abmelden", it: "Disconnetti", es: "Cerrar sesión", nl: "Uitloggen", pt: "Terminar sessão" },
    "Actions Rapides": { en: "Quick Actions", de: "Schnellaktionen", it: "Azioni Rapide", es: "Acciones Rápidas", nl: "Snelle Acties", pt: "Ações Rápidas" },
    "Demandes ouvertes": { en: "Open Requests", de: "Offene Anfragen", it: "Richieste Aperte", es: "Solicitudes Abiertas", nl: "Openstaande Aanvragen", pt: "Pedidos Abertos" },
    "Échéances proches (< 7j)": { en: "Due Soon (< 7d)", de: "Bald fällig (< 7T)", it: "In scadenza (< 7gg)", es: "Próximas a vencer (< 7d)", nl: "Binnenkort verwacht (< 7d)", pt: "A expirar brevemente (< 7d)" },
    "Réponses reçues": { en: "Responses Received", de: "Erhaltene Antworten", it: "Risposte Ricevute", es: "Respuestas Recibidas", nl: "Ontvangen Antwoorden", pt: "Respostas Recebidas" },
    "Créer une demande de données": { en: "Create Data Request", de: "Datenanfrage erstellen", it: "Crea richiesta dati", es: "Crear solicitud de datos", nl: "Gegevensaanvraag aanmaken", pt: "Criar pedido de dados" },
    "Détail de la demande": { en: "Request Detail", de: "Anfragedetails", it: "Dettaglio Richiesta", es: "Detalle de Solicitud", nl: "Aanvraagdetails", pt: "Detalhe do Pedido" },
    "Détail du produit": { en: "Product Detail", de: "Produktdetails", it: "Dettaglio Prodotto", es: "Detalle de Producto", nl: "Productdetails", pt: "Detalhe do Produto" },
    "Détail du fournisseur": { en: "Supplier Detail", de: "Lieferantendetails", it: "Dettaglio Fornitore", es: "Detalle de Proveedor", nl: "Leveranciersdetails", pt: "Detalhe do Fornecedor" },

    // Supplier portal views
    "Sites de production": { en: "Production Sites", de: "Produktionsstätten", it: "Siti di Produzione", es: "Centros de Producción", nl: "Productielocaties", pt: "Instalações de Produção" },
    "Matériaux & Fils": { en: "Materials & Yarns", de: "Materialien & Garne", it: "Materiali e Filati", es: "Materiales e Hilados", nl: "Materialen & Garens", pt: "Materiais & Fios" },
    "Coffre-fort de Preuves (Vault)": { en: "Evidence Vault", de: "Nachweis-Tresor (Vault)", it: "Cassaforte Prove (Vault)", es: "Bóveda de Evidencias (Vault)", nl: "Bewijskluis (Vault)", pt: "Cofre de Evidências (Vault)" },
    "Données structurées": { en: "Structured Data", de: "Strukturierte Daten", it: "Dati Strutturati", es: "Datos Estructurados", nl: "Gestructureerde Gegevens", pt: "Dados Estruturados" },
    "Équipe & Accès": { en: "Team & Access", de: "Team & Berechtigungen", it: "Team & Accessi", es: "Equipo y Accesos", nl: "Team & Toegang", pt: "Equipa & Acessos" },
    "Score Qualité": { en: "Quality Score", de: "Qualitätsindex", it: "Punteggio Qualità", es: "Puntuación de Calidad", nl: "Kwaliteitsscore", pt: "Pontuação de Qualidade" },
    "Mon profil entreprise": { en: "Company Profile", de: "Unternehmensprofil", it: "Profilo Aziendale", es: "Perfil de Empresa", nl: "Bedrijfsprofiel", pt: "Perfil da Empresa" },
    "Enregistrer le brouillon": { en: "Save Draft", de: "Entwurf speichern", it: "Salva bozza", es: "Guardar borrador", nl: "Concept opslaan", pt: "Guardar rascunho" },
    "Soumettre à la marque": { en: "Submit to Brand", de: "An Marke übermitteln", it: "Invia al brand", es: "Enviar a la marca", nl: "Verzenden naar merk", pt: "Submeter à marca" }
  };

  function translateDom(lang) {
    if (!lang || lang === 'fr') return; // Base text in app is French

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (['script', 'style', 'code', 'pre', 'textarea'].includes(tag)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    const textNodes = [];
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }

    textNodes.forEach(n => {
      const trimmed = n.nodeValue.trim();
      if (GLOSSARY[trimmed] && GLOSSARY[trimmed][lang]) {
        n.nodeValue = n.nodeValue.replace(trimmed, GLOSSARY[trimmed][lang]);
      }
    });

    // Also translate button labels and placeholders
    document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(input => {
      const p = input.getAttribute('placeholder');
      if (GLOSSARY[p] && GLOSSARY[p][lang]) {
        input.setAttribute('placeholder', GLOSSARY[p][lang]);
      }
    });
  }

  // Observe DOM mutations to translate dynamically rendered views
  let currentLanguage = localStorage.getItem('tracefab_lang') || 'en';
  let observer = null;

  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (currentLanguage !== 'fr') {
        translateDom(currentLanguage);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.setTracefabGlobalLanguage = function(lang) {
    currentLanguage = lang;
    localStorage.setItem('tracefab_lang', lang);
    document.documentElement.lang = lang;
    translateDom(lang);
  };

  document.addEventListener('DOMContentLoaded', () => {
    currentLanguage = localStorage.getItem('tracefab_lang') || 'en';
    setupObserver();
    translateDom(currentLanguage);
  });
})();
