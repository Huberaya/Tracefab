// Diagnostic d'un processus enfant : sorties brutes et paramètres sensibles
// ne doivent jamais franchir cette frontière. Les libellés sont prédéfinis.
export function diagnosticProvisionnement(result, etape) {
  const nom = etape === 2 ? 'provisionnement 2' : 'provisionnement 1';
  if (result.status === 0) return [];
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const codeSortie = Number.isInteger(result.status) ? String(result.status) : 'indisponible';
  const signal = ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(result.signal) ? result.signal : 'aucun';
  const lignes = [`diagnostic ${nom} : sortie=${codeSortie} signal=${signal} echecs_script=${(text.match(/^\s*ECHEC\b/gm) || []).length}`];
  if (/\bReferenceError: ROLE_WORKER is not defined\b/.test(text)) lignes.push(`diagnostic ${nom} : ReferenceError ROLE_WORKER non defini`);
  else if (/\bReferenceError:/.test(text)) lignes.push(`diagnostic ${nom} : ReferenceError (identifiant masque)`);
  const codes = [...text.matchAll(/(?:code:\s*['"]|(?:→|—)\s*)([0-9A-Z]{5})(?:['"]|\b)/g)].map((m) => m[1]);
  const sqlstates = new Set(['42501', '42P01', '42704', '42710', '0P000', '42601', '2BP01', '28P01', 'XX000', '23505', '3F000', '08006', '08001', '08003', '08004', '57P01', '55006', 'P0001']);
  for (const code of new Set(codes)) lignes.push(sqlstates.has(code)
    ? `diagnostic ${nom} : SQLSTATE ${code}` : `diagnostic ${nom} : SQLSTATE non classe (masque)`);
  for (const [motif, libelle] of [
    [/ECHEC provisionnement du schéma migrateur/, 'provisionnement du schema migrateur'],
    [/ECHEC EXECUTE de pgcrypto retire a PUBLIC/, 'ACL PUBLIC pgcrypto ouvertes'],
    [/ECHEC .* sans EXECUTE sur pgcrypto/, 'acces runtime a pgcrypto'],
    [/ECHEC aucun objet public détenu par un rôle tiers/, 'objets detenus par un role tiers'],
  ]) if (motif.test(text)) lignes.push(`diagnostic ${nom} : ${libelle}`);
  if (['ENOENT', 'EACCES', 'EAGAIN', 'ENOMEM'].includes(result.error?.code)) lignes.push(`diagnostic ${nom} : lancement ${result.error.code}`);
  lignes.push('diagnostic : sorties brutes masquees pour proteger les secrets.');
  return lignes;
}
