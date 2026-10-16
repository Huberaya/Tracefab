#!/usr/bin/env node
/**
 * Pose le role applicatif `tracefab_app` AVANT la chaine de migrations.
 *
 * A executer avant `npm run db:deploy` sur une base vierge. Voir
 * scripts/lib/tracefab_app_role.mjs pour la justification complete.
 *
 * Variables :
 *   DATABASE_URL     connexion proprietaire de la base (obligatoire)
 *   TF_APP_PASSWORD  mot de passe a donner au role applicatif (obligatoire)
 *
 * Idempotent : sans effet sur une base ou le role existe deja.
 */
import { ensureAppRoleFromUrl } from './lib/tracefab_app_role.mjs';

const urlProprio = process.env.DATABASE_URL;
const motDePasse = process.env.TF_APP_PASSWORD;

if (!urlProprio) {
  console.error('  DATABASE_URL manquant — il doit pointer le proprietaire de la base.');
  process.exit(2);
}
if (!motDePasse) {
  console.error('  TF_APP_PASSWORD manquant — mot de passe a donner au role tracefab_app.');
  process.exit(2);
}

await ensureAppRoleFromUrl(urlProprio, motDePasse);
console.log('  base prete pour npm run db:deploy');
