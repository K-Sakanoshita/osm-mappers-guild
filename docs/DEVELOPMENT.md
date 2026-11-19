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
'db_dsn'  => 'sqlite:' . __DIR__ . '/../guild.sqlite',
'db_user' => '',
'db_pass' => '',
'frontend_url' => 'http://localhost:8080/frontend',
'frontend_origins' => ['http://localhost:8080'],
'public_api_url' => 'http://localhost:8080/api/index.php',
'cookie_samesite' => 'Lax',               // 同一オリジン開発では Lax
```

## 3. 起動

リポジトリルートをドキュメントルートにして PHP 組み込みサーバを起動します。

```bash
php -S localhost:8080 -t .
```

- フロントエンド: http://localhost:8080/frontend/
- API: http://localhost:8080/api/index.php/...

ローカルで試すときは、`frontend/config.js` の `apiBase` を一時的に `/api/index.php` に変更します。

## 4. OpenStreetMap でログイン

OpenStreetMap の OAuth アプリにリダイレクト URI `http://localhost:8080/api/index.php/auth/callback` と権限 `read_prefs` を設定します。
発行されたクライアント ID とシークレットを `api/config.php` の `osm_client_id` と `osm_client_secret` に設定し、画面の「OSMでログイン」を使います。

## 5. curl でのAPI確認例

```bash
# 依頼一覧
curl -s http://localhost:8080/api/index.php/requests
```

## 6. スモークテスト

PHP CLI（PDO SQLite 有効）と Python 3 が必要です。スクリプトは一時 DB とテスト専用セッションを用意し、
`127.0.0.1:8099` でテストサーバーを起動します。投稿から承認までの流れ、認可、バリデーションを確認できます。

```bash
bash tests/run_smoke_test.sh
```
