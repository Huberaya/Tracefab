/* ==========================================================================
   TRACEFAB — portee i18n du DPP public (dpp/).

   Migration du dictionnaire inline dppLangs vers le catalogue unique.

   Constat releve pendant la migration : sur les 10 cles du dictionnaire,
   une seule, badgeEu, etait reellement lue par la page. Les neuf autres
   etaient traduites dans sept langues et jamais affichees. Elles sont
   conservees ici parce qu'elles correspondent aux sections que le DPP
   public doit exposer et qu'elles serviront a l'extraction de la copie
   (chantier 7), mais elles restent inutilisees a ce jour et le test
   d'integrite les signale comme telles plutot que de les faire passer
   pour de la couverture acquise.

   Usage : node scripts/build_dpp_i18n.mjs [--check]
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const I18N = join(ROOT, 'assets/i18n');
const CHECK = process.argv.includes('--check');
const LANGS = ["en", "fr", "de", "it", "es", "nl", "pt"];

// cle: [en, fr, de, it, es, nl, pt]
const T = {
  badgeEu: ["EU ESPR / DPP Compliant", "EU ESPR / DPP Conforme", "EU ESPR / DPP Konform", "EU ESPR / DPP Conforme", "EU ESPR / DPP Conforme", "EU ESPR / DPP Conform", "EU ESPR / DPP Conforme"],
  verifiedOrigin: ["✓ Verified Provenance", "✓ Provenance Vérifiée", "✓ Verifizierte Herkunft", "✓ Provenienza Verificata", "✓ Procedencia Verificada", "✓ Geverifieerde Herkomst", "✓ Proveniência Verificada"],  // non utilisee a ce jour (voir note en tete)
  composition: ["Material Composition", "Composition des Matières", "Materialzusammensetzung", "Composizione Materiali", "Composición de Materiales", "Materiaalsamenstelling", "Composição dos Materiais"],  // non utilisee a ce jour (voir note en tete)
  traceability: ["Supply Chain Traceability", "Traçabilité de la Chaîne", "Lieferketten-Rückverfolgbarkeit", "Tracciabilità della Filiera", "Trazabilidad de la Cadena", "Traceerbaarheid Toeleveringsketen", "Rastreabilidade da Cadeia"],  // non utilisee a ce jour (voir note en tete)
  operations: ["Operations & Facilities", "Opérations & Ateliers", "Betriebe & Werkstätten", "Operazioni & Stabilimenti", "Operaciones e Instalaciones", "Bewerkingen & Faciliteiten", "Operações & Instalações"],  // non utilisee a ce jour (voir note en tete)
  circularity: ["Circularity & Care", "Circularité & Entretien", "Kreislaufwirtschaft & Pflege", "Circolarità & Cura", "Circularidad y Cuidado", "Circulariteit & Onderhoud", "Circularidade & Cuidados"],  // non utilisee a ce jour (voir note en tete)
  repairScore: ["Repairability Index", "Indice de Réparabilité", "Reparierbarkeitsindex", "Indice di Riparabilità", "Índice de Reparabilidad", "Repareerbaarheidsindex", "Índice de Reparabilidade"],  // non utilisee a ce jour (voir note en tete)
  carbon: ["Environmental Footprint", "Empreinte Environnementale", "Ökologischer Fußabdruck", "Impronta Ambientale", "Huella Ambiental", "Milieu-voetafdruk", "Pegada Ambiental"],  // non utilisee a ce jour (voir note en tete)
  passcode: ["SHA-256 Verified Seal", "Sceau Scellé SHA-256", "SHA-256 Verifiziertes Siegel", "Sigillo Verificato SHA-256", "Sello Verificado SHA-256", "SHA-256 Geverifieerd Zegel", "Selo Verificado SHA-256"],  // non utilisee a ce jour (voir note en tete)
  viewCert: ["View Audit Certificate", "Voir le certificat d'audit", "Audit-Zertifikat ansehen", "Visualizza certificato audit", "Ver certificado de auditoría", "Auditcertificaat bekijken", "Ver certificado de auditoria"],  // non utilisee a ce jour (voir note en tete)
};

const keys = Object.keys(T);
const gaps = [];
for (const k of keys) {
  if (T[k].length !== LANGS.length) gaps.push(`${k}: ${T[k].length}/${LANGS.length}`);
  T[k].forEach((v, i) => { if (!v || !String(v).trim()) gaps.push(`${k}.${LANGS[i]} vide`); });
}
console.log(`  portee 'dpp' : ${keys.length} cles x ${LANGS.length} langues`);
if (gaps.length) { gaps.forEach((g) => console.log(`      ${g}`)); process.exit(1); }
console.log('  table complete, aucun trou.');

if (CHECK) { console.log('\n  --check : aucun fichier ecrit.'); process.exit(0); }

const scopeFor = (i) => Object.fromEntries(keys.map((k) => [k, T[k][i]]));

const enPath = join(I18N, 'en.js');
let enSrc = readFileSync(enPath, 'utf8');
enSrc = enSrc.replace(/,\n\n  \/\/ --- DPP public[\s\S]*?\n  \}(?=\n\};)/, '');
const body = Object.entries(scopeFor(0)).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join(',\n');
enSrc = enSrc.replace(/\n\};\s*$/, `,\n\n  // --- DPP public --------------------------------------------------------\n  dpp: {\n${body}\n  }\n};\n`);
writeFileSync(enPath, enSrc);
console.log('\n  ecrit  assets/i18n/en.js');

LANGS.forEach((lang, i) => {
  if (lang === 'en') return;
  const p = join(I18N, `${lang}.json`);
  const d = JSON.parse(readFileSync(p, 'utf8'));
  d.dpp = scopeFor(i);
  writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  console.log(`  ecrit  assets/i18n/${lang}.json`);
});
