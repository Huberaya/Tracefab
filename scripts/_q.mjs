import { randomUUID } from 'node:crypto';
import pg from 'pg';
const P = process.env.DATABASE_URL, A = process.env.TF_RLS_APP_URL;
const o = new pg.Client({ connectionString: P }), a = new pg.Client({ connectionString: A });
await o.connect(); await a.connect();
const s = randomUUID().slice(0, 8);
const brand = randomUUID(), supplierOrg = randomUUID(), brandUser = randomUUID(), viewer = randomUUID(), supUser = randomUUID(), supplierId = randomUUID();
const ctx = async (userId, orgId) => {
  await a.query('BEGIN');
  await a.query(`select set_config('tracefab.user_id',$1,true)`, [userId]);
  await a.query(`select set_config('tracefab.active_organization_id',$1,true)`, [orgId]);
};
const fin = async () => { await a.query('COMMIT'); };
try {
  for (const [id, mail] of [[brandUser, 'b'], [viewer, 'v'], [supUser, 's']])
    await o.query(`insert into users (id, clerk_user_id, email, full_name) values ($1::uuid,$2,$3,'q')`, [id, `q_${mail}_${s}`, `q-${mail}-${s}@example.test`]);
  await o.query(`insert into organizations (id,type,legal_name,display_name,status,created_by) values ($1::uuid,'brand'::organization_type,'QB','QB','active'::organization_status,$3::uuid),($2::uuid,'supplier'::organization_type,'QS','QS','active'::organization_status,$4::uuid)`, [brand, supplierOrg, brandUser, supUser]);
  await o.query(`insert into organization_memberships (organization_id,user_id,role,status) values ($1::uuid,$3::uuid,'owner'::membership_role,'active'::membership_status),($1::uuid,$4::uuid,'viewer'::membership_role,'active'::membership_status),($2::uuid,$5::uuid,'owner'::membership_role,'active'::membership_status)`, [brand, supplierOrg, brandUser, viewer, supUser]);
  await o.query(`insert into suppliers (id, organization_id, onboarding_status, activity_types, profile_version, profile_completion) values ($1::uuid,$2::uuid,'in_progress'::supplier_onboarding_status,'{}',1,0)`, [supplierId, supplierOrg]);

  await ctx(brandUser, brand);
  const p = await a.query(`SELECT * FROM tracefab_create_product($1::uuid,'Q-PRODUCT','Q Product','shirt','Q-SKU')`, [brand]);
  const productId = p.rows[0].id;
  await fin(); console.log('produit cree:', !!productId);

  await ctx(supUser, supplierOrg);
  const sc = await a.query(`SELECT * FROM tracefab_compute_supplier_quality($1::uuid,'supplier_quality_test_v1')`, [supplierId]);
  console.log('score fournisseur:', sc.rows[0]?.completeness, 'manquants:', sc.rows[0]?.missing_fields?.length);
  await fin();

  const issues = await o.query(`select id from data_quality_issues where supplier_id=$1::uuid order by detected_at`, [supplierId]);
  console.log('anomalies:', issues.rowCount);

  await ctx(supUser, supplierOrg);
  const ack = await a.query(`SELECT * FROM tracefab_acknowledge_quality_issue($1::uuid)`, [issues.rows[0].id]);
  console.log('acquittee:', ack.rows[0]?.status);
  await fin();

  await ctx(viewer, brand);
  try { await a.query(`SELECT * FROM tracefab_waive_quality_issue($1::uuid,'viewer')`, [issues.rows[0].id]); console.log('FUITE: viewer a pu renoncer'); }
  catch (e) { console.log('refus viewer:', e.message); }
  await fin();

  await ctx(supUser, supplierOrg);
  const w = await a.query(`SELECT * FROM tracefab_waive_quality_issue($1::uuid,'supplier accepts')`, [issues.rows[0].id]);
  console.log('renoncee:', w.rows[0]?.status);
  await fin();

  await ctx(brandUser, brand);
  const pq = await a.query(`SELECT * FROM tracefab_compute_product_quality($1::uuid,'product_quality_test_v1')`, [productId]);
  console.log('score produit:', pq.rows[0]?.product_id === productId);
  await fin();

  await ctx(viewer, brand);
  try { await a.query(`SELECT * FROM tracefab_compute_product_quality($1::uuid,'product_quality_test_v1')`, [productId]); console.log('FUITE: viewer a pu calculer'); }
  catch (e) { console.log('refus viewer produit:', e.message); }
  await fin();
} finally {
  await o.end(); await a.end();
}
