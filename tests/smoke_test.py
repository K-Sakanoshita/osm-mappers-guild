#!/usr/bin/env python3
"""OSM Mappers Guild API スモークテスト（tests/run_smoke_test.sh から実行）。"""
import json, sys, urllib.request, urllib.error, http.cookiejar
from urllib.parse import urlencode
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
s, d = call(anon, "GET", "/requests?status=open&area=worldwide")
check("list worldwide open requests", s == 200 and [r["id"] for r in d["requests"]] == [worldwide_id], str(d))
s, d = call(anon, "GET", "/requests?status=completed&area=worldwide")
check("worldwide filter respects status", s == 200 and d["requests"] == [], str(d))
s, d = call(anon, "GET", "/requests?area=located")
check("list located requests", s == 200 and bool(d["requests"]) and all(
    r["area"] is not None for r in d["requests"]), str(d))
s, d = call(anon, "GET", "/requests?area=unknown")
check("invalid area filter -> 400", s == 400, str(d))
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

# --- Issue #8: bbox 絞り込み・カーソルページネーション
TS = "2025-01-01 12:00:00"

def rect(w, s, e, n):
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}

seed = [(101 + i, rect(135.0, 35.0, 135.1, 35.1)) for i in range(60)]      # 地域A (101-160)
seed += [(161 + i, rect(140.0, 40.0, 140.1, 40.1)) for i in range(60)]     # 地域B (161-220)
seed += [(221 + i, None) for i in range(30)]                               # worldwide (221-250)
seed += [
    (251, rect(135.10, 50.0, 135.20, 50.10)),   # bbox西端に境界タッチ
    (252, rect(135.11, 50.0, 135.20, 50.10)),   # bboxと重ならない
    (253, rect(-179.0, -45.0, 179.0, -44.0)),  # 両側に重なる広い矩形
    (254, rect(-178.0, -45.0, -177.0, -44.0)),  # 日付変更線西側
    (255, rect(177.0, -45.0, 178.0, -44.0)),    # 日付変更線東側
    (256, rect(0.0, 0.0, 1.0, 1.0)),            # wrapされない中央
]
with sqlite3.connect(TEST_DIR / "guild.sqlite") as db:
    db.executemany(
        "INSERT INTO requests (id, user_id, title, description, category, reward_text, area_geojson, status, created_at, updated_at) "
        "VALUES (?, 1, ?, 'seed', 'その他', NULL, ?, 'open', ?, ?)",
        [(rid, f"bboxテスト{rid}", "null" if area is None else json.dumps(area), TS, TS) for rid, area in seed],
    )

def get_requests(params, op=anon):
    return call(op, "GET", "/requests?" + urlencode(params))

B8 = {"status": "open", "category": "その他", "area": "located"}

s, d = get_requests(B8)
check("legacy contract: {requests} max 100, no cursor",
      s == 200 and len(d["requests"]) == 100 and "next_cursor" not in d and d["requests"][0]["id"] == 256, str(d)[:200])

s, d = get_requests({**B8, "bbox": "-180,-90,180,90", "limit": 100})
located_ids = sorted((rid for rid, area in seed if area is not None), reverse=True)
check("limit=100 page 1: 100 items, id DESC, cursor present",
      s == 200 and len(d["requests"]) == 100 and d["next_cursor"] is not None
      and [r["id"] for r in d["requests"]] == located_ids[:100], str(d)[:200])
cursor1 = d["next_cursor"]
s, d = get_requests({**B8, "bbox": "-180,-90,180,90", "limit": 100, "cursor": cursor1})
check("page 2: remaining 26, next_cursor null",
      s == 200 and d["next_cursor"] is None and [r["id"] for r in d["requests"]] == located_ids[100:], str(d)[:200])

s, d = get_requests({**B8, "limit": 1})
c1 = d["next_cursor"]
check("limit=1 first page", s == 200 and [r["id"] for r in d["requests"]] == [256] and c1, str(d))
s, d = get_requests({**B8, "limit": 1, "cursor": c1})
check("limit=1 second page", s == 200 and [r["id"] for r in d["requests"]] == [255] and d["next_cursor"], str(d))

bad_params = [
    {"area": "worldwide", "bbox": "1,2,3,4"},   # area=worldwide と bbox は併用不可
    {"bbox": "abc,2,3,4"},                        # 数値でない
    {"bbox": "1,2,3"},                            # 3値
    {"bbox": "1,2,3,4,5"},                        # 5値
    {"bbox[]": "1,2,3,4"},                        # 配列
    {"bbox": "1e999,2,3,4"},                      # 非有限値
    {"bbox": "1" * 129 + ",2,3,4"},               # 過大な値
    {"bbox": "181,-90,182,90"},                   # 経度範囲超過
    {"bbox": "-181,-90,180,90"},                  # 西端範囲超過
    {"bbox": "1,95,3,90"},                        # 緯度範囲超過
    {"bbox": "1,-91,3,90"},                       # 南端範囲超過
    {"bbox": "1,40,3,40"},                        # south == north
    {"bbox": "1,41,3,40"},                        # south > north
    {"bbox": "1,2,1,3"},                          # 経度スパンゼロ
    {"limit": 0},                                 # limit下限未満
    {"limit": 101},                               # limit上限超過
    {"limit": "abc"},                             # 数値でないlimit
    {"cursor": "2025-02-31 00:00:00|1"},           # 存在しない日付
    {"cursor": "2025-02-28 00:00:00|9999999999999999999"},
    {"cursor[]": cursor1},
]
for i, extra in enumerate(bad_params, 1):
    s, d = get_requests({**B8, **extra})
    check(f"invalid params #{i} -> 400", s == 400, f"{extra} -> {s} {str(d)[:120]}")

s, d = get_requests({**B8, "bbox": "135,35,135.1,35.1"})
check("bbox = region A bounds -> exactly A",
      s == 200 and sorted(r["id"] for r in d["requests"]) == list(range(101, 161)), str(d)[:200])

s, d = get_requests({**B8, "bbox": "135.10,50.05,135.105,50.06"})
check("narrow bbox: touches 251 edge, excludes 252",
      s == 200 and [r["id"] for r in d["requests"]] == [251], str(d)[:200])

s, d = get_requests({**B8, "bbox": "170,-44.5,-170,-44.0"})
check("dateline wrap (west > east): both sides, excludes middle",
      s == 200 and [r["id"] for r in d["requests"]] == [255, 254, 253], str(d)[:200])

s, d = get_requests({"status": "open", "bbox": "134,34,136,36"})
check("bbox without area excludes worldwide",
      s == 200 and [r["id"] for r in d["requests"]] == list(range(160, 100, -1))
      and all(r["area"] is not None for r in d["requests"]), str(d)[:200])

s, d = get_requests({**B8, "bbox": "134,34,136,36", "owner": "me"}, A)
check("bbox + owner=me (A)", s == 200 and [r["id"] for r in d["requests"]] == list(range(160, 100, -1)), str(d)[:200])
s, d = get_requests({**B8, "bbox": "134,34,136,36", "owner": "me"}, B)
check("bbox + owner=me (B) -> empty", s == 200 and d["requests"] == [], str(d)[:200])
s, d = get_requests({"status": "open", "area": "located", "bbox": "135.10,50.05,135.105,50.06", "participating": "me"}, B)
check("bbox + participating=me (B) -> empty", s == 200 and d["requests"] == [], str(d)[:200])
s, d = get_requests({"area": "located", "bbox": "135.51,34.70,135.53,34.72", "participating": "me"}, B)
check("bbox + participating=me (B) matches nearby assignments",
      s == 200 and {r["id"] for r in d["requests"]} == {req_id, req2_id}, str(d)[:200])
s, d = get_requests({"area": "worldwide", "category": "その他", "limit": 1})
check("worldwide page contains worldwide requests only",
      s == 200 and d["next_cursor"] and [r["id"] for r in d["requests"]] == [250]
      and d["requests"][0]["area"] is None, str(d)[:200])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
