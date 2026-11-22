// Le bootstrap initial crée tracefab_worker et accorde à l'exécutant
// CREATEROLE une appartenance temporaire qu'il révoque lui-même.
// Les migrations suivantes utilisent un bail SET/INHERIT fourni par le runner
// administratif dans leur transaction, puis révoqué avant COMMIT.

export const MIGRATIONS_ASSISTEES = Object.freeze({});

export function exigeAssistance(nom) {
  return Object.prototype.hasOwnProperty.call(MIGRATIONS_ASSISTEES, nom);
}

export async function preparerAppartenance(_client, _nom) {
  return { revoques: [] };
}
