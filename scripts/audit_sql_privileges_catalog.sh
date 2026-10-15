#!/usr/bin/env bash
# TRACEFAB — catalogue exhaustif des privilèges de fonctions sur PG17 jetable.
# Aucun secret. Aucune cible Neon. Ne fusionne rien. Ne réécrit aucune migration.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SHA_MAIN="${SHA_MAIN:-76298b242ac34fd6823adfe6fed1e0c4ff055461}"
SHA34="${SHA34:-19a867a19d6e569f3b68a0969eab8b45ff341a73}"
SHA36="${SHA36:-6d785dcb5611b38313f61864fe7ff2e25d6842bb}"
SHA41="${SHA41:-c75ee3eb25042c1e8848fe56df14094303e1e155}"

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
    || refuse "mode jetable requis"
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

deploy() { node scripts/db-deploy-throwaway.mjs; }
prepare_role() { node scripts/run-db-suite.mjs scripts/prepare_ci_db_role.mjs; }

install_tree() {
  local sha="$1"
  git cat-file -t "$sha" >/dev/null || fail "objet git absent $sha"
  rm -rf prisma/migrations
  git archive "$sha" prisma/migrations | tar -x
  [[ -d prisma/migrations ]] || fail "archive migrations vide @$sha"
  echo "ok    arbre migrations $sha"
}

install_sql() {
  local dest="$1" sha="$2" path="$3"
  mkdir -p "$dest"
  git show "$sha:$path" > "$dest/migration.sql"
  [[ -s "$dest/migration.sql" ]] || fail "extraction vide $path @$sha"
}

PRIORITY=(
  tracefab_get_or_create_supplier_passport
  tracefab_update_supplier_passport
  tracefab_get_public_supplier_passport
  tracefab_request_passport_access
  tracefab_review_passport_access
  tracefab_material_visible_via_product
  tracefab_product_is_public
  tracefab_material_is_public
  tracefab_supplier_site_is_public
  tracefab_public_brand
  tracefab_public_context
)

RLS_APP=(
  tracefab_material_visible_via_product
  tracefab_product_is_public
  tracefab_material_is_public
  tracefab_supplier_site_is_public
  tracefab_public_brand
  tracefab_public_context
)

PASSPORT_APP=(
  tracefab_get_or_create_supplier_passport
  tracefab_update_supplier_passport
  tracefab_get_public_supplier_passport
  tracefab_request_passport_access
  tracefab_review_passport_access
)

CATALOG_SQL="$(cat <<'SQL'
SELECT
  p.proname AS fn,
  pg_get_function_identity_arguments(p.oid) AS args,
  r.rolname AS owner,
  p.prosecdef AS secdef,
  COALESCE(array_to_string(p.proconfig, ','), '') AS proconfig,
  (p.proacl IS NULL) AS acl_null,
  COALESCE(p.proacl::text, '') AS proacl_explicit,
  EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) AS public_exec,
  COALESCE(has_function_privilege('tracefab_app', p.oid, 'EXECUTE'), false) AS app_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.prokind IN ('f', 'p')
  AND (p.prosecdef OR p.proname LIKE 'tracefab_%')
ORDER BY p.prosecdef DESC, p.proname, 2;
SQL
)"

assert_present() {
  local label="$1" fn="$2" n
  n="$(pg -tAc "
SELECT count(*)::int
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = '$fn';")"
  [[ "$n" -ge 1 ]] || fail "$label: fonction ABSENTE $fn (NOT TESTED interdit : elle doit exister)"
  echo "ok    $label: presente $fn (n=$n)"
}

assert_no_secdef_public() {
  local label="$1" n list
  n="$(pg -tAc "
SELECT count(*)::int
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
 WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
   AND EXISTS (
     SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
   );")"
  if [[ "$n" != "0" ]]; then
    list="$(pg -tAc "
SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' ORDER BY 1)
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
 WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
   AND EXISTS (
     SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
   );")"
    echo "::error title=$label::SECURITY DEFINER encore EXECUTE PUBLIC ($n) : $list"
    fail "$label: $n SECURITY DEFINER encore EXECUTE PUBLIC : $list"
  fi
  echo "ok    $label: 0 SECURITY DEFINER avec EXECUTE PUBLIC effectif"
}

assert_app_exec() {
  local label="$1" fn="$2" app
  app="$(pg -tAc "
SELECT COALESCE(bool_and(has_function_privilege('tracefab_app', p.oid, 'EXECUTE')), false)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = '$fn';")"
  [[ "$app" == "t" ]] || fail "$label: tracefab_app sans EXECUTE sur $fn"
  echo "ok    $label: tracefab_app EXECUTE $fn"
}

row_of() {
  local fn="$1"
  pg -tAc "
SELECT p.proname || '|' || pg_get_function_identity_arguments(p.oid)
    || '|owner=' || r.rolname
    || '|secdef=' || p.prosecdef::text
    || '|cfg=' || COALESCE(array_to_string(p.proconfig, ','), '')
    || '|acl_null=' || (p.proacl IS NULL)::text
    || '|proacl=' || COALESCE(p.proacl::text, '')
    || '|public_exec=' || EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       )::text
    || '|app_exec=' || COALESCE(has_function_privilege('tracefab_app', p.oid, 'EXECUTE'), false)::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
 WHERE n.nspname = 'public' AND p.proname = '$fn'
 ORDER BY 1;"
}

emit_priority() {
  local label="$1" fn row
  echo
  echo "----- PRIORITE $label -----"
  for fn in "${PRIORITY[@]}"; do
    row="$(row_of "$fn")"
    if [[ -z "$row" ]]; then
      echo "::error title=$label::$fn ABSENTE"
      fail "$label: $fn absente"
    fi
    echo "$row"
    echo "::notice title=$label $fn::${row//$'\n'/ ; }"
  done
}

dump_catalog() {
  local label="$1" out="$2"
  local n_secdef n_public n_invoker_public
  echo
  echo "========== CATALOGUE $label =========="
  pg -c "\\pset footer off" -c "$CATALOG_SQL" | tee "$out"
  n_secdef="$(pg -tAc "
SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef;")"
  n_public="$(pg -tAc "
SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
   AND EXISTS (
     SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
   );")"
  n_invoker_public="$(pg -tAc "
SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f' AND NOT p.prosecdef
   AND p.proname LIKE 'tracefab_%'
   AND EXISTS (
     SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
   );")"
  echo "compte $label: secdef=$n_secdef secdef_public=$n_public invoker_tracefab_public=$n_invoker_public"
  echo "::notice title=$label comptes::secdef=$n_secdef secdef_public=$n_public invoker_tracefab_public=$n_invoker_public"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "## Catalogue $label"
      echo
      echo "- SECURITY DEFINER : $n_secdef"
      echo "- SECURITY DEFINER + EXECUTE PUBLIC effectif : $n_public"
      echo "- INVOKER tracefab_* + EXECUTE PUBLIC effectif : $n_invoker_public"
      echo
      echo '```'
      cat "$out"
      echo '```'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

negative_controls() {
  local label="$1"
  echo
  echo "----- CONTROLES NEGATIFS $label -----"
  pg -c "BEGIN;"
  pg -c "CREATE FUNCTION public.tracefab_audit_negatif() RETURNS int LANGUAGE sql SECURITY DEFINER AS \$\$ SELECT 1 \$\$;"
  pg -c "GRANT EXECUTE ON FUNCTION public.tracefab_audit_negatif() TO PUBLIC;"
  local vue
  vue="$(pg -tAc "
SELECT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tracefab_audit_negatif' AND p.prosecdef
     AND EXISTS (
       SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     )
);")"
  pg -c "ROLLBACK;"
  [[ "$vue" == "t" ]] || fail "$label: controle negatif GRANT PUBLIC non detecte"
  echo "ok    $label: GRANT PUBLIC exprès est vu par aclexplode+acldefault"
  local reste
  reste="$(pg -tAc "
SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'tracefab_audit_negatif';")"
  [[ "$reste" == "0" ]] || fail "$label: fonction negatif subsiste apres ROLLBACK"
  echo "ok    $label: ROLLBACK a efface la sonde"

  # Absence : une liste théorique ne doit pas passer.
  local ghost
  ghost="$(pg -tAc "
SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'tracefab_fonction_inexistante_audit';")"
  [[ "$ghost" == "0" ]] || fail "$label: fantôme inattendu"
  echo "ok    $label: fonction inexistante n est pas presente (garde anti-liste théorique)"
}

scenario_main() {
  echo
  echo "========== SCENARIO MAIN $SHA_MAIN =========="
  install_tree "$SHA_MAIN"
  reset_db
  prepare_role
  deploy
  dump_catalog "MAIN" /tmp/acl-main.txt
  local fn
  for fn in "${PRIORITY[@]}"; do assert_present "MAIN" "$fn"; done
  emit_priority "MAIN"
  assert_no_secdef_public "MAIN"
  for fn in "${RLS_APP[@]}"; do assert_app_exec "MAIN" "$fn"; done
  negative_controls "MAIN"
  # Passeport : #41 n'est pas sur main. On mesure, on ne force pas app_exec.
  local fn row
  echo "----- MAIN passeport app_exec (mesure, pas exigence de fusion #36) -----"
  for fn in "${PASSPORT_APP[@]}"; do
    row="$(row_of "$fn")"
    echo "$row"
    if [[ "$row" == *"app_exec=t"* ]]; then
      echo "ok    MAIN: $fn deja executable par tracefab_app"
    else
      echo "mesure MAIN: $fn app_exec=f (attendu tant que 1414 n est pas sur main)"
      echo "::notice title=MAIN $fn sans app::${row//$'\n'/ ; }"
    fi
  done
  echo "SCENARIO MAIN: PASS"
}

scenario_pr36() {
  echo
  echo "========== SCENARIO PR36 $SHA36 =========="
  install_tree "$SHA36"
  reset_db
  prepare_role
  deploy
  dump_catalog "PR36" /tmp/acl-pr36.txt
  local fn
  for fn in "${PRIORITY[@]}"; do assert_present "PR36" "$fn"; done
  emit_priority "PR36"
  assert_no_secdef_public "PR36"
  for fn in "${RLS_APP[@]}"; do assert_app_exec "PR36" "$fn"; done
  negative_controls "PR36"
  echo "----- PR36 passeport app_exec (mesure) -----"
  local row
  for fn in "${PASSPORT_APP[@]}"; do
    row="$(row_of "$fn")"
    echo "$row"
    if [[ "$row" == *"app_exec=t"* ]]; then
      echo "ok    PR36: $fn executable par tracefab_app"
    else
      echo "mesure PR36: $fn app_exec=f (1414 absente du produit #36)"
      echo "::notice title=PR36 $fn sans app::${row//$'\n'/ ; }"
    fi
  done
  echo "SCENARIO PR36: PASS"
}

scenario_combined() {
  echo
  echo "========== SCENARIO COMBINE 36+10120000+1412-1414 =========="
  install_tree "$SHA36"
  install_sql prisma/migrations/20261010120000_publication_explicite "$SHA34" \
    prisma/migrations/20261010120000_publication_explicite/migration.sql
  install_sql prisma/migrations/20261014120000_close_global_default_function_execute "$SHA41" \
    prisma/migrations/20261014120000_close_global_default_function_execute/migration.sql
  install_sql prisma/migrations/20261014130000_revoke_public_schema_privileges "$SHA41" \
    prisma/migrations/20261014130000_revoke_public_schema_privileges/migration.sql
  install_sql prisma/migrations/20261014140000_remove_public_supplier_passport_share_token "$SHA41" \
    prisma/migrations/20261014140000_remove_public_supplier_passport_share_token/migration.sql
  reset_db
  prepare_role
  deploy
  dump_catalog "COMBINE" /tmp/acl-combine.txt
  local fn
  for fn in "${PRIORITY[@]}"; do assert_present "COMBINE" "$fn"; done
  emit_priority "COMBINE"
  assert_no_secdef_public "COMBINE"
  for fn in "${RLS_APP[@]}" "${PASSPORT_APP[@]}"; do
    assert_app_exec "COMBINE" "$fn"
  done
  negative_controls "COMBINE"
  echo "SCENARIO COMBINE: PASS"
}

restore_head_tree() {
  install_tree HEAD
}

main() {
  preflight
  verif_pg17
  echo "SHA_MAIN=$SHA_MAIN"
  echo "SHA34=$SHA34"
  echo "SHA36=$SHA36"
  echo "SHA41=$SHA41"
  echo "HEAD=$(git rev-parse HEAD)"
  git cat-file -e "$SHA_MAIN:prisma/migrations/20261014100000_revoke_material_visible_public/migration.sql" \
    || fail "1410 absente de main"
  git cat-file -e "$SHA36:prisma/migrations/20261012120000_close_public_execute_gap/migration.sql" \
    || fail "1212 absente de #36"
  git cat-file -e "$SHA41:prisma/migrations/20261014140000_remove_public_supplier_passport_share_token/migration.sql" \
    || fail "1414 absente de #41"
  scenario_main
  scenario_pr36
  scenario_combined
  restore_head_tree
  echo
  echo "============================================"
  echo "AUDIT CATALOGUE : MAIN, PR36 et COMBINE ont tourne sur PG17 jetable."
  echo "============================================"
}

main "$@"
