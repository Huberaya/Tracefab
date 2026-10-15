/**
 * Comparaison fail-closed entre le dépôt Prisma et _prisma_migrations.
 * Pur, sans connexion ni effet de bord : testable sur des jeux de données.
 */
export function compareMigrationHistory(diskNames, records) {
  const errors = [];
  const disk = [...diskNames].sort();
  const seen = new Set();
  for (const name of disk) {
    if (seen.has(name)) errors.push(`Dossier de migration dupliqué : ${name}`);
    seen.add(name);
  }

  const byName = new Map();
  for (const row of records) {
    if (!row || typeof row.migration_name !== 'string' || !row.migration_name) {
      errors.push('Entrée _prisma_migrations invalide : nom absent.');
      continue;
    }
    const list = byName.get(row.migration_name) || [];
    list.push(row);
    byName.set(row.migration_name, list);
  }

  const diskSet = new Set(disk);
  const applied = [];
  const pending = [];
  const failed = [];
  const unknown = [];

  for (const name of disk) {
    const rows = byName.get(name) || [];
    if (rows.length === 0) {
      pending.push(name);
      errors.push(`Migration du dépôt absente de l'historique : ${name}`);
      continue;
    }

    const successes = rows.filter((r) => r.finished_at != null && r.rolled_back_at == null);
    const unresolved = rows.filter((r) => r.finished_at == null && r.rolled_back_at == null);
    if (unresolved.length > 0) {
      failed.push(name);
      errors.push(`Tentative de migration non résolue : ${name}`);
      continue;
    }
    if (successes.length === 0) {
      failed.push(name);
      errors.push(`Aucune application réussie non annulée : ${name}`);
      continue;
    }
    if (successes.length > 1) {
      failed.push(name);
      errors.push(`Plusieurs applications réussies enregistrées : ${name}`);
      continue;
    }
    applied.push(name);
  }

  for (const [name, rows] of byName) {
    if (!diskSet.has(name)) {
      unknown.push(name);
      errors.push(`Migration enregistrée mais absente du dépôt : ${name}`);
      continue;
    }
    // Une ligne de tentative échouée puis explicitement annulée peut coexister
    // avec une application réussie ultérieure. Elle n'est pas un échec actif.
    const unresolved = rows.some((r) => r.finished_at == null && r.rolled_back_at == null);
    if (unresolved && applied.includes(name)) {
      // Déjà signalé dans la boucle principale ; éviter une seconde alerte.
    }
  }

  return {
    ok: errors.length === 0,
    diskCount: disk.length,
    applied,
    pending,
    failed,
    unknown,
    errors,
  };
}
