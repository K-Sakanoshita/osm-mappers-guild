<?php
/**
 * OSM Mappers Guild API (Phase 1 MVP)
 *
 * 単一ファイルのフロントコントローラ。Apache では .htaccess により
 * すべてのリクエストがここへ集約される。開発時は PHP 組み込みサーバで
 * /api/index.php/<route> の形でもアクセスできる。
 *
 * 認証: OSM OAuth 2.0（認可コードフロー）。セッションはCookieで管理し、
 * 状態変更系APIは CSRF トークン（/api/me で配布、X-CSRF-Token ヘッダ）を必須とする。
 */

declare(strict_types=1);

// ---------------------------------------------------------------- bootstrap

$configFile = __DIR__ . '/config.php';
if (!file_exists($configFile)) {
    $configFile = __DIR__ . '/config.sample.php';
}
$config = require $configFile;

header('Content-Type: application/json; charset=utf-8');

// CORS: 許可オリジンからの credentialed リクエストのみ通す
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array($origin, $config['frontend_origins'] ?? [], true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Credentials: true');
    header('Vary: Origin');
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        header('Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, X-CSRF-Token');
        header('Access-Control-Max-Age: 86400');
        http_response_code(204);
        exit;
    }
}

// セッション（クロスオリジン運用を想定し SameSite は設定値に従う）
$samesite = $config['cookie_samesite'] ?? 'Lax';
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'secure' => $samesite === 'None' || (($_SERVER['HTTPS'] ?? '') !== '' && ($_SERVER['HTTPS'] ?? '') !== 'off'),
    'httponly' => true,
    'samesite' => $samesite,
]);
session_name('MGSESSID');
session_start();
if (empty($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

try {
    $db = new PDO($config['db_dsn'], $config['db_user'] ?: null, $config['db_pass'] ?: null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    if (str_starts_with($config['db_dsn'], 'sqlite:')) {
        $db->exec('PRAGMA foreign_keys = ON');
    }
} catch (Throwable $e) {
    error_log('DB connect failed: ' . $e->getMessage());
    fail(500, 'データベースに接続できません');
}

// ------------------------------------------------------------------ helpers

function fail(int $code, string $message): void
{
    http_response_code($code);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function out($data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function now(): string
{
    return date('Y-m-d H:i:s');
}

function body_json(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    if (strlen($raw) > 1024 * 1024) {
        fail(413, 'リクエストが大きすぎます');
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        fail(400, 'JSONの形式が正しくありません');
    }
    return $data;
}

function current_user(PDO $db): ?array
{
    $id = $_SESSION['user_id'] ?? null;
    if (!$id) {
        return null;
    }
    $stmt = $db->prepare('SELECT id, osm_user_id, display_name, created_at FROM users WHERE id = ?');
    $stmt->execute([$id]);
    $user = $stmt->fetch();
    return $user ?: null;
}

function require_login(PDO $db): array
{
    $user = current_user($db);
    if (!$user) {
        fail(401, 'ログインが必要です');
    }
    return $user;
}

function require_csrf(): void
{
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!hash_equals($_SESSION['csrf'] ?? '', $token)) {
        fail(403, 'CSRFトークンが一致しません');
    }
}

function str_len(string $s): int
{
    return mb_strlen($s, 'UTF-8');
}

function valid_text($v, int $min, int $max): bool
{
    return is_string($v) && str_len(trim($v)) >= $min && str_len($v) <= $max;
}

const CATEGORIES = ['建物', '道路・交通', '公園・緑地', '店舗・施設', '住所', '自然・水系', 'その他'];
const REQUEST_STATUSES = ['open', 'in_progress', 'awaiting_review', 'changes_requested', 'completed', 'withdrawn'];

/** 矩形ポリゴン（GeoJSON）であることを検証する。 */
function valid_rectangle($area): bool
{
    if (!is_array($area) || ($area['type'] ?? '') !== 'Polygon') {
        return false;
    }
    $rings = $area['coordinates'] ?? null;
    if (!is_array($rings) || count($rings) !== 1 || !is_array($rings[0]) || count($rings[0]) !== 5) {
        return false;
    }
    $lngs = [];
    $lats = [];
    foreach ($rings[0] as $pt) {
        if (!is_array($pt) || count($pt) !== 2 || !is_numeric($pt[0]) || !is_numeric($pt[1])) {
            return false;
        }
        [$lng, $lat] = [(float)$pt[0], (float)$pt[1]];
        if ($lng < -180 || $lng > 180 || $lat < -85 || $lat > 85) {
            return false;
        }
        $lngs[] = $lng;
        $lats[] = $lat;
    }
    // 始点と終点が一致し、経度・緯度がそれぞれ2値ずつ = 軸平行な矩形
    if ($rings[0][0] !== $rings[0][4]) {
        return false;
    }
    return count(array_unique($lngs)) === 2 && count(array_unique($lats)) === 2;
}

function log_event(PDO $db, int $requestId, ?int $assignmentId, int $actorId, string $type, ?string $comment): void
{
    $stmt = $db->prepare('INSERT INTO review_events (request_id, assignment_id, actor_user_id, event_type, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    $stmt->execute([$requestId, $assignmentId, $actorId, $type, $comment, now()]);
}

/** 参加状況から依頼ステータスを再計算する（取り下げは維持）。 */
function recompute_status(PDO $db, int $requestId): void
{
    $stmt = $db->prepare('SELECT status FROM requests WHERE id = ?');
    $stmt->execute([$requestId]);
    $req = $stmt->fetch();
    if (!$req || $req['status'] === 'withdrawn') {
        return;
    }
    $stmt = $db->prepare('SELECT status FROM assignments WHERE request_id = ?');
    $stmt->execute([$requestId]);
    $statuses = array_column($stmt->fetchAll(), 'status');
    if (in_array('reported', $statuses, true)) {
        $next = 'awaiting_review';
    } elseif (in_array('approved', $statuses, true)) {
        $next = 'completed';
    } elseif (in_array('changes_requested', $statuses, true)) {
        $next = 'changes_requested';
    } elseif (in_array('joined', $statuses, true)) {
        $next = 'in_progress';
    } else {
        $next = 'open';
    }
    $stmt = $db->prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?');
    $stmt->execute([$next, now(), $requestId]);
}

function fetch_request(PDO $db, int $id): ?array
{
    $stmt = $db->prepare(
        'SELECT r.*, u.display_name AS owner_name, u.osm_user_id AS owner_osm_id,
                (SELECT COUNT(*) FROM request_supports rs WHERE rs.request_id = r.id) AS support_count
         FROM requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?'
    );
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function present_request(array $row): array
{
    $row['area'] = json_decode($row['area_geojson'], true);
    unset($row['area_geojson']);
    $row['id'] = (int)$row['id'];
    $row['user_id'] = (int)$row['user_id'];
    $row['owner_osm_id'] = (int)$row['owner_osm_id'];
    if (isset($row['participant_count'])) {
        $row['participant_count'] = (int)$row['participant_count'];
    }
    if (isset($row['support_count'])) {
        $row['support_count'] = (int)$row['support_count'];
    }
    return $row;
}

function public_api_url(array $config): string
{
    if (!empty($config['public_api_url'])) {
        return rtrim($config['public_api_url'], '/');
    }
    $scheme = (($_SERVER['HTTPS'] ?? '') !== '' && ($_SERVER['HTTPS'] ?? '') !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/index.php'), '/');
    return $scheme . '://' . $host . $dir;
}

function http_post_form(string $url, array $params): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query($params),
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_TIMEOUT => 30,
    ]);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $data = is_string($res) ? json_decode($res, true) : null;
    return [$code, is_array($data) ? $data : []];
}

function http_get_json(string $url, string $bearer): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'Authorization: Bearer ' . $bearer],
        CURLOPT_TIMEOUT => 30,
    ]);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $data = is_string($res) ? json_decode($res, true) : null;
    return [$code, is_array($data) ? $data : []];
}

function upsert_user(PDO $db, int $osmId, string $displayName): array
{
    $stmt = $db->prepare('SELECT id FROM users WHERE osm_user_id = ?');
    $stmt->execute([$osmId]);
    $row = $stmt->fetch();
    if ($row) {
        $stmt = $db->prepare('UPDATE users SET display_name = ? WHERE id = ?');
        $stmt->execute([$displayName, $row['id']]);
        $id = (int)$row['id'];
    } else {
        $stmt = $db->prepare('INSERT INTO users (osm_user_id, display_name, created_at) VALUES (?, ?, ?)');
        $stmt->execute([$osmId, $displayName, now()]);
        $id = (int)$db->lastInsertId();
    }
    $stmt = $db->prepare('SELECT id, osm_user_id, display_name, created_at FROM users WHERE id = ?');
    $stmt->execute([$id]);
    return $stmt->fetch();
}

// ------------------------------------------------------------------- router

$uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$script = $_SERVER['SCRIPT_NAME'] ?? '/index.php';
if (str_starts_with($uriPath, $script)) {
    $route = substr($uriPath, strlen($script));
} else {
    $base = rtrim(dirname($script), '/');
    $route = str_starts_with($uriPath, $base) ? substr($uriPath, strlen($base)) : $uriPath;
}
$route = '/' . trim($route, '/');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    route($db, $config, $method, $route);
} catch (Throwable $e) {
    error_log('API error: ' . $e->getMessage());
    fail(500, 'サーバ内部でエラーが発生しました');
}

function route(PDO $db, array $config, string $method, string $route): void
{
    if ($route === '/health' && $method === 'GET') {
        out(['ok' => true]);
    }

    if ($route === '/me' && $method === 'GET') {
        $user = current_user($db);
        out([
            'user' => $user ? [
                'id' => (int)$user['id'],
                'osm_user_id' => (int)$user['osm_user_id'],
                'display_name' => $user['display_name'],
            ] : null,
            'csrf_token' => $_SESSION['csrf'],
            'dev_login_enabled' => ($config['app_env'] ?? '') === 'dev',
            'categories' => CATEGORIES,
        ]);
    }

    // ------------------------------------------------------------- auth
    if ($route === '/auth/login' && $method === 'GET') {
        if (empty($config['osm_client_id'])) {
            fail(500, 'OSM OAuth が未設定です（osm_client_id）');
        }
        $state = bin2hex(random_bytes(16));
        $_SESSION['oauth_state'] = $state;
        $redirectUri = public_api_url($config) . '/auth/callback';
        $url = 'https://www.openstreetmap.org/oauth2/authorize?' . http_build_query([
            'response_type' => 'code',
            'client_id' => $config['osm_client_id'],
            'redirect_uri' => $redirectUri,
            'scope' => 'read_prefs',
            'state' => $state,
        ]);
        header('Location: ' . $url);
        exit;
    }

    if ($route === '/auth/callback' && $method === 'GET') {
        $code = $_GET['code'] ?? '';
        $state = $_GET['state'] ?? '';
        if (!is_string($code) || $code === '' || !hash_equals($_SESSION['oauth_state'] ?? '', (string)$state)) {
            fail(400, 'OAuthの状態が一致しません');
        }
        unset($_SESSION['oauth_state']);
        [$tcode, $token] = http_post_form('https://www.openstreetmap.org/oauth2/token', [
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => public_api_url($config) . '/auth/callback',
            'client_id' => $config['osm_client_id'],
            'client_secret' => $config['osm_client_secret'],
        ]);
        if ($tcode !== 200 || empty($token['access_token'])) {
            fail(502, 'OSMからアクセストークンを取得できませんでした');
        }
        [$ucode, $details] = http_get_json('https://api.openstreetmap.org/api/0.6/user/details.json', $token['access_token']);
        $osmUser = $details['user'] ?? null;
        if ($ucode !== 200 || !$osmUser || !isset($osmUser['id'])) {
            fail(502, 'OSMのユーザー情報を取得できませんでした');
        }
        $user = upsert_user($db, (int)$osmUser['id'], (string)($osmUser['display_name'] ?? ('user' . $osmUser['id'])));
        session_regenerate_id(true);
        $_SESSION['user_id'] = (int)$user['id'];
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        header('Location: ' . rtrim($config['frontend_url'], '/') . '/');
        exit;
    }

    if ($route === '/auth/logout' && $method === 'POST') {
        require_csrf();
        unset($_SESSION['user_id']);
        out(['ok' => true]);
    }

    if ($route === '/auth/dev-login' && $method === 'POST') {
        // 開発専用: OSM OAuth アプリ未登録でも一連の流れを確認するための疑似ログイン。
        // 本番（app_env != dev）では常に無効。
        if (($config['app_env'] ?? '') !== 'dev') {
            fail(404, 'not found');
        }
        require_csrf();
        $b = body_json();
        $osmId = filter_var($b['osm_user_id'] ?? null, FILTER_VALIDATE_INT);
        if ($osmId === false || $osmId <= 0 || !valid_text($b['display_name'] ?? null, 1, 100)) {
            fail(400, 'osm_user_id（正の整数）と display_name（1〜100文字）が必要です');
        }
        $user = upsert_user($db, (int)$osmId, trim($b['display_name']));
        session_regenerate_id(true);
        $_SESSION['user_id'] = (int)$user['id'];
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        out(['user' => ['id' => (int)$user['id'], 'osm_user_id' => (int)$user['osm_user_id'], 'display_name' => $user['display_name']]]);
    }

    // ---------------------------------------------------------- requests
    if ($route === '/requests' && $method === 'GET') {
        $where = [];
        $args = [];
        $status = $_GET['status'] ?? '';
        if (is_string($status) && $status !== '') {
            if (!in_array($status, REQUEST_STATUSES, true)) {
                fail(400, 'status の値が不正です');
            }
            $where[] = 'r.status = ?';
            $args[] = $status;
        }
        $category = $_GET['category'] ?? '';
        if (is_string($category) && $category !== '') {
            if (!in_array($category, CATEGORIES, true)) {
                fail(400, 'category の値が不正です');
            }
            $where[] = 'r.category = ?';
            $args[] = $category;
        }
        if (($_GET['owner'] ?? '') === 'me' || ($_GET['participating'] ?? '') === 'me') {
            $me = require_login($db);
            if (($_GET['owner'] ?? '') === 'me') {
                $where[] = 'r.user_id = ?';
                $args[] = $me['id'];
            }
            if (($_GET['participating'] ?? '') === 'me') {
                $where[] = 'EXISTS (SELECT 1 FROM assignments a WHERE a.request_id = r.id AND a.user_id = ?)';
                $args[] = $me['id'];
            }
        }
        $sql = 'SELECT r.*, u.display_name AS owner_name, u.osm_user_id AS owner_osm_id,
                       (SELECT COUNT(*) FROM assignments a WHERE a.request_id = r.id) AS participant_count,
                       (SELECT COUNT(*) FROM request_supports rs WHERE rs.request_id = r.id) AS support_count
                FROM requests r JOIN users u ON u.id = r.user_id';
        if ($where) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY r.updated_at DESC LIMIT 100';
        $stmt = $db->prepare($sql);
        $stmt->execute($args);
        out(['requests' => array_map('present_request', $stmt->fetchAll())]);
    }

    if ($route === '/requests' && $method === 'POST') {
        $me = require_login($db);
        require_csrf();
        $b = body_json();
        if (!valid_text($b['title'] ?? null, 1, 120)) {
            fail(400, 'タイトルは1〜120文字で入力してください');
        }
        if (!valid_text($b['description'] ?? null, 1, 5000)) {
            fail(400, '説明は1〜5000文字で入力してください');
        }
        if (!in_array($b['category'] ?? '', CATEGORIES, true)) {
            fail(400, 'カテゴリが不正です');
        }
        $reward = $b['reward_text'] ?? null;
        if ($reward !== null && !valid_text($reward, 1, 300)) {
            fail(400, '報酬・謝礼欄は300文字以内で入力してください');
        }
        if (!valid_rectangle($b['area'] ?? null)) {
            fail(400, '対象エリアは矩形（ポリゴン）で指定してください');
        }
        $stmt = $db->prepare('INSERT INTO requests (user_id, title, description, category, reward_text, area_geojson, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([
            $me['id'], trim($b['title']), $b['description'], $b['category'],
            $reward !== null ? trim($reward) : null,
            json_encode($b['area'], JSON_UNESCAPED_UNICODE), 'open', now(), now(),
        ]);
        $id = (int)$db->lastInsertId();
        log_event($db, $id, null, (int)$me['id'], 'create', null);
        out(['request' => present_request(fetch_request($db, $id))], 201);
    }

    if (preg_match('#^/requests/(\d+)$#', $route, $m)) {
        $id = (int)$m[1];
        if ($method === 'GET') {
            $req = fetch_request($db, $id);
            if (!$req) {
                fail(404, '依頼が見つかりません');
            }
            $stmt = $db->prepare(
                'SELECT a.*, u.display_name AS user_name, u.osm_user_id AS user_osm_id
                 FROM assignments a JOIN users u ON u.id = a.user_id
                 WHERE a.request_id = ? ORDER BY a.created_at ASC'
            );
            $stmt->execute([$id]);
            $assignments = $stmt->fetchAll();
            $viewer = current_user($db);
            $csStmt = $db->prepare('SELECT changeset_id FROM assignment_changesets WHERE assignment_id = ? ORDER BY changeset_id ASC');
            $likeCountStmt = $db->prepare('SELECT COUNT(*) FROM assignment_likes WHERE assignment_id = ?');
            $myLikeStmt = $db->prepare('SELECT 1 FROM assignment_likes WHERE assignment_id = ? AND user_id = ?');
            foreach ($assignments as &$a) {
                $csStmt->execute([$a['id']]);
                $a['changeset_ids'] = array_map('intval', array_column($csStmt->fetchAll(), 'changeset_id'));
                $a['id'] = (int)$a['id'];
                $a['user_id'] = (int)$a['user_id'];
                $a['user_osm_id'] = (int)$a['user_osm_id'];
                $likeCountStmt->execute([$a['id']]);
                $a['like_count'] = (int)$likeCountStmt->fetchColumn();
                $a['liked_by_me'] = false;
                if ($viewer) {
                    $myLikeStmt->execute([$a['id'], $viewer['id']]);
                    $a['liked_by_me'] = (bool)$myLikeStmt->fetchColumn();
                }
            }
            unset($a);
            $stmt = $db->prepare(
                'SELECT e.*, u.display_name AS actor_name FROM review_events e
                 JOIN users u ON u.id = e.actor_user_id
                 WHERE e.request_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 100'
            );
            $stmt->execute([$id]);
            $events = $stmt->fetchAll();
            $supportedByMe = false;
            if ($viewer) {
                $supportStmt = $db->prepare('SELECT 1 FROM request_supports WHERE request_id = ? AND user_id = ?');
                $supportStmt->execute([$id, $viewer['id']]);
                $supportedByMe = (bool)$supportStmt->fetchColumn();
            }
            out([
                'request' => present_request($req),
                'assignments' => $assignments,
                'events' => $events,
                'supported_by_me' => $supportedByMe,
            ]);
        }
        if ($method === 'PATCH') {
            $me = require_login($db);
            require_csrf();
            $req = fetch_request($db, $id);
            if (!$req) {
                fail(404, '依頼が見つかりません');
            }
            if ((int)$req['user_id'] !== (int)$me['id']) {
                fail(403, '自分の依頼のみ編集できます');
            }
            if ($req['status'] === 'withdrawn') {
                fail(409, '取り下げ済みの依頼は編集できません');
            }
            $b = body_json();
            $fields = [];
            $args = [];
            if (array_key_exists('title', $b)) {
                if (!valid_text($b['title'], 1, 120)) {
                    fail(400, 'タイトルは1〜120文字で入力してください');
                }
                $fields[] = 'title = ?';
                $args[] = trim($b['title']);
            }
            if (array_key_exists('description', $b)) {
                if (!valid_text($b['description'], 1, 5000)) {
                    fail(400, '説明は1〜5000文字で入力してください');
                }
                $fields[] = 'description = ?';
                $args[] = $b['description'];
            }
            if (array_key_exists('category', $b)) {
                if (!in_array($b['category'], CATEGORIES, true)) {
                    fail(400, 'カテゴリが不正です');
                }
                $fields[] = 'category = ?';
                $args[] = $b['category'];
            }
            if (array_key_exists('reward_text', $b)) {
                if ($b['reward_text'] !== null && !valid_text($b['reward_text'], 1, 300)) {
                    fail(400, '報酬・謝礼欄は300文字以内で入力してください');
                }
                $fields[] = 'reward_text = ?';
                $args[] = $b['reward_text'] !== null ? trim($b['reward_text']) : null;
            }
            if (array_key_exists('area', $b)) {
                if (!valid_rectangle($b['area'])) {
                    fail(400, '対象エリアは矩形（ポリゴン）で指定してください');
                }
                $fields[] = 'area_geojson = ?';
                $args[] = json_encode($b['area'], JSON_UNESCAPED_UNICODE);
            }
            if (!$fields) {
                fail(400, '変更項目がありません');
            }
            $fields[] = 'updated_at = ?';
            $args[] = now();
            $args[] = $id;
            $stmt = $db->prepare('UPDATE requests SET ' . implode(', ', $fields) . ' WHERE id = ?');
            $stmt->execute($args);
            log_event($db, $id, null, (int)$me['id'], 'edit', null);
            out(['request' => present_request(fetch_request($db, $id))]);
        }
    }

    // Phase 2: 依頼への応援（同じユーザーは1件につき1回、ON/OFFは冪等）
    if (preg_match('#^/requests/(\d+)/support$#', $route, $m) && $method === 'POST') {
        $me = require_login($db);
        require_csrf();
        $id = (int)$m[1];
        $req = fetch_request($db, $id);
        if (!$req) {
            fail(404, '依頼が見つかりません');
        }
        $b = body_json();
        if (!isset($b['active']) || !is_bool($b['active'])) {
            fail(400, 'active は真偽値で指定してください');
        }
        if ((int)$req['user_id'] === (int)$me['id']) {
            fail(403, '自分の依頼には応援を付けられません');
        }
        if ($b['active'] && $req['status'] === 'withdrawn') {
            fail(409, '取り下げ済みの依頼には応援できません');
        }
        if ($b['active']) {
            $insertSql = str_starts_with($config['db_dsn'], 'sqlite:')
                ? 'INSERT OR IGNORE INTO request_supports (request_id, user_id, created_at) VALUES (?, ?, ?)'
                : 'INSERT IGNORE INTO request_supports (request_id, user_id, created_at) VALUES (?, ?, ?)';
            $db->prepare($insertSql)->execute([$id, $me['id'], now()]);
        } else {
            $db->prepare('DELETE FROM request_supports WHERE request_id = ? AND user_id = ?')->execute([$id, $me['id']]);
        }
        $stmt = $db->prepare('SELECT COUNT(*) FROM request_supports WHERE request_id = ?');
        $stmt->execute([$id]);
        out(['support_count' => (int)$stmt->fetchColumn(), 'supported_by_me' => $b['active']]);
    }

    // Phase 2: 承認済み成果へのいいね（自己評価は禁止）
    if (preg_match('#^/assignments/(\d+)/like$#', $route, $m) && $method === 'POST') {
        $me = require_login($db);
        require_csrf();
        $id = (int)$m[1];
        $stmt = $db->prepare(
            'SELECT a.id, a.user_id, a.status, r.status AS request_status
             FROM assignments a JOIN requests r ON r.id = a.request_id WHERE a.id = ?'
        );
        $stmt->execute([$id]);
        $assignment = $stmt->fetch();
        if (!$assignment) {
            fail(404, '成果が見つかりません');
        }
        if ($assignment['status'] !== 'approved' || $assignment['request_status'] === 'withdrawn') {
            fail(409, '承認済みの成果にのみいいねできます');
        }
        if ((int)$assignment['user_id'] === (int)$me['id']) {
            fail(403, '自分の成果にはいいねできません');
        }
        $b = body_json();
        if (!isset($b['active']) || !is_bool($b['active'])) {
            fail(400, 'active は真偽値で指定してください');
        }
        if ($b['active']) {
            $insertSql = str_starts_with($config['db_dsn'], 'sqlite:')
                ? 'INSERT OR IGNORE INTO assignment_likes (assignment_id, user_id, created_at) VALUES (?, ?, ?)'
                : 'INSERT IGNORE INTO assignment_likes (assignment_id, user_id, created_at) VALUES (?, ?, ?)';
            $db->prepare($insertSql)->execute([$id, $me['id'], now()]);
        } else {
            $db->prepare('DELETE FROM assignment_likes WHERE assignment_id = ? AND user_id = ?')->execute([$id, $me['id']]);
        }
        $stmt = $db->prepare('SELECT COUNT(*) FROM assignment_likes WHERE assignment_id = ?');
        $stmt->execute([$id]);
        out(['like_count' => (int)$stmt->fetchColumn(), 'liked_by_me' => $b['active']]);
    }

    if (preg_match('#^/requests/(\d+)/(withdraw|join|leave|report|review)$#', $route, $m) && $method === 'POST') {
        $id = (int)$m[1];
        $action = $m[2];
        $me = require_login($db);
        require_csrf();
        $req = fetch_request($db, $id);
        if (!$req) {
            fail(404, '依頼が見つかりません');
        }
        $isOwner = (int)$req['user_id'] === (int)$me['id'];

        $myAssignment = null;
        $stmt = $db->prepare('SELECT * FROM assignments WHERE request_id = ? AND user_id = ?');
        $stmt->execute([$id, $me['id']]);
        $myAssignment = $stmt->fetch() ?: null;

        if ($action === 'withdraw') {
            if (!$isOwner) {
                fail(403, '依頼者のみ取り下げできます');
            }
            if ($req['status'] === 'withdrawn') {
                fail(409, 'すでに取り下げ済みです');
            }
            $stmt = $db->prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?');
            $stmt->execute(['withdrawn', now(), $id]);
            log_event($db, $id, null, (int)$me['id'], 'withdraw', null);
            out(['request' => present_request(fetch_request($db, $id))]);
        }

        if ($action === 'join') {
            if ($isOwner) {
                fail(400, '自分の依頼には参加表明できません');
            }
            if (in_array($req['status'], ['completed', 'withdrawn'], true)) {
                fail(409, 'この依頼は参加を受け付けていません');
            }
            if ($myAssignment) {
                fail(409, 'すでに参加しています');
            }
            $stmt = $db->prepare('INSERT INTO assignments (request_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
            $stmt->execute([$id, $me['id'], 'joined', now(), now()]);
            $assignmentId = (int)$db->lastInsertId();
            log_event($db, $id, $assignmentId, (int)$me['id'], 'join', null);
            recompute_status($db, $id);
            out(['ok' => true, 'request' => present_request(fetch_request($db, $id))]);
        }

        if ($action === 'leave') {
            if (!$myAssignment) {
                fail(409, '参加していません');
            }
            if (!in_array($myAssignment['status'], ['joined', 'changes_requested'], true)) {
                fail(409, '報告済み・承認済みの参加は解除できません');
            }
            $stmt = $db->prepare('DELETE FROM assignment_changesets WHERE assignment_id = ?');
            $stmt->execute([$myAssignment['id']]);
            $stmt = $db->prepare('DELETE FROM assignments WHERE id = ?');
            $stmt->execute([$myAssignment['id']]);
            log_event($db, $id, null, (int)$me['id'], 'leave', null);
            recompute_status($db, $id);
            out(['ok' => true, 'request' => present_request(fetch_request($db, $id))]);
        }

        if ($action === 'report') {
            if (!$myAssignment) {
                fail(403, '参加しているマッパーのみ報告できます');
            }
            if ($req['status'] === 'withdrawn') {
                fail(409, '取り下げ済みの依頼には報告できません');
            }
            if (!in_array($myAssignment['status'], ['joined', 'changes_requested'], true)) {
                fail(409, 'この参加はすでに報告済みです');
            }
            $b = body_json();
            if (!valid_text($b['comment'] ?? null, 1, 2000)) {
                fail(400, '報告コメントは1〜2000文字で入力してください');
            }
            $changesets = $b['changeset_ids'] ?? [];
            if (!is_array($changesets) || count($changesets) > 50) {
                fail(400, 'Changeset ID は50件までです');
            }
            $csIds = [];
            foreach ($changesets as $c) {
                $ci = filter_var($c, FILTER_VALIDATE_INT);
                if ($ci === false || $ci <= 0) {
                    fail(400, 'Changeset ID は正の整数で指定してください');
                }
                $csIds[(int)$ci] = true;
            }
            $stmt = $db->prepare('UPDATE assignments SET status = ?, updated_at = ? WHERE id = ?');
            $stmt->execute(['reported', now(), $myAssignment['id']]);
            $ins = $db->prepare('INSERT OR IGNORE INTO assignment_changesets (assignment_id, changeset_id, created_at) VALUES (?, ?, ?)');
            if (!str_starts_with($config['db_dsn'], 'sqlite:')) {
                $ins = $db->prepare('INSERT IGNORE INTO assignment_changesets (assignment_id, changeset_id, created_at) VALUES (?, ?, ?)');
            }
            foreach (array_keys($csIds) as $ci) {
                $ins->execute([$myAssignment['id'], $ci, now()]);
            }
            log_event($db, $id, (int)$myAssignment['id'], (int)$me['id'], 'report', trim($b['comment']));
            recompute_status($db, $id);
            out(['ok' => true, 'request' => present_request(fetch_request($db, $id))]);
        }

        if ($action === 'review') {
            if (!$isOwner) {
                fail(403, '依頼者のみ確認できます');
            }
            $b = body_json();
            $assignmentId = filter_var($b['assignment_id'] ?? null, FILTER_VALIDATE_INT);
            $act = $b['action'] ?? '';
            if ($assignmentId === false || !in_array($act, ['approve', 'request_changes'], true)) {
                fail(400, 'assignment_id と action（approve / request_changes）が必要です');
            }
            $comment = $b['comment'] ?? null;
            if ($comment !== null && !valid_text($comment, 1, 2000)) {
                fail(400, 'コメントは2000文字以内で入力してください');
            }
            $stmt = $db->prepare('SELECT * FROM assignments WHERE id = ? AND request_id = ?');
            $stmt->execute([(int)$assignmentId, $id]);
            $target = $stmt->fetch();
            if (!$target) {
                fail(404, '対象の参加が見つかりません');
            }
            if ($target['status'] !== 'reported') {
                fail(409, '報告済みの参加のみ確認できます');
            }
            $next = $act === 'approve' ? 'approved' : 'changes_requested';
            $stmt = $db->prepare('UPDATE assignments SET status = ?, updated_at = ? WHERE id = ?');
            $stmt->execute([$next, now(), $target['id']]);
            log_event($db, $id, (int)$target['id'], (int)$me['id'], $act, $comment !== null ? trim($comment) : null);
            recompute_status($db, $id);
            out(['ok' => true, 'request' => present_request(fetch_request($db, $id))]);
        }
    }

    fail(404, 'not found');
}
