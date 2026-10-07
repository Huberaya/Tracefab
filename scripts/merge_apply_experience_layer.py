#!/usr/bin/env python3
"""Reapply the experience layer's infrastructure fixes onto the phase 9-12 SPAs.

The phase 9-12 line on main rewrote view content; this script does not touch
that. It reapplies only the cross-cutting fixes, which are still needed there:

  1. the legacy auto-translate.js DOM rewriter, which fights the SPA's own
     catalogue (same localStorage key, opposite default) and produces a
     half-translated UI on a first visit;
  2. labels{}, a hardcoded French status map, so chips read French in all
     languages;
  3. date() / moneyless(), hardcoded to 'fr-FR';
  4. onclick="alert('...')" buttons claiming an action succeeded while
     performing nothing;
  5. the supplier portal language <select>, which has no listener at all.

Run:  python3 scripts/merge_apply_experience_layer.py
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

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
    "uploaded": "stUploaded", "scanning": "stScanning", "available": "stAvailable",
    "rejected": "stRejected", "deleted": "stDeleted",
    "suspended": "stSuspended", "revoked": "stRevoked",
}

ST = {
    "en": {"stDraft": "Draft", "stSent": "Sent", "stInProgress": "In progress", "stSubmitted": "Submitted",
           "stChangesRequested": "Changes requested", "stApproved": "Approved", "stCancelled": "Cancelled",
           "stVerified": "Verified", "stNeedsReview": "Needs review", "stOpen": "Open",
           "stAcknowledged": "Acknowledged", "stWaived": "Waived", "stResolved": "Resolved",
           "stNotStarted": "Not started", "stDataReady": "Ready for validation",
           "stReadyToPublish": "Ready to publish", "stReviewRequired": "Review required",
           "stActive": "Active", "stCompleted": "Completed", "stInvited": "Invited",
           "stDeclared": "Declared", "stDocumented": "Documented", "stUploaded": "Saved",
           "stScanning": "Scanning", "stAvailable": "Available", "stRejected": "Rejected",
           "stDeleted": "Deleted", "stSuspended": "Suspended", "stRevoked": "Revoked",
           "demoUnavailable": "Not available in demonstration mode — connect the TRACEFAB APIs to run this action."},
    "fr": {"stDraft": "Brouillon", "stSent": "Envoyée", "stInProgress": "En cours", "stSubmitted": "Soumise",
           "stChangesRequested": "À corriger", "stApproved": "Approuvée", "stCancelled": "Annulée",
           "stVerified": "Vérifiée", "stNeedsReview": "À revoir", "stOpen": "Ouverte",
           "stAcknowledged": "Acquittée", "stWaived": "Dérogation", "stResolved": "Résolue",
           "stNotStarted": "Non démarré", "stDataReady": "Prêt pour validation",
           "stReadyToPublish": "Validé & prêt à publier", "stReviewRequired": "Revue requise",
           "stActive": "Actif", "stCompleted": "Terminée", "stInvited": "Invité",
           "stDeclared": "Déclaré", "stDocumented": "Documenté", "stUploaded": "Enregistré",
           "stScanning": "Contrôle en cours", "stAvailable": "Disponible", "stRejected": "Rejeté",
           "stDeleted": "Supprimé", "stSuspended": "Suspendu", "stRevoked": "Révoqué",
           "demoUnavailable": "Indisponible en mode démonstration — connectez les API TRACEFAB pour exécuter cette action."},
    "de": {"stDraft": "Entwurf", "stSent": "Gesendet", "stInProgress": "In Bearbeitung", "stSubmitted": "Eingereicht",
           "stChangesRequested": "Korrektur nötig", "stApproved": "Genehmigt", "stCancelled": "Storniert",
           "stVerified": "Verifiziert", "stNeedsReview": "Prüfung nötig", "stOpen": "Offen",
           "stAcknowledged": "Bestätigt", "stWaived": "Ausnahme", "stResolved": "Gelöst",
           "stNotStarted": "Nicht begonnen", "stDataReady": "Bereit zur Validierung",
           "stReadyToPublish": "Freigegeben & publikationsbereit", "stReviewRequired": "Prüfung erforderlich",
           "stActive": "Aktiv", "stCompleted": "Abgeschlossen", "stInvited": "Eingeladen",
           "stDeclared": "Erklärt", "stDocumented": "Dokumentiert", "stUploaded": "Gespeichert",
           "stScanning": "Wird geprüft", "stAvailable": "Verfügbar", "stRejected": "Abgelehnt",
           "stDeleted": "Gelöscht", "stSuspended": "Ausgesetzt", "stRevoked": "Widerrufen",
           "demoUnavailable": "Im Demonstrationsmodus nicht verfügbar — verbinden Sie die TRACEFAB-APIs, um diese Aktion auszuführen."},
    "it": {"stDraft": "Bozza", "stSent": "Inviata", "stInProgress": "In corso", "stSubmitted": "Inviata",
           "stChangesRequested": "Da correggere", "stApproved": "Approvata", "stCancelled": "Annullata",
           "stVerified": "Verificata", "stNeedsReview": "Da rivedere", "stOpen": "Aperta",
           "stAcknowledged": "Presa in carico", "stWaived": "Deroga", "stResolved": "Risolta",
           "stNotStarted": "Non avviato", "stDataReady": "Pronto per la validazione",
           "stReadyToPublish": "Validato e pronto alla pubblicazione", "stReviewRequired": "Revisione richiesta",
           "stActive": "Attivo", "stCompleted": "Completata", "stInvited": "Invitato",
           "stDeclared": "Dichiarato", "stDocumented": "Documentato", "stUploaded": "Salvato",
           "stScanning": "Controllo in corso", "stAvailable": "Disponibile", "stRejected": "Respinto",
           "stDeleted": "Eliminato", "stSuspended": "Sospeso", "stRevoked": "Revocato",
           "demoUnavailable": "Non disponibile in modalità dimostrativa — collega le API TRACEFAB per eseguire questa azione."},
    "es": {"stDraft": "Borrador", "stSent": "Enviada", "stInProgress": "En curso", "stSubmitted": "Entregada",
           "stChangesRequested": "Por corregir", "stApproved": "Aprobada", "stCancelled": "Cancelada",
           "stVerified": "Verificada", "stNeedsReview": "Por revisar", "stOpen": "Abierta",
           "stAcknowledged": "Confirmada", "stWaived": "Exención", "stResolved": "Resuelta",
           "stNotStarted": "Sin empezar", "stDataReady": "Lista para validación",
           "stReadyToPublish": "Validada y lista para publicar", "stReviewRequired": "Revisión requerida",
           "stActive": "Activo", "stCompleted": "Completada", "stInvited": "Invitado",
           "stDeclared": "Declarado", "stDocumented": "Documentado", "stUploaded": "Guardado",
           "stScanning": "Comprobando", "stAvailable": "Disponible", "stRejected": "Rechazado",
           "stDeleted": "Eliminado", "stSuspended": "Suspendido", "stRevoked": "Revocado",
           "demoUnavailable": "No disponible en modo demostración — conecta las API de TRACEFAB para ejecutar esta acción."},
    "nl": {"stDraft": "Concept", "stSent": "Verzonden", "stInProgress": "Loopt", "stSubmitted": "Ingediend",
           "stChangesRequested": "Correctie nodig", "stApproved": "Goedgekeurd", "stCancelled": "Geannuleerd",
           "stVerified": "Geverifieerd", "stNeedsReview": "Beoordeling nodig", "stOpen": "Open",
           "stAcknowledged": "Bevestigd", "stWaived": "Ontheffing", "stResolved": "Opgelost",
           "stNotStarted": "Niet gestart", "stDataReady": "Klaar voor validatie",
           "stReadyToPublish": "Gevalideerd en publicatieklaar", "stReviewRequired": "Beoordeling vereist",
           "stActive": "Actief", "stCompleted": "Afgerond", "stInvited": "Uitgenodigd",
           "stDeclared": "Opgegeven", "stDocumented": "Gedocumenteerd", "stUploaded": "Opgeslagen",
           "stScanning": "Wordt gecontroleerd", "stAvailable": "Beschikbaar", "stRejected": "Afgewezen",
           "stDeleted": "Verwijderd", "stSuspended": "Opgeschort", "stRevoked": "Ingetrokken",
           "demoUnavailable": "Niet beschikbaar in demonstratiemodus — verbind de TRACEFAB-API's om deze actie uit te voeren."},
}

BCP47 = ("{ fr:'fr-FR', en:'en-GB', de:'de-DE', it:'it-IT', es:'es-ES', "
         "nl:'nl-NL', pt:'pt-PT', tr:'tr-TR', zh:'zh-CN' }")


def patch(path, tfn, indent):
    p = ROOT / path
    s = p.read_text(encoding="utf-8")
    before = len(s)
    done = []

    # 1 ── the legacy DOM rewriter -------------------------------------------
    m = re.search(r'[ \t]*<script src="/auto-translate\.js"></script>\n?', s)
    if m:
        s = s[:m.start()] + (
            "  <!-- The legacy auto-translate.js DOM rewriter was removed here: it reads the\n"
            "       same localStorage key as this app (\"tracefab_lang\") but defaults to \"en\"\n"
            "       while the app defaults to \"fr\", so on a first visit it rewrote only the\n"
            "       glossary-matched strings and produced a half-translated UI. This page owns\n"
            "       its own complete catalogue. -->\n") + s[m.end():]
        done.append("auto-translate.js removed")

    # 2 ── status vocabulary --------------------------------------------------
    m = re.search(r"\n[ \t]*const labels = \{.*?\};?\n", s, re.S)
    if m:
        pad = " " * indent
        keys = json.dumps(STATUS_KEYS, ensure_ascii=False, indent=indent + 2)
        keys = keys.replace("\n}", "\n" + pad + "}")
        s = s[:m.start()] + (
            "\n%s// Status chips used to read French in every language because this was a\n"
            "%s// hardcoded map. They now resolve through the catalogue.\n"
            "%sconst STATUS_KEYS = %s;\n"
            "%sconst statusLabel = (value) => value ? %s(STATUS_KEYS[value] || value) : '—';\n"
            % (pad, pad, pad, keys, pad, tfn)) + s[m.end():]
        s = re.sub(r"labels\[([^\]]+)\] \|\| \1", r"statusLabel(\1)", s)
        s = re.sub(r"labels\[([^\]]+)\]", r"statusLabel(\1)", s)
        assert "labels[" not in s, "a labels[...] usage survived in %s" % path
        done.append("labels{} -> statusLabel()")

    # 3 ── locale-aware dates and numbers -------------------------------------
    m = re.search(r"\n([ \t]*)const date = \(value\) => value \? new Intl\.DateTimeFormat\('fr-FR',([^\n]*)\n", s)
    if m:
        pad = m.group(1)
        s = (s[:m.start()] +
             "\n%s// Dates and numbers used to render French whatever the chosen language.\n"
             "%sconst BCP47 = %s;\n"
             "%sconst locale = () => BCP47[state.lang] || 'en-GB';\n"
             "%sconst date = (value) => value ? new Intl.DateTimeFormat(locale(),%s\n"
             % (pad, pad, BCP47, pad, pad, m.group(2)) + s[m.end():])
        s = re.sub(r"(const moneyless = \(value\) => Number\(value \|\| 0\)\.toLocaleString\()'fr-FR'",
                   r"\1locale()", s)
        done.append("date()/moneyless() locale-aware")

    # 4 ── buttons that claimed success without doing anything ----------------
    fakes = re.findall(r'onclick="alert\([^"]*\)"', s)
    if fakes:
        s = re.sub(r'onclick="alert\([^"]*\)"', 'data-demo-action="1"', s)
        assert 'onclick="alert(' not in s
        done.append("%d fake alert buttons" % len(fakes))

    # 5 ── wire the listeners inside bind() -----------------------------------
    mb = re.search(r"\n([ \t]*)function bind\(\) \{\n", s)
    assert mb, "bind() not found in %s" % path
    pad = mb.group(1) + "  "
    hook = "\n%s// Buttons that used to alert() a fake success now say what is actually true.\n" % pad
    hook += ("%sdocument.querySelectorAll('[data-demo-action]').forEach((el) => el.addEventListener('click', (event) => {\n"
             "%s  event.preventDefault(); notify(%s('demoUnavailable'));\n"
             "%s}));\n" % (pad, pad, tfn, pad))
    if "lang-switch" in s and "getElementById('lang-switch')?.addEventListener" not in s:
        hook += ("%s// The language <select> was rendered but wired to nothing: this page relied\n"
                 "%s// on the legacy rewriter, so it was never actually translatable.\n"
                 "%sdocument.getElementById('lang-switch')?.addEventListener('change', (event) => {\n"
                 "%s  state.lang = event.currentTarget.value;\n"
                 "%s  try { localStorage.setItem('tracefab_lang', state.lang); } catch (error) { /* noop */ }\n"
                 "%s  document.documentElement.lang = state.lang;\n"
                 "%s  render();\n"
                 "%s});\n" % (pad, pad, pad, pad, pad, pad, pad, pad))
        done.append("#lang-switch wired")
    s = s[:mb.end()] + hook + s[mb.end():]

    # 6 ── locale entries ------------------------------------------------------
    added = 0
    for lang, pairs in ST.items():
        mm = re.search(r"\n(\s+)%s: \{\n" % lang, s)
        if not mm:
            print("    note: locale %s absent from %s, skipped" % (lang, path))
            continue
        lpad = mm.group(1) + "  "
        block = "".join("%s%s: %s,\n" % (lpad, k, json.dumps(v, ensure_ascii=False))
                        for k, v in pairs.items())
        s = s[:mm.end()] + block + s[mm.end():]
        added += 1
    done.append("%d status keys x %d locales" % (len(ST["en"]), added))

    p.write_text(s, encoding="utf-8")
    print("  %s: %d -> %d bytes" % (path, before, len(s)))
    for d in done:
        print("    - %s" % d)


if __name__ == "__main__":
    patch("brand-console/index.html", "bt", 6)
    patch("supplier-portal/index.html", "t", 2)
    print("done")
