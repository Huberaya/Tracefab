// Neon/PostgreSQL : les migrations worker gèrent désormais elles-mêmes leur
// appartenance SET/INHERIT temporaire dans leur transaction. Aucune migration
// ne requiert une élévation SUPERUSER ni une assistance externe.
//
// Le module est conservé pour compatibilité avec le runner de rehearsal
// historique. Il ne prépare plus de privilèges et ne modifie aucun rôle.

export const MIGRATIONS_ASSISTEES = Object.freeze({});

export function exigeAssistance(_nom) {
  return false;
}

export async function preparerAppartenance(_client, _nom) {
  return { revoques: [] };
}
