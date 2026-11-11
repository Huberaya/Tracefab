// Le premier bootstrap de tracefab_worker crée le rôle puis doit accorder
// temporairement SET/INHERIT à l'exécutant pour transférer les fonctions.
// Un rôle non membre ne peut pas s'accorder lui-même cette appartenance.
// Le runner de rehearsal encadre donc cette migration par une élévation
// administrative bornée, puis vérifie sa révocation avant de poursuivre.
// Les migrations suivantes gèrent leur appartenance temporaire dans leur
// transaction, avec le rôle worker déjà créé.

export const MIGRATIONS_ASSISTEES = Object.freeze({
  '20261028120100_worker_identity_not_forgeable': {
    raison: 'bootstrap initial de tracefab_worker : l executant doit pouvoir accorder puis retirer son appartenance SET/INHERIT dans la migration; assistance administrative bornee necessaire au premier CREATE ROLE',
  },
});

export function exigeAssistance(nom) {
  return Object.prototype.hasOwnProperty.call(MIGRATIONS_ASSISTEES, nom);
}

export async function preparerAppartenance(_client, _nom) {
  return { revoques: [] };
}
