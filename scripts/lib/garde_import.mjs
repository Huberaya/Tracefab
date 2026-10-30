/**
 * Garde de cible exécutée À L'IMPORT (R11 étendu, 30/10).
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Neuf scripts de `scripts/` écrivent en base sans passer par le classifieur
 * commun. Le plus souvent une seule ligne en tête du corps aurait suffi — mais
 * pas toujours : en ESM, TOUS les `import` sont évalués avant la première
 * instruction du corps. Un module importé peut donc construire un client
 * (voire ouvrir une connexion) avant que le corps n'ait la moindre occasion de
 * vérifier la cible. Une garde posée « au début du corps » arrive après.
 *
 * Ce module déplace la garde au niveau de l'évaluation du module : importé en
 * PREMIÈRE position, il s'exécute avant les autres imports (ordre d'évaluation
 * ESM : profondeur d'abord, dans l'ordre des déclarations d'import).
 *
 * CE QU'IL VÉRIFIE
 *
 * `DATABASE_URL` — la seule variable de connexion que ces scripts lisent
 * (Prisma la lit implicitement quand `datasourceUrl` n'est pas fourni). Un
 * script qui lirait une autre variable doit appeler `requireThrowawayDb`
 * lui-même avec la liste complète : ce module ne devine rien.
 *
 * SORTIES : 2 si la variable est absente (rien à faire, donc rien à exécuter),
 * 3 si la cible n'est pas jetable. Dans les deux cas, aucune connexion n'a été
 * ouverte et aucune écriture n'a eu lieu.
 */
import path from 'node:path';
import { requireThrowawayDb } from './require-throwaway-db.mjs';

/** Nom du script appelant, pour un message lisible. */
const script = path.basename(process.argv[1] || 'script');

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: `écriture base — ${process.env.TF_GARDE_PURPOSE || script}`,
  exitOnFailure: true,
});
