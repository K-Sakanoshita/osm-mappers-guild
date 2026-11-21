'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value: '', innerHTML: '', textContent: '', hidden: true,
    addEventListener(type, callback) { this[type] = callback; },
    removeAttribute() {}, setAttribute() {}, scrollIntoView() {}, querySelectorAll() { return []; },
    insertAdjacentHTML(_position, html) { this.innerHTML += html; },
  });
  return elements.get(id);
}

const events = new Map();
const sources = new Map();
const layers = new Map();
const moves = [];
let viewport = [135, 34, 136, 35];
const map = {
  on(type, ...args) { events.set([type, ...args.slice(0, -1)].join(':'), args.at(-1)); },
  addControl() {},
  addSource(id, config) {
    sources.set(id, {
      ...config, setData(data) { this.data = data; },
      async getClusterExpansionZoom(id) { assert.equal(id, 4); return 13; },
    });
  },
  getSource(id) { return sources.get(id); },
  addLayer(layer) { layers.set(layer.id, layer); },
  getBounds() {
    return Object.fromEntries(['West', 'South', 'East', 'North'].map((direction, index) =>
      ['get' + direction, () => viewport[index]]));
  },
  easeTo(options) { moves.push(options); },
  fitBounds(bounds) { moves.push(bounds); },
};
const calls = [];
const timers = new Map();
let timerId = 0;
const response = (data, ok = true) => ({ ok, json: async () => data });
const context = vm.createContext({
  document: { getElementById: element, addEventListener() {}, querySelectorAll() { return []; } },
  window: {}, URLSearchParams,
  maplibregl: { Map: function () { return map; }, NavigationControl: function () {} },
  setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
  clearTimeout(id) { timers.delete(id); },
  fetch(url) {
    const path = new URL(url, 'https://test.invalid');
    if (path.pathname.endsWith('/me')) return response({ user: null, categories: [] });
    return new Promise((resolve) => calls.push({ path, resolve }));
  },
});
vm.runInContext(fs.readFileSync('frontend/app.js', 'utf8'), context);

const tick = () => new Promise(setImmediate);
const request = (id, title, w = 135.95, e = 136.5) => ({
  id, title, description: '説明', status: 'open', category: '建物', owner_name: '依頼者',
  area: { coordinates: [[[w, 34.4], [e, 34.4], [e, 34.5], [w, 34.5], [w, 34.4]]] },
});
function fireTimers() {
  const queued = [...timers.values()];
  timers.clear();
  queued.forEach((callback) => callback());
}

(async () => {
  await tick();
  events.get('load')();
  const source = sources.get('request-pins');
  assert.equal(source.cluster, true);
  assert.equal(layers.get('request-cluster-count').source, 'request-pins');
  assert.equal(calls[0].path.searchParams.get('bbox'), '135.000000,34,136.000000,35');
  assert.match(element('request-list-status').textContent, /読み込み中/);
  calls[0].resolve(response({ requests: [request(1, '範囲が重なる依頼')], next_cursor: 'page-two' }));
  await tick();
  assert.equal(source.data.features[0].geometry.coordinates[0], 135.975);
  assert.match(element('request-list').innerHTML, /範囲が重なる依頼/);
  await events.get('click:request-clusters')({
    lngLat: { lng: 495 }, originalEvent: {},
    features: [{ properties: { cluster_id: 4 }, geometry: { coordinates: [135, 34] } }],
  });
  assert.equal(moves[0].zoom, 13);
  assert.equal(moves[0].center[0], 495);
  events.get('click:request-point')({ originalEvent: {}, features: [{ properties: { id: 1 } }] });
  assert.match(calls[1].path.pathname, /\/requests\/1$/);
  calls[1].resolve(response({ request: request(1, '詳細依頼'), assignments: [], events: [] }));
  await tick();
  assert.match(element('panel-content').innerHTML, /詳細依頼/);
  assert.equal(moves[1][0][0], 135.95);

  element('request-list-more').click();
  assert.equal(calls[2].path.searchParams.get('cursor'), 'page-two');
  calls[2].resolve(response({ requests: [request(2, '次の依頼')], next_cursor: 'page-three' }));
  await tick();
  assert.equal(source.data.features.length, 2);
  assert.match(element('request-list').innerHTML, /範囲が重なる依頼[\s\S]*次の依頼/);
  element('request-list-more').click();
  viewport = [136, 34, 137, 35];
  events.get('moveend')();
  viewport = [179, 34, 181, 35];
  events.get('moveend')();
  assert.equal(timers.size, 1);
  calls[3].resolve(response({ requests: [request(3, '古いページ')], next_cursor: null }));
  await tick();
  assert.doesNotMatch(element('request-list').innerHTML, /古いページ/);
  fireTimers();
  assert.equal(calls[4].path.searchParams.get('bbox'), '179.000000,34,-179.000000,35');
  assert.equal(calls[4].path.searchParams.get('cursor'), null);

  element('filter-status').value = 'completed';
  element('filter-status').change();
  assert.equal(calls[5].path.searchParams.get('status'), 'completed');
  element('filter-category').value = '建物';
  element('filter-category').change();
  assert.equal(calls[6].path.searchParams.get('category'), '建物');
  element('filter-worldwide').click();
  assert.equal(calls[7].path.searchParams.get('area'), 'worldwide');
  assert.equal(calls[7].path.searchParams.get('bbox'), null);
  calls[7].resolve(response({ requests: [{ ...request(8, '世界の依頼'), area: null }], next_cursor: null }));
  for (const index of [4, 5, 6]) {
    calls[index].resolve(response({ requests: [request(index, '古い条件')], next_cursor: 'old' }));
  }
  await tick();
  assert.match(element('request-list').innerHTML, /世界の依頼/);
  assert.doesNotMatch(element('request-list').innerHTML, /古い条件/);
  assert.equal(source.data.features.length, 0);
  viewport = [-210, -85, 210, 85];
  events.get('moveend')();
  assert.equal(timers.size, 0);
  assert.equal(calls.length, 8);

  element('filter-worldwide').click();
  assert.equal(calls[8].path.searchParams.get('bbox'), '-180,-85,180,85');
  calls[8].resolve(response({ error: '一時エラー' }, false));
  await tick();
  assert.match(element('request-list-status').textContent, /一時エラー/);
  assert.equal(element('request-list-more').textContent, '再試行');
  element('request-list-more').click();
  calls[9].resolve(response({ requests: [], next_cursor: null }));
  await tick();
  assert.equal(element('request-list-more').hidden, true);
  assert.match(element('request-list-status').textContent, /一致する依頼はありません/);
  console.log('地図範囲、クラスタ操作、ページ送り、応答順、世界中モード、再試行: OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
