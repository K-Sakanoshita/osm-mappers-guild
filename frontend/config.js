// APIはCloudflare Workerの同一サイト窓口を使用する。
// GitHub Pages: https://guild.openacrossbase.net/
// API窓口: https://guild-api.openacrossbase.net/api/
// 物理的なバックエンド: https://armd-01.sakura.ne.jp/mappers-guild/api
//
// 注意: Worker・OAuthリダイレクト先・PHP public_api_url を設定してから公開すること。
// ローカル開発でPHP組み込みサーバを使う場合は、一時的に apiBase: '/api/index.php' に変更する。
window.GUILD_CONFIG = {
  apiBase: 'https://guild-api.openacrossbase.net/api',
};
