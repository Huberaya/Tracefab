#!/usr/bin/env bash
# ============================================================================
# P10.8 — Demarre un PostgreSQL 17.11 REEL jetable pour les harnais P10.8.
#
# Pourquoi : PGlite local est PostgreSQL 18.6, et les preuves exigent 17.11
# exactement (CI : service `postgres:17`, image Debian 17.11-1.pgdg13+2).
# Ce lanceur recupere le binaire 17.11 publie sur npm (hote autorise
# registry.npmjs.org), l'hydrate, puis cree/ demarre un cluster dans /tmp.
#
# AUCUNE base distante. Aucun secret. Aucun acces a Production/Preproduction.
# /tmp n'est pas persiste : relancer ce script apres chaque redemarrage du bac
# a sable, puis `npm run p108:chaines` et `npm run p108:outbox`.
#
# Usage : bash scripts/p108_pg17_demarrer.sh [start|stop|status]
# ============================================================================
set -euo pipefail

VERSION="17.11.0-beta.19"
DIR="${TF_P108_PG_DIR:-/tmp/p108_pg}"
PORT="${TF_P108_PG_PORT:-55432}"
NATIVE="$DIR/ep/package/native"
DATA="$DIR/data"
SOCK="$DIR/sock"
export LD_LIBRARY_PATH="$NATIVE/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
[ -d /tmp/al2023/lib ] && export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:/tmp/al2023/lib"

preparer() {
  mkdir -p "$DIR" "$SOCK"
  if [ ! -x "$NATIVE/bin/postgres" ]; then
    echo "P10.8 : telechargement de @embedded-postgres/linux-x64@$VERSION ..."
    (cd "$DIR" && npm pack "@embedded-postgres/linux-x64@$VERSION" --silent >/dev/null)
    mkdir -p "$DIR/ep"
    tar -xzf "$DIR/embedded-postgres-linux-x64-$VERSION.tgz" -C "$DIR/ep"
    (cd "$DIR/ep/package" && node scripts/hydrate-symlinks.js)
  fi
  "$NATIVE/bin/postgres" --version | grep -q "17.11" || {
    echo "P10.8 : version PostgreSQL inattendue" >&2; "$NATIVE/bin/postgres" --version; exit 1;
  }
  echo "P10.8 : $($NATIVE/bin/postgres --version)"
}

demarrer() {
  preparer
  if "$NATIVE/bin/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
    echo "P10.8 : cluster deja demarre sur le port $PORT."
  else
    if [ ! -f "$DATA/PG_VERSION" ]; then
      "$NATIVE/bin/initdb" -D "$DATA" -U postgres --auth=trust --no-instructions \
        > "$DIR/initdb.log" 2>&1
    fi
    "$NATIVE/bin/pg_ctl" -D "$DATA" -l "$DIR/pg.log" -w \
      -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1" start > "$DIR/start.log" 2>&1
  fi
  node -e "
    const {Client}=require('pg');
    (async()=>{const c=new Client({host:'127.0.0.1',port:$PORT,user:'postgres',database:'postgres'});
      await c.connect();
      const v=(await c.query('select version() v')).rows[0].v;
      await c.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await c.query('CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"');
      console.log('P10.8 : '+v);
      await c.end();})().catch(e=>{console.error(e.message);process.exit(1)})"
}

case "${1:-start}" in
  start)  demarrer ;;
  stop)   "$NATIVE/bin/pg_ctl" -D "$DATA" -m fast -w stop || true ;;
  status) "$NATIVE/bin/pg_ctl" -D "$DATA" status || true ;;
  *) echo "usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac
