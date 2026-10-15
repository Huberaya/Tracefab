#!/bin/sh
# Saisie masquee du jeton, puis diagnostic en lecture seule.
#
# Pourquoi ce lanceur existe : si le jeton est ecrit dans la ligne de commande,
# il entre dans l historique du shell et dans la sortie de `ps`. Ce lanceur le
# lit sans echo, le passe uniquement par l environnement du processus fils, et
# ne l affiche jamais. Il ne l ecrit dans aucun fichier.
#
# Usage :   sh scripts/diagnose_production_incident.sh
# Variable utile :  TF_DEPLOYMENT_ID (defaut 6968252029)
set -eu

ici=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${VERCEL_TOKEN:-}" ]; then
  jeton=$VERCEL_TOKEN
else
  printf 'Jeton Vercel (la saisie ne s affiche pas) : '
  if [ -t 0 ]; then
    ancien=$(stty -g 2>/dev/null || true)
    stty -echo 2>/dev/null || true
    IFS= read -r jeton || true
    [ -n "${ancien:-}" ] && stty "$ancien" 2>/dev/null || stty echo 2>/dev/null || true
  else
    IFS= read -r jeton || true
  fi
  printf '\n'
fi

if [ -z "${jeton:-}" ]; then
  echo "  ARRET — aucun jeton fourni." >&2
  exit 2
fi

case "$jeton" in
  *'<'*|*"remplacer"*|*"votre_jeton"*|*"xxx"*)
    echo "  ARRET — la valeur saisie ressemble a un texte de remplacement, pas a un jeton." >&2
    exit 2
    ;;
esac

VERCEL_TOKEN=$jeton
export VERCEL_TOKEN
unset jeton

exec node "$ici/diagnose_production_incident.mjs"
