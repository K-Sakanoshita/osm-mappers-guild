# 開発手順（ローカル）

ビルド不要の構成です。PHP 8.x（PDO、curl、mbstring）と、開発用には SQLite が使えます。

## 1. 開発用DB（SQLite）を用意

```bash
sqlite3 guild.sqlite < db/schema.sqlite.sql
```

## 2. API設定（開発用）

```bash
cp api/config.sample.php api/config.php
```

`api/config.php` を開発用に編集します。

```php
'app_env' => 'dev',                       // dev-login を有効化
'db_dsn'  => 'sqlite:' . __DIR__ . '/../guild.sqlite',
'db_user' => '',
'db_pass' => '',
'frontend_url' => 'http://localhost:8080/frontend',
'frontend_origins' => ['http://localhost:8080'],
'cookie_samesite' => 'Lax',               // 同一オリジン開発では Lax
```

## 3. 起動

リポジトリルートをドキュメントルートにして PHP 組み込みサーバを起動します。

```bash
php -S localhost:8080 -t .
```

- フロントエンド: http://localhost:8080/frontend/
- API: http://localhost:8080/api/index.php/...

フロントエンドの `frontend/config.js` の `apiBase` は開発既定値 `/api/index.php` のままで動作します。

## 4. 開発用ログイン

`app_env = dev` のとき、画面上部に「開発用ログイン」が表示されます。
任意の OSM ユーザーIDと表示名でログインでき、OSM OAuth アプリを登録しなくても
「投稿 → 参加 → 報告 → 承認」の一連の流れを確認できます。
依頼者とマッパーで2ユーザーを作り、ブラウザを分けて（通常＋シークレット等）試すのが簡単です。

**本番では必ず `app_env = production` にしてください。** dev-login は無効化されます。

## 5. curl でのAPI確認例

```bash
# CSRFトークンとCookieを取得
curl -s -c cookies.txt http://localhost:8080/api/index.php/me
# 開発ログイン（CSRFトークンは /me の応答から）
curl -s -b cookies.txt -c cookies.txt -H 'Content-Type: application/json' \
  -H 'X-CSRF-Token: <token>' -X POST \
  -d '{"osm_user_id": 1001, "display_name": "テスト依頼者"}' \
  http://localhost:8080/api/index.php/auth/dev-login
# 依頼一覧
curl -s http://localhost:8080/api/index.php/requests
```

## 6. スモークテスト

`tests/smoke_test.py` は、dev-login を使って「投稿 → 参加 → 報告 → 修正依頼 → 再報告 → 承認」の
一連の流れと認可・バリデーションを通しで確認するスクリプトです。
サーバを `127.0.0.1:8099` で起動し、SQLite のテスト用DBを用意したうえで実行します。

```bash
python3 tests/smoke_test.py
```
