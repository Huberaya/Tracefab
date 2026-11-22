#!/usr/bin/env node
/**
 * Identité Clerk — épreuve comportementale de `verifiedPrimaryEmail`.
 *
 * POURQUOI CE TEST EXISTE
 * -----------------------
 * L'adresse primaire Clerk alimente `tracefab.user_email`, seule barrière de la
 * politique `passport_access_select` (migration 20261006250000). Mesure du
 * 28/10/2026, base jetable, rôle `tracefab_app` sans BYPASSRLS :
 *   sans GUC -> 0 ligne ; GUC = e-mail de la victime -> 1 ligne ; autre -> 0.
 *
 * Une adresse non vérifiée permettrait donc de lire la demande d'accès d'un
 * tiers. Ce test appelle RÉELLEMENT la fonction, cas par cas — une assertion
 * statique sur le source de `auth.ts` ne prouverait pas le comportement.
 *
 * Exécution : npx --no-install tsx scripts/test_clerk_identity.mjs
 */
import assert from 'node:assert/strict';
import {
  verifiedPrimaryEmail,
  MOTIF_ADRESSE_ABSENTE,
  MOTIF_ADRESSE_NON_VERIFIEE,
} from '../api/_lib/clerk-identity.ts';

let echecs = 0;
const ok = (condition, message) => {
  console.log(`  ${condition ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!condition) echecs += 1;
};

/** Construit un utilisateur Clerk minimal, comme le rend `clerk.users.getUser`. */
const utilisateur = (adresses, primaire) => ({
  emailAddresses: adresses,
  primaryEmailAddressId: primaire,
});

const verifiee = (id, emailAddress) => ({ id, emailAddress, verification: { status: 'verified' } });
const nonVerifiee = (id, emailAddress, status = 'unverified') => ({ id, emailAddress, verification: { status } });

const refus = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/* --- 1. parcours nominal -------------------------------------------------- */
{
  const u = utilisateur([verifiee('id_1', 'alice@example.test')], 'id_1');
  ok(verifiedPrimaryEmail(u) === 'alice@example.test', 'adresse primaire vérifiée : rendue telle quelle');
}

/* --- 2. adresse secondaire vérifiée mais non primaire --------------------- */
{
  // Le compte peut avoir plusieurs adresses vérifiées : seule la PRIMAIRE doit
  // être retenue, sinon un utilisateur choisirait l'identité qu'il préfère.
  const u = utilisateur(
    [verifiee('id_2', 'tiers@example.test'), verifiee('id_1', 'alice@example.test')],
    'id_1',
  );
  ok(verifiedPrimaryEmail(u) === 'alice@example.test', 'la primaire est retenue, pas la première déclarée');
}

/* --- 3. refus : adresse non vérifiée -------------------------------------- */
for (const statut of ['unverified', 'transferable', 'failed', undefined]) {
  const u = utilisateur([nonVerifiee('id_1', 'alice@example.test', statut)], 'id_1');
  const motif = refus(() => verifiedPrimaryEmail(u));
  ok(motif === MOTIF_ADRESSE_NON_VERIFIEE, `statut « ${statut ?? 'absent'} » refusé (${MOTIF_ADRESSE_NON_VERIFIEE})`);
}

/* --- 4. refus : adresse absente ou inexploitable -------------------------- */
const absences = [
  ['aucune adresse', utilisateur([], 'id_1')],
  ['primaire introuvable', utilisateur([verifiee('id_2', 'x@example.test')], 'id_1')],
  ['primaire nulle', utilisateur([verifiee('id_1', 'a@example.test')], null)],
  ['adresse vide', utilisateur([verifiee('id_1', '')], 'id_1')],
  ['adresse blanche', utilisateur([verifiee('id_1', '   ')], 'id_1')],
];
for (const [libelle, u] of absences) {
  const motif = refus(() => verifiedPrimaryEmail(u));
  ok(motif === MOTIF_ADRESSE_ABSENTE, `${libelle} -> refus (${MOTIF_ADRESSE_ABSENTE})`);
}

/* --- 5. normalisation ----------------------------------------------------- */
{
  const u = utilisateur([verifiee('id_1', '  alice@example.test  ')], 'id_1');
  ok(verifiedPrimaryEmail(u) === 'alice@example.test', 'les espaces de bord sont retirés');
}

/* --- 6. les messages de refus ne divulgue aucune donnée personnelle ------- */
{
  const motifs = [
    refus(() => verifiedPrimaryEmail(utilisateur([nonVerifiee('id_1', 'victime@example.test')], 'id_1'))),
    refus(() => verifiedPrimaryEmail(utilisateur([], 'id_1'))),
  ];
  ok(motifs.every((m) => typeof m === 'string' && !m.includes('@')), 'aucun motif ne contient d\'adresse e-mail');
  ok(
    motifs.every((m) => m === MOTIF_ADRESSE_NON_VERIFIEE || m === MOTIF_ADRESSE_ABSENTE),
    'chaque refus porte un motif nommé de la liste fermée',
  );
}

/* --- 7. contrôle négatif : le test sait échouer --------------------------- */
{
  // Une fonction qui accepterait n'importe quelle adresse doit être détectée
  // par les assertions ci-dessus. On le prouve ici : la version permissive
  // rend bien une valeur là où la vraie refuse.
  const permissive = (u) => u.emailAddresses[0]?.emailAddress;
  const u = utilisateur([nonVerifiee('id_1', 'victime@example.test')], 'id_1');
  ok(permissive(u) === 'victime@example.test', 'la variante permissive laisse bien passer (témoin)');
  ok(refus(() => verifiedPrimaryEmail(u)) === MOTIF_ADRESSE_NON_VERIFIEE, 'la vraie fonction refuse (témoin)');
}

console.log(`\n  Identité Clerk : ${echecs === 0 ? 'OK' : `${echecs} échec(s)`}.`);
process.exit(echecs === 0 ? 0 : 1);
