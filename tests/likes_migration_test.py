#!/usr/bin/env python3
"""既存の依頼・成果へのいいねの統合と制約を確認する。"""
import sqlite3
from pathlib import Path

db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys = ON')
db.executescript(Path('db/schema.sqlite.sql').read_text())
db.executescript(Path('db/migrations/002_support_likes.sqlite.sql').read_text())
db.execute("INSERT INTO users VALUES (1, 123, 'user', '2026-01-01')")
db.execute("INSERT INTO requests (id, user_id, title, description, category, reward_text, area_geojson, status, created_at, updated_at) VALUES (1, 1, 'title', 'description', '建物', NULL, '{}', 'open', '2026-01-01', '2026-01-01')")
db.execute("INSERT INTO assignments VALUES (1, 1, 1, 'approved', '2026-01-01', '2026-01-01')")
db.execute("INSERT INTO request_supports VALUES (1, 1, '2026-02-01')")
db.execute("INSERT INTO assignment_likes VALUES (1, 1, '2026-03-01')")
migration = Path('db/migrations/003_unify_likes.sqlite.sql').read_text()
db.executescript(migration)
rows = db.execute('SELECT request_id, assignment_id, user_id, created_at FROM likes ORDER BY created_at').fetchall()
assert rows == [(1, None, 1, '2026-02-01'), (None, 1, 1, '2026-03-01')], rows
for values in [(None, None, 1), (1, 1, 1), (1, None, 1), (None, 1, 1), (999, None, 1)]:
    try:
        db.execute("INSERT INTO likes (request_id, assignment_id, user_id, created_at) VALUES (?, ?, ?, '2026-01-01')", values)
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError(f'constraint accepted {values}')
db.execute('DELETE FROM assignments WHERE id=1')
assert db.execute('SELECT COUNT(*) FROM likes WHERE assignment_id IS NOT NULL').fetchone()[0] == 0
assert db.execute('SELECT COUNT(*) FROM likes WHERE request_id=1').fetchone()[0] == 1
print('旧データ移行、対象の区別、重複防止、外部キー: OK')
