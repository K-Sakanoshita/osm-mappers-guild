# OSM OAuthログイン後にフロントが「未ログイン」になる問題への対応

## 原因

従来:
- Front: `https://guild.openacrossbase.net/`
- API: `https://armd-01.sakura.ne.jp/mappers-guild/api`

ログイン開始時、OSM認証のコールバックはさくらAPIドメインで受け、PHPが `MGSESSID` Cookieを発行する。
しかしフロントからの `fetch(..., { credentials: 'include' })` は別サイトへの第三者リクエストになる。
Firefox等でCookieが分離/拒否されると、PHPが別セッションとして扱い、`GET /me` は `{"user":null}` になる。
CORSの許可や `SameSite=None` では、第三者Cookieのブロックを解除できない。

## 対応構成

| 役割 | URL |
| --- | --- |
| GitHub Pages | `https://guild.openacrossbase.net/` |
| Cloudflare Worker API窓口 | `https://guild-api.openacrossbase.net/api` |
| 実際のPHP（さくらサーバ） | `https://armd-01.sakura.ne.jp/mappers-guild/api` |

WorkerがリクエストをPHPへ転送する。ブラウザに返るPHPセッションCookieは、
リクエスト先の `guild-api.openacrossbase.net` に関連付けられる（PHPから Domain 属性を付けない）。
`guild.openacrossbase.net` と `guild-api.openacrossbase.net` は同一サイトなので、
サードパーティCookieの制限を受けにくい。異なる**オリジン**なので引き続きCORSは必要。

## 1. Cloudflare Workerを作成

Cloudflare管理画面 → **Workers & Pages** → Worker作成 → コードエディタに
`cloudflare/api-proxy-worker.js` を貼り付け、デプロイする。

Worker設定 → **Domains & Routes** → **Add** → **Custom domain** に
`guild-api.openacrossbase.net` を設定する。

Workerの固定転送先は `https://armd-01.sakura.ne.jp/mappers-guild/api`。
ユーザー指定の任意URLへ転送しない。
CloudflareがCustom DomainのDNS・証明書を管理する。
既に同じサブドメインのDNSレコードがある場合は競合を解消する。

### 動作確認

```bash
curl -i https://guild-api.openacrossbase.net/api/health
curl -i -H 'Origin: https://guild.openacrossbase.net' \
  https://guild-api.openacrossbase.net/api/me
```

`/health` が `{"ok":true}` を返し、`/me` に
`Access-Control-Allow-Origin: https://guild.openacrossbase.net` と
`Access-Control-Allow-Credentials: true` があることを確認する。
**Cookieに Domain=armd-01.sakura.ne.jp が付いていないこと**も確認する。

## 2. さくらサーバの `api/config.php` を更新

```php
'frontend_url' => 'https://guild.openacrossbase.net',
'frontend_origins' => [
    'https://guild.openacrossbase.net',
],
'public_api_url' => 'https://guild-api.openacrossbase.net/api',
'cookie_samesite' => 'Lax',
```

MySQL・OSM Client ID/Secretなどの既存設定はそのまま利用する。

重要: `public_api_url` を変えないとOAuthのcallbackが
`armd-01.sakura.ne.jp` のままとなり、同じ問題が残る。

**PHPはセッションCookieに `Domain` を付けない**こと。
`cookie_samesite='Lax'` の場合でも、`https://guild-api.openacrossbase.net/api/auth/callback` は
OSMからのトップレベルGETナビゲーションなのでセッションCookieが送信される。

## 3. OSM OAuthアプリのRedirect URIを更新

OSMのOAuth 2.0アプリ管理ページでRedirect URIに以下を登録する。

```text
https://guild-api.openacrossbase.net/api/auth/callback
```

元のコールバックURLから変更するか、両方許可できる場合は追加する。
文字列が完全一致していること（末尾スラッシュなど）を確認。

## 4. GitHub PagesのAPI URLを切替

`frontend/config.js` の `apiBase` を

```js
apiBase: 'https://guild-api.openacrossbase.net/api',
```

に変更。Worker・PHP・OAuthの設定が完成する**前にmainへ反映しないこと**。
新URLがまだ存在しないとフロントからAPIに接続できなくなる。
GitHub Pagesのビルド／キャッシュ反映後に再読み込みする。

## 5. ブラウザで確認

1. `guild.openacrossbase.net` を開く
2. 開発者ツールのネットワークタブで、APIが `guild-api.openacrossbase.net` に向いていることを確認
3. 「OSMでログイン」 → OSM認証 → `guild-api.openacrossbase.net/api/auth/callback` → `guild.openacrossbase.net` の順に戻る
4. `GET https://guild-api.openacrossbase.net/api/me` のJSONで `user` が `null` ではないことを確認
5. 依頼作成などのPOSTのOPTIONSプリフライトも確認

失敗時の目安:
- `OAuthの状態が一致しません`: 認証開始・コールバックで異なるドメインへ移動、またはCookie不送信
- `/me` が `user:null`: API URL、Cookie、SameSite、ブラウザCookie保存先を確認
- CORS: `frontend_origins` の完全一致、重複した `Access-Control-Allow-Origin: *` を確認
- OAuthの `redirect_uri` 不一致: OSMアプリ登録と `public_api_url` を確認

## ローカル開発

`http://localhost:8080` は `guild-api.openacrossbase.net` と**別サイト**なので、
本番と同じセッション動作は保証されない。ローカルでは
`apiBase: '/api/index.php'` として、ローカルPHP + SQLiteを同一オリジンで使う。
リモートの本番APIをローカルから使う場合は第三者Cookie制限を別途考慮する。

## 注記

- HTTPS・HttpOnly CookieとCSRF保護を維持すること。
- WorkerはHTTPレスポンスの302リダイレクトを追跡せず、そのままブラウザへ返す。
  これがないとOAuth画面への転送が成立しない。
- 元の `armd-01.sakura.ne.jp` のURLが直接開けても構わないが、
  通常のログインとAPI呼出しは必ず同じAPI公開ホスト（`guild-api.openacrossbase.net`）を使用する。
- 独自ドメインを追加するだけではなく、**Workerによる実際のHTTPプロキシ**が必要。
