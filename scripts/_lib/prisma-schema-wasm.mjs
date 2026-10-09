/**
 * Chargeur du moteur de schéma Prisma en WASM.
 *
 * POURQUOI CE FICHIER EXISTE
 *   `prisma generate`, `prisma validate` et `prisma format` appellent tous un
 *   binaire natif `schema-engine` téléchargé depuis binaries.prisma.sh. Dans un
 *   environnement sans accès à cet hôte, aucune de ces commandes ne fonctionne —
 *   et le schéma n'est alors validé par rien.
 *
 *   Or Prisma publie le MÊME moteur en WASM sur le registre npm public, sous
 *   `@prisma/prisma-schema-wasm`, avec exactement la même version de moteur. Ce
 *   module le charge et expose `get_dmmf`, `get_config` et `validate`.
 *
 *   Ce n'est pas un contournement approximatif : c'est le même code Rust,
 *   compilé pour une autre cible. La validation qu'il produit est celle que
 *   produirait le binaire.
 *
 * LE PIÈGE DU REGISTRE DE PANIC
 *   Le glue WASM appelle `global.PRISMA_WASM_PANIC_REGISTRY.set_message(...)`
 *   dans son gestionnaire de panic. Sans ce global, toute erreur Rust remonte en
 *   « Cannot read properties of undefined (reading 'set_message') » — le vrai
 *   message est perdu. On l'installe donc avant de charger le module.
 *
 * LE PIÈGE DU NOM DE CHAMP
 *   `get_dmmf` et `validate` prennent un JSON dont le champ s'appelle
 *   `prismaSchema`, pas `datamodel`. Avec le mauvais nom, la réponse est
 *   « unreachable » : un trap WASM, pas un message d'erreur.
 *
 * Module sans dépendance externe.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Version de moteur attendue par le Prisma installé. */
export function expectedEngineVersion() {
  try {
    const pkg = require('@prisma/engines-version/package.json');
    /* Le champ est niché sous `prisma`, pas à la racine : le chercher au mauvais
       endroit renvoie null et fait croire à une version indéterminée. */
    return pkg?.prisma?.enginesVersion ?? null;
  } catch {
    return null;
  }
}

/** Le commit de moteur contenu dans une version du type `7.1.1-3.<40 hex>`. */
export function engineHashOf(version) {
  if (typeof version !== 'string') return null;
  const m = version.match(/\.([0-9a-f]{40})$/);
  return m ? m[1] : null;
}

/** Version de `@prisma/prisma-schema-wasm` réellement installée, ou null. */
export function installedWasmVersion() {
  try {
    return require('@prisma/prisma-schema-wasm/package.json').version ?? null;
  } catch {
    return null;
  }
}

let cached = null;
let cachedError = null;

/**
 * Charge le module WASM, ou renvoie null s'il n'est pas installé.
 *
 * Renvoyer null plutôt que lever permet à l'appelant de se déclarer
 * « indisponible » au lieu d'échouer : une vérification qui ne peut pas
 * s'exécuter doit le dire, jamais se faire passer pour réussie.
 */
export function loadSchemaWasm() {
  if (cached) return cached;
  if (cachedError) return null;
  try {
    let registryInstalled = false;
    if (!global.PRISMA_WASM_PANIC_REGISTRY) {
      global.PRISMA_WASM_PANIC_REGISTRY = {
        set_message(message) { this.lastMessage = message; },
      };
      registryInstalled = true;
    }
    const mod = require('@prisma/prisma-schema-wasm');
    cached = { mod, registryInstalled };
    return cached;
  } catch (e) {
    cachedError = e;
    return null;
  }
}

/** Le module est-il utilisable ? */
export function schemaWasmAvailable() {
  return loadSchemaWasm() !== null;
}

function unwrap(error) {
  const raw = error?.message ?? String(error);
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.message) return String(parsed.message).replace(/\u001b\[[0-9;]*m/g, '');
  } catch { /* pas un JSON d'erreur Prisma */ }
  const panic = global.PRISMA_WASM_PANIC_REGISTRY?.lastMessage;
  if (panic) return `${panic}\n${raw}`;
  return raw.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Valide un schéma. Renvoie `{ ok: true }` ou `{ ok: false, errors }`.
 * Lève si le module n'est pas chargé — vérifier `schemaWasmAvailable()` avant.
 */
export function validateSchema(prismaSchema) {
  const { mod } = loadSchemaWasm();
  global.PRISMA_WASM_PANIC_REGISTRY.lastMessage = '';
  try {
    mod.validate(JSON.stringify({ prismaSchema }));
    return { ok: true };
  } catch (e) {
    return { ok: false, errors: unwrap(e) };
  }
}

/** DMMF du schéma (l'entrée du générateur de client). */
export function getDmmf(prismaSchema) {
  const { mod } = loadSchemaWasm();
  global.PRISMA_WASM_PANIC_REGISTRY.lastMessage = '';
  try {
    return JSON.parse(mod.get_dmmf(JSON.stringify({ prismaSchema })));
  } catch (e) {
    const detail = unwrap(e);
    const error = new Error(`get_dmmf a échoué : ${detail.slice(0, 4000)}`);
    error.prismaValidation = detail;
    throw error;
  }
}

/** Bloc `config` (generators + datasources) extrait du schéma. */
export function getConfig(prismaSchema) {
  const { mod } = loadSchemaWasm();
  global.PRISMA_WASM_PANIC_REGISTRY.lastMessage = '';
  try {
    const out = JSON.parse(mod.get_config(JSON.stringify({ prismaSchema, ignoreEnvVarErrors: true })));
    return out.config;
  } catch (e) {
    throw new Error(`get_config a échoué : ${unwrap(e).slice(0, 2000)}`);
  }
}
