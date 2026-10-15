#!/usr/bin/env bash
# TRACEFAB — intégration des migrations #34 / #36 / #41 sur PostgreSQL 17 jetable.
# Aucun secret. Aucune cible Neon. N'écrit pas l'historique Git.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SHA34="${SHA34:-19a867a19d6e569f3b68a0969eab8b45ff341a73}"
SHA36="${SHA36:-384b18f2876caba9247029923bdbe0fd04fe13f9}"
SHA41="${SHA41:-c75ee3eb25042c1e8848fe56df14094303e1e155}"

MIG34="prisma/migrations/20261010120000_publication_explicite"
MIG36_1212="prisma/migrations/20261012120000_close_public_execute_gap"
MIG1410="prisma/migrations/20261014100000_revoke_material_visible_public"
MIG1411="prisma/migrations/20261014110000_revoke_dpp_functions_public"
MIG1412="prisma/migrations/20261014120000_close_global_default_function_execute"
MIG1413="prisma/migrations/20261014130000_revoke_public_schema_privileges"
MIG1414="prisma/migrations/20261014140000_remove_public_supplier_passport_share_token"

refuse() { echo "REFUS: $1" >&2; exit 2; }
fail() { echo "ECHEC: $1" >&2; exit 1; }

hote_local() {
  case "$1" in
    localhost|127.0.0.1|::1|'[::1]') return 0 ;;
  esac
  return 1
}

preflight() {
  [[ "${TRACEFAB_H1_4_MODE:-}" == "jetable" || "${TF_INTEGRATION_THROWAWAY:-}" == "oui" ]] \
    || refuse "mode jetable requis (TRACEFAB_H1_4_MODE=jetable ou TF_INTEGRATION_THROWAWAY=oui)"
  [[ "${PGDATABASE:-}" == "tracefab_test" ]] || refuse "PGDATABASE=tracefab_test requis"
  if [[ -n "${DIRECT_URL:-}" ]]; then refuse "DIRECT_URL ne doit pas etre pose"; fi
  if [[ -n "${DATABASE_URL:-}" ]]; then
    case "${DATABASE_URL}" in
      postgresql://postgres:postgres@localhost:5432/tracefab_test|postgresql://postgres:postgres@127.0.0.1:5432/tracefab_test) ;;
      *) refuse "DATABASE_URL n'est pas la base jetable locale tracefab_test" ;;
    esac
  fi
  [[ -n "${PGHOST:-}" ]] || refuse "PGHOST local explicite requis"
  hote_local "${PGHOST}" || refuse "PGHOST non local"
  local ve ne
  ve="${VERCEL_ENV:-}"; ne="${NODE_ENV:-}"
  ve="${ve,,}"; ne="${ne,,}"
  if [[ "$ve" == "production" || "$ne" == "production" ]]; then
    refuse "contexte production"
  fi
  command -v psql >/dev/null || refuse "psql absent"
  [[ -x node_modules/.bin/prisma ]] || refuse "binaire prisma local absent"
  echo "preflight: jetable, tracefab_test, hote local."
}

PSQL=(psql -X --no-password -v ON_ERROR_STOP=1)

pg() { "${PSQL[@]}" "$@"; }

verif_pg17() {
  local ver db
  ver="$(pg -tAc "SHOW server_version")"
  [[ "$ver" == 17* ]] || fail "PostgreSQL 17 requis (obtenu masqué, pas 17.*)"
  db="$(pg -tAc "SELECT current_database()")"
  [[ "$db" == "tracefab_test" ]] || fail "current_database n'est pas tracefab_test"
  echo "ok    serveur 17, base tracefab_test ($ver)"
}

reset_db() {
  "${PSQL[@]}" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'tracefab_test' AND pid <> pg_backend_pid();" >/dev/null
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS tracefab_test;"
  "${PSQL[@]}" -d postgres -c "CREATE DATABASE tracefab_test OWNER postgres;"
  echo "ok    base tracefab_test recreee vide"
}

deploy() {
  node scripts/db-deploy-throwaway.mjs
}

prepare_role() {
  node scripts/run-db-suite.mjs scripts/prepare_ci_db_role.mjs
}

install_sql() {
  local dest="$1" sha="$2" path="$3"
  mkdir -p "$dest"
  git -C "$ROOT" show "$sha:$path" > "$dest/migration.sql"
  [[ -s "$dest/migration.sql" ]] || fail "extraction vide $path @$sha"
}

snapshot() {
  local label="$1"
  echo
  echo "----- ACL $label -----"
  pg -c "\\pset footer off" -c "
SELECT p.proname AS fn,
       pg_get_function_identity_arguments(p.oid) AS args,
       r.rolname AS owner,
       p.prosecdef AS secdef,
       COALESCE(array_to_string(p.proconfig, ','), '') AS proconfig,
       EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS public_exec,
       COALESCE(has_function_privilege('tracefab_app', p.oid, 'EXECUTE'), false) AS app_exec
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'tracefab_material_visible_via_product',
     'tracefab_product_is_public',
     'tracefab_material_is_public',
     'tracefab_supplier_site_is_public',
     'tracefab_public_brand',
     'tracefab_public_context',
     'tracefab_get_public_supplier_passport',
     'tracefab_get_or_create_supplier_passport',
     'tracefab_update_supplier_passport'
   )
 ORDER BY 1, 2;"
  pg -tAc "SELECT string_agg(migration_name, ',' ORDER BY migration_name) FROM _prisma_migrations;" | sed 's/^/historique: /'
}

assert_no_public() {
  local label="$1"
  shift
  local fn pub
  for fn in "$@"; do
    pub="$(pg -tAc "
SELECT EXISTS (
  SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '$fn'
     AND EXISTS (
       SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     )
);")"
    [[ "$pub" == "f" ]] || fail "$label: $fn encore EXECUTE PUBLIC"
    echo "ok    $label: $fn sans EXECUTE PUBLIC"
  done
}

assert_app_exec() {
  local label="$1"
  shift
  local fn app
  for fn in "$@"; do
    app="$(pg -tAc "
SELECT COALESCE(bool_and(has_function_privilege('tracefab_app', p.oid, 'EXECUTE')), false)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = '$fn';")"
    [[ "$app" == "t" ]] || fail "$label: tracefab_app sans EXECUTE sur $fn"
    echo "ok    $label: tracefab_app EXECUTE $fn"
  done
}

assert_replace_same_oid_family() {
  # Après CREATE OR REPLACE de même signature, l'oid change mais les ACL
  # doivent suivre l'état précédent (conservation PostgreSQL).
  true
}

SIX=(
  tracefab_material_visible_via_product
  tracefab_product_is_public
  tracefab_material_is_public
  tracefab_supplier_site_is_public
  tracefab_public_brand
  tracefab_public_context
)

FOUR_REPLACE=(
  tracefab_product_is_public
  tracefab_material_is_public
  tracefab_supplier_site_is_public
  tracefab_public_brand
)

verify_sources() {
  local head
  head="$(git -C "$ROOT" rev-parse HEAD)"
  echo "HEAD=$(git -C "$ROOT" rev-parse --short HEAD) ($head)"
  echo "SHA34=$SHA34"
  echo "SHA36=$SHA36"
  echo "SHA41=$SHA41"
  git -C "$ROOT" cat-file -e "$SHA34:$MIG34/migration.sql" || fail "10120000 absent de $SHA34"
  git -C "$ROOT" cat-file -e "$SHA36:$MIG36_1212/migration.sql" || fail "1212 absent de $SHA36"
  git -C "$ROOT" cat-file -e "$SHA36:$MIG1410/migration.sql" || fail "1410 absent de $SHA36"
  git -C "$ROOT" cat-file -e "$SHA36:$MIG1411/migration.sql" || fail "1411 absent de $SHA36"
  git -C "$ROOT" cat-file -e "$SHA41:$MIG1412/migration.sql" || fail "1412 absent de $SHA41"
  git -C "$ROOT" cat-file -e "$SHA41:$MIG1413/migration.sql" || fail "1413 absent de $SHA41"
  git -C "$ROOT" cat-file -e "$SHA41:$MIG1414/migration.sql" || fail "1414 absent de $SHA41"
  [[ "$head" == "$SHA36" ]] || echo "ATTENTION: HEAD != SHA36 pinne (on continue sur le checkout)"
  echo "ok    sources 7 migrations presentes aux SHA pinnees"
}

aside_late() {
  mkdir -p /tmp/mig-aside
  for d in "$MIG36_1212" "$MIG1410" "$MIG1411"; do
    [[ -d "$d" ]] || fail "attendu $d dans le checkout #36"
    mv "$d" /tmp/mig-aside/
  done
}

restore_tree() {
  # Le job est jetable ; on remet les dossiers deplacés si le script est relancé.
  for d in 20261012120000_close_public_execute_gap 20261014100000_revoke_material_visible_public 20261014110000_revoke_dpp_functions_public; do
    if [[ -d "/tmp/mig-aside/$d" && ! -d "prisma/migrations/$d" ]]; then
      mv "/tmp/mig-aside/$d" prisma/migrations/
    fi
  done
  rm -rf "$MIG34" "$MIG1412" "$MIG1413" "$MIG1414"
}

scenario_a() {
  echo
  echo "========== SCENARIO A : installation neuve =========="
  restore_tree
  reset_db
  prepare_role
  aside_late
  echo "-- baseline (sans 10120000/1212/1410/1411/1412+) --"
  deploy
  snapshot "A-baseline"
  install_sql "$MIG34" "$SHA34" "$MIG34/migration.sql"
  deploy
  snapshot "A-apres-10120000"
  # Conservation ACL : les 4 fonctions existaient deja (09180000). PUBLIC
  # avant le REPLACE est encore PUBLIC apres si PostgreSQL conserve les ACL.
  mv /tmp/mig-aside/20261012120000_close_public_execute_gap "$MIG36_1212"
  deploy
  snapshot "A-apres-1212"
  assert_no_public "A-1212" "${SIX[@]}"
  assert_app_exec "A-1212" "${SIX[@]}"
  mv /tmp/mig-aside/20261014100000_revoke_material_visible_public "$MIG1410"
  deploy
  snapshot "A-apres-1410"
  assert_no_public "A-1410" "${SIX[@]}"
  mv /tmp/mig-aside/20261014110000_revoke_dpp_functions_public "$MIG1411"
  deploy
  snapshot "A-apres-1411"
  assert_no_public "A-1411" "${SIX[@]}"
  install_sql "$MIG1412" "$SHA41" "$MIG1412/migration.sql"
  deploy
  snapshot "A-apres-1412"
  assert_no_public "A-1412" "${SIX[@]}"
  install_sql "$MIG1413" "$SHA41" "$MIG1413/migration.sql"
  deploy
  snapshot "A-apres-1413"
  assert_no_public "A-1413" "${SIX[@]}"
  install_sql "$MIG1414" "$SHA41" "$MIG1414/migration.sql"
  deploy
  snapshot "A-apres-1414"
  assert_no_public "A-1414" "${SIX[@]}" tracefab_get_public_supplier_passport
  assert_app_exec "A-1414" "${SIX[@]}" tracefab_get_public_supplier_passport
  node scripts/test_neon_privileges.mjs
  echo "SCENARIO A: PASS"
}

scenario_b() {
  echo
  echo "========== SCENARIO B : 10120000 apres 1212/1410/1411 =========="
  restore_tree
  reset_db
  prepare_role
  echo "-- etat #36 : baseline + 1212 + 1410 + 1411 --"
  deploy
  snapshot "B-etat-36"
  assert_no_public "B-36" "${SIX[@]}"
  local pub_before
  pub_before="$(pg -tAc "
SELECT proname || '=' || EXISTS (
  SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
)::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'tracefab_product_is_public';")"
  echo "ACL product_is_public avant 10120000: $pub_before"
  install_sql "$MIG34" "$SHA34" "$MIG34/migration.sql"
  deploy
  snapshot "B-apres-10120000-tardif"
  local pub_after
  pub_after="$(pg -tAc "
SELECT proname || '=' || EXISTS (
  SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
)::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'tracefab_product_is_public';")"
  echo "ACL product_is_public apres 10120000 tardif: $pub_after"
  if [[ "$pub_after" == *"=t" ]]; then
    echo "DEFAUT REPRODUIT: CREATE OR REPLACE a laisse ou rouvert EXECUTE PUBLIC sur product_is_public"
    echo "CORRECTION_REQUISE=oui"
    export TF_B_REOPENED=oui
  else
    echo "ok    10120000 tardif n'a pas d'EXECUTE PUBLIC sur product_is_public"
    export TF_B_REOPENED=non
  fi
  assert_no_public "B-10120000-tardif" "${FOUR_REPLACE[@]}"
  install_sql "$MIG1412" "$SHA41" "$MIG1412/migration.sql"
  install_sql "$MIG1413" "$SHA41" "$MIG1413/migration.sql"
  install_sql "$MIG1414" "$SHA41" "$MIG1414/migration.sql"
  deploy
  snapshot "B-apres-1412-1414"
  assert_no_public "B-final" "${SIX[@]}" tracefab_get_public_supplier_passport
  assert_app_exec "B-final" "${SIX[@]}" tracefab_get_public_supplier_passport
  node scripts/test_neon_privileges.mjs
  echo "SCENARIO B: PASS (reouverture=$TF_B_REOPENED)"
}

main() {
  preflight
  verif_pg17
  verify_sources
  scenario_a
  scenario_b
  restore_tree
  echo
  echo "============================================"
  echo "INTEGRATION 34/36/41 : les deux scenarios ont tourne."
  echo "reouverture B (CREATE OR REPLACE tardif) : ${TF_B_REOPENED:-inconnue}"
  echo "============================================"
}

main "$@"
