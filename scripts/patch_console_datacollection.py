#!/usr/bin/env python3
"""PHASE 7 — Data Collection.

Builds the brief's collection surface on top of the existing request machinery:

  Brand -> Supplier -> Product -> Required Data -> Evidence -> Review -> Verified
  states: Missing / Requested / Submitted / Under Review / Accepted / Rejected

Nothing about the request API, the locked form ids or the reminder workflow is
touched. The existing #request-search / #request-filter / #request-list trio is
reused rather than duplicated: the state board drives the same filter.

Also fixes two i18n defects that sit directly on this path:
  - labels{} was a hardcoded French map, so every status chip in the console
    read French in all six languages;
  - date() and moneyless() hardcoded 'fr-FR'.

Run:  python3 scripts/patch_console_datacollection.py
"""
import json
import pathlib
import re

HTML = pathlib.Path(__file__).resolve().parent.parent / "brand-console" / "index.html"

STATUS_KEYS = {
    "draft": "stDraft", "sent": "stSent", "in_progress": "stInProgress",
    "submitted": "stSubmitted", "changes_requested": "stChangesRequested",
    "approved": "stApproved", "cancelled": "stCancelled",
    "verified_by_reviewer": "stVerified", "needs_review": "stNeedsReview",
    "open": "stOpen", "acknowledged": "stAcknowledged", "waived": "stWaived",
    "resolved": "stResolved", "not_started": "stNotStarted",
    "data_ready": "stDataReady", "ready_to_publish": "stReadyToPublish",
    "review_required": "stReviewRequired", "active": "stActive",
    "completed": "stCompleted", "invited": "stInvited",
    "declared": "stDeclared", "documented": "stDocumented",
}

T = {
    "en": {
        "stDraft": "Draft", "stSent": "Sent", "stInProgress": "In progress",
        "stSubmitted": "Submitted", "stChangesRequested": "Changes requested",
        "stApproved": "Approved", "stCancelled": "Cancelled", "stVerified": "Verified",
        "stNeedsReview": "Needs review", "stOpen": "Open", "stAcknowledged": "Acknowledged",
        "stWaived": "Waived", "stResolved": "Resolved", "stNotStarted": "Not started",
        "stDataReady": "Ready for validation", "stReadyToPublish": "Ready to publish",
        "stReviewRequired": "Review required", "stActive": "Active", "stCompleted": "Completed",
        "stInvited": "Invited", "stDeclared": "Declared", "stDocumented": "Documented",
        "dcEyebrow": "Collection & compliance", "dcTitle": "Data collection",
        "dcLead": "From the brand's question to verified data. Every item carries a state, and every state has an owner.",
        "dcPipeline": "The collection pipeline",
        "dcS1": "Brand", "dcS2": "Supplier", "dcS3": "Product", "dcS4": "Required data",
        "dcS5": "Evidence", "dcS6": "Review", "dcS7": "Verified data",
        "dcS1d": "asks", "dcS2d": "answers", "dcS3d": "in scope", "dcS4d": "data points",
        "dcS5d": "attached", "dcS6d": "awaiting", "dcS7d": "accepted",
        "dcStates": "Where everything stands",
        "dcMissing": "Missing", "dcRequested": "Requested", "dcSubmitted": "Submitted",
        "dcUnderReview": "Under review", "dcAccepted": "Accepted", "dcRejected": "Rejected",
        "dcMissingD": "Never asked for", "dcRequestedD": "Waiting on the supplier",
        "dcSubmittedD": "Back from the supplier", "dcUnderReviewD": "On your desk",
        "dcAcceptedD": "Verified and reusable", "dcRejectedD": "Sent back for correction",
        "dcAll": "All states", "dcSearch": "Search a request…",
        "dcNewRequest": "+ New request", "dcRequests": "Requests",
        "dcFilterNote": "Select a state to filter the list",
        "dcOwnerYou": "You", "dcOwnerSupplier": "Supplier", "dcOwnerNobody": "Nobody yet",
    },
    "fr": {
        "stDraft": "Brouillon", "stSent": "Envoyée", "stInProgress": "En cours",
        "stSubmitted": "Soumise", "stChangesRequested": "À corriger",
        "stApproved": "Approuvée", "stCancelled": "Annulée", "stVerified": "Vérifiée",
        "stNeedsReview": "À revoir", "stOpen": "Ouverte", "stAcknowledged": "Acquittée",
        "stWaived": "Dérogation", "stResolved": "Résolue", "stNotStarted": "Non démarré",
        "stDataReady": "Prêt pour validation", "stReadyToPublish": "Validé & prêt à publier",
        "stReviewRequired": "Revue requise", "stActive": "Actif", "stCompleted": "Terminée",
        "stInvited": "Invité", "stDeclared": "Déclaré", "stDocumented": "Documenté",
        "dcEyebrow": "Collecte & conformité", "dcTitle": "Collecte de données",
        "dcLead": "De la question de la marque à la donnée vérifiée. Chaque élément porte un état, et chaque état a un responsable.",
        "dcPipeline": "Le circuit de collecte",
        "dcS1": "Marque", "dcS2": "Fournisseur", "dcS3": "Produit", "dcS4": "Données requises",
        "dcS5": "Preuves", "dcS6": "Revue", "dcS7": "Données vérifiées",
        "dcS1d": "demande", "dcS2d": "répondent", "dcS3d": "concernés", "dcS4d": "points de donnée",
        "dcS5d": "rattachées", "dcS6d": "en attente", "dcS7d": "acceptées",
        "dcStates": "Où en est chaque chose",
        "dcMissing": "Manquant", "dcRequested": "Demandé", "dcSubmitted": "Soumis",
        "dcUnderReview": "En revue", "dcAccepted": "Accepté", "dcRejected": "Rejeté",
        "dcMissingD": "Jamais demandé", "dcRequestedD": "En attente du fournisseur",
        "dcSubmittedD": "Revenu du fournisseur", "dcUnderReviewD": "Sur votre bureau",
        "dcAcceptedD": "Vérifié et réutilisable", "dcRejectedD": "Renvoyé pour correction",
        "dcAll": "Tous les états", "dcSearch": "Rechercher une demande…",
        "dcNewRequest": "+ Nouvelle demande", "dcRequests": "Demandes",
        "dcFilterNote": "Sélectionnez un état pour filtrer la liste",
        "dcOwnerYou": "Vous", "dcOwnerSupplier": "Fournisseur", "dcOwnerNobody": "Personne encore",
    },
    "de": {
        "stDraft": "Entwurf", "stSent": "Gesendet", "stInProgress": "In Bearbeitung",
        "stSubmitted": "Eingereicht", "stChangesRequested": "Korrektur nötig",
        "stApproved": "Genehmigt", "stCancelled": "Storniert", "stVerified": "Verifiziert",
        "stNeedsReview": "Prüfung nötig", "stOpen": "Offen", "stAcknowledged": "Bestätigt",
        "stWaived": "Ausnahme", "stResolved": "Gelöst", "stNotStarted": "Nicht begonnen",
        "stDataReady": "Bereit zur Validierung", "stReadyToPublish": "Freigegeben & publikationsbereit",
        "stReviewRequired": "Prüfung erforderlich", "stActive": "Aktiv", "stCompleted": "Abgeschlossen",
        "stInvited": "Eingeladen", "stDeclared": "Erklärt", "stDocumented": "Dokumentiert",
        "dcEyebrow": "Erhebung & Compliance", "dcTitle": "Datenerhebung",
        "dcLead": "Von der Frage der Marke bis zur verifizierten Angabe. Jedes Element hat einen Status, und jeder Status hat einen Verantwortlichen.",
        "dcPipeline": "Der Erhebungsweg",
        "dcS1": "Marke", "dcS2": "Lieferant", "dcS3": "Produkt", "dcS4": "Erforderliche Daten",
        "dcS5": "Nachweise", "dcS6": "Prüfung", "dcS7": "Verifizierte Daten",
        "dcS1d": "fragt", "dcS2d": "antworten", "dcS3d": "betroffen", "dcS4d": "Datenpunkte",
        "dcS5d": "angehängt", "dcS6d": "ausstehend", "dcS7d": "angenommen",
        "dcStates": "Wo alles steht",
        "dcMissing": "Fehlt", "dcRequested": "Angefragt", "dcSubmitted": "Eingereicht",
        "dcUnderReview": "In Prüfung", "dcAccepted": "Angenommen", "dcRejected": "Abgelehnt",
        "dcMissingD": "Nie angefragt", "dcRequestedD": "Wartet auf den Lieferanten",
        "dcSubmittedD": "Vom Lieferanten zurück", "dcUnderReviewD": "Auf Ihrem Tisch",
        "dcAcceptedD": "Verifiziert und wiederverwendbar", "dcRejectedD": "Zur Korrektur zurückgeschickt",
        "dcAll": "Alle Status", "dcSearch": "Anfrage suchen…",
        "dcNewRequest": "+ Neue Anfrage", "dcRequests": "Anfragen",
        "dcFilterNote": "Status wählen, um die Liste zu filtern",
        "dcOwnerYou": "Sie", "dcOwnerSupplier": "Lieferant", "dcOwnerNobody": "Noch niemand",
    },
    "it": {
        "stDraft": "Bozza", "stSent": "Inviata", "stInProgress": "In corso",
        "stSubmitted": "Inviata dal fornitore", "stChangesRequested": "Da correggere",
        "stApproved": "Approvata", "stCancelled": "Annullata", "stVerified": "Verificata",
        "stNeedsReview": "Da rivedere", "stOpen": "Aperta", "stAcknowledged": "Presa in carico",
        "stWaived": "Deroga", "stResolved": "Risolta", "stNotStarted": "Non avviato",
        "stDataReady": "Pronto per la validazione", "stReadyToPublish": "Validato e pronto alla pubblicazione",
        "stReviewRequired": "Revisione richiesta", "stActive": "Attivo", "stCompleted": "Completata",
        "stInvited": "Invitato", "stDeclared": "Dichiarato", "stDocumented": "Documentato",
        "dcEyebrow": "Raccolta e conformità", "dcTitle": "Raccolta dati",
        "dcLead": "Dalla domanda del marchio al dato verificato. Ogni elemento ha uno stato, e ogni stato ha un responsabile.",
        "dcPipeline": "Il percorso di raccolta",
        "dcS1": "Marchio", "dcS2": "Fornitore", "dcS3": "Prodotto", "dcS4": "Dati richiesti",
        "dcS5": "Prove", "dcS6": "Revisione", "dcS7": "Dati verificati",
        "dcS1d": "chiede", "dcS2d": "rispondono", "dcS3d": "coinvolti", "dcS4d": "punti dato",
        "dcS5d": "allegate", "dcS6d": "in attesa", "dcS7d": "accettati",
        "dcStates": "A che punto è tutto",
        "dcMissing": "Mancante", "dcRequested": "Richiesto", "dcSubmitted": "Inviato",
        "dcUnderReview": "In revisione", "dcAccepted": "Accettato", "dcRejected": "Respinto",
        "dcMissingD": "Mai richiesto", "dcRequestedD": "In attesa del fornitore",
        "dcSubmittedD": "Tornato dal fornitore", "dcUnderReviewD": "Sulla tua scrivania",
        "dcAcceptedD": "Verificato e riutilizzabile", "dcRejectedD": "Rimandato per correzione",
        "dcAll": "Tutti gli stati", "dcSearch": "Cerca una richiesta…",
        "dcNewRequest": "+ Nuova richiesta", "dcRequests": "Richieste",
        "dcFilterNote": "Seleziona uno stato per filtrare l’elenco",
        "dcOwnerYou": "Tu", "dcOwnerSupplier": "Fornitore", "dcOwnerNobody": "Ancora nessuno",
    },
    "es": {
        "stDraft": "Borrador", "stSent": "Enviada", "stInProgress": "En curso",
        "stSubmitted": "Entregada", "stChangesRequested": "Por corregir",
        "stApproved": "Aprobada", "stCancelled": "Cancelada", "stVerified": "Verificada",
        "stNeedsReview": "Por revisar", "stOpen": "Abierta", "stAcknowledged": "Confirmada",
        "stWaived": "Exención", "stResolved": "Resuelta", "stNotStarted": "Sin empezar",
        "stDataReady": "Lista para validación", "stReadyToPublish": "Validada y lista para publicar",
        "stReviewRequired": "Revisión requerida", "stActive": "Activo", "stCompleted": "Completada",
        "stInvited": "Invitado", "stDeclared": "Declarado", "stDocumented": "Documentado",
        "dcEyebrow": "Recogida y cumplimiento", "dcTitle": "Recogida de datos",
        "dcLead": "De la pregunta de la marca al dato verificado. Cada elemento tiene un estado, y cada estado tiene un responsable.",
        "dcPipeline": "El circuito de recogida",
        "dcS1": "Marca", "dcS2": "Proveedor", "dcS3": "Producto", "dcS4": "Datos requeridos",
        "dcS5": "Pruebas", "dcS6": "Revisión", "dcS7": "Datos verificados",
        "dcS1d": "pregunta", "dcS2d": "responden", "dcS3d": "afectados", "dcS4d": "puntos de dato",
        "dcS5d": "adjuntas", "dcS6d": "en espera", "dcS7d": "aceptados",
        "dcStates": "Dónde está cada cosa",
        "dcMissing": "Falta", "dcRequested": "Solicitado", "dcSubmitted": "Entregado",
        "dcUnderReview": "En revisión", "dcAccepted": "Aceptado", "dcRejected": "Rechazado",
        "dcMissingD": "Nunca solicitado", "dcRequestedD": "A la espera del proveedor",
        "dcSubmittedD": "Devuelto por el proveedor", "dcUnderReviewD": "En tu mesa",
        "dcAcceptedD": "Verificado y reutilizable", "dcRejectedD": "Devuelto para corrección",
        "dcAll": "Todos los estados", "dcSearch": "Buscar una solicitud…",
        "dcNewRequest": "+ Nueva solicitud", "dcRequests": "Solicitudes",
        "dcFilterNote": "Selecciona un estado para filtrar la lista",
        "dcOwnerYou": "Tú", "dcOwnerSupplier": "Proveedor", "dcOwnerNobody": "Nadie todavía",
    },
    "nl": {
        "stDraft": "Concept", "stSent": "Verzonden", "stInProgress": "Loopt",
        "stSubmitted": "Ingediend", "stChangesRequested": "Correctie nodig",
        "stApproved": "Goedgekeurd", "stCancelled": "Geannuleerd", "stVerified": "Geverifieerd",
        "stNeedsReview": "Beoordeling nodig", "stOpen": "Open", "stAcknowledged": "Bevestigd",
        "stWaived": "Ontheffing", "stResolved": "Opgelost", "stNotStarted": "Niet gestart",
        "stDataReady": "Klaar voor validatie", "stReadyToPublish": "Gevalideerd en publicatieklaar",
        "stReviewRequired": "Beoordeling vereist", "stActive": "Actief", "stCompleted": "Afgerond",
        "stInvited": "Uitgenodigd", "stDeclared": "Opgegeven", "stDocumented": "Gedocumenteerd",
        "dcEyebrow": "Verzameling & naleving", "dcTitle": "Gegevensverzameling",
        "dcLead": "Van de vraag van het merk tot het geverifieerde gegeven. Elk item heeft een status, en elke status heeft een eigenaar.",
        "dcPipeline": "Het verzameltraject",
        "dcS1": "Merk", "dcS2": "Leverancier", "dcS3": "Product", "dcS4": "Vereiste gegevens",
        "dcS5": "Bewijs", "dcS6": "Beoordeling", "dcS7": "Geverifieerde gegevens",
        "dcS1d": "vraagt", "dcS2d": "antwoorden", "dcS3d": "betrokken", "dcS4d": "gegevenspunten",
        "dcS5d": "bijgevoegd", "dcS6d": "in afwachting", "dcS7d": "geaccepteerd",
        "dcStates": "Hoe alles ervoor staat",
        "dcMissing": "Ontbreekt", "dcRequested": "Opgevraagd", "dcSubmitted": "Ingediend",
        "dcUnderReview": "In beoordeling", "dcAccepted": "Geaccepteerd", "dcRejected": "Afgewezen",
        "dcMissingD": "Nooit opgevraagd", "dcRequestedD": "Wacht op de leverancier",
        "dcSubmittedD": "Terug van de leverancier", "dcUnderReviewD": "Op uw bureau",
        "dcAcceptedD": "Geverifieerd en herbruikbaar", "dcRejectedD": "Teruggestuurd ter correctie",
        "dcAll": "Alle statussen", "dcSearch": "Zoek een aanvraag…",
        "dcNewRequest": "+ Nieuwe aanvraag", "dcRequests": "Aanvragen",
        "dcFilterNote": "Kies een status om de lijst te filteren",
        "dcOwnerYou": "U", "dcOwnerSupplier": "Leverancier", "dcOwnerNobody": "Nog niemand",
    },
}

HELPERS = r"""
      // ── PHASE 7 — collection vocabulary ──────────────────────────────────
      // Status chips used to read French in every language because `labels`
      // was a hardcoded map. They now resolve through the catalogue.
      const STATUS_KEYS = %s;
      const statusLabel = (value) => value ? bt(STATUS_KEYS[value] || value) : '—';

      // The brief's six collection states, derived from the request statuses
      // the API already produces. One request maps to exactly one state.
      const DC_STATES = ['missing', 'requested', 'submitted', 'underReview', 'accepted', 'rejected'];
      const DC_MAP = {
        draft: 'missing', not_started: 'missing',
        sent: 'requested', in_progress: 'requested', open: 'requested', invited: 'requested',
        submitted: 'submitted', data_ready: 'submitted',
        needs_review: 'underReview', review_required: 'underReview', acknowledged: 'underReview',
        approved: 'accepted', verified_by_reviewer: 'accepted', completed: 'accepted',
        ready_to_publish: 'accepted', resolved: 'accepted', active: 'accepted',
        changes_requested: 'rejected', cancelled: 'rejected', waived: 'rejected'
      };
      const dcState = (status) => DC_MAP[status] || 'requested';
""" % json.dumps(STATUS_KEYS, ensure_ascii=False, indent=8).replace("\n}", "\n      }")

NEW_VIEW = r"""function requestsView() {
        const demo = state.demo;
        const reqs = state.requests || [];

        // Demonstration mode shows the briefed workspace figures; connected mode
        // counts what is really there and prints an em dash when it cannot.
        const counts = {};
        DC_STATES.forEach((s) => { counts[s] = 0; });
        reqs.forEach((r) => { counts[dcState(r.status)] += 1; });
        const demoCounts = { missing: 17, requested: 64, submitted: 23, underReview: 12, accepted: 1186, rejected: 5 };

        const supplierCount = demo ? 86 : new Set(reqs.map((r) => r.supplierOrganizationId).filter(Boolean)).size;
        const productCount = demo ? 1248 : (state.products || []).length;

        const stages = [
          { k: 'dcS1', d: 'dcS1d', v: demo ? 1 : (currentBrand() ? 1 : '—') },
          { k: 'dcS2', d: 'dcS2d', v: supplierCount || '—' },
          { k: 'dcS3', d: 'dcS3d', v: productCount || '—' },
          { k: 'dcS4', d: 'dcS4d', v: demo ? 14208 : '—' },
          { k: 'dcS5', d: 'dcS5d', v: demo ? 9847 : '—' },
          { k: 'dcS6', d: 'dcS6d', v: demo ? demoCounts.underReview : counts.underReview },
          { k: 'dcS7', d: 'dcS7d', v: demo ? demoCounts.accepted : counts.accepted }
        ];

        const flow = `<div class="dc-flow">${stages.map((s, i) => `
            <div class="dc-stage"${i === stages.length - 1 ? ' data-final="yes"' : ''}>
              <div class="dc-stage__i">${String(i + 1).padStart(2, '0')}</div>
              <div class="dc-stage__v">${typeof s.v === 'number' ? moneyless(s.v) : esc(String(s.v))}</div>
              <div class="dc-stage__n">${esc(bt(s.k))}</div>
              <div class="dc-stage__d">${esc(bt(s.d))}</div>
            </div>`).join('')}</div>`;

        const board = `<div class="dc-states">${DC_STATES.map((s) => `
            <button class="dc-state" data-state="${s}" data-dc-filter="${s}">
              <span class="dc-state__v">${moneyless(demo ? demoCounts[s] : counts[s])}</span>
              <span class="dc-state__n">${esc(bt('dc' + s.charAt(0).toUpperCase() + s.slice(1)))}</span>
              <span class="dc-state__d">${esc(bt('dc' + s.charAt(0).toUpperCase() + s.slice(1) + 'D'))}</span>
            </button>`).join('')}</div>`;

        return `<div class="page-head"><div><div class="eyebrow">${esc(bt('dcEyebrow'))}</div>
            <h1>${esc(bt('dcTitle'))}</h1><p>${esc(bt('dcLead'))}</p></div>
            <div class="actions">${demo ? `<span class="mc-demo">${esc(bt('mcDemoData'))}</span>` : ''}
            <button class="btn btn-primary" data-action="new-request">${esc(bt('dcNewRequest'))}</button></div></div>

          <div class="eyebrow" style="margin-bottom:10px">${esc(bt('dcPipeline'))}</div>
          ${flow}

          <div style="height:26px"></div>
          <div class="eyebrow" style="margin-bottom:10px">${esc(bt('dcStates'))}
            <span class="dc-hint">${esc(bt('dcFilterNote'))}</span></div>
          ${board}

          <div style="height:26px"></div>
          <div class="card panel">
            <div class="panel-head"><h2>${esc(bt('dcRequests'))}</h2></div>
            <div class="filters">
              <input class="input" id="request-search" placeholder="${esc(bt('dcSearch'))}">
              <select class="select" id="request-filter" style="max-width:210px">
                <option value="all">${esc(bt('dcAll'))}</option>
                ${DC_STATES.map((s) => `<option value="${s}">${esc(bt('dc' + s.charAt(0).toUpperCase() + s.slice(1)))}</option>`).join('')}
              </select>
            </div>
            <div id="request-list">${requestTable(state.requests)}</div>
          </div>`;
      }"""


def main():
    s = HTML.read_text(encoding="utf-8")
    before = len(s)

    # ── 1. locale-aware date / number ───────────────────────────────────────
    old_date = ("      const date = (value) => value ? new Intl.DateTimeFormat('fr-FR', "
                "{ dateStyle: 'medium' }).format(new Date(value)) : '—';")
    assert old_date in s, "date() not found"
    new_date = """      // Dates and numbers used to render French whatever the chosen language.
      const BCP47 = { fr: 'fr-FR', en: 'en-GB', de: 'de-DE', it: 'it-IT', es: 'es-ES', nl: 'nl-NL', pt: 'pt-PT' };
      const locale = () => BCP47[state.lang] || 'en-GB';
      const date = (value) => value ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(new Date(value)) : '—';"""
    s = s.replace(old_date, new_date, 1)

    old_num = ("      const moneyless = (value) => Number(value || 0)"
               ".toLocaleString('fr-FR', { maximumFractionDigits: 0 });")
    assert old_num in s, "moneyless() not found"
    s = s.replace(old_num, "      const moneyless = (value) => Number(value || 0)"
                           ".toLocaleString(locale(), { maximumFractionDigits: 0 });", 1)

    # ── 2. status vocabulary ────────────────────────────────────────────────
    m = re.search(r"      const labels = \{.*?\n      \};?\n", s, re.S)
    assert m, "labels map not found"
    s = s[:m.start()] + HELPERS.lstrip("\n") + s[m.end():]
    s = s.replace("labels[supplier.profile?.onboardingStatus] || supplier.profile",
                  "statusLabel(supplier.profile?.onboardingStatus) || supplier.profile", 1)
    s = re.sub(r"labels\[([^\]]+)\] \|\| \1", r"statusLabel(\1)", s)
    assert "labels[" not in s, "a labels[...] usage survived: %r" % s[s.index("labels["):s.index("labels[") + 90]

    # ── 3. the view ─────────────────────────────────────────────────────────
    a = s.index("function requestsView() {")
    b = s.index("\n      function ", a + 10)
    s = s[:a] + NEW_VIEW + s[b:]

    # ── 4. teach the existing filter about grouped states ───────────────────
    old_pred = "(filter.value === 'all' || r.status === filter.value)"
    assert old_pred in s, "filter predicate not found"
    s = s.replace(old_pred,
                  "(filter.value === 'all' || r.status === filter.value || dcState(r.status) === filter.value)", 1)

    # the state board drives that same filter rather than a parallel one
    anchor = "        search?.addEventListener('input', filterRequests); filter?.addEventListener('change', filterRequests);"
    assert anchor in s, "filter listeners not found"
    s = s.replace(anchor, anchor + """
        document.querySelectorAll('[data-dc-filter]').forEach((el) => el.addEventListener('click', () => {
          if (!filter) return;
          const next = filter.value === el.dataset.dcFilter ? 'all' : el.dataset.dcFilter;
          filter.value = next;
          document.querySelectorAll('[data-dc-filter]').forEach((b) => b.classList.toggle('is-on', b.dataset.dcFilter === next));
          filterRequests();
        }));""", 1)

    # ── 5. locales ──────────────────────────────────────────────────────────
    for lang, pairs in T.items():
        mm = re.search(r"\n(\s+)%s: \{\n" % lang, s)
        assert mm, "locale %s not found" % lang
        pad = mm.group(1) + "  "
        block = "".join("%s%s: %s,\n" % (pad, k, json.dumps(v, ensure_ascii=False))
                        for k, v in pairs.items())
        s = s[:mm.end()] + block + s[mm.end():]

    HTML.write_text(s, encoding="utf-8")
    print("brand-console/index.html: %d -> %d bytes" % (before, len(s)))
    print("  locale-aware date() / moneyless()")
    print("  labels{} -> statusLabel() through the catalogue (%d statuses)" % len(STATUS_KEYS))
    print("  requestsView() -> 7-stage pipeline + 6-state board")
    print("  existing #request-filter extended to grouped states")
    print("  %d keys x %d locales" % (len(T["en"]), len(T)))


if __name__ == "__main__":
    main()
