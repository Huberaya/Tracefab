#!/usr/bin/env python3
"""PHASE 6 — rewrite the Supplier Portal landing screen.

The brief: dead simple. "Your data. Your profile. Reusable across your
customers." plus a completion bar. The persona test is that a supplier
immediately knows what to do.

So the screen answers three questions in order:
  1. How complete am I?            -> .sp-hero gauge
  2. What do I do right now?       -> .sp-next, one action, nothing else
  3. Who benefits from this?       -> .sp-reuse, the brands actually connected
and only then shows the request list and the remaining checklist.

Everything is derived from live state. Nothing is invented.

Run:  python3 scripts/patch_portal_overview.py
"""
import json
import pathlib
import re

HTML = pathlib.Path(__file__).resolve().parent.parent / "supplier-portal" / "index.html"

KEYS = {
    "en": {
        "spEyebrow": "Supplier workspace",
        "spTitle": "Your data. Your profile. Reusable across your customers.",
        "spLead": "Fill it in once. Every brand you work with draws from the same record, so you never answer the same question twice.",
        "spCompletion": "Profile complete",
        "spNextRequestsT": "requests are waiting for your response",
        "spNextRequestsD": "Answer them in the portal — your existing evidence is attached automatically.",
        "spNextUrgentD": "{n} of them are due within 7 days.",
        "spNextProfileT": "of your profile is still missing",
        "spNextProfileD": "A complete profile means fewer questions from your customers later.",
        "spNextDoneT": "You are up to date",
        "spNextDoneD": "No open request, and your profile is complete. We will tell you when something arrives.",
        "spRespond": "Respond now",
        "spCompleteProfile": "Complete my profile",
        "spOpenProfile": "Open my profile",
        "spSharedWith": "Shared with",
        "spNoShares": "No customer connected yet",
        "spChecklist": "What is left",
        "spCheckProfile": "Company profile",
        "spCheckSites": "Production sites",
        "spCheckMaterials": "Materials and yarns",
        "spCheckCerts": "Certificates",
        "spCheckDocs": "Supporting documents",
        "spDone": "Done", "spTodo": "To do",
        "spRequestsTitle": "Requests waiting for you",
        "spViewAll": "View all",
    },
    "fr": {
        "spEyebrow": "Espace fournisseur",
        "spTitle": "Vos données. Votre profil. Réutilisables chez tous vos clients.",
        "spLead": "Remplissez une seule fois. Chaque marque avec qui vous travaillez puise dans la même fiche : vous ne répondez jamais deux fois à la même question.",
        "spCompletion": "Profil complété",
        "spNextRequestsT": "demandes attendent votre réponse",
        "spNextRequestsD": "Répondez depuis le portail — vos preuves déjà déposées sont rattachées automatiquement.",
        "spNextUrgentD": "Dont {n} à échéance sous 7 jours.",
        "spNextProfileT": "de votre profil reste à compléter",
        "spNextProfileD": "Un profil complet, ce sont moins de questions de vos clients plus tard.",
        "spNextDoneT": "Vous êtes à jour",
        "spNextDoneD": "Aucune demande ouverte et votre profil est complet. Nous vous préviendrons dès qu’il y a du nouveau.",
        "spRespond": "Répondre maintenant",
        "spCompleteProfile": "Compléter mon profil",
        "spOpenProfile": "Ouvrir mon profil",
        "spSharedWith": "Partagé avec",
        "spNoShares": "Aucun client connecté pour l’instant",
        "spChecklist": "Ce qu’il reste à faire",
        "spCheckProfile": "Profil entreprise",
        "spCheckSites": "Sites de production",
        "spCheckMaterials": "Matières et fils",
        "spCheckCerts": "Certificats",
        "spCheckDocs": "Documents justificatifs",
        "spDone": "Fait", "spTodo": "À faire",
        "spRequestsTitle": "Demandes qui vous attendent",
        "spViewAll": "Tout voir",
    },
    "de": {
        "spEyebrow": "Lieferantenbereich",
        "spTitle": "Ihre Daten. Ihr Profil. Wiederverwendbar bei allen Kunden.",
        "spLead": "Einmal ausfüllen. Jede Marke, mit der Sie arbeiten, greift auf denselben Datensatz zu — dieselbe Frage beantworten Sie nie zweimal.",
        "spCompletion": "Profil vollständig",
        "spNextRequestsT": "Anfragen warten auf Ihre Antwort",
        "spNextRequestsD": "Antworten Sie im Portal — Ihre vorhandenen Nachweise werden automatisch angehängt.",
        "spNextUrgentD": "Davon {n} mit Frist innerhalb von 7 Tagen.",
        "spNextProfileT": "Ihres Profils fehlen noch",
        "spNextProfileD": "Ein vollständiges Profil bedeutet später weniger Rückfragen Ihrer Kunden.",
        "spNextDoneT": "Sie sind auf dem aktuellen Stand",
        "spNextDoneD": "Keine offene Anfrage, Ihr Profil ist vollständig. Wir melden uns, sobald etwas eintrifft.",
        "spRespond": "Jetzt antworten",
        "spCompleteProfile": "Profil vervollständigen",
        "spOpenProfile": "Mein Profil öffnen",
        "spSharedWith": "Geteilt mit",
        "spNoShares": "Noch kein Kunde verbunden",
        "spChecklist": "Was noch offen ist",
        "spCheckProfile": "Unternehmensprofil",
        "spCheckSites": "Produktionsstandorte",
        "spCheckMaterials": "Materialien und Garne",
        "spCheckCerts": "Zertifikate",
        "spCheckDocs": "Belegdokumente",
        "spDone": "Erledigt", "spTodo": "Offen",
        "spRequestsTitle": "Anfragen, die auf Sie warten",
        "spViewAll": "Alle ansehen",
    },
    "it": {
        "spEyebrow": "Area fornitore",
        "spTitle": "I tuoi dati. Il tuo profilo. Riutilizzabili presso tutti i tuoi clienti.",
        "spLead": "Compila una volta sola. Ogni marchio con cui lavori attinge alla stessa scheda: non rispondi mai due volte alla stessa domanda.",
        "spCompletion": "Profilo completato",
        "spNextRequestsT": "richieste attendono la tua risposta",
        "spNextRequestsD": "Rispondi dal portale — le prove già caricate vengono allegate automaticamente.",
        "spNextUrgentD": "Di cui {n} in scadenza entro 7 giorni.",
        "spNextProfileT": "del tuo profilo è ancora da completare",
        "spNextProfileD": "Un profilo completo significa meno domande dai tuoi clienti in seguito.",
        "spNextDoneT": "Sei in regola",
        "spNextDoneD": "Nessuna richiesta aperta e il tuo profilo è completo. Ti avviseremo appena arriva qualcosa.",
        "spRespond": "Rispondi ora",
        "spCompleteProfile": "Completa il profilo",
        "spOpenProfile": "Apri il mio profilo",
        "spSharedWith": "Condiviso con",
        "spNoShares": "Nessun cliente ancora collegato",
        "spChecklist": "Cosa manca",
        "spCheckProfile": "Profilo azienda",
        "spCheckSites": "Siti produttivi",
        "spCheckMaterials": "Materiali e filati",
        "spCheckCerts": "Certificati",
        "spCheckDocs": "Documenti giustificativi",
        "spDone": "Fatto", "spTodo": "Da fare",
        "spRequestsTitle": "Richieste che ti aspettano",
        "spViewAll": "Vedi tutte",
    },
    "es": {
        "spEyebrow": "Espacio del proveedor",
        "spTitle": "Tus datos. Tu perfil. Reutilizables con todos tus clientes.",
        "spLead": "Rellénalo una sola vez. Cada marca con la que trabajas consulta la misma ficha: nunca respondes dos veces a la misma pregunta.",
        "spCompletion": "Perfil completado",
        "spNextRequestsT": "solicitudes esperan tu respuesta",
        "spNextRequestsD": "Responde desde el portal — tus pruebas ya cargadas se adjuntan automáticamente.",
        "spNextUrgentD": "De las cuales {n} vencen en menos de 7 días.",
        "spNextProfileT": "de tu perfil está sin completar",
        "spNextProfileD": "Un perfil completo significa menos preguntas de tus clientes más adelante.",
        "spNextDoneT": "Estás al día",
        "spNextDoneD": "Ninguna solicitud abierta y tu perfil está completo. Te avisaremos en cuanto llegue algo.",
        "spRespond": "Responder ahora",
        "spCompleteProfile": "Completar mi perfil",
        "spOpenProfile": "Abrir mi perfil",
        "spSharedWith": "Compartido con",
        "spNoShares": "Ningún cliente conectado todavía",
        "spChecklist": "Lo que queda",
        "spCheckProfile": "Perfil de empresa",
        "spCheckSites": "Centros de producción",
        "spCheckMaterials": "Materiales e hilos",
        "spCheckCerts": "Certificados",
        "spCheckDocs": "Documentos justificativos",
        "spDone": "Hecho", "spTodo": "Pendiente",
        "spRequestsTitle": "Solicitudes que te esperan",
        "spViewAll": "Ver todas",
    },
    "nl": {
        "spEyebrow": "Leveranciersomgeving",
        "spTitle": "Uw gegevens. Uw profiel. Herbruikbaar bij al uw klanten.",
        "spLead": "Eén keer invullen. Elk merk waarmee u werkt put uit hetzelfde dossier, dus u beantwoordt dezelfde vraag nooit twee keer.",
        "spCompletion": "Profiel compleet",
        "spNextRequestsT": "aanvragen wachten op uw antwoord",
        "spNextRequestsD": "Beantwoord ze in het portaal — uw bestaande bewijs wordt automatisch meegestuurd.",
        "spNextUrgentD": "Waarvan {n} binnen 7 dagen verlopen.",
        "spNextProfileT": "van uw profiel ontbreekt nog",
        "spNextProfileD": "Een compleet profiel betekent later minder vragen van uw klanten.",
        "spNextDoneT": "U bent bij",
        "spNextDoneD": "Geen openstaande aanvraag en uw profiel is compleet. We laten het weten zodra er iets binnenkomt.",
        "spRespond": "Nu antwoorden",
        "spCompleteProfile": "Mijn profiel afmaken",
        "spOpenProfile": "Mijn profiel openen",
        "spSharedWith": "Gedeeld met",
        "spNoShares": "Nog geen klant verbonden",
        "spChecklist": "Wat er nog is",
        "spCheckProfile": "Bedrijfsprofiel",
        "spCheckSites": "Productielocaties",
        "spCheckMaterials": "Materialen en garens",
        "spCheckCerts": "Certificaten",
        "spCheckDocs": "Bewijsstukken",
        "spDone": "Klaar", "spTodo": "Te doen",
        "spRequestsTitle": "Aanvragen die op u wachten",
        "spViewAll": "Alles bekijken",
    },
}

NEW_OVERVIEW = r"""function overview() {
        const open = openRequests();
        const dueSoon = open.filter((r) => r.dueAt && new Date(r.dueAt).getTime() - Date.now() < 7 * 86400000);
        const done = Math.max(0, Math.min(100, Number(state.profile?.profileCompletion) || 0));

        // One action. The supplier should never have to work out what is next.
        let next;
        if (open.length) {
          next = {
            n: open.length,
            title: t('spNextRequestsT'),
            desc: dueSoon.length
              ? t('spNextUrgentD').replace('{n}', String(dueSoon.length)) + ' ' + t('spNextRequestsD')
              : t('spNextRequestsD'),
            cta: t('spRespond'),
            view: 'requests',
            tone: dueSoon.length ? 'urgent' : ''
          };
        } else if (done < 100) {
          next = { n: (100 - done) + '%', title: t('spNextProfileT'), desc: t('spNextProfileD'),
                   cta: t('spCompleteProfile'), view: 'profile', tone: 'calm' };
        } else {
          next = { n: '✓', title: t('spNextDoneT'), desc: t('spNextDoneD'),
                   cta: t('spOpenProfile'), view: 'profile', tone: 'calm' };
        }

        const brands = (state.shares || [])
          .filter((s) => s && s.status === 'active')
          .map((s) => s.granteeOrganization?.display_name || s.granteeOrganization?.displayName)
          .filter(Boolean);

        const checklist = [
          { k: 'spCheckProfile', ok: done >= 100, view: 'profile' },
          { k: 'spCheckSites', ok: (state.sites || []).length > 0, view: 'sites' },
          { k: 'spCheckMaterials', ok: (state.materials || []).length > 0, view: 'materials' },
          { k: 'spCheckCerts', ok: (state.certifications || []).length > 0, view: 'certifications' },
          { k: 'spCheckDocs', ok: (state.documents || []).length > 0, view: 'documents' }
        ];

        return `<section class="sp-hero">
            <div>
              <div class="sp-hero__eyebrow">${esc(t('spEyebrow'))}</div>
              <h1 class="sp-hero__title">${esc(t('spTitle'))}</h1>
              <p class="sp-hero__lead">${esc(t('spLead'))}</p>
            </div>
            <div class="sp-gauge">
              <div class="sp-gauge__v">${moneyless(done)}%</div>
              <div class="sp-gauge__k">${esc(t('spCompletion'))}</div>
              <div class="sp-gauge__bar"><i style="width:${pct(done)}%"></i></div>
            </div>
          </section>

          <div style="height:22px"></div>

          <div class="sp-next" data-tone="${esc(next.tone)}">
            <div class="sp-next__n">${esc(String(next.n))}</div>
            <div>
              <div class="sp-next__t">${esc(next.title)}</div>
              <div class="sp-next__d">${esc(next.desc)}</div>
            </div>
            <button class="btn btn-primary" data-view="${esc(next.view)}">${esc(next.cta)}</button>
          </div>

          <div style="height:14px"></div>

          <div class="sp-reuse">
            <span class="sp-reuse__k">${esc(t('spSharedWith'))}</span>
            ${brands.length
              ? brands.map((b) => `<span class="sp-brandchip">${esc(b)}</span>`).join('')
              : `<span class="meta" style="text-transform:none;letter-spacing:0">${esc(t('spNoShares'))}</span>`}
          </div>

          <div style="height:22px"></div>

          <div class="grid split">
            <div class="card panel">
              <div class="panel-head"><h2>${esc(t('spRequestsTitle'))}</h2>
                <button class="btn btn-secondary btn-small" data-view="requests">${esc(t('spViewAll'))}</button>
              </div>
              ${requestList(open.slice(0, 4))}
            </div>
            <div class="card panel">
              <div class="panel-head"><h2>${esc(t('spChecklist'))}</h2></div>
              <div class="sp-check">
                ${checklist.map((c) => `<button class="sp-check__row" data-done="${c.ok ? 'yes' : 'no'}" data-view="${esc(c.view)}">
                    <span class="sp-check__i">${c.ok ? '✓' : '⚠'}</span>
                    <span class="sp-check__t">${esc(t(c.k))}</span>
                    <span class="sp-check__go">${esc(c.ok ? t('spDone') : t('spTodo'))}</span>
                  </button>`).join('')}
              </div>
            </div>
          </div>`;
      }"""


def main():
    s = HTML.read_text(encoding="utf-8")
    before = len(s)

    a = s.index("function overview() {")
    b = s.index("\n      function ", a + 10)
    s = s[:a] + NEW_OVERVIEW + s[b:]

    for lang, pairs in KEYS.items():
        m = re.search(r"\n(\s+)%s: \{\n" % lang, s)
        assert m, "locale %s not found" % lang
        pad = m.group(1) + "  "
        block = "".join("%s%s: %s,\n" % (pad, k, json.dumps(v, ensure_ascii=False))
                        for k, v in pairs.items())
        s = s[:m.end()] + block + s[m.end():]

    HTML.write_text(s, encoding="utf-8")
    print("supplier-portal/index.html: %d -> %d bytes" % (before, len(s)))
    print("overview() rewritten; %d keys x %d locales" % (len(KEYS["en"]), len(KEYS)))


if __name__ == "__main__":
    main()
