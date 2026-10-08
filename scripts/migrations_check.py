"""Applique toute la chaîne de migrations sur un PostgreSQL réel, puis vérifie
que le schéma Prisma décrit bien la base obtenue.

Ce n'est pas une simulation : `embedded-postgres` embarque un vrai serveur
PostgreSQL (initdb + postgres + psql). Chaque migration est appliquée dans
l'ordre et l'échec de l'une est rapporté avec le message réel du serveur.

POURQUOI CE SCRIPT EXISTE
  Jusqu'au chantier 10, aucune migration n'avait jamais été exécutée nulle part.
  Deux affirmations en dépendaient et se sont révélées fausses : « le bloc CRM
  n'a aucune clé étrangère » (il en a 15 dès A01/A02) et « organization_id est
  une colonne nouvelle » (elle doublonnait linked_organization_id). Ni l'une ni
  l'autre n'était détectable en lisant du SQL : seule l'exécution les montre.

LE SHIM pgcrypto
  Le build PostgreSQL embarqué est livré sans contrib/pgcrypto. Le dépôt utilise
  digest() et hmac() pour la chaîne de hachage du journal d'audit, donc un shim
  vide n'aurait rien prouvé. Celui-ci réimplémente les deux à partir de
  sha256()/md5(), natifs depuis PostgreSQL 11, et il est VÉRIFIÉ sur vecteurs
  connus avant toute migration : un digest faux invaliderait tout le reste.

SORTIE
  exit 0 — tout est appliqué et le schéma décrit la base
  exit 1 — un échec réel
  POSTGRES_SERVER_UNAVAILABLE — l'environnement ne permet pas d'installer le
  serveur (réseau absent) ; le runner classe alors ce test en SKIP.
"""
from __future__ import annotations

import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "prisma" / "migrations"
SCHEMA = ROOT / "prisma" / "schema.prisma"

os.environ.setdefault("XDG_RUNTIME_DIR", "/tmp/runtime-tracefab-pg")
pathlib.Path(os.environ["XDG_RUNTIME_DIR"]).mkdir(parents=True, exist_ok=True)

try:
    from embedded_postgres import PostgresServer  # type: ignore
except ImportError:
    print("POSTGRES_SERVER_UNAVAILABLE: embedded-postgres non installé")
    print("  à faire : installer embedded-postgres et pglast dans un venv")
    sys.exit(1)

PGDATA = pathlib.Path(os.environ.get("TRACEFAB_PGDATA", "/tmp/tracefab-pgdata"))
PGSOCKET = str(PGDATA)
PGPORT = "5432"
PGUSER = "postgres"
DB = "tracefab_migrations"

failures: list[str] = []
checks = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if condition:
        print(f"  ok    {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}" + (f"\n        {detail}" if detail else ""))


PSQL = pathlib.Path(PostgresServer.__init__.__globals__["__file__"]).parent / "pginstall" / "bin" / "psql"


def sql(database: str, *args: str) -> str:
    """psql en appel direct : le wrapper du module injecte -D, que psql ignore."""
    return subprocess.run(
        [str(PSQL), "-h", PGSOCKET, "-p", PGPORT, "-U", PGUSER, "-d", database,
         "-t", "-A", "-F", "|", *args],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def table(database: str, query: str) -> list[list[str]]:
    out = sql(database, "-c", query)
    return [line.split("|") for line in out.splitlines() if line]


# --------------------------------------------------------------------------- #
# 1. Serveur
# --------------------------------------------------------------------------- #
print("\n1. Démarrage d'un PostgreSQL réel")
server = PostgresServer(PGDATA)
try:
    server.ensure_pgdata_inited()
    server.ensure_postgres_running()
except Exception as exc:  # noqa: BLE001
    print(f"POSTGRES_SERVER_UNAVAILABLE: {exc}")
    sys.exit(1)
check("le serveur démarre", PSQL.exists(), f"psql introuvable : {PSQL}")
print(f"       {sql('postgres', '-c', 'SELECT version()').splitlines()[0][:70]}")

# --------------------------------------------------------------------------- #
# 2. Shim pgcrypto, vérifié AVANT toute migration
# --------------------------------------------------------------------------- #
print("\n2. Shim pgcrypto (ce build est livré sans contrib/pgcrypto)")
EXT = pathlib.Path(PostgresServer.__init__.__globals__["__file__"]).parent / "pginstall" / "share" / "extension"
has_pgcrypto = (EXT / "pgcrypto.control").exists() and (EXT / "pgcrypto.so").exists()
if has_pgcrypto:
    print("       contrib/pgcrypto présent — aucun shim nécessaire")
else:
    (EXT / "pgcrypto.control").write_text(
        "comment = 'test-only pgcrypto shim built on core sha2/md5'\n"
        "default_version = '1.3'\n"
        "module_pathname = '$libdir/pgcrypto'\n"
        "relocatable = true\n", encoding="utf-8")
    (EXT / "pgcrypto--1.3.sql").write_text(r"""
CREATE FUNCTION digest(bytea, text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  CASE lower($2)
    WHEN 'md5'    THEN RETURN decode(md5(encode($1, 'hex')), 'hex');
    WHEN 'sha224' THEN RETURN sha224($1);
    WHEN 'sha256' THEN RETURN sha256($1);
    WHEN 'sha384' THEN RETURN sha384($1);
    WHEN 'sha512' THEN RETURN sha512($1);
    ELSE RAISE EXCEPTION 'digest: algorithme non pris en charge : %', $2;
  END CASE;
END $$;
CREATE FUNCTION digest(text, text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT digest(convert_to($1, 'UTF8'), $2) $$;
CREATE FUNCTION tf_xor(bytea, bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE r bytea := ''; i int; b int;
BEGIN
  IF octet_length($1) <> octet_length($2) THEN
    RAISE EXCEPTION 'xor: longueurs differentes';
  END IF;
  FOR i IN 0..octet_length($1)-1 LOOP
    b := get_byte($1, i) # get_byte($2, i);
    r := r || set_byte('\x00'::bytea, 0, b);
  END LOOP;
  RETURN r;
END $$;
CREATE FUNCTION hmac(bytea, bytea, text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  alg text := lower($3);
  bs int := CASE WHEN lower($3) IN ('sha384','sha512') THEN 128 ELSE 64 END;
  k bytea := $2; ipad bytea := ''; opad bytea := ''; i int;
BEGIN
  IF octet_length(k) > bs THEN k := digest(k, alg); END IF;
  WHILE octet_length(k) < bs LOOP k := k || '\x00'::bytea; END LOOP;
  FOR i IN 1..bs LOOP ipad := ipad || '\x36'::bytea; opad := opad || '\x5c'::bytea; END LOOP;
  RETURN digest(tf_xor(k, opad) || digest(tf_xor(k, ipad) || $1, alg), alg);
END $$;
CREATE FUNCTION hmac(text, text, text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT hmac(convert_to($1,'UTF8'), convert_to($2,'UTF8'), $3) $$;
""", encoding="utf-8")
    print("       shim écrit, vérification sur vecteurs connus")
    sql("postgres", "-c", "DROP DATABASE IF EXISTS shimcheck")
    sql("postgres", "-c", "CREATE DATABASE shimcheck")
    sql("shimcheck", "-c", "CREATE EXTENSION pgcrypto")
    VECTORS = [
        ("digest('','sha256')",
         "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        ("digest('abc','sha256')",
         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
        # RFC 4231, cas 2 : clé « Jefe », données « what do ya want for nothing? »
        ("hmac('what do ya want for nothing?','Jefe','sha256')",
         "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"),
    ]
    for expr, expected in VECTORS:
        got = sql("shimcheck", "-c", f"SELECT encode({expr}, 'hex')")
        check(f"vecteur {expr.split('(')[0]}…", got == expected, f"obtenu {got}")
    sql("postgres", "-c", "DROP DATABASE shimcheck")

# --------------------------------------------------------------------------- #
# 3. Application de toute la chaîne
# --------------------------------------------------------------------------- #
print("\n3. Application des migrations")
sql("postgres", "-c", f"DROP DATABASE IF EXISTS {DB}")
sql("postgres", "-c", f"CREATE DATABASE {DB}")

dirs = sorted(d for d in MIGRATIONS.iterdir() if d.is_dir())
applied, failed_migrations = [], []
for d in dirs:
    f = d / "migration.sql"
    if not f.exists():
        continue
    tmp = pathlib.Path("/tmp/_tracefab_migration.sql")
    tmp.write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
    try:
        sql(DB, "-v", "ON_ERROR_STOP=1", "-q", "-f", str(tmp))
        applied.append(d.name)
    except subprocess.CalledProcessError as exc:
        msg = " ".join((exc.stderr or exc.stdout or "").split())[:300]
        failed_migrations.append((d.name, msg))
        print(f"  FAIL  {d.name}\n        {msg}")

check(f"{len(applied)} migrations appliquées, 0 en échec", not failed_migrations,
      "; ".join(n for n, _ in failed_migrations[:3]))

if failed_migrations:
    print(f"\nÉCHEC — {len(failed_migrations)} migration(s) en erreur")
    sys.exit(1)

# --------------------------------------------------------------------------- #
# 4. Le schéma Prisma décrit-il la base obtenue ?
# --------------------------------------------------------------------------- #
print("\n4. Schéma Prisma ↔ base réelle (bloc CRM)")

PG_DELETE = {"c": "Cascade", "n": "SetNull", "r": "Restrict", "a": "NoAction", "d": "SetDefault"}

# 4a. Ce que la base contient.
db_fks: set[tuple[str, str, str, str]] = set()
for table_name, cols, ref, deltype in table(DB, """
SELECT conrelid::regclass::text,
       (SELECT string_agg(attname, ',' ORDER BY k.ord)
          FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum),
       confrelid::regclass::text, confdeltype
FROM pg_constraint con
WHERE contype = 'f' AND conrelid::regclass::text LIKE 'crm_%'"""):
    db_fks.add((table_name, cols, ref, PG_DELETE.get(deltype, deltype)))

# 4b. Ce que le schéma déclare.
schema_text = SCHEMA.read_text(encoding="utf-8")
declared_fks: set[tuple[str, str, str, str]] = set()
RELATION = re.compile(
    r"^\s*\w+\s+\w+[?]?\s+@relation\((?P<args>[^)]*)\)", re.M)
for model in re.finditer(r"^model (\w+) \{(.*?)^\}", schema_text, re.M | re.S):
    name, body = model.group(1), model.group(2)
    if not name.startswith("crm_"):
        continue
    for rel in RELATION.finditer(body):
        args = rel.group("args")
        fields = re.search(r"fields:\s*\[([^\]]+)\]", args)
        refs = re.search(r"references:\s*\[([^\]]+)\]", args)
        target = re.search(r"^\s*\w+\s+(\w+)[?]?\s+@relation", rel.group(0), re.M)
        on_delete = re.search(r"onDelete:\s*(\w+)", args)
        if not (fields and refs and target):
            continue
        # Le type de la relation (2e mot) est le modèle cible, pas le nom du champ.
        target_model = re.match(r"\s*\w+\s+(\w+)", rel.group(0)).group(1)
        declared_fks.add((
            name,
            ",".join(x.strip() for x in fields.group(1).split(",")),
            target_model,
            on_delete.group(1) if on_delete else "(implicite)",
        ))

missing = sorted(db_fks - declared_fks)
extra = sorted(declared_fks - db_fks)

check(f"{len(db_fks)} clés étrangères en base sur crm_*", len(db_fks) >= 17,
      f"obtenu {len(db_fks)}")
check("toute clé étrangère de la base est déclarée dans le schéma", not missing,
      f"{len(missing)} non déclarées :\n          "
      + "\n          ".join(".".join(m[:3]) + f" onDelete={m[3]}" for m in missing))
check("aucune relation déclarée sans contrainte en base", not extra,
      "fantômes : " + "; ".join(".".join(e[:3]) for e in extra[:6]))

# 4b'. TOUTE colonne de périmètre doit être contrainte — invariant à part.
#      Les deux vérifications ci-dessus comparent schéma et base : elles sont
#      aveugles au cas où les deux sont d'accord sur l'absence de contrainte.
#      C'est exactement ce qu'on a trouvé sur crm_campaigns, crm_leads et
#      crm_saved_views : `platform_organization_id` sans clé étrangère, alors
#      que c'est la colonne que les politiques RLS comparent via
#      tracefab_is_platform_org(). Sans contrainte, un import peut écrire un
#      prospect rattaché à une organisation inexistante, et supprimer une
#      organisation laisse des lignes orphelines que la RLS rend invisibles
#      sans les effacer. D'où cet invariant, indépendant du schéma.
scope_cols = table(DB, """
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'platform_organization_id'
WHERE n.nspname = 'public' AND c.relkind = 'r'   -- tables, pas les index
  AND c.relname LIKE 'crm_%' AND NOT a.attisdropped
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid
                        AND ca.attnum = ANY (con.conkey)
                        AND ca.attname = 'platform_organization_id'
    WHERE con.conrelid = c.oid AND con.contype = 'f')
ORDER BY c.relname""")
check("toute colonne platform_organization_id est contrainte par une clé étrangère",
      not scope_cols, "orphelines : " + ", ".join(r[0] for r in scope_cols))

# 4c. RLS : la base doit forcer l'isolation, pas seulement l'activer.
for t in ["crm_companies", "crm_contacts", "crm_activities", "crm_tasks",
          "crm_meetings", "crm_pilots", "crm_saved_views", "crm_campaigns", "crm_leads"]:
    row = table(DB, f"SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                    f"WHERE relname = '{t}'")
    check(f"{t} : RLS activée ET forcée",
          bool(row) and row[0] == ["t", "t"],
          f"obtenu {row[0] if row else 'table absente'}")

policies = table(DB, "SELECT count(*) FROM pg_policies WHERE tablename LIKE 'crm_%'")
check("au moins 18 politiques RLS sur crm_*", int(policies[0][0]) >= 18,
      f"obtenu {policies[0][0]}")

# 4d. Contraintes UNIQUES : Prisma les exprime (@@unique), donc toute contrainte
#     unique de la base doit être déclarée — sinon `migrate diff` la supprimerait.
named = table(DB, """
SELECT conrelid::regclass::text AS tbl, conname,
       pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid::regclass::text LIKE 'crm_%' AND contype = 'u'""")
# Prisma NOMME automatiquement une contrainte unique mono-colonne
# `<table>_<colonne>_key` : elle est déclarée par `@unique` seul, sans `map:`.
undeclared = []
for tbl, cname, cdef in named:
    if f'"{cname}"' in schema_text:
        continue
    col = re.search(r"UNIQUE \((\w+)\)", cdef)
    declared = False
    if col and cname == f"{tbl}_{col.group(1)}_key":
        # Chercher dans le CORPS du modèle uniquement, et exiger @unique sur la
        # MÊME ligne que le champ. Avec re.S, un motif `.*@unique` traverse les
        # modèles et trouve un @unique ailleurs : la vérification passe alors
        # même quand le bon a été retiré (contre-vérification n°4 l'a montré).
        body = re.search(r"^model %s \{(.*?)^\}" % re.escape(tbl),
                         schema_text, re.M | re.S)
        if body:
            line = re.search(r"^  %s\b.*$" % re.escape(col.group(1)),
                             body.group(1), re.M)
            declared = bool(line and "@unique" in line.group(0))
    if not declared:
        undeclared.append(cname)
check("toute contrainte UNIQUE est déclarée dans le schéma", not undeclared,
      "absentes : " + ", ".join(undeclared[:5]))

#     Les contraintes CHECK n'ont aucune syntaxe Prisma : exiger qu'elles soient
#     déclarées serait impossible à satisfaire. On vérifie donc seulement
#     qu'elles EXISTENT en base — elles sont un filet que le schéma ne peut pas
#     décrire, et le dire vaut mieux que le taire.
checks_db = table(DB, """
SELECT count(*) FROM pg_constraint
WHERE conrelid::regclass::text LIKE 'crm_%' AND contype = 'c'""")
check("des contraintes CHECK existent en base (non exprimables en Prisma)",
      int(checks_db[0][0]) >= 5, f"obtenu {checks_db[0][0]}")

indexes = table(DB, """
SELECT indexname FROM pg_indexes
WHERE tablename LIKE 'crm_%' AND indexname LIKE 'idx_crm_%'""")
undeclared_idx = [i[0] for i in indexes if f'"{i[0]}"' not in schema_text]
check("tout index idx_crm_* est déclaré dans le schéma", not undeclared_idx,
      f"{len(undeclared_idx)} absents :\n          " + "\n          ".join(undeclared_idx))

# 4e. Aucun index partiel : Prisma ne sait pas les exprimer.
partial = table(DB, """
SELECT indexname FROM pg_indexes
WHERE tablename LIKE 'crm_%' AND indexdef LIKE '% WHERE %'""")
check("aucun index partiel sur crm_* (indéclarable en Prisma)", not partial,
      "partiels : " + ", ".join(p[0] for p in partial[:5]))

# --------------------------------------------------------------------------- #
print(f"\n{checks - len(failures)}/{checks} vérifications")
server.cleanup()
if failures:
    print(f"ÉCHEC — {len(failures)} vérification(s) en échec")
    sys.exit(1)
print("SUCCÈS — la chaîne s'applique et le schéma décrit la base")
