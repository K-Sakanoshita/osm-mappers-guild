'use strict';
/* OSM Mappers Guild フロントエンド (Phase 1 MVP)
 * ビルド不要の素のJavaScript。地図は MapLibre GL JS + OSMラスタタイル。
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

const state = {
  me: null,
  csrf: '',
  categories: [],
  requests: [],
  filterMode: 'all', // all | mine | joining
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
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
  center: [135.5023, 34.6937], // 大阪
  zoom: 11,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

map.on('load', () => {
  map.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'areas-fill', type: 'fill', source: 'areas',
    paint: {
      'fill-color': ['match', ['get', 'status'],
        'open', '#2e7d32', 'in_progress', '#1565c0', 'awaiting_review', '#ef6c00',
        'changes_requested', '#b3261e', 'completed', '#616161', '#9e9e9e'],
      'fill-opacity': 0.22,
    },
  });
  map.addLayer({
    id: 'areas-line', type: 'line', source: 'areas',
    paint: { 'line-color': '#22303a', 'line-width': 1.2, 'line-opacity': 0.6 },
  });
  map.addSource('pick', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'pick-fill', type: 'fill', source: 'pick',
    paint: { 'fill-color': '#2e7d32', 'fill-opacity': 0.3 },
  });
  map.addLayer({
    id: 'pick-line', type: 'line', source: 'pick',
    paint: { 'line-color': '#1b5e20', 'line-width': 2 },
  });
  loadRequests();
});

map.on('click', (e) => {
  if (state.pick.active) {
    state.pick.corners.push([e.lngLat.lng, e.lngLat.lat]);
    if (state.pick.corners.length === 2) {
      drawPick();
      finishPicking();
      updateAreaBox();
      toast('範囲を設定しました');
    } else {
      $('pick-instruction').textContent = 'もう1点（対角）をタップしてください';
    }
    return;
  }
  const feats = map.queryRenderedFeatures(e.point, { layers: ['areas-fill'] });
  if (feats.length > 0 && feats[0].properties && feats[0].properties.id) {
    openDetail(Number(feats[0].properties.id));
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
  if (state.pick.corners.length === 2) {
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

function finishPicking() {
  state.pick.active = false;
  document.body.classList.remove('picking');
  $('pick-controls').hidden = true;
  $('panel').hidden = false;
  map.resize();
}

function refreshAreas() {
  const src = map.getSource('areas');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: state.requests.map((r) => ({
      type: 'Feature',
      geometry: r.area,
      properties: { id: r.id, status: r.status },
    })),
  });
}

function fitToArea(area) {
  if (!area || !area.coordinates || !area.coordinates[0]) return;
  const pts = area.coordinates[0];
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 60, maxZoom: 16 }
  );
}

// -------------------------------------------------------------------- list

async function loadRequests() {
  const params = new URLSearchParams();
  const st = $('filter-status').value;
  const cat = $('filter-category').value;
  if (st) params.set('status', st);
  if (cat) params.set('category', cat);
  if (state.filterMode === 'mine') params.set('owner', 'me');
  if (state.filterMode === 'joining') params.set('participating', 'me');
  try {
    const data = await api('/requests?' + params.toString());
    state.requests = data.requests;
    renderList();
    refreshAreas();
  } catch (e) {
    $('request-list').innerHTML = '<p class="error-text">' + esc(e.message) + '</p>';
  }
}

function renderList() {
  const el = $('request-list');
  if (state.requests.length === 0) {
    el.innerHTML = '<p>依頼はまだありません。</p>';
    return;
  }
  el.innerHTML = state.requests.map((r) => `
    <article class="request-card" data-id="${r.id}">
      <h3>${esc(r.title)}</h3>
      <div class="meta">
        <span class="badge badge-${esc(r.status)}">${esc(STATUS_LABELS[r.status] || r.status)}</span>
        <span>${esc(r.category)}</span>
        <span>依頼者: ${esc(r.owner_name)}</span>
        <span>参加 ${r.participant_count} 人</span>
      </div>
      <p class="desc">${esc(r.description)}</p>
    </article>`).join('');
  el.querySelectorAll('.request-card').forEach((card) => {
    card.addEventListener('click', () => openDetail(Number(card.dataset.id)));
  });
}

// ------------------------------------------------------------------ detail

function openPanel(html) {
  $('panel-content').innerHTML = html;
  $('panel').hidden = false;
}
function closePanel() {
  $('panel').hidden = true;
  state.detail = null;
  state.editingId = null;
}

async function openDetail(id) {
  try {
    const data = await api('/requests/' + id);
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
      <span>依頼者: ${esc(r.owner_name)}</span>
      <span>更新: ${esc(r.updated_at)}</span>
    </div>
    <p>${esc(r.description)}</p>
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
  } else if (isOwner) {
    if (r.status !== 'withdrawn') {
      btns += '<button id="act-edit" class="btn" type="button">編集</button>';
      btns += '<button id="act-withdraw" class="btn btn-danger" type="button">取り下げ</button>';
    }
  } else if (!myAssignment) {
    if (!['completed', 'withdrawn'].includes(r.status)) {
      btns += '<button id="act-join" class="btn btn-primary" type="button">参加する</button>';
    }
  } else {
    if (['joined', 'changes_requested'].includes(myAssignment.status)) {
      btns += '<button id="act-leave" class="btn" type="button">参加を解除</button>';
    }
  }
  actions.innerHTML = btns;

  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('act-join', async () => { await mutate('/requests/' + r.id + '/join'); });
  on('act-leave', async () => { if (confirm('参加を解除しますか？')) await mutate('/requests/' + r.id + '/leave'); });
  on('act-withdraw', async () => { if (confirm('この依頼を取り下げますか？')) await mutate('/requests/' + r.id + '/withdraw'); });
  on('act-edit', () => openForm(r));

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
        <label>Changeset ID（必須、複数可、カンマ区切り）
          <input id="report-changesets" type="text" required placeholder="例: 123456789, 123456790">
          <span class="hint">OSMで編集したChangesetのIDを入力してください。</span>
        </label>
        <p class="error-text" id="report-error"></p>
        <button class="btn btn-primary" type="submit">報告する</button>
      </form>`;
    $('report-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const raw = $('report-changesets').value.trim();
      const parts = raw.split(/[,\s]+/).filter(Boolean);
      if (parts.length === 0 || parts.length > 50 || parts.some((part) => !/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part)))) {
        $('report-error').textContent = 'Changeset ID は正の整数で1〜50件指定してください';
        return;
      }
      const ids = parts.map(Number);
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
  const pts = area.coordinates[0];
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  box.textContent = `設定済み: 経度 ${Math.min(...lngs).toFixed(5)}〜${Math.max(...lngs).toFixed(5)} / 緯度 ${Math.min(...lats).toFixed(5)}〜${Math.max(...lats).toFixed(5)}`;
}

function openForm(existing) {
  if (!state.me) {
    toast('ログインが必要です');
    return;
  }
  state.editingId = existing ? existing.id : null;
  state.pick.corners = [];
  state.pick.active = false;
  if (existing && existing.area) {
    const pts = existing.area.coordinates[0];
    const lngs = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    state.pick.corners = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ];
    drawPick();
    fitToArea(existing.area);
  } else {
    drawPick();
  }

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
        <textarea id="f-description" rows="7" required maxlength="5000" placeholder="対象地域で確認・編集してほしい内容を書いてください">${existing ? esc(existing.description) : ''}</textarea>
      </label>
      <label>報酬・謝礼（任意）
        <input id="f-reward" type="text" maxlength="300" value="${existing && existing.reward_text ? esc(existing.reward_text) : ''}" placeholder="例: 交通費実費を負担します">
        <span class="hint">金銭・物品・交通費負担などを自由に記載できます。受け渡しは当事者間で行い、ギルドは決済・支払い保証・仲介を行いません。</span>
      </label>
      <div class="area-box">
        <div>対象エリア（矩形）</div>
        <p id="form-area-summary" class="hint"></p>
        <button id="f-pick" class="btn btn-small" type="button">地図で範囲を指定</button>
        <button id="f-pick-clear" class="btn btn-small" type="button">範囲をクリア</button>
        <p class="hint">地図に切り替わります。対角の2点を選んでください。</p>
      </div>
      <p class="error-text" id="form-error"></p>
      <button class="btn btn-primary" type="submit">${existing ? '保存する' : '投稿する'}</button>
    </form>`);
  updateAreaBox();

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
    state.pick.corners = [];
    state.pick.active = false;
    drawPick();
    updateAreaBox();
  });

  $('request-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const area = pickedArea();
    if (!area) {
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
    $('dev-login').hidden = !data.dev_login_enabled;
    renderAuth();
  } catch (e) {
    toast('APIに接続できません: ' + e.message);
  }
}

function renderAuth() {
  const me = state.me;
  $('user-info').textContent = me ? `${me.display_name} さん` : '未ログイン';
  $('btn-login').hidden = !!me;
  $('btn-logout').hidden = !me;
}

$('btn-login').addEventListener('click', () => {
  window.location.href = API_BASE + '/auth/login';
});
$('btn-logout').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
    state.me = null;
    renderAuth();
    closePanel();
    loadRequests();
    toast('ログアウトしました');
  } catch (e) { toast(e.message); }
});
$('btn-dev-login').addEventListener('click', async () => {
  try {
    const res = await api('/auth/dev-login', {
      method: 'POST',
      body: { osm_user_id: Number($('dev-osm-id').value), display_name: $('dev-name').value },
    });
    state.me = res.user;
    // dev-login でセッションが再生成され CSRF が変わるため /me を取り直す
    await loadMe();
    renderAuth();
    loadRequests();
    toast('開発ログインしました');
  } catch (e) { toast(e.message); }
});
$('btn-new-request').addEventListener('click', () => openForm(null));
$('panel-close').addEventListener('click', closePanel);
$('filter-status').addEventListener('change', loadRequests);
$('filter-category').addEventListener('change', loadRequests);
$('filter-all').addEventListener('click', () => { state.filterMode = 'all'; loadRequests(); });
$('filter-mine').addEventListener('click', () => { state.filterMode = 'mine'; loadRequests(); });
$('filter-joining').addEventListener('click', () => { state.filterMode = 'joining'; loadRequests(); });

loadMe();
