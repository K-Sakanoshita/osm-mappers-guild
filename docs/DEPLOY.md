# 配置手順（本番）

> **異なるサイト間のOAuthセッション問題:** GitHub Pages `guild.openacrossbase.net` とさくらAPIを直接接続すると、
> Firefox等でCookieが分離され、ログイン成功後も `/me` が未ログインになる場合があります。
> Cloudflare Workerで `guild-api.openacrossbase.net` にAPIを公開する手順は
> [SAME_SITE_AUTH.md](SAME_SITE_AUTH.md) を参照してください。
> **Worker・OSM OAuthのURL・PHP設定を切替える前に `frontend/config.js` を本番公開しないでください。**


構成: フロントエンドは GitHub Pages、API は `armd-01.sakura.ne.jp` 配下の PHP、DB は MySQL を想定します。
正式なパス・ドメインは運用決定に合わせて読み替えてください（例: API は `https://armd-01.sakura.ne.jp/mappers-guild/api`）。

## 1. OSM OAuth 2.0 アプリケーションの登録

1. https://www.openstreetmap.org/ にログインし、「設定 → OAuth 2 アプリケーション」から新規登録します。
2. Redirect URI には API のコールバックURLを指定します。
   例: `https://armd-01.sakura.ne.jp/mappers-guild/api/auth/callback`
3. スコープは `read_prefs`（ユーザーIDと表示名の取得）を許可します。
4. 発行された Client ID / Client Secret を控えます（API の `config.php` にのみ記載し、リポジトリには含めません）。

## 2. MySQL データベース

1. さくらのコントロールパネルで MySQL データベースとユーザーを作成します。
2. `db/schema.mysql.sql` をそのデータベースに対して実行します（phpMyAdmin のインポート等）。

## 3. API の配置

1. `api/` フォルダをサーバへアップロードします（例: `~/www/mappers-guild/api/`）。
2. `api/config.sample.php` を `api/config.php` にコピーし、実値を設定します。
   - `app_env` は `production`
   - `db_dsn` / `db_user` / `db_pass` に MySQL の接続情報
   - `frontend_url` にフロントエンドの公開URL（ログイン後に戻る先）
   - `frontend_origins` にフロントエンドのオリジン（例: `https://<ユーザー名>.github.io`、独自ドメイン取得後はそのオリジン）
   - `public_api_url` に API の公開URL（例: `https://armd-01.sakura.ne.jp/mappers-guild/api`）
   - `osm_client_id` / `osm_client_secret` に手順1の値
   - `cookie_samesite` は `None`（フロントとAPIが別オリジンのため。HTTPS必須）
3. `config.php` は Web から直接読めないことを確認します（`.htaccess` で拒否設定済み。サーバ設定で `.htaccess` が無効な場合は配置場所を公開ディレクトリ外にする等、別途対策してください）。
4. 動作確認: `https://armd-01.sakura.ne.jp/mappers-guild/api/health` が `{"ok":true}` を返すこと。

## 4. フロントエンドの公開（GitHub Pages）

1. `frontend/config.js` の `apiBase` を API の公開URLに書き換えます。
   例: `apiBase: 'https://armd-01.sakura.ne.jp/mappers-guild/api'`
2. リポジトリの Settings → Pages で、Source を **GitHub Actions** に設定します。
3. `main` ブランチへ push すると `.github/workflows/pages.yml` が `frontend/` をデプロイします。
4. 独自ドメインは後で決定し、Pages のカスタムドメイン設定と `frontend_origins` / `frontend_url` の更新を行います。

## 5. 公開後の確認（MVP完了条件）

実ユーザー2人（依頼者・マッパー）で次を確認します。

1. 両者が OSM アカウントでログインできる
2. 依頼者が実データに基づく対象地域の依頼を投稿できる
3. マッパーが参加表明し、OSM で編集、Changeset ID 付きで成果報告できる
4. 依頼者が確認し、承認（または修正依頼）できる
5. マッパーが別の依頼にも同時参加できる

## 注意

- 報酬・謝礼は当事者間の扱いであり、ギルドは決済・支払い保証・仲介を行いません（画面にも明記しています）。
- `config.php` や DB パスワード、OAuth シークレットをリポジトリにコミットしないでください。
