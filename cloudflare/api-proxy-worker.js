/**
 * OSM Mappers Guild: same-site API gateway.
 *
 * Public URL: https://guild-api.openacrossbase.net/api/...
 * Origin URL: https://armd-01.sakura.ne.jp/mappers-guild/api/...
 *
 * Bind this Worker to the custom domain guild-api.openacrossbase.net in Cloudflare.
 * The origin remains on Sakura; browsers see a cookie for guild-api.openacrossbase.net,
 * which is same-site with guild.openacrossbase.net.
 */
const ORIGIN_BASE = 'https://armd-01.sakura.ne.jp/mappers-guild/api';

export default {
  async fetch(request) {
    const incoming = new URL(request.url);

    // Never proxy arbitrary hosts or arbitrary paths.
    if (incoming.hostname !== 'guild-api.openacrossbase.net' ||
        !/^\/api(?:\/|$)/.test(incoming.pathname)) {
      return new Response('Not found', { status: 404 });
    }

    const suffix = incoming.pathname.slice('/api'.length);
    const target = new URL(ORIGIN_BASE + suffix + incoming.search);

    // Preserve method, body, cookies, Origin and CSRF headers. Most importantly,
    // do not follow the PHP OAuth redirects on the Worker: they belong to the browser.
    const upstreamRequest = new Request(target.toString(), request);
    return fetch(upstreamRequest, { redirect: 'manual' });
  },
};
