#!/usr/bin/env python3
"""Exercise 004 against a pre-004 SQLite database without dropping original data."""
import sqlite3
from pathlib import Path

schema = Path('db/schema.sqlite.sql').read_text(encoding='utf-8')
schema = schema.split('-- Phase 1 hardening:')[0]
schema = schema.replace('  is_hidden    INTEGER NOT NULL DEFAULT 0,\n', '')
schema = schema.replace('  report_kind TEXT NOT NULL DEFAULT \'edit\',\n', '')

db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys = ON')
db.executescript(schema)
db.execute("INSERT INTO users (id, osm_user_id, display_name, created_at) VALUES (1,101,'A','2026-01-01')")
db.execute("INSERT INTO users (id, osm_user_id, display_name, created_at) VALUES (2,202,'B','2026-01-01')")
db.execute("INSERT INTO requests (id,user_id,title,description,category,area_geojson,status,created_at,updated_at) VALUES (1,1,'x','test','建物','{}','completed','2026-01-01','2026-01-01')")
db.execute("INSERT INTO assignments (request_id,user_id,status,created_at,updated_at) VALUES (1,1,'approved','2026-01-01','2026-01-01')")
db.execute("INSERT INTO assignments (request_id,user_id,status,created_at,updated_at) VALUES (1,2,'joined','2026-01-01','2026-01-01')")
db.commit()

db.executescript(Path('db/migrations/004_safety_moderation.sqlite.sql').read_text(encoding='utf-8'))
assert db.execute("SELECT status,is_hidden FROM requests WHERE id=1").fetchone() == ('in_progress',0)
assert [row[0] for row in db.execute("SELECT report_kind FROM assignments")] == ['edit','edit']
assert db.execute("SELECT COUNT(*) FROM moderation_reports").fetchone()[0] == 0
assert db.execute("SELECT COUNT(*) FROM moderation_actions").fetchone()[0] == 0
print('004 migration preserves data and repairs partial completion: OK')
