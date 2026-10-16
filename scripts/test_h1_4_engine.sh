#!/usr/bin/env bash
# TRACEFAB H1.4 — épreuves moteur PostgreSQL jetable (PG17 et PG18).
#
# Neon de production exécute PostgreSQL 18.6. Le diagnostic Q1–Q6 doit
# être validé sur les DEUX versions majeures :
#   - PG17 : version précédente (baseline de compatibilité)
#   - PG18 : version cible de production (p. ex. incident P3018
#            p_org → p_organization_id était spécifique à PG18).
#
# Ne lit pas DATABASE_URL (il doit être absent). N'imprime aucun secret.
# N'appelle ni prepare_ci_db_role.mjs ni db:deploy:throwaway.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL="${ROOT}/docs/security/h1-4-diagnostic-lecture-seule.sql"
WRAP="${ROOT}/scripts/run_h1_4_diagnostic_readonly.sh"
cd "$ROOT"

refuse() { echo "REFUS: $1" >&2; echo "Aucune connexion moteur utile." >&2; exit 2; }
fail() { echo "ECHEC: $1" >&2; exit 1; }

hote_local() {
  case "$1" in
    localhost|127.0.0.1|::1|'[::1]') return 0 ;;
    /*) return 0 ;;
  esac
  return 1
}

preflight_env() {
  [[ -f "$SQL" ]] || fail "artefact SQL absent du checkout"
  [[ -f "$WRAP" ]] || fail "wrapper absent du checkout"
  [[ "${TRACEFAB_H1_4_MODE:-}" == "jetable" ]] || refuse "MODE=jetable requis"
  [[ "${TRACEFAB_H1_4_CIBLE:-}" == "locale" ]] || refuse "CIBLE=locale requis"
  [[ "${TRACEFAB_H1_4_CONFIRM_READONLY:-}" == "oui" ]] || refuse "CONFIRM_READONLY=oui requis"
  [[ "${PGDATABASE:-}" == "tracefab_test" ]] || refuse "PGDATABASE=tracefab_test requis"
  if [[ -n "${DATABASE_URL:-}" || -n "${DIRECT_URL:-}" ]]; then
    refuse "DATABASE_URL/DIRECT_URL ne doivent pas etre poses (libpq seulement)"
  fi
  if [[ -n "${PGSERVICE:-}" || -n "${PGSERVICEFILE:-}" || -n "${PGSYSCONFDIR:-}" ]]; then
    refuse "PGSERVICE/PGSERVICEFILE/PGSYSCONFDIR interdits"
  fi
  if [[ -n "${PGOPTIONS:-}" ]] && grep -qiE '(^|[[:space:]])host=|[[:space:]]-h[[:space:]]' <<<"${PGOPTIONS}"; then
    refuse "PGOPTIONS redirige l'hote"
  fi
  if [[ -z "${PGHOST:-}" ]]; then
    refuse "PGHOST local explicite requis"
  fi
  if ! hote_local "${PGHOST}"; then
    refuse "PGHOST non local"
  fi
  if [[ -n "${PGHOSTADDR:-}" ]] && ! hote_local "${PGHOSTADDR}"; then
    refuse "PGHOSTADDR non local"
  fi
  local ve ne
  ve="${VERCEL_ENV:-}"; ne="${NODE_ENV:-}"
  ve="${ve,,}"; ne="${ne,,}"
  if [[ "$ve" == "production" || "$ne" == "production" ]]; then
    refuse "contexte production"
  fi
  echo "preflight: env jetable, base tracefab_test, hote local, aucune connexion encore."
}

if [[ "${1:-}" == "--preflight" ]]; then
  preflight_env
  exit 0
fi

preflight_env

command -v psql >/dev/null 2>&1 || {
  echo "NOT RUN: psql absent. Ce n'est pas un succes." >&2
  exit 2
}

PSQL=(psql -X --no-password -v ON_ERROR_STOP=1)

ver="$("${PSQL[@]}" -tAc "SHOW server_version")"
pg_maj="${ver%%.*}"
# Version attendue : TRACEFAB_H14_PGVER peut forcer 17 ou 18 (utilisé par la CI
# pour lancer les mêmes épreuves contre chaque version majeure). Sans cette
# variable, PG17 et PG18 sont tous deux acceptés (validation locale).
attendu="${TRACEFAB_H14_PGVER:-}"
if [[ -n "$attendu" ]]; then
  [[ "$pg_maj" == "$attendu" ]] || fail "PostgreSQL $attendu attendu par TRACEFAB_H14_PGVER, obtenu $ver"
else
  case "$pg_maj" in
    17|18) ;;
    *) fail "PostgreSQL 17 ou 18 requis (obtenu $ver)";;
  esac
fi
db="$("${PSQL[@]}" -tAc "SELECT current_database()")"
[[ "$db" == "tracefab_test" ]] || fail "current_database n'est pas tracefab_test"
echo "ok    serveur $pg_maj ($ver), base tracefab_test"

set +e
write_out="$("${PSQL[@]}" \
  -c "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;" \
  -c "BEGIN READ ONLY;" \
  -c "CREATE TABLE h14_probe_write(x int);" 2>&1)"
write_st=$?
set -e
if [[ $write_st -eq 0 ]]; then
  fail "CREATE TABLE a reussi en READ ONLY"
fi
if ! grep -qiE 'read-only transaction|25006' <<<"$write_out"; then
  fail "refus d'ecriture sans 25006/read-only (detail non affiche)"
fi
echo "ok    CREATE TABLE refuse en READ ONLY (25006)"

extract_block() {
  python3 - "$SQL" "$1" <<'PY'
import sys
from pathlib import Path
sql = Path(sys.argv[1]).read_text()
ident = sys.argv[2]
start, end = f"-- >>>H14:{ident}", f"-- <<<H14:{ident}"

def idx(hay, needle):
    from_ = 0
    while True:
        i = hay.find(needle, from_)
        if i < 0:
            return -1
        after = hay[i + len(needle): i + len(needle) + 1]
        if after == "" or after in "\r\n ":
            return i
        from_ = i + len(needle)

i, j = idx(sql, start), idx(sql, end)
if i < 0 or j <= i:
    raise SystemExit(f"bloc {ident} introuvable")
print(sql[i + len(start):j], end="")
PY
}

run_block() {
  local id="$1" out st
  set +e
  out="$(extract_block "$id" | "${PSQL[@]}" -tA -F $'\t' -f -)"
  st=$?
  set -e
  [[ $st -eq 0 ]] || fail "$id: psql exit $st"
  printf '%s\n' "$out"
}

count_lines() {
  local s="$1"
  if [[ -z "$s" ]]; then
    echo 0
    return
  fi
  printf '%s\n' "$s" | grep -c .
}

q1="$(run_block Q1)"
n1="$(count_lines "$q1")"
[[ "$n1" -eq 1 ]] || fail "Q1: $n1 ligne(s), attendu 1"
echo "ok    Q1 : 1 ligne"

q2="$(run_block Q2)"
n2="$(count_lines "$q2")"
[[ "$n2" -eq 6 ]] || fail "Q2: $n2 ligne(s), attendu 6"
echo "ok    Q2 : 6 lignes"

q3="$(run_block Q3)"
n3="$(count_lines "$q3")"
[[ "$n3" -eq 6 ]] || fail "Q3: $n3 ligne(s), attendu 6"
echo "ok    Q3 : 6 lignes"

q4="$(run_block Q4)"
n4="$(count_lines "$q4")"
[[ "$n4" -ge 1 ]] || fail "Q4: 0 ligne (synthese manquante)"
echo "ok    Q4 : $n4 ligne(s) (>=1)"

q5c="$(run_block Q5C)"
n5c="$(count_lines "$q5c")"
[[ "$n5c" -eq 1 ]] || fail "Q5.C: $n5c ligne(s), attendu 1"
echo "ok    Q5.C : 1 ligne"

q6="$(run_block Q6)"
n6="$(count_lines "$q6")"
[[ "$n6" -eq 4 ]] || fail "Q6: $n6 ligne(s), attendu 4"
echo "ok    Q6 : 4 lignes"

etat="$("${PSQL[@]}" -tAc "SELECT CASE
  WHEN to_regclass('public._prisma_migrations') IS NULL THEN 'objet_absent'
  WHEN has_table_privilege('public._prisma_migrations', 'SELECT') THEN 'lecture_ok'
  ELSE 'refus_privilege' END")"
[[ "$etat" == "objet_absent" ]] || fail "catalogue initial: attendu objet_absent (table preexistante : refus d'ecrasement)"

set +e
diag_out="$(bash "$WRAP" 2>&1)"
diag_st=$?
set -e
[[ $diag_st -eq 0 ]] || fail "wrapper exit $diag_st alors que le catalogue est lisible (table absente)"
grep -q "Q5.A NON EXECUTE" <<<"$diag_out" || fail "porte Q5.A : pas de NON EXECUTE (table absente)"
echo "ok    porte Q5.A refusee (objet_absent, \\if psql)"

created_probe=0
cleanup() {
  if [[ "$created_probe" -eq 1 ]]; then
    "${PSQL[@]}" -c "DROP TABLE IF EXISTS public._prisma_migrations;" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

exists="$("${PSQL[@]}" -tAc "SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN 0 ELSE 1 END")"
[[ "$exists" == "0" ]] || fail "public._prisma_migrations preexiste : ne pas ecraser"
"${PSQL[@]}" -c "CREATE TABLE public._prisma_migrations (
  id text,
  checksum text,
  finished_at timestamptz,
  applied_steps_count integer,
  rolled_back_at timestamptz,
  started_at timestamptz,
  migration_name text
);" >/dev/null
created_probe=1

set +e
diag2="$(bash "$WRAP" 2>&1)"
diag2_st=$?
set -e
[[ $diag2_st -eq 0 ]] || fail "wrapper exit $diag2_st alors que lecture_ok"
grep -q "Q5.A NON EXECUTE" <<<"$diag2" && fail "porte Q5.A encore fermee alors que lecture_ok"

q5a="$(run_block Q5A)"
n5a="$(count_lines "$q5a")"
[[ "$n5a" -eq 5 ]] || fail "Q5.A table vide : $n5a ligne(s), attendu 5"
n_abs="$(awk -F $'\t' '$NF=="absente"{c++} END{print c+0}' <<<"$q5a")"
[[ "$n_abs" -eq 5 ]] || fail "Q5.A table vide : $n_abs absente, attendu 5"
echo "ok    Q5.A : 5 absente sur table vide (lecture_ok, \\if ouverte)"

q5b="$(run_block Q5B)"
n5b="$(count_lines "$q5b")"
[[ "$n5b" -eq 0 ]] || fail "Q5.B table vide : $n5b ligne(s), attendu 0"
echo "ok    Q5.B : 0 ligne sur table vide"

"${PSQL[@]}" -c "INSERT INTO public._prisma_migrations
  (id, checksum, finished_at, applied_steps_count, rolled_back_at, started_at, migration_name)
  VALUES
  ('a','x', now(), 1, NULL, now(), '20261010120000_publication_explicite'),
  ('b','y', now(), 1, NULL, now(), '20261010120000_publication_explicite');" >/dev/null
q5a2="$(run_block Q5A)"
awk -F $'\t' '$1=="20261010120000_publication_explicite" && $NF=="incomplete"{found=1} END{exit found?0:1}' <<<"$q5a2" \
  || fail "Q5.A doublon : incomplete attendu"
echo "ok    Q5.A : doublon classe incomplete"

echo "PASS moteur H1.4 (Postgres $pg_maj, tracefab_test, lecture seule)."
exit 0
