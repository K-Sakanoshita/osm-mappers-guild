<?php
// OSM Mappers Guild API 設定サンプル。
// このファイルを config.php にコピーして、実際の値を入れてください。
// config.php は .gitignore 済みで、リポジトリには含めません。
//
// 環境変数でも上書きできます（MG_DB_DSN, MG_DB_USER, MG_DB_PASS,
// MG_OSM_CLIENT_ID, MG_OSM_CLIENT_SECRET, MG_FRONTEND_URL, MG_APP_ENV）。

return [
    // 'production' または 'dev'。dev のときだけ /auth/dev-login が有効になる。
    'app_env' => getenv('MG_APP_ENV') ?: 'production',

    // DB接続。MySQL: 'mysql:host=localhost;dbname=xxxx;charset=utf8mb4'
    // 開発用SQLite: 'sqlite:/path/to/guild.sqlite'
    'db_dsn'  => getenv('MG_DB_DSN') ?: 'mysql:host=localhost;dbname=CHANGE_ME;charset=utf8mb4',
    'db_user' => getenv('MG_DB_USER') ?: 'CHANGE_ME',
    'db_pass' => getenv('MG_DB_PASS') ?: 'CHANGE_ME',

    // フロントエンドのURL（OAuthログイン後に戻る先、末尾スラッシュなし）
    'frontend_url' => getenv('MG_FRONTEND_URL') ?: 'https://example.github.io/osm-mappers-guild',

    // CORSを許可するフロントエンドのオリジン一覧（スキーム+ホスト+ポート）
    'frontend_origins' => [
        'https://example.github.io',
    ],

    // このAPIの公開URL（末尾スラッシュなし）。OAuthのリダイレクトURI生成に使う。
    // 別ドメインへのAPI直接アクセスではサードパーティCookie制限を受け得ます。
    // 本番Cloudflare Worker利用時: 'https://guild-api.openacrossbase.net/api'
    // 直接公開時: 'https://armd-01.sakura.ne.jp/mappers-guild/api'
    // null の場合はリクエストから推定する。
    'public_api_url' => null,

    // OSM OAuth 2.0 アプリケーション（openstreetmap.org で登録して取得）
    'osm_client_id'     => getenv('MG_OSM_CLIENT_ID') ?: '',
    'osm_client_secret' => getenv('MG_OSM_CLIENT_SECRET') ?: '',

    // セッションCookieのSameSite。
    // guild.openacrossbase.net と guild-api.openacrossbase.net は別オリジンですが同一サイトなので 'Lax' を推奨。
    // localhost と本番APIの通信は別サイトなので、サードパーティCookie制限を受ける点に注意。
    // 既定値は既存の直結環境との互換性のため 'None' のまま。
    'cookie_samesite' => 'None',

    // モデレーション管理者のOSMユーザーIDを数値で列挙（表示名は使用しない）。
    // 本番では信頼できる管理者のIDを設定。空のままだと誰も管理できません。
    'admin_osm_ids' => [],

    // 開発・CI限定: テスト用のChangesetメタデータAPI URL。
    // 本番(app_env=production)では無視され、公式OSM APIだけを参照します。
    'dev_changeset_api_base' => null,
];
