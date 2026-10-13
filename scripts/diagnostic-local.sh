#!/bin/bash
# TRACEFAB — Script de diagnostic (à exécuter sur votre machine locale)
#
# Prérequis :
#   - curl installé
#   - Accès réseau à tracefab.vercel.app, api.vercel.com, console.neon.tech
#   - Token Vercel : export VERCEL_TOKEN="votre_token"
#   - Chaîne Neon  : export DATABASE_URL="postgresql://..." (lecture seule suffit)
#
# Usage :
#   chmod +x scripts/diagnostic-local.sh
#   ./scripts/diagnostic-local.sh 2>&1 | tee diagnostic-output.txt
#
# ⚠️  Ce script est en LECTURE SEULE. Il n'écrit rien sur Vercel, Neon ou GitHub.
# ⚠️  Ne partagez pas la sortie telle quelle : masquez les mots de passe et tokens.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

divider() { echo -e "\n${YELLOW}================================================================${NC}"; echo -e "${YELLOW}  $1${NC}"; echo -e "${YELLOW}================================================================${NC}\n"; }

# ---------------------------------------------------------------------------
# 0. Vérification des prérequis
# ---------------------------------------------------------------------------
divider "0. Vérification des prérequis"

if [ -z "${VERCEL_TOKEN:-}" ]; then
  echo -e "${RED}⚠  VERCEL_TOKEN non défini. Les sections Vercel seront ignorées.${NC}"
  echo "   Définissez-le avec : export VERCEL_TOKEN='votre_token'"
  VERCEL_AVAILABLE=false
else
  VERCEL_AVAILABLE=true
  echo -e "${GREEN}✓  VERCEL_TOKEN défini${NC}"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo -e "${RED}⚠  DATABASE_URL non défini. Les sections Neon seront ignorées.${NC}"
  echo "   Définissez-le avec : export DATABASE_URL='postgresql://...'"
  NEON_AVAILABLE=false
else
  NEON_AVAILABLE=true
  echo -e "${GREEN}✓  DATABASE_URL défini${NC}"
  # Masquer le mot de passe dans la sortie
  SAFE_URL=$(echo "$DATABASE_URL" | sed 's/:\/\/[^:]*:[^@]*@/:\/\/***:***@/')
  echo "   URL (masquée) : $SAFE_URL"
fi

# Détecter psql
if command -v psql &> /dev/null; then
  PSQL_AVAILABLE=true
  echo -e "${GREEN}✓  psql trouvé${NC}"
else
  PSQL_AVAILABLE=false
  echo -e "${RED}⚠  psql non trouvé. Les requêtes SQL directes seront ignorées.${NC}"
fi

# Détecter node
if command -v node &> /dev/null; then
  echo -e "${GREEN}✓  node $(node --version)${NC}"
else
  echo -e "${RED}⚠  node non trouvé${NC}"
fi

# ---------------------------------------------------------------------------
# 1. Test de production (toujours exécutable)
# ---------------------------------------------------------------------------
divider "1. Test de production — tracefab.vercel.app"

echo "--- GET /api/health ---"
curl -sS -i --max-time 15 https://tracefab.vercel.app/api/health 2>&1 || echo "ERREUR: connexion échouée"

echo ""
echo "--- GET /api/catalog/schemas ---"
curl -sS -i --max-time 15 https://tracefab.vercel.app/api/catalog/schemas 2>&1 || echo "ERREUR: connexion échouée"

echo ""
echo "--- GET /api/config ---"
curl -sS -i --max-time 15 https://tracefab.vercel.app/api/config 2>&1 || echo "ERREUR: connexion échouée"

# ---------------------------------------------------------------------------
# 2. Logs Vercel (si token disponible)
# ---------------------------------------------------------------------------
divider "2. Logs Vercel — recherche du correlationId"

CORRELATION_ID="c3696f22-41d0-4981-8d99-4e6a177021a3"

if [ "$VERCEL_AVAILABLE" = true ]; then
  echo "--- Derniers déploiements Production ---"
  curl -sS -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v6/deployments?projectId=prj_&teamId=&limit=5&target=production" \
    2>/dev/null | python3 -m json.tool 2>/dev/null || echo "Impossible de lister les déploiements"

  echo ""
  echo "--- Recherche du correlationId dans les logs ---"
  # Note: l'endpoint des logs peut varier selon la version de l'API Vercel
  echo "Le correlationId recherché : $CORRELATION_ID"
  echo "Si l'API ne permet pas la recherche directe, cherchez manuellement dans :"
  echo "  https://vercel.com/dashboard → tracefab → Logs → filtrer par '$CORRELATION_ID'"

  echo ""
  echo "--- Variables d'environnement (noms seulement) ---"
  curl -sS -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v9/projects/tracefab/env" \
    2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    envs = data.get('envs', [])
    for e in envs:
        key = e.get('key', '?')
        target = ', '.join(e.get('target', []))
        print(f'  {key} (target: {target})')
except:
    print('  Impossible de lire les variables')
" 2>/dev/null || echo "  Erreur de lecture"

else
  echo "VERCEL_TOKEN non disponible — section ignorée."
  echo "Pour obtenir les logs :"
  echo "  1. Allez sur https://vercel.com/dashboard"
  echo "  2. Sélectionnez le projet 'tracefab'"
  echo "  3. Ouvrez Logs → Runtime Logs"
  echo "  4. Recherchez '$CORRELATION_ID'"
fi

# ---------------------------------------------------------------------------
# 3. Base de données Neon (si DATABASE_URL disponible)
# ---------------------------------------------------------------------------
divider "3. Base de données Neon — état réel"

if [ "$NEON_AVAILABLE" = true ] && [ "$PSQL_AVAILABLE" = true ]; then
  echo "--- 3.1 Rôle de connexion et attributs ---"
  psql "$DATABASE_URL" -c "
    SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
           rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
    FROM pg_roles
    WHERE rolname IN (current_user, 'neondb_owner', 'tracefab_app', 'postgres')
    ORDER BY rolname;
  " 2>&1 || echo "ERREUR: requête rôles échouée"

  echo ""
  echo "--- 3.2 Rôle courant ---"
  psql "$DATABASE_URL" -c "SELECT current_user, session_user;" 2>&1 || echo "ERREUR"

  echo ""
  echo "--- 3.3 Migrations appliquées (si table Prisma) ---"
  psql "$DATABASE_URL" -c "
    SELECT migration_name, started_at, finished_at, applied_steps_count
    FROM _prisma_migrations
    ORDER BY started_at DESC
    LIMIT 10;
  " 2>&1 || echo "  Table _prisma_migrations non trouvée ou erreur"

  echo ""
  echo "--- 3.4 Statut RLS ---"
  psql "$DATABASE_URL" -c "
    SELECT schemaname, tablename, rowsecurity, forcerowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename;
  " 2>&1 || echo "ERREUR"

  echo ""
  echo "--- 3.5 Fonctions SECURITY DEFINER ---"
  psql "$DATABASE_URL" -c "
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           p.prosecdef, p.provolatile,
           pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
    ORDER BY p.proname
    LIMIT 30;
  " 2>&1 || echo "ERREUR"

  echo ""
  echo "--- 3.6 Privilèges EXECUTE sur les 5 fonctions signalées ---"
  psql "$DATABASE_URL" -c "
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           (aclexplode(p.proacl)).grantee::regrole AS grantee,
           (aclexplode(p.proacl)).privilege_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'tracefab_material_is_public',
        'tracefab_material_visible_via_product',
        'tracefab_product_is_public',
        'tracefab_public_brand',
        'tracefab_supplier_site_is_public'
      )
    ORDER BY p.proname, grantee;
  " 2>&1 || echo "ERREUR"

  echo ""
  echo "--- 3.7 Nombre de tables et politiques ---"
  psql "$DATABASE_URL" -c "
    SELECT
      (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') AS tables,
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS policies;
  " 2>&1 || echo "ERREUR"

  echo ""
  echo "--- 3.8 Compteurs de rate limiting ---"
  psql "$DATABASE_URL" -c "
    SELECT count(*) AS active_counters FROM rate_limit_counters
    WHERE window_start > now() - interval '1 hour';
  " 2>&1 || echo "  Table rate_limit_counters non trouvée ou erreur"

else
  if [ "$NEON_AVAILABLE" = false ]; then
    echo "DATABASE_URL non disponible — section ignorée."
  else
    echo "psql non trouvé — section ignorée."
  fi
  echo ""
  echo "Pour exécuter ces requêtes manuellement :"
  echo "  1. Connectez-vous à https://console.neon.tech"
  echo "  2. Sélectionnez votre projet → SQL Editor"
  echo "  3. Exécutez les requêtes ci-dessus une par une"
fi

# ---------------------------------------------------------------------------
# 4. Vérification locale du dépôt (toujours exécutable)
# ---------------------------------------------------------------------------
divider "4. État du dépôt Git"

echo "--- Branche et commit ---"
git log --oneline -3 2>/dev/null || echo "Pas un dépôt Git"

echo ""
echo "--- Branches distantes ---"
git branch -r 2>/dev/null | head -20 || echo "Pas de branches distantes"

echo ""
echo "--- PR ouvertes ---"
if command -v gh &> /dev/null; then
  gh pr list --state open --limit 10 2>/dev/null || echo "gh non configuré"
else
  echo "gh non trouvé"
fi

echo ""
echo "--- Workflows ---"
if command -v gh &> /dev/null; then
  gh api repos/Huberaya/Tracefab/actions/workflows --jq '.workflows[]|{name, state}' 2>/dev/null || echo "API GitHub inaccessible"
fi

# ---------------------------------------------------------------------------
# 5. Tests statiques locaux (si node disponible)
# ---------------------------------------------------------------------------
divider "5. Tests statiques locaux"

if command -v node &> /dev/null; then
  SCRIPTS=(
    "scripts/test_route_registry.mjs"
    "scripts/test_cross_tenant.mjs"
    "scripts/test_asset_versions.mjs"
    "scripts/test_security_chantier1.mjs"
    "scripts/test_private_storage.mjs"
  )

  for script in "${SCRIPTS[@]}"; do
    if [ -f "$script" ]; then
      echo "--- $script ---"
      node "$script" 2>&1 | tail -5
      echo ""
    fi
  done

  if [ -f "scripts/test_production_readiness.ts" ]; then
    echo "--- test_production_readiness.ts ---"
    npx tsx scripts/test_production_readiness.ts 2>&1 | tail -5
  fi
else
  echo "node non trouvé — tests ignorés."
fi

# ---------------------------------------------------------------------------
# 6. Résumé
# ---------------------------------------------------------------------------
divider "6. RÉSUMÉ"

echo "Sections exécutées :"
echo "  [✓] Test production (curl)"
[ "$VERCEL_AVAILABLE" = true ] && echo "  [✓] Logs Vercel" || echo "  [✗] Logs Vercel (token manquant)"
[ "$NEON_AVAILABLE" = true ] && echo "  [✓] Base Neon" || echo "  [✗] Base Neon (DATABASE_URL manquant)"
echo "  [✓] État Git"
echo "  [✓] Tests statiques"
echo ""
echo "Copiez la sortie complète et transmettez-la à l'agent Arena pour analyse."
echo "Masquez les mots de passe et tokens avant de partager."
echo ""
echo "Fin du diagnostic."