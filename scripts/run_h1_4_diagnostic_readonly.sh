#!/usr/bin/env bash
# TRACEFAB H1.4 — wrapper lecture seule, mode jetable uniquement.
#
# CE SCRIPT NE SE CONNECTE JAMAIS A NEON / LA PRODUCTION.
# Mode neon-manuel : refuse d'ouvrir une connexion ; l'operateur colle
# les blocs >>>H14:Qn dans l'editeur (voir MODE-OPERATOIRE).
#
# DATABASE_URL n'est pas lu (sinon argv / ps(1)). Aucune URL en argument.
# Aucun secret n'est imprime.
#
# ON_ERROR_STOP=1 : si une instruction du -f echoue, psql quitte AVANT
# le dernier -c ROLLBACK. La transaction ouverte est avortee a la
# deconnexion (ROLLBACK implicite). Ce n'est PAS le ROLLBACK explicite.
#
# SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY et
# default_transaction_read_only=on : defaut des transactions suivantes.
# Un superutilisateur ou un SET TRANSACTION READ WRITE dans le SQL
# (aujourd'hui absent) peut les outrepasser. BEGIN READ ONLY porte sur
# CETTE transaction seulement. Ce ne sont pas des barrieres inviolables.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL="${ROOT}/docs/security/h1-4-diagnostic-lecture-seule.sql"

refuse() {
  echo "REFUS: $1" >&2
  echo "Aucune connexion n'a ete ouverte." >&2
  exit 2
}

# Hote local reconnu — comparaison exacte, sans afficher la valeur.
hote_local() {
  case "$1" in
    localhost|127.0.0.1|::1|'[::1]') return 0 ;;
    /*) return 0 ;;
  esac
  return 1
}

hote_neon() {
  local h="${1,,}"
  case "$h" in
    *neon.tech|*neon.build|neon.tech|neon.build) return 0 ;;
  esac
  return 1
}

verifier_cible_jetable() {
  local ve ne
  ve="${VERCEL_ENV:-}"
  ne="${NODE_ENV:-}"
  ve="${ve,,}"
  ne="${ne,,}"
  if [[ "$ve" == "production" || "$ne" == "production" ]]; then
    refuse "contexte de production (VERCEL_ENV/NODE_ENV). Mode jetable refuse."
  fi
  if [[ -n "${DATABASE_URL:-}" || -n "${DIRECT_URL:-}" ]]; then
    refuse "DATABASE_URL/DIRECT_URL ne doivent pas etre poses (libpq seulement, jamais un secret)."
  fi
  if [[ -z "${PGHOST:-}" ]]; then
    refuse "PGHOST local explicite requis (pas de socket implicite)."
  fi
  if [[ -n "${PGSERVICE:-}" || -n "${PGSERVICEFILE:-}" || -n "${PGSYSCONFDIR:-}" ]]; then
    refuse "cible ambigue (PGSERVICE/PGSERVICEFILE/PGSYSCONFDIR). Mode jetable exige un hote local explicite."
  fi
  if [[ -n "${PGOPTIONS:-}" ]] && grep -qiE '(^|[[:space:]])host=|[[:space:]]-h[[:space:]]' <<<"${PGOPTIONS}"; then
    refuse "cible ambigue (PGOPTIONS redirige l'hote). Mode jetable refuse."
  fi
  if [[ -n "${PGHOSTADDR:-}" ]]; then
    if hote_neon "${PGHOSTADDR}"; then
      refuse "hote Neon refuse (PGHOSTADDR). Mode jetable seulement."
    fi
    if ! hote_local "${PGHOSTADDR}"; then
      refuse "cible non locale (PGHOSTADDR). Mode jetable seulement."
    fi
  fi
  if [[ -n "${PGHOST:-}" ]]; then
    if hote_neon "${PGHOST}"; then
      refuse "hote Neon refuse (PGHOST). Mode jetable seulement."
    fi
    if ! hote_local "${PGHOST}"; then
      refuse "cible non locale (PGHOST). Mode jetable seulement."
    fi
  fi
  if [[ "${PGDATABASE:-}" != "tracefab_test" ]]; then
    refuse "nom de base non autorise (attendu tracefab_test). Mode jetable refuse."
  fi
  if [[ "${TRACEFAB_H1_4_CIBLE:-}" != "locale" ]]; then
    refuse "exporter TRACEFAB_H1_4_CIBLE=locale (cible de test reconnue, refus par defaut)."
  fi
}

usage() {
  cat <<'EOF'
Usage: bash scripts/run_h1_4_diagnostic_readonly.sh [--self-check|--help]

Modes (TRACEFAB_H1_4_MODE), refus par defaut :

  jetable       PostgreSQL local uniquement (PGHOST localhost/127.0.0.1/::1
                ou socket Unix). Exige aussi :
                  TRACEFAB_H1_4_CONFIRM_READONLY=oui
                  TRACEFAB_H1_4_CIBLE=locale
                  PGDATABASE=tracefab_test
                Refuse PGSERVICE, PGHOSTADDR non local, PGOPTIONS host=,
                hote Neon, NODE_ENV/VERCEL_ENV=production.

  neon-manuel   Aucune connexion. Affiche la procedure editeur et sort 2.

Ne pas passer d'URL. Ne pas utiliser --single-transaction.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      usage
      exit 0
      ;;
    --self-check)
      if [[ ! -f "$SQL" ]]; then
        echo "ECHEC: artefact SQL introuvable" >&2
        exit 1
      fi
      if ! grep -q '>>>H14:Q1' "$SQL" \
        || ! grep -q '>>>H14:Q2' "$SQL" \
        || ! grep -q '>>>H14:Q3' "$SQL" \
        || ! grep -q '>>>H14:Q4' "$SQL" \
        || ! grep -q '>>>H14:Q5A' "$SQL" \
        || ! grep -q '>>>H14:Q5B' "$SQL" \
        || ! grep -q '>>>H14:Q5C' "$SQL" \
        || ! grep -q '>>>H14:Q6' "$SQL"; then
        echo "ECHEC: marqueurs Q1–Q6 manquants" >&2
        exit 1
      fi
      echo "self-check: artefact present, marqueurs Q1–Q6 ok, aucune connexion."
      exit 0
      ;;
    postgres://*|postgresql://*|*"@"*|*"neon.tech"*|*"DATABASE_URL"*)
      refuse "ne pas passer de chaine de connexion ni d'option inconnue."
      ;;
    *)
      refuse "ne pas passer de chaine de connexion ni d'option inconnue."
      ;;
  esac
done

MODE="${TRACEFAB_H1_4_MODE:-}"
case "$MODE" in
  neon-manuel)
    cat <<'EOF' >&2
NON EXECUTE: mode neon-manuel — le wrapper n'ouvre aucune connexion.

Coller dans l'editeur SQL Neon UNIQUEMENT les blocs entre
  -- >>>H14:Qn  et  -- <<<H14:Qn
\gset et \if sont des commandes psql, pas du SQL serveur : ne pas les coller.
Chaque collage est une session separee, pas une transaction unique.
Q5.A / Q5.B seulement si Q1.prisma_migrations_etat = lecture_ok.
Si objet_absent, refus_privilege ou erreur catalogue : ne pas coller Q5.A/B
et ne pas conclure a cinq migrations absentes.
Ne pas communiquer d'URL ni de mot de passe.
EOF
    exit 2
    ;;
  jetable)
    ;;
  *)
    refuse "exporter TRACEFAB_H1_4_MODE=jetable (validation locale) ou neon-manuel (editeur, sans connexion)."
    ;;
esac

if [[ "${TRACEFAB_H1_4_CONFIRM_READONLY:-}" != "oui" ]]; then
  refuse "exporter TRACEFAB_H1_4_CONFIRM_READONLY=oui"
fi

verifier_cible_jetable

if ! command -v psql >/dev/null 2>&1; then
  echo "NON EXECUTE: psql absent." >&2
  echo "Le parseur PostgreSQL n'a pas tourne. Ce n'est pas un succes." >&2
  exit 2
fi

# -X : ignorer .psqlrc (pourrait \connect ou ecrire).
# --no-password : pas de prompt interactif.
# Pas de --single-transaction : son BEGIN externe n'est pas READ ONLY.
exec psql \
  -X \
  --no-password \
  -v ON_ERROR_STOP=1 \
  -c "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;" \
  -c "SET default_transaction_read_only = on;" \
  -c "BEGIN READ ONLY;" \
  -f "$SQL" \
  -c "ROLLBACK;"
