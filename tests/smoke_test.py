#!/usr/bin/env python3
"""OSM Mappers Guild API スモークテスト（dev-login使用）。"""
import json, sys, urllib.request, urllib.error, http.cookiejar

BASE = "http://127.0.0.1:8099/api/index.php"
passed = failed = 0

def client():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

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

# --- health / me
anon = client()
s, d = call(anon, "GET", "/health")
check("health", s == 200 and d.get("ok") is True, str(d))
s, d = call(anon, "GET", "/me")
check("me (logged out)", s == 200 and d.get("user") is None and d.get("dev_login_enabled") is True, str(d))

# --- 未ログインの変更は401
s, d = call(anon, "POST", "/requests", {"title": "x"})
check("POST while logged out -> 401", s == 401, str(s))

# --- 依頼者Aでログイン
A = client()
s, d = call(A, "GET", "/me"); csrfA = d["csrf_token"]
s, d = call(A, "POST", "/auth/dev-login", {"osm_user_id": 1001, "display_name": "依頼者A"}, csrfA)
check("dev-login A", s == 200 and d["user"]["display_name"] == "依頼者A", str(d))
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

# --- マッパーBでログイン
B = client()
s, d = call(B, "GET", "/me"); csrfB = d["csrf_token"]
s, d = call(B, "POST", "/auth/dev-login", {"osm_user_id": 2002, "display_name": "マッパーB"}, csrfB)
check("dev-login B", s == 200, str(d))
s, d = call(B, "GET", "/me"); csrfB = d["csrf_token"]

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
# Changesets are validated against OSM server, not trusted from browser.
s, d = call(B, "POST", f"/requests/{req_id}/report", {"comment":"他人の編集", "changeset_ids":[333333]}, csrfB)
check("reject changeset owned by someone else -> 422", s == 422, str(d))
s, d = call(B, "POST", f"/requests/{req_id}/report", {"comment":"遠隔の編集", "changeset_ids":[444444]}, csrfB)
check("reject changeset outside request bbox -> 422", s == 422, str(d))
s, d = call(B, "POST", f"/requests/{req_id}/report", {"comment":"0件編集", "changeset_ids":[555555]}, csrfB)
check("reject empty changeset -> 422", s == 422, str(d))
s, d = call(B, "POST", f"/requests/{req_id}/report", {"comment":"存在しないID", "changeset_ids":[666666]}, csrfB)
check("reject missing changeset -> 422", s == 422, str(d))
s, d = call(B, "GET", f"/requests/{req_id}")
check("invalid changesets never change assignment state", s == 200 and d["assignments"][0]["status"] == "joined", str(d["assignments"]))

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
s, d = call(A, "POST", f"/requests/{req2_id}/report", {"comment": "建物を編集", "changeset_ids": [223456]}, csrfA)
check("owner can report", s == 200 and d["request"]["status"] == "awaiting_review", str(d))
s, d = call(A, "GET", f"/requests/{req2_id}")
owner_assignment = next(a for a in d["assignments"] if a["user_osm_id"] == 1001)
check("owner report saves changeset", owner_assignment["changeset_ids"] == [223456], str(owner_assignment))
s, d = call(A, "POST", f"/requests/{req2_id}/review", {"assignment_id": owner_assignment["id"], "action": "approve"}, csrfA)
check("owner approval leaves other joined participant in progress", s == 200 and d["request"]["status"] == "in_progress", str(d))

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


# --- No-edit field verification and moderation
s, d = call(A, "POST", "/requests", {
    "title": "確認のみの依頼", "description": "対象設備の有無を確認",
    "category": "公園・緑地", "area": RECT
}, csrfA)
check("create no-edit task", s == 201, str(d))
noedit_id = d["request"]["id"]
s, d = call(B, "POST", f"/requests/{noedit_id}/join", {}, csrfB)
check("join no-edit task", s == 200, str(d))
s, d = call(B, "POST", f"/requests/{noedit_id}/report", {
    "report_kind": "no_changes", "comment": "現地確認の結果、既存データは正確でした",
    "changeset_ids": []
}, csrfB)
check("valid no-edit report accepted", s == 200 and d["request"]["status"] == "awaiting_review", str(d))
s, d = call(A, "GET", f"/requests/{noedit_id}")
noedit_assignment = d["assignments"][0]
check("no-edit kind persisted", noedit_assignment["report_kind"] == "no_changes" and noedit_assignment["changeset_ids"] == [], str(d))
s, d = call(A, "POST", f"/requests/{noedit_id}/review", {
    "assignment_id": noedit_assignment["id"], "action": "approve"
}, csrfA)
check("no-edit report can be approved", s == 200 and d["request"]["status"] == "completed", str(d))

s, d = call(anon, "POST", f"/requests/{noedit_id}/flag", {"reason": "不適切な依頼です"})
check("anonymous cannot flag -> 401", s == 401, str(d))
s, d = call(B, "GET", "/moderation/reports")
check("non-admin cannot see reports -> 403", s == 403, str(d))
s, d = call(B, "POST", f"/requests/{noedit_id}/flag", {"reason": "内容を確認してほしい依頼です"}, csrfB)
check("submit flag", s == 201, str(d))
s, d = call(B, "POST", f"/requests/{noedit_id}/flag", {"reason": "二回目の通報です"}, csrfB)
check("duplicate flag blocked", s == 409, str(d))
s, d = call(A, "GET", "/moderation/reports")
check("admin sees report queue", s == 200 and len(d["reports"]) == 1, str(d))
report_id = d["reports"][0]["id"]
s, d = call(B, "POST", f"/moderation/reports/{report_id}/review", {
    "decision": "hide", "note": "規約違反として非表示"
}, csrfB)
check("non-admin cannot hide -> 403", s == 403, str(d))
s, d = call(A, "POST", f"/moderation/reports/{report_id}/review", {
    "decision": "dismiss", "note": "問題がないことを確認"
}, csrfA)
check("admin can dismiss", s == 200, str(d))
s, d = call(A, "GET", "/moderation/reports")
check("dismissed flag not in open queue", s == 200 and d["reports"] == [], str(d))

# Separate flagged request to exercise hidden visibility and restoration.
s, d = call(A, "POST", "/requests", {
    "title": "一時非表示の確認", "description": "モデレーションによるアクセス制御",
    "category": "その他", "area": RECT
}, csrfA)
hidden_id = d["request"]["id"]
s, d = call(B, "POST", f"/requests/{hidden_id}/flag", {"reason": "この依頼を非表示にしてください"}, csrfB)
check("flag request for hiding", s == 201, str(d))
s, d = call(A, "GET", "/moderation/reports")
hidden_report_id = d["reports"][0]["id"]
s, d = call(A, "POST", f"/moderation/reports/{hidden_report_id}/review", {
    "decision": "hide", "note": "管理者による非表示処理"
}, csrfA)
check("admin can hide from report", s == 200, str(d))
s, d = call(anon, "GET", f"/requests/{hidden_id}")
check("hidden detail is not public -> 404", s == 404, str(d))
s, d = call(B, "GET", f"/requests/{hidden_id}")
check("hidden detail forbidden to regular users -> 404", s == 404, str(d))
s, d = call(anon, "GET", "/requests")
check("hidden request omitted from listing", s == 200 and not any(r["id"] == hidden_id for r in d["requests"]), str(d))
s, d = call(A, "GET", f"/requests/{hidden_id}")
check("owner/admin can see hidden detail", s == 200 and d["request"]["is_hidden"] is True, str(d["request"]))
s, d = call(B, "POST", f"/requests/{hidden_id}/join", {}, csrfB)
check("cannot join hidden request -> 409", s == 409, str(d))
s, d = call(A, "POST", f"/moderation/requests/{hidden_id}/visibility", {
    "hidden": False, "reason": "確認後に再公開するため"
}, csrfA)
check("admin can restore visibility", s == 200 and d.get("is_hidden") is False, str(d))
s, d = call(anon, "GET", f"/requests/{hidden_id}")
check("restored request public again", s == 200 and d["request"]["is_hidden"] is False, str(d))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
