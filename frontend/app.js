'use strict';
/* OSM Mappers Guild フロントエンド (Phase 1 MVP)
 * ビルド不要の素のJavaScript。地図は MapLibre GL JS + OSMFJベクタータイル。
 */

const API_BASE = (window.GUILD_CONFIG && window.GUILD_CONFIG.apiBase) || '/api/index.php';

const STATUS_LABELS = {
  open: '募集中',
  in_progress: '作業中',
  awaiting_review: '確認待ち',
  changes_requested: '修正依頼',
  completed: '完了',
  withdrawn: '取り下げ',
};
const ASSIGNMENT_LABELS = {
  joined: '参加中',
  reported: '報告済み',
  changes_requested: '修正依頼',
  approved: '承認済み',
};
const EVENT_LABELS = {
  create: '依頼を投稿',
  edit: '依頼を編集',
  withdraw: '依頼を取り下げ',
  join: '参加表明',
  leave: '参加解除',
  report: '作業報告',
  approve: '承認',
  request_changes: '修正依頼',
};
const WORLDWIDE_LABEL = '場所を指定しない（世界中）';

const state = {
  me: null,
  csrf: '',
  categories: [],
  requests: [],
  filterMode: 'all', // all | mine | joining
  showWorldwide: false,
  detail: null,
  pick: { active: false, corners: [], previousCorners: [] },
  editingId: null,
};

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const method = opts.method || 'GET';
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = state.csrf;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error((data && data.error) || ('HTTP ' + res.status));
  }
  return data;
}

// --------------------------------------------------------------------- map

const map = new maplibregl.Map({
  container: 'map',
  style: './tiles/osmfj_poi.json',
  center: [135.5023, 34.6937], // 大阪
  zoom: 11,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
const rangePickClicks = new WeakSet();

map.on('load', () => {
  map.addSource('pick', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'pick-fill', type: 'fill', source: 'pick',
    paint: { 'fill-color': '#2e7d32', 'fill-opacity': 0.3 },
  });
  map.addLayer({
    id: 'pick-line', type: 'line', source: 'pick',
    paint: { 'line-color': '#1b5e20', 'line-width': 2 },
  });
  addRequestLayers();
  loadRequests();
});

map.on('moveend', () => {
  if (!state.showWorldwide && map.getSource('request-pins')) {
    loadRequests({ debounce: true });
  }
});

map.on('click', (e) => {
  if (!state.pick.active) return;
  rangePickClicks.add(e.originalEvent);
  state.pick.corners.push([e.lngLat.lng, e.lngLat.lat]);
  if (state.pick.corners.length === 2) {
    drawPick();
    finishPicking();
    updateAreaBox();
    toast('範囲を設定しました');
  } else {
    $('pick-instruction').textContent = 'もう1点（対角）をタップしてください';
  }
});

function rectPolygon(a, b) {
  const w = Math.min(a[0], b[0]), e = Math.max(a[0], b[0]);
  const s = Math.min(a[1], b[1]), n = Math.max(a[1], b[1]);
  return {
    type: 'Polygon',
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  };
}

function drawPick() {
  const src = map.getSource('pick');
  if (!src) return;
  if ($('f-area-mode')?.value !== 'worldwide' && state.pick.corners.length === 2) {
    const poly = rectPolygon(state.pick.corners[0], state.pick.corners[1]);
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: poly, properties: {} }] });
  } else {
    src.setData({ type: 'FeatureCollection', features: [] });
  }
}

function pickedArea() {
  if (state.pick.corners.length !== 2) return null;
  return rectPolygon(state.pick.corners[0], state.pick.corners[1]);
}

function clearPickedArea() {
  state.pick.corners = [];
  drawPick();
}

function finishPicking() {
  state.pick.active = false;
  document.body.classList.remove('picking');
  $('pick-controls').hidden = true;
  $('panel').hidden = false;
  map.resize();
}

function addRequestLayers() {
  map.addSource('request-pins', {
    type: 'geojson', data: { type: 'FeatureCollection', features: [] },
    cluster: true, clusterRadius: 45, clusterMaxZoom: 17,
  });
  const cluster = ['has', 'point_count'];
  map.addLayer({
    id: 'request-clusters', type: 'circle', source: 'request-pins', filter: cluster,
    paint: { 'circle-color': '#1565c0', 'circle-radius': 19, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: 'request-cluster-count', type: 'symbol', source: 'request-pins', filter: cluster,
    layout: { 'text-field': ['to-string', ['get', 'point_count_abbreviated']], 'text-font': ['Noto Sans Regular'], 'text-size': 13, 'text-allow-overlap': true },
    paint: { 'text-color': '#fff' },
  });
  map.addLayer({
    id: 'request-point', type: 'circle', source: 'request-pins', filter: ['!', cluster],
    paint: { 'circle-color': '#c62828', 'circle-radius': 9, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  for (const layer of ['request-clusters', 'request-point']) {
    map.on('mouseenter', layer, () => {
      if (!state.pick.active) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', 'request-point', (e) => {
    if (state.pick.active || state.showWorldwide || rangePickClicks.has(e.originalEvent)) return;
    const ids = new Set(e.features.map((feature) => feature.properties.id));
    const requests = state.requests.filter((request) => ids.has(request.id));
    if (requests.length === 1) openDetail(requests[0].id);
    else if (requests.length > 1) openOverlappingRequests(requests);
  });
  map.on('click', 'request-clusters', async (e) => {
    if (state.pick.active || state.showWorldwide || state.requests.length === 0 || rangePickClicks.has(e.originalEvent)) return;
    const revision = listRevision;
    const feature = e.features[0];
    const [lng, lat] = feature.geometry.coordinates;
    const center = [lng + 360 * Math.round((e.lngLat.lng - lng) / 360), lat];
    try {
      const zoom = await map.getSource('request-pins').getClusterExpansionZoom(feature.properties.cluster_id);
      if (revision === listRevision && !state.pick.active && !state.showWorldwide) map.easeTo({ center, zoom });
    } catch {
      // The source can change while the expansion zoom is being looked up.
    }
  });
}

function wrapLongitude(lng) {
  return lng >= -180 && lng <= 180 ? lng : ((lng + 180) % 360 + 360) % 360 - 180;
}

function viewportBbox() {
  const bounds = map.getBounds();
  // Round outwards to keep edge intersections and avoid reloads from float noise.
  const west = Math.floor(bounds.getWest() * 1e6) / 1e6;
  const east = Math.ceil(bounds.getEast() * 1e6) / 1e6;
  const south = Math.max(-90, Math.floor(bounds.getSouth() * 1e6) / 1e6);
  const north = Math.min(90, Math.ceil(bounds.getNorth() * 1e6) / 1e6);
  if (east - west >= 360) return [-180, south, 180, north];
  return [wrapLongitude(west).toFixed(6), south, wrapLongitude(east).toFixed(6), north];
}

function refreshRequestPins(requests, bbox = null) {
  const source = map.getSource('request-pins');
  if (!source) return;
  const viewport = bbox?.split(',').map(Number);
  const features = [];
  for (const request of requests) {
    const bounds = areaBounds(request.area);
    if (!bounds) continue;
    let [[west, south], [east, north]] = bounds;
    if (viewport) {
      const [viewWest, viewSouth, viewEast, viewNorth] = viewport;
      const end = viewEast < viewWest ? viewEast + 360 : viewEast;
      // Keep the pin on the visible part of a rectangle that overlaps the viewport.
      const shift = [0, 360, -360].find((offset) => west + offset <= end && east + offset >= viewWest);
      if (shift === undefined) continue;
      west = Math.max(west + shift, viewWest);
      east = Math.min(east + shift, end);
      south = Math.max(south, viewSouth);
      north = Math.min(north, viewNorth);
    }
    features.push({
      type: 'Feature', geometry: { type: 'Point', coordinates: [wrapLongitude((west + east) / 2), (south + north) / 2] },
      properties: { id: request.id },
    });
  }
  source.setData({ type: 'FeatureCollection', features });
}

function areaBounds(area) {
  const pts = area?.coordinates?.[0];
  if (!pts?.length) return null;
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}

function fitToArea(area) {
  const bounds = areaBounds(area);
  if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
}

// -------------------------------------------------------------------- list

let listRevision = 0;
let listQuery = '';
let listCursor = null;
let listTimer;
let listBusy = false;

function loadRequests({ debounce = false } = {}) {
  if (!state.showWorldwide && !map.getSource('request-pins')) return;
  const params = new URLSearchParams({ limit: '30', area: state.showWorldwide ? 'worldwide' : 'located' });
  const st = $('filter-status').value;
  const cat = $('filter-category').value;
  if (st) params.set('status', st);
  if (cat) params.set('category', cat);
  if (state.filterMode === 'mine') params.set('owner', 'me');
  if (state.filterMode === 'joining') params.set('participating', 'me');
  if (!state.showWorldwide) params.set('bbox', viewportBbox().join(','));
  const query = params.toString();
  if (debounce && query === listQuery) return;
  listQuery = query;
  const revision = ++listRevision;
  clearTimeout(listTimer);
  listCursor = null;
  listBusy = false;
  state.requests = [];
  $('request-list').innerHTML = '';
  refreshRequestPins([]);
  $('request-list-status').textContent = '読み込み中…';
  $('request-list-more').hidden = true;
  if (debounce) {
    listTimer = setTimeout(() => loadRequestPage(revision), 220);
  } else {
    return loadRequestPage(revision);
  }
}

async function loadRequestPage(revision) {
  if (revision !== listRevision || listBusy) return;
  listBusy = true;
  const params = new URLSearchParams(listQuery);
  if (listCursor) params.set('cursor', listCursor);
  const button = $('request-list-more');
  const status = $('request-list-status');
  button.disabled = true;
  status.textContent = '読み込み中…';
  try {
    const page = await api('/requests?' + params.toString());
    if (revision !== listRevision) return;
    const ids = new Set(state.requests.map((request) => request.id));
    const added = page.requests.filter((request) => !ids.has(request.id));
    state.requests.push(...added);
    listCursor = page.next_cursor;
    renderList(added);
    if (!state.showWorldwide) refreshRequestPins(state.requests, params.get('bbox'));
    const empty = state.showWorldwide ? '条件に一致する場所指定なしの依頼はありません。' : '地図の表示範囲に条件に一致する依頼はありません。';
    status.textContent = state.requests.length ? '' : empty;
    button.textContent = 'さらに読み込む';
    button.hidden = !listCursor;
  } catch (e) {
    if (revision !== listRevision) return;
    status.textContent = '依頼を取得できませんでした。' + e.message;
    button.textContent = '再試行';
    button.hidden = false;
  } finally {
    if (revision === listRevision) {
      listBusy = false;
      button.disabled = false;
    }
  }
}

function renderList(requests) {
  const el = $('request-list');
  el.insertAdjacentHTML('beforeend', requests.map((r) => `
    <article class="request-card" data-id="${Number(r.id)}">
      <h3><button class="request-title" type="button">${esc(r.title)}</button></h3>
      <div class="meta">
        <span class="badge badge-${esc(r.status)}">${esc(STATUS_LABELS[r.status] || r.status)}</span>
        <span>${esc(r.category)}</span>
        ${r.area == null ? `<span>${WORLDWIDE_LABEL}</span>` : ''}
        <span>依頼者: ${esc(r.owner_name)}</span>
        <span>参加 ${r.participant_count} 人</span>
        <span>依頼へのいいね ${Number(r.support_count || 0)} 件</span>
      </div>
      <p class="desc">${esc(r.description)}</p>
    </article>`).join(''));
}

// ------------------------------------------------------------------ detail

let panelRevision = 0;
function openPanel(html) {
  panelRevision++;
  $('panel-content').innerHTML = html;
  $('panel').hidden = false;
  $('panel').scrollTop = 0;
}
function closePanel() {
  panelRevision++;
  $('panel').hidden = true;
  state.detail = null;
  state.editingId = null;
  clearPickedArea();
}

function openOverlappingRequests(requests) {
  clearPickedArea();
  state.detail = null;
  state.editingId = null;
  openPanel('<h2>この位置の依頼</h2>' + requests.map((request) =>
    `<button class="mypage-card" type="button" data-request-id="${Number(request.id)}">${esc(request.title)}</button>`
  ).join(''));
  $('panel-content').querySelectorAll('[data-request-id]').forEach((button) => {
    button.addEventListener('click', () => openDetail(Number(button.dataset.requestId)));
  });
}

async function openMyPage() {
  if (!state.me) { toast('ログインが必要です'); return; }
  clearPickedArea();
  state.detail = null;
  state.editingId = null;
  openPanel(`
    <h2>マイページ</h2>
    <p class="mypage-user">${esc(state.me.display_name)} さん</p>
    <button id="btn-logout" class="btn btn-small" type="button">ログアウト</button>
    <section aria-labelledby="mypage-owned-heading">
      <h3 id="mypage-owned-heading">自分の依頼</h3>
      <button id="btn-new-request" class="btn btn-primary mypage-new-request" type="button">依頼を投稿</button>
      <div id="mypage-owned" aria-live="polite">読み込み中…</div>
    </section>
    <section aria-labelledby="mypage-joined-heading">
      <h3 id="mypage-joined-heading">参加した依頼</h3>
      <div id="mypage-joined" aria-live="polite">読み込み中…</div>
    </section>`);
  const revision = panelRevision;
  $('btn-logout').addEventListener('click', logout);
  $('btn-new-request').addEventListener('click', () => openForm(null));
  const sections = [
    { id: 'mypage-owned', filter: 'owner', empty: '投稿した依頼はありません。' },
    { id: 'mypage-joined', filter: 'participating', empty: '参加した依頼はありません。' },
  ];
  await Promise.all(sections.map((section) => loadMyPageRequests(section, revision)));
}

async function loadMyPageRequests(section, revision) {
  const container = $(section.id);
  const params = new URLSearchParams({ [section.filter]: 'me', limit: '30' });
  let cursor = null;
  let html = '';
  async function loadPage() {
    if (cursor) params.set('cursor', cursor);
    const button = container.querySelector('.mypage-more');
    if (button) button.disabled = true;
    try {
      const data = await api('/requests?' + params.toString());
      if (revision !== panelRevision || !state.me) return;
      html += data.requests.map((r) => `
        <button class="mypage-card" type="button" data-request-id="${Number(r.id)}">
          <strong>${esc(r.title)}</strong>
          <span class="mypage-card-meta"><span class="badge badge-${esc(r.status)}">${esc(STATUS_LABELS[r.status] || r.status)}</span> ${esc(r.category)}${r.area == null ? ` / ${WORLDWIDE_LABEL}` : ''}</span>
        </button>`).join('');
      cursor = data.next_cursor;
      container.innerHTML = html || '<p class="hint">' + section.empty + '</p>';
      if (cursor) container.innerHTML += '<button class="mypage-more btn btn-small" type="button">さらに読み込む</button>';
    } catch (e) {
      if (revision !== panelRevision || !state.me) return;
      container.innerHTML = html + '<p class="error-text">依頼を取得できませんでした。' + esc(e.message)
        + '</p><button class="mypage-more btn btn-small" type="button">再試行</button>';
    }
  }
  container.addEventListener('click', (event) => {
    const card = event.target.closest('[data-request-id]');
    if (card) openDetail(Number(card.dataset.requestId));
    else if (event.target.closest('.mypage-more')) loadPage();
  });
  await loadPage();
}

async function openDetail(id) {
  try {
    const data = await api('/requests/' + id);
    clearPickedArea();
    state.detail = data;
    renderDetail();
    fitToArea(data.request.area);
  } catch (e) {
    toast(e.message);
  }
}

function changesetLinks(ids) {
  if (!ids || ids.length === 0) return '<div class="cs-links">Changeset: なし</div>';
  return '<div class="cs-links">Changeset: ' + ids.map((id) =>
    `<a href="https://www.openstreetmap.org/changeset/${id}" target="_blank" rel="noopener">${id}</a>`
  ).join(', ') + '</div>';
}

function changesetSearchUrl(userId, area) {
  const params = new URLSearchParams({
    user: String(userId),
    limit: '100',
  });
  const bounds = areaBounds(area);
  if (bounds) params.set('bbox', bounds.flat().join(','));
  return 'https://api.openstreetmap.org/api/0.6/changesets.json?' + params;
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const r = d.request;
  const me = state.me;
  const isOwner = me && me.id === r.user_id;
  const myAssignment = me ? d.assignments.find((a) => a.user_id === me.id) : null;

  let html = `
    <h2>${esc(r.title)}</h2>
    <div class="meta">
      <span class="badge badge-${esc(r.status)}">${esc(STATUS_LABELS[r.status] || r.status)}</span>
      <span>${esc(r.category)}</span>
      ${r.area == null ? `<span>${WORLDWIDE_LABEL}</span>` : ''}
      <span>依頼者: ${esc(r.owner_name)}</span>
      <span>更新: ${esc(r.updated_at)}</span>
    </div>
    <p>${esc(r.description)}</p>
    <p class="social-stat">依頼へのいいね <span id="support-count">${Number(r.support_count || 0)}</span> 件</p>
    ${r.reward_text ? `<p><strong>報酬・謝礼:</strong> ${esc(r.reward_text)}<br>
      <span class="hint" style="color:var(--muted);font-size:12px">※ 報酬の受け渡しは当事者間で行ってください。ギルドは決済・支払い保証・仲介を行いません。</span></p>` : ''}
    <div class="actions" id="detail-actions"></div>

    <h3>参加マッパー（${d.assignments.length}人）</h3>
    <div id="participants">
      ${d.assignments.length === 0 ? '<p>まだ参加者はいません。</p>' : d.assignments.map((a) => `
        <div class="participant">
          <div class="p-head">
            <span class="p-name">${esc(a.user_name)}</span>
            <span class="badge badge-${esc(a.status)}">${esc(ASSIGNMENT_LABELS[a.status] || a.status)}</span>
          </div>
          ${changesetLinks(a.changeset_ids)}
          <div class="social-stat">いいね <span id="like-count-${a.id}">${Number(a.like_count || 0)}</span> 件
          ${me && a.user_id !== me.id && (a.liked_by_me || (a.status === 'approved' && r.status !== 'withdrawn')) ? `
            <button class="btn btn-small" data-like-toggle="${a.id}" data-next-active="${a.liked_by_me ? 'false' : 'true'}" type="button">${a.liked_by_me ? 'いいねを取り消す' : 'いいね'}</button>` : ''}
          </div>
          ${isOwner && a.status === 'reported' ? `
            <div style="margin-top:8px">
              <textarea id="review-comment-${a.id}" rows="2" style="width:100%" placeholder="確認コメント（任意）"></textarea>
              <div class="actions">
                <button class="btn btn-primary btn-small" data-review="approve" data-aid="${a.id}" type="button">承認する</button>
                <button class="btn btn-danger btn-small" data-review="request_changes" data-aid="${a.id}" type="button">修正を依頼する</button>
              </div>
            </div>` : ''}
        </div>`).join('')}
    </div>

    <div id="report-area"></div>

    <h3>履歴</h3>
    <div>
      ${d.events.map((e) => `
        <div class="event">
          <span class="e-meta">${esc(e.created_at)} / ${esc(e.actor_name)} / ${esc(EVENT_LABELS[e.event_type] || e.event_type)}</span>
          ${e.comment ? `<div class="e-comment">${esc(e.comment)}</div>` : ''}
        </div>`).join('')}
    </div>`;

  openPanel(html);

  // アクションボタン
  const actions = $('detail-actions');
  let btns = '';
  if (!me) {
    btns = '<p>参加・報告にはログインが必要です。</p>';
  } else {
    if (isOwner && r.status !== 'withdrawn') {
      btns += '<button id="act-edit" class="btn" type="button">編集</button>';
      btns += '<button id="act-withdraw" class="btn btn-danger" type="button">取り下げ</button>';
    }
    if (!myAssignment && !['completed', 'withdrawn'].includes(r.status)) {
      btns += '<button id="act-join" class="btn btn-primary" type="button">参加する</button>';
    } else if (myAssignment && ['joined', 'changes_requested'].includes(myAssignment.status)) {
      btns += '<button id="act-leave" class="btn" type="button">参加を解除</button>';
    }
  }
  if (me && !isOwner && (d.supported_by_me || r.status !== 'withdrawn')) {
    btns += `<button id="act-support" class="btn" type="button">${d.supported_by_me ? '依頼へのいいねを取り消す' : '依頼にいいね'}</button>`;
  }
  actions.innerHTML = btns;

  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('act-join', async () => { await mutate('/requests/' + r.id + '/join'); });
  on('act-leave', async () => { if (confirm('参加を解除しますか？')) await mutate('/requests/' + r.id + '/leave'); });
  on('act-withdraw', async () => { if (confirm('この依頼を取り下げますか？')) await mutate('/requests/' + r.id + '/withdraw'); });
  on('act-edit', () => openForm(r));
  on('act-support', async () => {
    const button = $('act-support');
    button.disabled = true;
    try {
      const result = await api('/requests/' + r.id + '/support', { method: 'POST', body: { active: !d.supported_by_me } });
      if (state.detail === d && !$('panel').hidden && button.isConnected && $('support-count')) {
        d.supported_by_me = result.supported_by_me;
        r.support_count = result.support_count;
        $('support-count').textContent = result.support_count;
        button.textContent = result.supported_by_me ? '依頼へのいいねを取り消す' : '依頼にいいね';
        if (!result.supported_by_me && r.status === 'withdrawn') button.remove();
      }
      loadRequests();
    } catch (e) { toast(e.message); } finally { button.disabled = false; }
  });
  document.querySelectorAll('[data-like-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const assignmentId = Number(btn.dataset.likeToggle);
        const result = await api('/assignments/' + assignmentId + '/like', {
          method: 'POST', body: { active: btn.dataset.nextActive === 'true' },
        });
        if (state.detail === d && !$('panel').hidden && btn.isConnected && $('like-count-' + assignmentId)) {
          const assignment = d.assignments.find((a) => a.id === assignmentId);
          assignment.like_count = result.like_count;
          assignment.liked_by_me = result.liked_by_me;
          $('like-count-' + assignmentId).textContent = result.like_count;
          btn.dataset.nextActive = result.liked_by_me ? 'false' : 'true';
          btn.textContent = result.liked_by_me ? 'いいねを取り消す' : 'いいね';
          if (!result.liked_by_me && (r.status === 'withdrawn' || assignment.status !== 'approved')) btn.remove();
        }
      } catch (e) { toast(e.message); } finally { btn.disabled = false; }
    });
  });

  document.querySelectorAll('[data-review]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const aid = Number(btn.dataset.aid);
      const comment = ($('review-comment-' + aid) || {}).value || '';
      await mutate('/requests/' + r.id + '/review', {
        assignment_id: aid,
        action: btn.dataset.review,
        comment: comment.trim() === '' ? null : comment,
      });
    });
  });

  // 作業報告フォーム（参加中で未報告/修正依頼のとき）
  if (me && myAssignment && ['joined', 'changes_requested'].includes(myAssignment.status) && r.status !== 'withdrawn') {
    $('report-area').innerHTML = `
      <h3>作業報告</h3>
      <form class="form" id="report-form">
        <label>報告コメント
          <textarea id="report-comment" rows="4" required maxlength="2000" placeholder="実施した内容、現地確認の結果など"></textarea>
        </label>
        <div class="changeset-picker">
          <strong>Changeset（必須、複数選択可）</strong>
          <p class="hint">${r.area ? '対象エリアと重なるあなたの Changeset を取得します。' : 'あなたの最近の Changeset を取得します。'}依頼に関係するものを選んでください。</p>
          <button id="report-fetch-changesets" class="btn btn-small" type="button">Changeset を取得</button>
          <div id="report-changeset-list" aria-live="polite"></div>
        </div>
        <p class="error-text" id="report-error"></p>
        <button class="btn btn-primary" type="submit">報告する</button>
      </form>`;
    const selectedChangesets = new Set();
    $('report-fetch-changesets').addEventListener('click', async () => {
      const button = $('report-fetch-changesets');
      const list = $('report-changeset-list');
      button.disabled = true;
      selectedChangesets.clear();
      list.textContent = '取得しています…';
      try {
        const response = await fetch(changesetSearchUrl(me.osm_user_id, r.area));
        if (!response.ok) throw new Error('OSM API の応答: HTTP ' + response.status);
        const data = await response.json();
        if (!Array.isArray(data.changesets)) throw new Error('OSM API の応答形式が正しくありません');
        const changesets = data.changesets.filter((cs) => Number.isSafeInteger(cs.id) && cs.id > 0 && cs.changes_count > 0);
        if (!changesets.length) {
          list.textContent = r.area ? '対象エリアに該当する Changeset が見つかりませんでした。' : 'あなたの Changeset が見つかりませんでした。';
          return;
        }
        list.innerHTML = changesets.map((cs) => {
          const date = new Date(cs.created_at);
          const when = Number.isNaN(date.getTime()) ? cs.created_at || '' : date.toLocaleString('ja-JP');
          const comment = cs.tags && cs.tags.comment ? cs.tags.comment : 'コメントなし';
          return `<label class="changeset-option"><input type="checkbox" value="${cs.id}" ${selectedChangesets.has(cs.id) ? 'checked' : ''}>
            <span><strong>#${cs.id}</strong> ${esc(when)}<br>${esc(comment)}</span></label>`;
        }).join('') + (data.changesets.length >= 100 ? '<p class="hint">最新の100件を表示しています。</p>' : '');
        list.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
          checkbox.addEventListener('change', () => {
            const id = Number(checkbox.value);
            if (checkbox.checked) selectedChangesets.add(id);
            else selectedChangesets.delete(id);
          });
        });
      } catch (e) {
        list.textContent = '取得できませんでした。時間をおいて再度お試しください。（' + e.message + '）';
      } finally {
        button.disabled = false;
      }
    });
    $('report-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (selectedChangesets.size === 0 || selectedChangesets.size > 50) {
        $('report-error').textContent = 'Changeset を1〜50件選んでください';
        return;
      }
      const ids = Array.from(selectedChangesets);
      try {
        await api('/requests/' + r.id + '/report', {
          method: 'POST',
          body: { comment: $('report-comment').value, changeset_ids: ids },
        });
        toast('報告しました');
        await openDetail(r.id);
        loadRequests();
      } catch (e) {
        $('report-error').textContent = e.message;
      }
    });
  }
}

async function mutate(path, body) {
  try {
    await api(path, { method: 'POST', body: body || {} });
    toast('更新しました');
    if (state.detail) await openDetail(state.detail.request.id);
    loadRequests();
  } catch (e) {
    toast(e.message);
  }
}

// -------------------------------------------------------------------- form

function updateAreaBox() {
  const box = $('form-area-summary');
  if (!box) return;
  const area = pickedArea();
  if (!area) {
    box.textContent = '未設定です。「地図で範囲を指定」を押し、地図で対角の2点を選んでください。';
    return;
  }
  const [[west, south], [east, north]] = areaBounds(area);
  box.textContent = `設定済み: 経度 ${west.toFixed(5)}〜${east.toFixed(5)} / 緯度 ${south.toFixed(5)}〜${north.toFixed(5)}`;
}

function openForm(existing) {
  if (!state.me) {
    toast('ログインが必要です');
    return;
  }
  state.editingId = existing ? existing.id : null;
  const bounds = areaBounds(existing?.area);
  const worldwide = !!existing && !bounds;
  state.pick.corners = bounds || [];
  state.pick.active = false;

  openPanel(`
    <h2>${existing ? '依頼を編集' : '依頼を投稿'}</h2>
    <form class="form" id="request-form">
      <label>タイトル
        <input id="f-title" type="text" required maxlength="120" value="${existing ? esc(existing.title) : ''}">
      </label>
      <label>カテゴリ
        <select id="f-category">
          ${state.categories.map((c) => `<option value="${esc(c)}" ${existing && existing.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </label>
      <label>説明
        <textarea id="f-description" rows="7" required maxlength="5000" placeholder="確認・編集してほしい内容を書いてください">${existing ? esc(existing.description) : ''}</textarea>
      </label>
      <label>報酬・謝礼（任意）
        <input id="f-reward" type="text" maxlength="300" value="${existing && existing.reward_text ? esc(existing.reward_text) : ''}" placeholder="例: 交通費実費を負担します">
        <span class="hint">金銭・物品・交通費負担などを自由に記載できます。受け渡しは当事者間で行い、ギルドは決済・支払い保証・仲介を行いません。</span>
      </label>
      <label>対象エリア
        <select id="f-area-mode">
          <option value="area">地図で範囲を指定</option>
          <option value="worldwide"${worldwide ? ' selected' : ''}>${WORLDWIDE_LABEL}</option>
        </select>
      </label>
      <div id="f-area-options" class="area-box"${worldwide ? ' hidden' : ''}>
        <p id="form-area-summary" class="hint"></p>
        <button id="f-pick" class="btn btn-small" type="button">地図で範囲を指定</button>
        <button id="f-pick-clear" class="btn btn-small" type="button">範囲をクリア</button>
        <p class="hint">地図に切り替わります。対角の2点を選んでください。</p>
      </div>
      <p class="error-text" id="form-error"></p>
      <button class="btn btn-primary" type="submit">${existing ? '保存する' : '投稿する'}</button>
    </form>`);
  updateAreaBox();
  drawPick();
  if (bounds) fitToArea(existing.area);

  const areaMode = $('f-area-mode');
  areaMode.addEventListener('change', () => {
    $('f-area-options').hidden = areaMode.value === 'worldwide';
    $('form-error').textContent = '';
    drawPick();
  });
  $('f-pick').addEventListener('click', () => {
    state.pick.previousCorners = state.pick.corners.map((corner) => [...corner]);
    state.pick.corners = [];
    state.pick.active = true;
    drawPick();
    $('panel').hidden = true;
    $('pick-instruction').textContent = '地図で1点目をタップしてください';
    $('pick-controls').hidden = false;
    document.body.classList.add('picking');
    map.resize();
  });
  $('f-pick-clear').addEventListener('click', () => {
    state.pick.active = false;
    clearPickedArea();
    updateAreaBox();
  });

  $('request-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const needsArea = areaMode.value === 'area';
    const area = needsArea ? pickedArea() : null;
    if (needsArea && !area) {
      $('form-error').textContent = '対象エリアを設定してください';
      return;
    }
    const payload = {
      title: $('f-title').value,
      category: $('f-category').value,
      description: $('f-description').value,
      reward_text: $('f-reward').value.trim() === '' ? null : $('f-reward').value,
      area,
    };
    try {
      if (state.editingId) {
        await api('/requests/' + state.editingId, { method: 'PATCH', body: payload });
        toast('保存しました');
        const id = state.editingId;
        state.editingId = null;
        await openDetail(id);
      } else {
        const res = await api('/requests', { method: 'POST', body: payload });
        toast('投稿しました');
        await openDetail(res.request.id);
      }
      loadRequests();
    } catch (e) {
      $('form-error').textContent = e.message;
    }
  });
}

$('pick-cancel').addEventListener('click', () => {
  state.pick.corners = state.pick.previousCorners;
  drawPick();
  finishPicking();
  updateAreaBox();
});

// -------------------------------------------------------------------- auth

async function loadMe() {
  try {
    const data = await api('/me');
    state.me = data.user;
    state.csrf = data.csrf_token;
    state.categories = data.categories || [];
    const catSel = $('filter-category');
    catSel.innerHTML = '<option value="">すべて</option>' +
      state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    renderAuth();
  } catch (e) {
    toast('APIに接続できません: ' + e.message);
  }
}

function renderAuth() {
  const me = state.me;
  const menu = $('account-menu');
  const image = $('account-image');
  $('btn-login').hidden = !!me;
  menu.hidden = !me;
  menu.open = false;
  image.hidden = true;
  image.removeAttribute('src');
  if (!me) return;

  const name = me.display_name;
  $('account-name').textContent = name;
  $('account-toggle').title = name;
  $('account-initial').textContent = [...name.trim()][0]?.toUpperCase() || '?';
  loadAccountAvatar(me);
}

async function loadAccountAvatar(me) {
  try {
    const response = await fetch('https://api.openstreetmap.org/api/0.6/user/' + Number(me.osm_user_id) + '.json', {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return;
    const data = await response.json();
    const href = data.user?.img?.href;
    if (state.me === me && typeof href === 'string' && href.startsWith('https://')) {
      $('account-image').src = href;
    }
  } catch {
    // 画像が取得できない場合はユーザー名の先頭文字を表示する。
  }
}

function dismissAccountMenu(event) {
  const menu = $('account-menu');
  if (!menu.open) return;
  if (event.type === 'keydown') {
    if (event.key !== 'Escape') return;
    $('account-toggle').focus();
  } else if (menu.contains(event.target)) {
    return;
  }
  menu.open = false;
}

document.addEventListener('click', dismissAccountMenu);
document.addEventListener('keydown', dismissAccountMenu);
$('account-image').addEventListener('load', () => { $('account-image').hidden = false; });
$('account-image').addEventListener('error', () => { $('account-image').hidden = true; });

$('btn-login').addEventListener('click', () => {
  window.location.href = API_BASE + '/auth/login';
});
async function logout() {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
    state.me = null;
    state.filterMode = 'all';
    renderAuth();
    closePanel();
    loadRequests();
    toast('ログアウトしました');
  } catch (e) { toast(e.message); }
}
$('btn-mypage').addEventListener('click', () => {
  $('account-menu').open = false;
  const page = openMyPage();
  $('panel-close').focus();
  return page;
});
$('panel-close').addEventListener('click', closePanel);
$('request-list').addEventListener('click', (event) => {
  const card = event.target.closest('.request-card');
  if (card) openDetail(Number(card.dataset.id));
});
$('request-list-more').addEventListener('click', () => {
  if (!$('request-list-more').hidden) return loadRequestPage(listRevision);
});
$('filter-status').addEventListener('change', loadRequests);
$('filter-category').addEventListener('change', loadRequests);
$('filter-worldwide').addEventListener('click', () => {
  state.showWorldwide = !state.showWorldwide;
  $('filter-worldwide').setAttribute('aria-pressed', String(state.showWorldwide));
  const heading = $('request-list-heading');
  heading.textContent = state.showWorldwide ? '場所指定なしの依頼' : '依頼一覧';
  heading.scrollIntoView({ block: 'nearest' });
  loadRequests();
});
$('filter-all').addEventListener('click', () => { state.filterMode = 'all'; loadRequests(); });
$('filter-mine').addEventListener('click', () => { state.filterMode = 'mine'; loadRequests(); });
$('filter-joining').addEventListener('click', () => { state.filterMode = 'joining'; loadRequests(); });

loadMe();
