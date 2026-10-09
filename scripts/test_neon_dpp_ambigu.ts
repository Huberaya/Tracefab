#!/usr/bin/env npx tsx
/**
 * Identifiant public ambigu : la resolution doit REFUSER, pas choisir.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `resolveDppPassData` resolvait un identifiant public par `findFirst` sur
 * `public_slug` OU `reference` OU `sku` OU un `identifier_value`. Aucune de ces
 * colonnes n'est unique a l'echelle de la plateforme : `public_slug` etait
 * remplie par `lower(reference)` et n'etait unique que PAR MARQUE. Deux marques
 * qui referencent toutes deux « MB-SHIRT-001 » — une reference de catalogue
 * banale — produisaient donc deux lignes candidates.
 *
 * Le `orderBy` rendait le resultat stable, ce qui a longtemps ressemble a de la
 * correction : la meme requete rendait toujours la meme ligne. Mais stable ne
 * veut pas dire juste. La ligne rendue pouvait etre le passeport de l'AUTRE
 * marque, servi sous l'URL publique de la premiere. Pour un produit dont le
 * metier est la tracabilite, c'est la pire panne possible : silencieuse, et qui
 * publie la donnee d'un tiers.
 *
 * Ce test se joue donc en base reelle, parce que le defaut etait un defaut de
 * donnees, pas de code : il fabrique la collision, puis exige
 *   1. que la resolution leve `IdentifiantPublicAmbigu` au lieu de trancher,
 *   2. que l'index unique global refuse desormais deux `public_slug` identiques,
 *   3. qu'un identifiant NON ambigu continue de resoudre vers le bon produit —
 *      sans quoi « refuser toujours » passerait le test 1 sans rien valoir.
 *
 *   DATABASE_URL=postgresql://... npm run test:neon:dpp-ambigu
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { resolveDppPassData, IdentifiantPublicAmbigu } from '../api/_lib/wallet/dpp-data-resolver.js';

const URL_BASE = process.env.DATABASE_URL;
if (!URL_BASE) {
  console.log('\n  DATABASE_URL absente : test ignore.\n');
  process.exit(0);
}

let echecs = 0;
const ok = (condition: unknown, libelle: string) => {
  console.log(`  ${condition ? 'ok   ' : 'ECHEC'} ${libelle}`);
  if (!condition) echecs += 1;
};

const REFERENCE = `AMBIGU-${randomUUID().slice(0, 8)}`;
const client = new pg.Client({ connectionString: URL_BASE });
const prisma = new PrismaClient();
const aNettoyer: Array<{ table: string; id: string }> = [];

/**
 * Les deux tables portent des colonnes obligatoires qui ont change au fil des
 * migrations. Plutot que de les figer ici — ce qui ferait tomber ce test a la
 * prochaine migration, pour une raison sans rapport avec ce qu'il verifie — on
 * demande au catalogue quelles colonnes sont NOT NULL sans valeur par defaut,
 * et on ne renseigne que celles-la.
 */
async function inserer(table: string, valeurs: Record<string, unknown>) {
  const { rows } = await client.query(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`,
    [table],
  );
  const champs: Record<string, unknown> = { ...valeurs };
  for (const { column_name: col, data_type: type, udt_name: udt } of rows) {
    if (col in champs) continue;
    // Une colonne enum n'accepte aucune chaine arbitraire : on lui donne sa
    // premiere etiquette declaree.
    if (type === 'USER-DEFINED') {
      const { rows: [etiquette] } = await client.query(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = $1 ORDER BY e.enumsortorder LIMIT 1`, [udt]);
      champs[col] = etiquette ? etiquette.enumlabel : null;
      continue;
    }
    champs[col] = type.includes('timestamp') ? new Date()
      : type.includes('bool') ? false
        : type.includes('int') || type.includes('numeric') || type.includes('double') ? 0
          : type === 'jsonb' || type === 'json' ? '{}'
            : type === 'ARRAY' ? '{}'
              : `t-${randomUUID().slice(0, 8)}`;
  }
  const cols = Object.keys(champs);
  const { rows: [ligne] } = await client.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    cols.map((c) => champs[c]),
  );
  aNettoyer.unshift({ table, id: ligne.id });
  return ligne.id as string;
}

try {
  await client.connect();
  console.log('\n  Identifiant public ambigu\n');

  // --- A. l'index unique global existe ---
  const { rows: index } = await client.query(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'tracefab_products' AND indexname = $1`,
    ['tracefab_products_public_slug_global_key'],
  );
  ok(index.length === 1, 'l\'index unique global sur public_slug existe');
  ok(index[0] && /WHERE \(public_slug IS NOT NULL\)/i.test(index[0].indexdef),
    'il est partiel : les produits non publies ne sont pas contraints');

  // --- B. deux marques, la meme reference de catalogue ---
  const orgA = await inserer('organizations', { id: randomUUID(), display_name: 'Marque A' });
  const orgB = await inserer('organizations', { id: randomUUID(), display_name: 'Marque B' });
  const produitA = await inserer('tracefab_products', {
    id: randomUUID(), brand_organization_id: orgA, reference: REFERENCE,
    public_slug: REFERENCE.toLowerCase(),
  });
  await inserer('tracefab_products', {
    id: randomUUID(), brand_organization_id: orgB, reference: REFERENCE,
    public_slug: `${REFERENCE.toLowerCase()}-b`,
  });

  // --- C. l'index refuse la collision de slug ---
  let refuse = false;
  try {
    await client.query(
      `UPDATE tracefab_products SET public_slug = $1 WHERE brand_organization_id = $2`,
      [REFERENCE.toLowerCase(), orgB],
    );
  } catch (erreur: any) {
    refuse = erreur.code === '23505';
  }
  ok(refuse, 'deux produits ne peuvent plus partager un meme public_slug');

  // --- D. la reference partagee est ambigue : refus attendu ---
  let leve: unknown = null;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('tracefab.public_context', 'true', true)`;
      return resolveDppPassData(tx as any, REFERENCE);
    });
  } catch (erreur) {
    leve = erreur;
  }
  ok(leve instanceof IdentifiantPublicAmbigu,
    `une reference partagee par deux marques est refusee (${leve ? (leve as Error).name : 'aucune erreur'})`);

  // --- E. un identifiant non ambigu resout toujours ---
  const resolu = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.public_context', 'true', true)`;
    return resolveDppPassData(tx as any, REFERENCE.toLowerCase());
  });
  ok(resolu !== null, 'le slug propre d\'une des deux marques resout encore');
  ok(resolu && (resolu as any).productId === produitA,
    'et il resout vers SON produit, pas vers celui du voisin');
} finally {
  for (const { table, id } of aNettoyer) {
    await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
  await client.end().catch(() => {});
}

console.log(echecs
  ? `\n  ${echecs} echec(s).\n`
  : '\n  Un identifiant public ambigu est refuse, pas devine.\n');
process.exit(echecs ? 1 : 0);
