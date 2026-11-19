#!/usr/bin/env python3
"""OSM Mappers Guild API スモークテスト（tests/run_smoke_test.sh から実行）。"""
import json, sys, urllib.request, urllib.error, http.cookiejar
from pathlib import Path
import sqlite3
import subprocess

BASE = "http://127.0.0.1:8099/api/index.php"
TEST_DIR = Path(sys.argv[1])
passed = failed = 0

def client():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def authenticated_client(user_id):
    session_id = subprocess.check_output([
        "php", "-d", f"session.save_path={TEST_DIR / 'sessions'}",
        "-r", 'session_start(); $_SESSION["user_id"] = (int)$argv[1]; '
              'session_write_close(); echo session_id();',
        str(user_id),
    ], text=True)
    opener = client()
    opener.addheaders.append(("Cookie", f"MGSESSID={session_id}"))
    return opener

def call(op, method, path, body=None, csrf=None, raw_headers=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if csrf:
        req.add_header("X-CSRF-Token", csrf)
    if raw_headers:
        for k, v in raw_headers.items():
            req.add_header(k, v)
    try:
        with op.open(req) as res:
            return res.status, json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        payload = e.read().decode()
        try:
            return e.code, json.loads(payload or "{}")
        except json.JSONDecodeError:
            return e.code, {"raw": payload}

def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        print(f"FAIL  {name} {extra}")

RECT = {"type": "Polygon", "coordinates": [[[135.49, 34.68], [135.52, 34.68], [135.52, 34.71], [135.49, 34.71], [135.49, 34.68]]]}

with sqlite3.connect(TEST_DIR / "guild.sqlite") as db:
    schema = Path(__file__).resolve().parents[1] / "db/schema.sqlite.sql"
    db.executescript(schema.read_text(encoding="utf-8"))
    db.executemany(
        "INSERT INTO users (id, osm_user_id, display_name, created_at) VALUES (?, ?, ?, datetime('now'))",
        [(1, 1001, "依頼者A"), (2, 2002, "マッパーB")],
    )
db.close()

# --- health / me
anon = client()
s, d = call(anon, "GET", "/health")
check("health", s == 200 and d.get("ok") is True, str(d))
s, d = call(anon, "GET", "/me")
check("me (logged out)", s == 200 and d.get("user") is None and "dev_login_enabled" not in d, str(d))
s, d = call(anon, "POST", "/auth/dev-login",
            {"osm_user_id": 1001, "display_name": "依頼者A"}, d["csrf_token"])
check("removed login route -> 404", s == 404, str(d))

# --- 未ログインの変更は401
s, d = call(anon, "POST", "/requests", {"title": "x"})
check("POST while logged out -> 401", s == 401, str(s))

# --- 依頼者Aのテストセッション
A = authenticated_client(1)
s, d = call(A, "GET", "/me"); csrfA = d["csrf_token"]
check("me A", d["user"]["osm_user_id"] == 1001, str(d))

# ログイン済みでもCSRFトークンなしの変更は403
s, d = call(A, "POST", "/requests", {
    "title": "CSRFなし", "description": "x", "category": "建物", "area": RECT})
check("POST without CSRF (logged in) -> 403", s == 403, str(s))

# --- 依頼作成（正常・異常）
s, d = call(A, "POST", "/requests", {
    "title": "三国駅周辺の店舗を確認", "description": "駅前の店舗の営業時間を確認してください",
    "category": "店舗・施設", "reward_text": "交通費実費", "area": RECT}, csrfA)
check("create request", s == 201 and d["request"]["status"] == "open", str(d))
req_id = d["request"]["id"]

s, d = call(A, "POST", "/requests", {
    "title": "不正な範囲", "description": "x", "category": "建物",
    "area": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}}, csrfA)
check("create with bad area -> 400", s == 400, str(s))

s, d = call(A, "POST", "/requests", {
    "title": "カテゴリ不正", "description": "x", "category": "存在しない", "area": RECT}, csrfA)
check("create with bad category -> 400", s == 400, str(s))

# 2件目（同時参加テスト用）
s, d = call(A, "POST", "/requests", {
    "title": "公園の遊具を点検", "description": "遊具の有無を確認", "category": "公園・緑地", "area": RECT}, csrfA)
req2_id = d["request"]["id"]
check("create request 2", s == 201, str(d))

# --- マッパーBのテストセッション
B = authenticated_client(2)
s, d = call(B, "GET", "/me"); csrfB = d["csrf_token"]
check("me B", d["user"]["osm_user_id"] == 2002, str(d))

# --- 参加フロー
s, d = call(B, "POST", f"/requests/{req_id}/join", {}, csrfB)
check("B join", s == 200 and d["request"]["status"] == "in_progress", str(d))
s, d = call(B, "POST", f"/requests/{req_id}/join", {}, csrfB)
check("B join twice -> 409", s == 409, str(s))
s, d = call(B, "POST", f"/requests/{req2_id}/join", {}, csrfB)
check("B join second request (multi)", s == 200, str(d))

# --- 報告フロー
s, d = call(A, "POST", f"/requests/{req_id}/report", {"comment": "やりました", "changeset_ids": [1]}, csrfA)
check("non-participant report -> 403", s == 403, str(s))
s, d = call(B, "POST", f"/requests/{req_id}/report", {"comment": "報告", "changeset_ids": []}, csrfB)
check("empty changesets -> 400", s == 400, str(d))
s, d = call(B, "POST", f"/requests/{req_id}/report", {"comment": "報告", "changeset_ids": [0]}, csrfB)
check("invalid changeset -> 400", s == 400, str(d))
s, d = call(A, "GET", f"/requests/{req_id}")
check("invalid reports leave assignment unchanged", d["assignments"][0]["status"] == "joined" and not d["assignments"][0]["changeset_ids"], str(d))
s, d = call(B, "POST", f"/requests/{req_id}/report",
            {"comment": "駅前の店舗3件を確認・更新しました", "changeset_ids": [123456, 123457]}, csrfB)
check("B report", s == 200 and d["request"]["status"] == "awaiting_review", str(d))
s, d = call(B, "POST", f"/requests/{req_id}/report", {"comment": "再報告", "changeset_ids": []}, csrfB)
check("B double report -> 409", s == 409, str(s))

# --- 確認フロー（修正依頼→再報告→承認）
s, d = call(B, "POST", f"/requests/{req_id}/review", {"assignment_id": 1, "action": "approve"}, csrfB)
check("non-owner review -> 403", s == 403, str(s))
s, d = call(A, "GET", f"/requests/{req_id}")
aid = d["assignments"][0]["id"]
check("detail has changesets", d["assignments"][0]["changeset_ids"] == [123456, 123457], str(d["assignments"]))
s, d = call(A, "POST", f"/requests/{req_id}/review",
            {"assignment_id": aid, "action": "request_changes", "comment": "西側の店舗もお願いします"}, csrfA)
check("A request_changes", s == 200 and d["request"]["status"] == "changes_requested", str(d))
s, d = call(B, "POST", f"/requests/{req_id}/report",
            {"comment": "西側も確認しました", "changeset_ids": [123999]}, csrfB)
check("B re-report", s == 200 and d["request"]["status"] == "awaiting_review", str(d))
s, d = call(A, "POST", f"/requests/{req_id}/review",
            {"assignment_id": aid, "action": "approve", "comment": "ありがとうございました"}, csrfA)
check("A approve -> completed", s == 200 and d["request"]["status"] == "completed", str(d))

# --- 詳細・一覧・認可
s, d = call(anon, "GET", f"/requests/{req_id}")
check("detail events include report/approve",
      any(e["event_type"] == "report" for e in d["events"]) and any(e["event_type"] == "approve" for e in d["events"]), str([e["event_type"] for e in d["events"]]))
check("detail changesets merged", d["assignments"][0]["changeset_ids"] == [123456, 123457, 123999], str(d["assignments"][0]["changeset_ids"]))
check("assignment approved", d["assignments"][0]["status"] == "approved", str(d["assignments"][0]))

s, d = call(A, "POST", f"/requests/{req2_id}/join", {}, csrfA)
check("owner can join own request", s == 200, str(d))
s, d = call(A, "POST", f"/requests/{req2_id}/join", {}, csrfA)
check("owner cannot join twice", s == 409, str(d))
s, d = call(A, "POST", f"/requests/{req2_id}/report", {"comment": "建物を編集", "changeset_ids": []}, csrfA)
check("owner report requires changeset", s == 400, str(d))
s, d = call(A, "POST", f"/requests/{req2_id}/report", {"comment": "建物を編集", "changeset_ids": [123456]}, csrfA)
check("owner can report", s == 200 and d["request"]["status"] == "awaiting_review", str(d))
s, d = call(A, "GET", f"/requests/{req2_id}")
owner_assignment = next(a for a in d["assignments"] if a["user_osm_id"] == 1001)
check("owner report saves changeset", owner_assignment["changeset_ids"] == [123456], str(owner_assignment))
s, d = call(A, "POST", f"/requests/{req2_id}/review", {"assignment_id": owner_assignment["id"], "action": "approve"}, csrfA)
check("owner can approve own report", s == 200, str(d))

s, d = call(B, "PATCH", f"/requests/{req2_id}", {"title": "乗っ取り"}, csrfB)
check("non-owner edit -> 403", s == 403, str(s))
s, d = call(A, "PATCH", f"/requests/{req2_id}", {"title": "公園の遊具を点検（更新）"}, csrfA)
check("owner edit", s == 200 and d["request"]["title"].endswith("（更新）"), str(d))
s, d = call(B, "POST", f"/requests/{req2_id}/support", {"active": True}, csrfB)
check("support before withdrawal", s == 200 and d.get("support_count") == 1, str(d))
s, d = call(A, "POST", f"/requests/{req2_id}/withdraw", {}, csrfA)
check("owner withdraw", s == 200 and d["request"]["status"] == "withdrawn", str(d))
s, d = call(B, "POST", f"/requests/{req2_id}/join", {}, csrfB)
check("join withdrawn -> 409", s == 409, str(s))

s, d = call(anon, "GET", "/requests?status=completed")
check("list filter completed", s == 200 and len(d["requests"]) == 1 and d["requests"][0]["id"] == req_id, str(d)[:200])
s, d = call(B, "GET", "/requests?participating=me")
check("list participating=me", s == 200 and len(d["requests"]) >= 1, str(d)[:200])

# --- Phase 2: 依頼への応援 / 承認済み成果へのいいね
s, d = call(anon, "POST", f"/requests/{req_id}/support", {"active": True})
check("anonymous support -> 401", s == 401, str(d))
s, d = call(A, "POST", f"/requests/{req_id}/support", {"active": True}, csrfA)
check("owner cannot support own request -> 403", s == 403, str(d))
s, d = call(B, "POST", f"/requests/{req_id}/support", {"active": True}, csrfB)
check("support request", s == 200 and d.get("support_count") == 1 and d.get("supported_by_me") is True, str(d))
s, d = call(B, "POST", f"/requests/{req_id}/support", {"active": True}, csrfB)
check("duplicate support is idempotent", s == 200 and d.get("support_count") == 1, str(d))
s, d = call(B, "GET", f"/requests/{req_id}")
check("support status in detail", d.get("supported_by_me") is True and d["request"]["support_count"] == 1, str(d))
s, d = call(anon, "GET", "/requests")
check("support count in list", s == 200 and any(r["id"] == req_id and r["support_count"] == 1 for r in d["requests"]), str(d)[:300])
s, d = call(B, "POST", f"/requests/{req_id}/support", {"active": False}, csrfB)
check("remove support", s == 200 and d.get("support_count") == 0 and d.get("supported_by_me") is False, str(d))
s, d = call(B, "POST", f"/requests/{req2_id}/support", {"active": True}, csrfB)
check("cannot support withdrawn request -> 409", s == 409, str(d))
s, d = call(B, "POST", f"/requests/{req2_id}/support", {"active": False}, csrfB)
check("can remove support after withdrawal", s == 200 and d.get("support_count") == 0, str(d))

s, d = call(A, "POST", f"/assignments/{aid}/like", {"active": True}, csrfA)
check("like approved work", s == 200 and d.get("like_count") == 1 and d.get("liked_by_me") is True, str(d))
s, d = call(A, "POST", f"/assignments/{aid}/like", {"active": True}, csrfA)
check("duplicate like is idempotent", s == 200 and d.get("like_count") == 1, str(d))
s, d = call(B, "POST", f"/assignments/{aid}/like", {"active": True}, csrfB)
check("cannot like own work -> 403", s == 403, str(d))
s, d = call(A, "GET", f"/requests/{req_id}")
check("like count and viewer state in detail", s == 200 and d["assignments"][0]["like_count"] == 1 and d["assignments"][0]["liked_by_me"] is True, str(d["assignments"]))
s, d = call(anon, "GET", f"/requests/{req_id}")
check("like count public and viewer false", s == 200 and d["assignments"][0]["like_count"] == 1 and d["assignments"][0]["liked_by_me"] is False, str(d["assignments"]))
s, d = call(A, "POST", f"/assignments/{aid}/like", {"active": False}, csrfA)
check("remove like", s == 200 and d.get("like_count") == 0 and d.get("liked_by_me") is False, str(d))
s, d = call(A, "GET", f"/requests/{req2_id}")
pending_aid = next(a["id"] for a in d["assignments"] if a["user_osm_id"] == 2002)
s, d = call(A, "POST", f"/assignments/{pending_aid}/like", {"active": True}, csrfA)
check("cannot like unapproved work -> 409", s == 409, str(d))

s, d = call(A, "POST", f"/assignments/{aid}/like", {"active": True}, csrfA)
check("like before withdrawal", s == 200 and d.get("like_count") == 1, str(d))
s, d = call(A, "POST", f"/requests/{req_id}/withdraw", {}, csrfA)
check("withdraw request with liked work", s == 200, str(d))
s, d = call(A, "POST", f"/assignments/{aid}/like", {"active": True}, csrfA)
check("cannot like withdrawn work", s == 409, str(d))
s, d = call(A, "POST", f"/assignments/{aid}/like", {"active": False}, csrfA)
check("can remove like after withdrawal", s == 200 and d.get("like_count") == 0, str(d))

# --- 場所指定なしの依頼
s, d = call(A, "POST", "/requests", {
    "title": "病院を10件追加", "description": "世界中のどこでも対象です",
    "category": "店舗・施設", "area": None}, csrfA)
check("create worldwide request", s == 201 and d["request"]["area"] is None, str(d))
worldwide_id = d["request"]["id"]
worldwide_path = f"/requests/{worldwide_id}"
s, d = call(anon, "GET", "/requests?status=open")
check("list includes worldwide request", s == 200 and any(
    r["id"] == worldwide_id and r["area"] is None for r in d["requests"]), str(d))
s, d = call(A, "PATCH", worldwide_path, {"area": RECT}, csrfA)
check("add an area to a worldwide request", s == 200 and d["request"]["area"] == RECT, str(d))
s, d = call(A, "PATCH", worldwide_path, {"title": "病院を追加"}, csrfA)
check("editing other fields preserves area", s == 200 and d["request"]["area"] == RECT, str(d))
s, d = call(A, "PATCH", worldwide_path, {"area": None}, csrfA)
check("change back to worldwide", s == 200 and d["request"]["area"] is None, str(d))
s, d = call(anon, "GET", worldwide_path)
check("worldwide request detail", s == 200 and d["request"]["area"] is None, str(d))
s, d = call(B, "POST", worldwide_path + "/join", {}, csrfB)
check("join worldwide request", s == 200, str(d))
s, d = call(B, "POST", worldwide_path + "/report", {
    "comment": "追加しました", "changeset_ids": [123456]}, csrfB)
check("report on worldwide request", s == 200, str(d))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
