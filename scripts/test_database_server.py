#!/usr/bin/env python
"""
Serveur PostgreSQL de test, maintenu vivant le temps d'une suite de tests.

POURQUOI UN SCRIPT PYTHON
  `embedded-postgres` est distribué sur PyPI, pas sur npm. `test_migrations.mjs`
  l'utilise déjà ; ce script reprend exactement le même socle (même venv, même
  shim pgcrypto) pour que les tests d'intégration parlent à un PostgreSQL réel
  plutôt qu'à une simulation.

CE QUI DIFFÈRE DE test_migrations
  1. LA CONNEXION PASSE PAR LE SOCKET UNIX, PAS PAR TCP.
     `embedded_postgres` démarre postgres avec `-o '-h ""'`, c'est-à-dire
     « n'écoute sur aucune adresse IP » — le commentaire de la librairie est
     explicite. Une option de ligne de commande écrase `listen_addresses` dans
     postgresql.conf : écrire cette directive ne change rien, et c'est un piège
     qui coûte un cycle complet de démarrage à découvrir.

     Le pilote `pg` de Node sait parler à un socket : il suffit que `host` soit le
     RÉPERTOIRE contenant `.s.PGSQL.<port>`. D'où l'URI
     `postgresql://postgres@localhost:<port>/<base>?host=<répertoire>`.

     Le socket et le port ne sont pas devinés : ils sont demandés au serveur
     (`SHOW unix_socket_directories`, `SHOW port`), parce que la librairie peut
     choisir un répertoire différent de pgdata si le chemin dépasse la longueur
     maximale d'un socket de domaine.
  2. LE PROCESSUS RESTE VIVANT.
     `PostgresServer` arrête le serveur quand l'objet est libéré, donc dès que le
     processus Python se termine. Ce script imprime l'URI puis attend la fermeture
     de stdin : c'est le parent Node qui décide de la durée de vie en fermant le
     descripteur.

CONTRAT AVEC LE PARENT
  stdout : une ligne `TRACEFAB_TEST_DB_URI=postgresql://...` quand la base est
           prête et migrée. Toute autre ligne est du journal.
  échec  : `POSTGRES_SERVER_UNAVAILABLE: <raison>` puis code de sortie 1. Le
           parent doit alors se déclarer indisponible, jamais réussir.
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import time

os.environ.setdefault("XDG_RUNTIME_DIR", "/tmp/runtime-tracefab-test-pg")
pathlib.Path(os.environ["XDG_RUNTIME_DIR"]).mkdir(parents=True, exist_ok=True)
os.chmod(os.environ["XDG_RUNTIME_DIR"], 0o700)

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "prisma" / "migrations"
PGDATA = pathlib.Path(os.environ.get("TRACEFAB_PGDATA", "/tmp/tracefab-test-pgdata"))
# Port découvert APRÈS le démarrage, sur le fichier socket réellement créé.
# Une valeur par défaut ici serait utilisée par la première sonde — donc avant
# toute découverte — et produirait un ENOENT sur `.s.PGSQL.<mauvais port>`.
PGPORT = os.environ.get("TRACEFAB_PGPORT", "")
DB = os.environ.get("TRACEFAB_TEST_DB", "tracefab_test")


def log(message: str) -> None:
    print(message, flush=True)


def unavailable(reason: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"POSTGRES_SERVER_UNAVAILABLE: {reason}", flush=True)
    sys.exit(1)


try:
    from embedded_postgres import PostgresServer  # type: ignore
except ImportError:
    unavailable("embedded-postgres non installé dans le venv")

server = PostgresServer(PGDATA)
try:
    server.ensure_pgdata_inited()
except Exception as exc:  # noqa: BLE001
    unavailable(f"initdb a échoué : {exc}")

PGINSTALL = pathlib.Path(PostgresServer.__init__.__globals__["__file__"]).parent / "pginstall"
PSQL = PGINSTALL / "bin" / "psql"

# --- Libérer le répertoire de données avant de démarrer --------------------
"""
Indispensable, et pas une précaution théorique.

Chaque test démarre son propre serveur sur le MÊME TRACEFAB_PGDATA. Quand un test
se termine, Node sort et Python arrête PostgreSQL — mais cet arrêt prend
plusieurs secondes. Dans la suite complète, le test suivant démarre pendant ce
créneau et `ensure_postgres_running()` trouve un postmaster encore vivant sur le
même répertoire.

C'est l'instabilité mesurée : `test:neon:bulk:chantier8` échouait dans la suite
et passait toujours seul. Un test dont le résultat dépend de la vitesse de la
machine n'est pas un test vert.

Attendre n'est PAS le bon remède : un serveur orphelin — laissé par un run tué
par `timeout`, ce qui arrive — ne s'arrêterait jamais, et chaque test perdrait
alors 120 s avant de se déclarer indisponible. Ce répertoire appartient à la
suite de test : s'il est occupé, on arrête l'occupant et on démarre.
"""


def _pgdata_owner() -> int | None:
    """PID du postmaster qui occupe TRACEFAB_PGDATA, ou None."""
    pid_file = PGDATA / "postmaster.pid"
    if not pid_file.exists():
        return None
    try:
        pid = int(pid_file.read_text().split("\n", 1)[0].strip())
    except (ValueError, OSError):
        return None
    if pid <= 0:
        return None
    try:
        os.kill(pid, 0)          # ne signale rien : teste seulement l'existence
    except ProcessLookupError:
        return None
    except PermissionError:
        return pid
    return pid


if _pgdata_owner() is not None:
    from embedded_postgres._commands import pg_ctl  # type: ignore

    print(
        "TRACEFAB_PGDATA occupé par le postmaster %d — arrêt avant démarrage"
        % _pgdata_owner(),
        flush=True,
    )
    try:
        pg_ctl(["-w", "stop"], pgdata=PGDATA, user=None, timeout=60)
    except Exception as exc:  # noqa: BLE001
        print("arrêt du postmaster existant en échec : %s" % exc, flush=True)

    _deadline = time.time() + 60
    while _pgdata_owner() is not None and time.time() < _deadline:
        time.sleep(0.5)
    if _pgdata_owner() is not None:
        unavailable("le postmaster existant refuse de s'arrêter")

# --- Écoute TCP, écrite AVANT le démarrage ----------------------------------
# Aucune modification de postgresql.conf : le port par défaut (5432) est celui
# que le serveur utilise réellement, et c'est celui que get_uri() et SHOW port
# rapportent. Tenter d'imposer un port ici s'est révélé sans effet.
try:
    server.ensure_postgres_running()
except Exception as exc:  # noqa: BLE001
    unavailable(f"le serveur n'a pas démarré : {exc}")

if not PSQL.exists():
    unavailable(f"psql introuvable : {PSQL}")


# get_uri() renvoie la forme socket correcte, y compris le répertoire exact :
# la librairie peut en choisir un autre que pgdata si le chemin dépasse la
# longueur maximale d'un socket de domaine. Ne pas le deviner.
BASE_URI = server.get_uri()
SOCKET_DIR = BASE_URI.split("host=", 1)[1] if "host=" in BASE_URI else str(PGDATA)

if not PGPORT:
    sockets = sorted(pathlib.Path(SOCKET_DIR).glob(".s.PGSQL.[0-9]*"))
    sockets = [x for x in sockets if x.suffix != ".lock"]
    if not sockets:
        unavailable(f"aucun socket PostgreSQL dans {SOCKET_DIR}")
    PGPORT = sockets[0].name.rsplit(".", 1)[1]


def sql(database: str, *args: str) -> str:
    """psql en appel direct : le wrapper du module injecte -D, que psql ignore."""
    return subprocess.run(
        [str(PSQL), "-h", SOCKET_DIR, "-p", PGPORT, "-U", "postgres",
         "-d", database, "-t", "-A", "-F", "|", *args],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


try:
    probe = sql("postgres", "-c", "SELECT 'socket'")
except subprocess.CalledProcessError as exc:
    unavailable(f"connexion refusée via le socket {SOCKET_DIR} — "
                f"{(exc.stderr or exc.stdout or '').strip()[:200]}")
if probe != "socket":
    unavailable(f"sonde inattendue : {probe!r}")

# Le port est relu au serveur, pas supposé : l'imposer dans postgresql.conf
# s'est révélé sans effet, et un port faux produit un ENOENT déroutant.
try:
    PGPORT = sql("postgres", "-c", "SHOW port") or PGPORT
except subprocess.CalledProcessError as exc:
    unavailable(f"impossible de lire le port du serveur : {exc}")
log(f"PostgreSQL démarré — socket {SOCKET_DIR}, port {PGPORT}")

# --- Shim pgcrypto ----------------------------------------------------------
EXT = PGINSTALL / "share" / "extension"
if not ((EXT / "pgcrypto.control").exists() and (EXT / "pgcrypto.so").exists()):
    (EXT / "pgcrypto.control").write_text(
        "comment = 'test-only pgcrypto shim built on core sha2/md5'\n"
        "default_version = '1.3'\n"
        "module_pathname = '$libdir/pgcrypto'\n"
        "relocatable = true\n", encoding="utf-8")
    (EXT / "pgcrypto--1.3.sql").write_text(
        "CREATE FUNCTION digest(bytea, text) RETURNS bytea\n"
        "LANGUAGE plpgsql IMMUTABLE STRICT AS $$\n"
        "BEGIN\n"
        "  CASE lower($2)\n"
        "    WHEN 'md5'    THEN RETURN decode(md5(encode($1, 'hex')), 'hex');\n"
        "    WHEN 'sha224' THEN RETURN sha224($1);\n"
        "    WHEN 'sha256' THEN RETURN sha256($1);\n"
        "    WHEN 'sha384' THEN RETURN sha384($1);\n"
        "    WHEN 'sha512' THEN RETURN sha512($1);\n"
        "    ELSE RAISE EXCEPTION 'digest: algorithme non pris en charge : %', $2;\n"
        "  END CASE;\n"
        "END $$;\n", encoding="utf-8")
    log("shim pgcrypto installé (ce build est livré sans contrib/pgcrypto)")

# --- Base et migrations ----------------------------------------------------
existing = sql("postgres", "-c",
               f"SELECT 1 FROM pg_database WHERE datname = '{DB}'")
if not existing:
    sql("postgres", "-c", f'CREATE DATABASE "{DB}"')
    log(f"base {DB} créée")

# Les migrations ne sont PAS idempotentes : `CREATE POLICY` et `CREATE TRIGGER`
# échouent si l'objet existe déjà. Rejouer la chaîne sur une base déjà migrée
# produit donc « policy ... already exists » — ce n'est pas un défaut du schéma,
# c'est un rejeu. On journalise donc ce qui a été appliqué, comme le ferait
# Prisma, et on ne repart de zéro que si l'ensemble a changé.
# L'état attendu est la liste (nom, empreinte du contenu), pas seulement les
# noms. Sans l'empreinte, corriger une migration déjà appliquée ne déclenche
# aucune recréation et la base garde l'ancienne définition — exactement le piège
# rencontré en corrigeant la procédure PLM/ERP.
import hashlib
expected = sorted(
    (d.name, hashlib.sha256((d / "migration.sql").read_bytes()).hexdigest()[:16])
    for d in MIGRATIONS.iterdir()
    if d.is_dir() and (d / "migration.sql").exists())

JOURNAL = ("CREATE TABLE IF NOT EXISTS tracefab_test_migrations "
           "(name text PRIMARY KEY, content_hash text, "
           "applied_at timestamptz NOT NULL DEFAULT now())")
sql(DB, "-q", "-c", JOURNAL)
sql(DB, "-q", "-c",
    "ALTER TABLE tracefab_test_migrations ADD COLUMN IF NOT EXISTS content_hash text")
already = sorted(
    tuple(line.split("|"))
    for line in sql(DB, "-c",
                    "SELECT name, COALESCE(content_hash, '') FROM tracefab_test_migrations")
    .splitlines() if line)

# La condition porte sur l'ÉCART, pas sur le contenu du journal.
#
# `if already and already != expected` laissait passer un état réellement
# rencontré : journal vide MAIS base peuplée (28 tables, `users` présent) après
# une exécution interrompue. Le premier `CREATE POLICY` échouait alors sur
# « policy already exists », et la base devenait inutilisable.
if already != expected:
    log(f"{len(already)} migration(s) enregistrée(s), {len(expected)} attendue(s) "
        "— base recréée (écart de nom ou de contenu)")
    sql("postgres", "-q", "-c", f'DROP DATABASE "{DB}"')
    sql("postgres", "-q", "-c", f'CREATE DATABASE "{DB}"')
    already = []
    # Le journal vivait DANS la base supprimée : le recréer, sinon la première
    # INSERT de la boucle échoue sur « relation tracefab_test_migrations does
    # not exist » et la base devient inutilisable.
    sql(DB, "-q", "-c", JOURNAL)

applied = 0
applied_names = {name for name, _ in already}
for name, digest in expected:
    if name in applied_names:
        continue
    sql_file = MIGRATIONS / name / "migration.sql"
    tmp = pathlib.Path(f"/tmp/_tracefab_test_migration_{PGPORT}.sql")
    tmp.write_text(sql_file.read_text(encoding="utf-8"), encoding="utf-8")
    try:
        sql(DB, "-v", "ON_ERROR_STOP=1", "-q", "-f", str(tmp))
        sql(DB, "-q", "-c",
            "INSERT INTO tracefab_test_migrations (name, content_hash) "
            "VALUES ('" + name + "', '" + digest + "') ON CONFLICT DO NOTHING")
        applied += 1
    except subprocess.CalledProcessError as exc:
        detail = " ".join((exc.stderr or exc.stdout or "").split())[:400]
        unavailable(f"migration {name} en échec : {detail}")
log(f"{applied} migration(s) appliquée(s), {len(expected) - applied} déjà en place")

# --- Droits d'exécution pour les rôles d'exécution -------------------------
#
# La migration 20261007100000_security_definer_execute_hardening révoque
# EXECUTE sur toutes les fonctions SECURITY DEFINER et supprime l'octroi par
# défaut. Son propre commentaire l'annonce :
#
#   « Runtime roles must receive explicit EXECUTE grants in a separate,
#     reviewed role migration. »
#
# Cette migration de rôles n'existe pas dans le dépôt. Résultat mesuré sur la
# base : 106 fonctions tracefab_* sur 111 ne sont exécutables que par leur
# propriétaire, dont tracefab_is_org_member — qui porte les politiques RLS. Un
# rôle autre que le propriétaire reçoit donc « permission denied », et les
# politiques RLS elles-mêmes échouent.
#
# Le correctif de fond (quel rôle applicatif, quels octrois) est une décision
# d'architecture qui ne se prend pas ici. En attendant, la BASE DE TEST accorde
# ce que la migration de rôles accorderait : sans cela aucun test d'intégration
# ne peut exercer la RLS qu'il est censé vérifier. Ceci ne touche pas aux
# migrations, donc pas à la production.
sql(DB, "-q", "-c", """
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT n.nspname AS s, p.proname AS n, pg_get_function_identity_arguments(p.oid) AS a
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO PUBLIC', f.s, f.n, f.a);
  END LOOP;
END $$""")
sql(DB, "-q", "-c",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC")
log("droits EXECUTE accordés à PUBLIC (base de test uniquement)")

# `host=` dans la query string : c'est ainsi que le pilote pg reçoit le
# répertoire de socket. Sans lui, il tenterait une connexion TCP et échouerait.
uri = f"postgresql://postgres@localhost:{PGPORT}/{DB}?host={SOCKET_DIR}"
print(f"TRACEFAB_TEST_DB_URI={uri}", flush=True)

# --- Attente : c'est le parent Node qui décide de la fin --------------------
try:
    sys.stdin.read()
except KeyboardInterrupt:
    pass

# Arrêt EXPLICITE.
#
# La librairie nettoie via un gestionnaire de sortie, mais il ne se déclenche pas
# de façon fiable ici : mesuré après un cycle complet, postgres restait vivant
# avec ppid=1 alors que le processus Python avait bien quitté. Sans cet appel,
# chaque exécution laisse un serveur orphelin.
#
# `cleanup_mode='stop'` (le défaut) fait `pg_ctl stop` SANS supprimer pgdata —
# malgré ce qu'annonce le docstring de cleanup(). Les données survivent donc, et
# le test suivant réutilise les 37 migrations déjà appliquées.
# `server.cleanup()` ne suffit PAS : son garde-fou `pids != [os.getpid()]` sort
# silencieusement dès que la liste de pids partagée contient un reste d'une
# exécution interrompue. Mesuré : cleanup() s'exécutait sans lever, et postgres
# restait vivant. On appelle donc pg_ctl stop directement — c'est exactement ce
# que fait la librairie en interne, sans sa comptabilité de pids.
try:
    from embedded_postgres._commands import pg_ctl  # type: ignore
    pg_ctl(["-w", "stop"], pgdata=PGDATA, user=None, timeout=30)
    log("serveur arrêté, pgdata conservé")
except Exception as exc:  # noqa: BLE001
    log(f"arrêt du serveur en échec : {exc}")
