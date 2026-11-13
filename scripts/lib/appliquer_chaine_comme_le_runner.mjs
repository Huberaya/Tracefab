/**
 * APPLIQUER LA CHAINE COMME LE RUNNER, DANS UN BANC QUI L'APPLIQUE LUI-MEME.
 *
 * LE DEFAUT MESURE — 2026-11-12
 *
 * Trois suites du job `base-de-donnees` (isolation RLS sur lignes reelles,
 * concurrence des suites, provisioning du role applicatif) appliquent les
 * fichiers de migration elles-memes au lieu d'appeler le runner. Raison
 * legitime : elles doivent intercaler des mesures entre deux fichiers, ou
 * provoquer un echec a un endroit precis.
 *
 * Mais six migrations testent l'appartenance `tracefab_worker` de
 * `current_user` avant de transferer des objets proteges, et refusent de
 * s'executer sans que le runner ait declare — DANS LA TRANSACTION — qu'il gere
 * cette appartenance :
 *
 *     tracefab.worker_membership_managed = 'true'
 *
 * Sans cette declaration, la chaine s'arrete a la 61e migration sur
 *
 *     P0001 worker_membership_must_be_managed_by_runner
 *
 * puis les suivantes tombent en cascade (25P02). Les bancs mesuraient donc un
 * etat que le deploiement ne produit jamais : ce n'est pas un defaut de la
 * chaine, c'est un defaut du banc.
 *
 * CE QUE CE MODULE FOURNIT
 *
 * `appliquerCommeLeRunner(client, nom, sql)` : la transaction complete, dans
 * l'ordre du runner et avec sa declaration. `nom` est le nom du DOSSIER de
 * migration (`20261028120100_worker_identity_not_forgeable`), pas le chemin.
 *
 * La liste des six vient du module partage `migrations_worker_temporaire.mjs`,
 * importable, qui est aussi celle qu'importe le runner : le banc ne peut ni en
 * oublier une, ni s'en accorder une de plus. Cette duplication de LISTE etait
 * exactement ce qui avait rendu le defaut possible.
 */

import { exigeBailWorker } from './migrations_worker_temporaire.mjs';

/**
 * Declare l'appartenance worker gere par le runner, si cette migration l'exige.
 *
 * L'appel est fait AVANT le premier ordre de la migration et DANS sa
 * transaction : `SET LOCAL` disparait au COMMIT/ROLLBACK, il ne peut donc pas
 * fuir vers la migration suivante ni vers une autre suite.
 */
export async function declarerBailWorkerSiRequis(client, nom) {
  if (!exigeBailWorker(nom)) return false;
  await client.query("SET LOCAL tracefab.worker_membership_managed = 'true'");
  return true;
}

/**
 * Applique une migration dans sa propre transaction, comme le runner.
 *
 * @returns {Promise<{ bailWorker: boolean }>}
 */
export async function appliquerCommeLeRunner(client, nom, sql) {
  await client.query('BEGIN');
  try {
    const bailWorker = await declarerBailWorkerSiRequis(client, nom);
    await client.query(sql);
    await client.query('COMMIT');
    return { bailWorker };
  } catch (erreur) {
    await client.query('ROLLBACK').catch(() => {});
    throw erreur;
  }
}

/**
 * Variante pour les bancs qui ont besoin de la transaction ouverte autour de
 * plusieurs ordres (mesures intercalees, preparation d'appartenance).
 *
 * Le client doit avoir ouvert la transaction ; la fonction pose uniquement la
 * declaration, et signale si elle l'a fait.
 */
export { exigeBailWorker };
