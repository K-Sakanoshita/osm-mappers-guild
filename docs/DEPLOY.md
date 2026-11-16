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


## Phase 2: 依頼・成果へのいいねを追加する場合

**既存DBは再作成しないでください。** Phase 2 の旧テーブルがある既存DBでは、DBをバックアップし、旧APIのいいね操作を停止してから、次の移行を一度実行してください。

- MySQL（本番）: `db/migrations/003_unify_likes.mysql.sql`
- SQLite（開発）: `db/migrations/003_unify_likes.sqlite.sql`

例（MySQL CLIを利用できる場合）:

```bash
mysql -h YOUR_DB_HOST -u YOUR_DB_USER -p YOUR_DB_NAME < db/migrations/003_unify_likes.mysql.sql
```

さくらのphpMyAdminからSQLファイルをインポートしても構いません。依頼・成果へのいいねと作成日時を `likes` にコピーし、旧テーブルも残します。旧 Phase 1 DB の場合は先に `002_support_likes` を適用してください。新規インストールは最新のスキーマのみで構いません。

**重要：旧APIのいいね操作を停止した状態で移行し、新しい `api/index.php` を配置してから再開してください。** コピー後に旧APIが書き込むと、その変更は新テーブルに反映されません。新APIへの切り替え後に移行SQLを再実行すると、解除済みのいいねが復活するため、再実行しないでください。新APIは依頼一覧・詳細でも新テーブルを参照するため、DBより先に公開するとエラーになります。

### 新API

- `POST /requests/{id}/support` — `{"active":true}` で依頼にいいね、`false` で解除。本人の依頼には不可
- `POST /assignments/{id}/like` — 承認済み成果にいいね、`false` で解除。本人の成果はいいね不可
- `GET /requests` — `support_count` を追加
- `GET /requests/{id}` — `supported_by_me`、各参加者の `like_count` / `liked_by_me` を追加

POSTはログインと `X-CSRF-Token` が必要です。同じユーザーが同じ対象を繰り返しONにしても1件として計上します。ログインしていない利用者は件数を閲覧できます。

### 確認手順

1. MySQLへマイグレーションを適用し、新APIを配置
2. 新フロントをGitHub Pagesで公開
3. 他人が投稿した依頼にいいねし、カウントが増えることを確認
4. 依頼へのいいねの解除と重複防止を確認
5. 依頼者がマッパーの成果を承認し、その成果へのいいね・取り消しを確認
6. 未ログイン時は件数のみ表示、本人の依頼・成果にはいいねできないことを確認

テスト環境では `python3 tests/smoke_test.py` を再実行します。

## Phase 1 安全性強化（PR: マルチ参加者・Changeset検証・通報）

### 変更点
- 参加者が複数の場合、「完了」は参加者**全員**が承認済みの場合のみ。確認待ち・修正依頼・作業中を優先表示。取り下げは維持
- Changesetのサーバー側照合: OSM公式API `GET /api/0.6/changeset/{id}.json` にアクセスし、OSM user ID、変更件数、編集bboxと依頼bboxの重なりを検証。これは編集内容・品質の保証ではなく、最終判定は依頼者が行う
- 「現地確認したが変更不要」は `report_kind=no_changes` とChangeset 0件、コメント必須で報告できる
- 依頼を通報できる。管理者のみ通報一覧・対応不要/非表示・非表示解除が可能。非公開依頼は通常ユーザーの一覧・詳細から隠し、操作を止める
- 管理者操作は `moderation_actions` に記録される。管理者の指定は `config.php` のOSMユーザーID allowlist

### 本番反映手順（既存DB）

1. 本番MySQLの**全体バックアップ**を取る。適用中は依頼投稿や成果報告を止める
2. 既存の `002_support_likes`、`003_unify_likes` が適用済みであることを確認
3. `db/migrations/004_safety_moderation.mysql.sql` を**1回だけ実行**
   - `assignments.report_kind` と `requests.is_hidden` を追加
   - `moderation_reports` と `moderation_actions` を新規追加
   - 既存の誤った「完了」状態を、全参加者の承認状況から修正（withdrawnは対象外）
4. `api/config.php` に管理者を設定する（実際のOSM数値IDを使用、秘密情報として取り扱う）
   ```php
   'admin_osm_ids' => [12345678],
   ```
   ここでの `12345678` は**架空の例**。自分の実際のOSM IDに置き換える
5. `api/index.php` をさくらサーバへ配置。追加した `dev_changeset_api_base` は本番では**設定しない**
6. PRをマージしGitHub Pagesの更新を反映する
7. 本番環境で依頼者・マッパー・管理者のそれぞれの権限と動作を確認する

**DB未更新で新APIを配置すると、依頼の取得などで500エラーになる可能性があります。DB → API → フロントの順序を守ってください。**

### API・管理の仕様

- `POST /requests/{id}/report`: `{"report_kind":"edit","changeset_ids":[...],"comment":"..."}`、または `{"report_kind":"no_changes","changeset_ids":[],"comment":"..."}`
- `POST /requests/{id}/flag`: `{"reason":"10文字以上の通報理由"}`。要ログイン/CSRF、1依頼につき1ユーザー1件
- `GET /moderation/reports`: 管理者だけが未処理の通報一覧を取得（`?status=all` で対応済み含む）
- `POST /moderation/reports/{id}/review`: 管理者が `{"decision":"hide","note":"理由（5文字以上）"}` または `dismiss`
- `POST /moderation/requests/{id}/visibility`: 管理者が `{"hidden":false,"reason":"公開に戻す理由"}` 等を指定
- `GET /me`: `is_admin` を返す

### 制限と注意

- OSM changesetのbboxは対象領域と重なっていても、変更オブジェクトがその領域内にあるとは限らない。**成果品質の自動判定には使わない**
- OSM APIが一時的に応答しない場合、編集報告を受け付けず502を返す。障害時の回避として手動で偽のIDを通さない
- 調査で「変更不要」と判断した理由は依頼者が確認・承認する
- 通報理由は一般公開せず管理者のみに表示。非公開の依頼も作者と管理者は表示可能
- 通報・非表示機能は最低限のMVP対策。IP単位レート制限、管理者通知、利用規約・プライバシー文書等は別途検討する
