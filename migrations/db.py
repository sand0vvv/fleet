#!/usr/bin/env python3
"""
db.py - Execute SQL directly against DATABASE_URL.
Usage: DATABASE_URL=... python migrations/db.py "SQL"
       DATABASE_URL=... python migrations/db.py "$(cat migrations/001_fleet_schema.sql)"
"""
import os, sys, json, time, re, psycopg2

DATABASE_URL = os.environ.get("DATABASE_URL")

def log(msg): print(f"[db.py] {msg}", file=sys.stderr)

def execute(sql):
    if not DATABASE_URL:
        print("ERROR: DATABASE_URL not set"); sys.exit(1)
    try:
        conn = psycopg2.connect(DATABASE_URL, connect_timeout=10)
    except Exception as e:
        print(f"ERROR: Connection failed: {e}"); sys.exit(1)
    cur = conn.cursor()
    try:
        cur.execute(sql)
        stripped = re.sub(r'^(\s*(--[^\n]*|/\*.*?\*/)\s*)+', '', sql, flags=re.DOTALL).lstrip().upper()
        is_write = stripped.startswith(("INSERT","UPDATE","DELETE","CREATE","ALTER","DROP","TRUNCATE","GRANT","REVOKE","COMMENT","SET","WITH")) or any(k in stripped for k in ("CREATE TABLE","CREATE SCHEMA","CREATE INDEX","ALTER TABLE"))
        if is_write:
            conn.commit(); log(f"Committed. Rows affected: {cur.rowcount}")
        if cur.description:
            rows = cur.fetchall(); cols = [d[0] for d in cur.description]
            print(json.dumps([{c: (v if isinstance(v,(int,float,bool)) or v is None else str(v)) for c,v in zip(cols,r)} for r in rows], indent=2, ensure_ascii=False))
        elif not is_write:
            print("No results")
    except Exception as e:
        conn.rollback(); print(f"ERROR: {e}")
    finally:
        cur.close(); conn.close()

if __name__ == "__main__":
    if len(sys.argv) < 2: print(__doc__)
    else: execute(" ".join(sys.argv[1:]))
