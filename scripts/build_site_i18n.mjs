#!/usr/bin/env node
/* ==========================================================================
   Chantier 03 — injection du namespace `site` et des cles modal/footer
   du site public dans les catalogues i18n.

   Source unique : scripts/_chantier03_site_i18n.json (7 langues).
   Cible : assets/i18n/en.js (reference) + fr/de/it/es/nl/pt.json.
   Les locales partielles (tr/zh) ne couvrent que shared+portal : le repli
   anglais s'applique, aucune cle n'y est ajoutee (parite testee stricte
   sur les locales completes uniquement).

   Idempotent : relancer ne duplique rien.
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = JSON.parse(readFileSync(join(ROOT, 'scripts/_chantier03_site_i18n.json'), 'utf8'));

const LANGS = Object.keys(SRC);
if (!LANGS.includes('en')) throw new Error('en manquant dans la source');

/* -- 1. parite stricte des cles entre les 7 langues ----------------------- */
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out;
};
const refKeys = new Set(leaves(SRC.en));
for (const lang of LANGS) {
  const keys = new Set(leaves(SRC[lang]));
  for (const k of refKeys) if (!keys.has(k)) throw new Error(`${lang}: cle manquante ${k}`);
  for (const k of keys) if (!refKeys.has(k)) throw new Error(`${lang}: cle en trop ${k}`);
}
console.log(`ok  parite source : ${refKeys.size} cles x ${LANGS.length} langues`);

/* -- 2. valeurs modal/footer mises a jour (EN + 6 locales) ---------------- */
const MODAL_PATCH = {
  successTxt: SRC.en.form.successTxt,
  sending: 'Sending…',
  errorTxt: 'We could not record your request. Please try again or write to sales@tracefab.com.',
};
const FOOTER_PATCH = {
  resources1: 'Platform overview',
  resources2: 'Trust & security',
  resources3: 'Resources',
  resources4: 'About & contact',
};
const MODAL_I18N = {
  fr: { successTxt: SRC.fr.form.successTxt, sending: 'Envoi…', errorTxt: "Nous n'avons pas pu enregistrer votre demande. Réessayez ou écrivez à sales@tracefab.com." },
  de: { successTxt: SRC.de.form.successTxt, sending: 'Wird gesendet…', errorTxt: 'Wir konnten Ihre Anfrage nicht erfassen. Bitte versuchen Sie es erneut oder schreiben Sie an sales@tracefab.com.' },
  it: { successTxt: SRC.it.form.successTxt, sending: 'Invio…', errorTxt: 'Non siamo riusciti a registrare la tua richiesta. Riprova o scrivi a sales@tracefab.com.' },
  es: { successTxt: SRC.es.form.successTxt, sending: 'Enviando…', errorTxt: 'No pudimos registrar tu solicitud. Inténtalo de nuevo o escribe a sales@tracefab.com.' },
  nl: { successTxt: SRC.nl.form.successTxt, sending: 'Versturen…', errorTxt: 'We konden je aanvraag niet registreren. Probeer het opnieuw of schrijf naar sales@tracefab.com.' },
  pt: { successTxt: SRC.pt.form.successTxt, sending: 'A enviar…', errorTxt: 'Não foi possível registar o seu pedido. Tente novamente ou escreva para sales@tracefab.com.' },
};
const FOOTER_I18N = {
  fr: { resources1: 'Aperçu de la plateforme', resources2: 'Confiance & sécurité', resources3: 'Ressources', resources4: 'À propos & contact' },
  de: { resources1: 'Plattformüberblick', resources2: 'Vertrauen & Sicherheit', resources3: 'Ressourcen', resources4: 'Über uns & Kontakt' },
  it: { resources1: 'Panoramica della piattaforma', resources2: 'Fiducia e sicurezza', resources3: 'Risorse', resources4: 'Chi siamo e contatti' },
  es: { resources1: 'Visión general de la plataforma', resources2: 'Confianza y seguridad', resources3: 'Recursos', resources4: 'Nosotros y contacto' },
  nl: { resources1: 'Platformoverzicht', resources2: 'Vertrouwen & beveiliging', resources3: 'Bronnen', resources4: 'Over ons & contact' },
  pt: { resources1: 'Visão geral da plataforma', resources2: 'Confiança e segurança', resources3: 'Recursos', resources4: 'Sobre e contacto' },
};

/* -- 3. en.js : valeurs + bloc site -------------------------------------- */
const EN_PATH = join(ROOT, 'assets/i18n/en.js');
let en = readFileSync(EN_PATH, 'utf8');

function patchJsValue(src, key, value) {
  const re = new RegExp(`(\\b${key}:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`);
  if (!re.test(src)) throw new Error(`en.js: cle ${key} introuvable`);
  return src.replace(re, `$1${JSON.stringify(value)}`);
}
en = patchJsValue(en, 'successTxt', MODAL_PATCH.successTxt);
en = patchJsValue(en, 'resources1', FOOTER_PATCH.resources1);
en = patchJsValue(en, 'resources2', FOOTER_PATCH.resources2);
en = patchJsValue(en, 'resources3', FOOTER_PATCH.resources3);
en = patchJsValue(en, 'resources4', FOOTER_PATCH.resources4);

/* insertion des cles modal.sending / modal.errorTxt apres successTxt */
if (!/\bsending:/.test(en)) {
  en = en.replace(
    /(\bsuccessTxt:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))(,?)/,
    `$1,\n    sending: ${JSON.stringify(MODAL_PATCH.sending)},\n    errorTxt: ${JSON.stringify(MODAL_PATCH.errorTxt)}$2`,
  );
}

/* insertion du bloc site avant le }; final (idempotent) */
if (!/\n\s*"site":\s*\{/.test(en) && !/\n\s*site:\s*\{/.test(en)) {
  const siteLiteral = JSON.stringify(SRC.en, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
  const idx = en.lastIndexOf('};');
  if (idx === -1) throw new Error('en.js: fermeture }; introuvable');
  en = en.slice(0, idx).replace(/\s*$/, '') + ',\n  "site": ' + siteLiteral + '\n};\n';
  en = en.replace(/\};\n};/, '};');
}
writeFileSync(EN_PATH, en);
console.log('ok  en.js : valeurs modal/footer + bloc site');

/* -- 4. locales completes : valeurs + bloc site --------------------------- */
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const path = join(ROOT, `assets/i18n/${lang}.json`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data.modal || !data.footer) throw new Error(`${lang}: modal ou footer absent`);
  Object.assign(data.modal, MODAL_I18N[lang]);
  Object.assign(data.footer, FOOTER_I18N[lang]);
  data.site = SRC[lang];
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`ok  ${lang}.json : modal/footer + bloc site`);
}

console.log('injection site i18n terminee');
