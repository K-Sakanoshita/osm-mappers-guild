'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const elements = {};
function el(id) {
  return elements[id] ||= {
    hidden: false, value: '', textContent: '', innerHTML: '', disabled: false, boxes: [],
    addEventListener(type, fn) { this[type] = fn; },
    querySelectorAll() { return this.boxes; },
  };
}
const map = { on() {}, addControl() {}, getSource() {}, resize() {}, fitBounds() {} };
let mode = 'success', requestedUrl = '', sentBody = null;
const context = {
  document: { getElementById: el, querySelectorAll: () => [], body: { classList: { add() {}, remove() {} } } },
  window: {}, maplibregl: { Map: function () { return map; }, NavigationControl: function () {} },
  URLSearchParams, setTimeout() {}, console,
  fetch: async (url, opts = {}) => {
    if (url.includes('openstreetmap.org/api/0.6/changesets')) {
      requestedUrl = url;
      if (mode === 'error') throw new Error('network');
      return { ok: true, json: async () => ({ changesets: mode === 'empty' ? [] : [
        { id: 42, created_at: '2026-01-01T00:00:00Z', changes_count: 2, tags: { comment: '<test>' } },
        { id: 43, created_at: '2026-01-02T00:00:00Z', changes_count: 1, tags: {} },
        { id: 44, changes_count: 0 },
      ] }) };
    }
    if (opts.method === 'POST') { sentBody = JSON.parse(opts.body); throw new Error('stop after submission'); }
    return { ok: true, json: async () => ({ user: null, categories: [], requests: [] }) };
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('frontend/app.js', 'utf8'), context);
(async () => {
  await new Promise(setImmediate);
  vm.runInContext(`state.me = {id: 2, osm_user_id: 99}; state.detail = {
    request: {id: 3, user_id: 1, status: 'in_progress', area: {coordinates: [[[135,34],[136,34],[136,35],[135,35],[135,34]]]}},
    assignments: [{user_id: 2, status: 'joined', changeset_ids: []}], events: []
  }; renderDetail()`, context);
  const submit = () => el('report-form').submit({ preventDefault() {} });
  await submit();
  assert.match(el('report-error').textContent, /1〜50/);
  await el('report-fetch-changesets').click();
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get('user'), '99');
  assert.equal(url.searchParams.get('bbox'), '135,34,136,35');
  assert.match(el('report-changeset-list').innerHTML, /#42/);
  assert.match(el('report-changeset-list').innerHTML, /&lt;test&gt;/);
  assert.doesNotMatch(el('report-changeset-list').innerHTML, /#44/);
  const box = { value: '42', checked: true, addEventListener(type, fn) { this[type] = fn; } };
  const box2 = { value: '43', checked: true, addEventListener(type, fn) { this[type] = fn; } };
  el('report-changeset-list').boxes = [box, box2];
  await el('report-fetch-changesets').click();
  box.change();
  box2.change();
  el('report-comment').value = 'done';
  await submit();
  assert.deepEqual(sentBody.changeset_ids, [42, 43]);
  mode = 'empty'; await el('report-fetch-changesets').click();
  assert.match(el('report-changeset-list').textContent, /見つかりません/);
  await submit(); assert.match(el('report-error').textContent, /1〜50/);
  mode = 'error'; await el('report-fetch-changesets').click();
  assert.match(el('report-changeset-list').textContent, /取得できません/);
  assert.equal(el('report-fetch-changesets').disabled, false);
  vm.runInContext("state.me = {id: 1, osm_user_id: 99}; state.detail.assignments = []; renderDetail()", context);
  assert.match(el('detail-actions').innerHTML, /act-edit/);
  assert.match(el('detail-actions').innerHTML, /act-join/);
  vm.runInContext("state.detail.assignments = [{user_id: 1, status: 'joined', changeset_ids: []}]; renderDetail()", context);
  assert.match(el('detail-actions').innerHTML, /act-leave/);
  assert.match(el('report-area').innerHTML, /report-fetch-changesets/);
  console.log('Changeset の検索条件、選択、送信、空結果、取得失敗: OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });
