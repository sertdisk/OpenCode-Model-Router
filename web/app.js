'use strict';
/* OpenCode Model Router — saf vanilla JS (ES2022), tek dosya.
   State bellekte tutulur; Kaydet tüm ajan zincirlerini POST eder. */

const $ = (sel, root = document) => root.querySelector(sel);

const SLOT_DEFS = [
  { key: 'primary', label: 'Öncelik', req: true },
  { key: 'secondary', label: 'Yedek', req: false },
  { key: 'tertiary', label: 'Son yedek', req: false },
];

const state = {
  agents: [],          // [{id, current, chain}]
  models: [],          // [{providerID, id, name}]
  original: {},        // agentId -> {primary, secondary, tertiary} (sunucudan gelen)
  chains: {},          // agentId -> {primary, secondary, tertiary} (düzenlenen)
  dirty: new Set(),    // değişmiş ajan id'leri
  selectedAgent: null,
  drawerSlot: null,    // drawer hangi slot için açık (0/1/2)
  drawerQuery: '',
  drawerActive: 0,     // klavye ile gezilen satır indexi (filtreli düz listede)
  server: null,
  meta: null,
  connected: false,
};

/* ---------- yardımcılar ---------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const fullId = (m) => `${m.providerID}/${m.id}`;
const shortId = (fid) => {
  if (!fid) return '';
  const i = fid.indexOf('/');
  return i >= 0 ? fid.slice(i + 1) : fid;
};
const modelByFullId = (fid) => state.models.find((m) => fullId(m) === fid) || null;
const chainOf = (agentId) =>
  state.chains[agentId] || { primary: null, secondary: null, tertiary: null };

const sameChain = (a, b) =>
  !!a && !!b &&
  (a.primary || null) === (b.primary || null) &&
  (a.secondary || null) === (b.secondary || null) &&
  (a.tertiary || null) === (b.tertiary || null);

function refreshDirty(agentId) {
  if (sameChain(state.chains[agentId], state.original[agentId])) state.dirty.delete(agentId);
  else state.dirty.add(agentId);
}

async function api(path, options = {}) {
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    if (data && data.ok === false) throw new Error(data.error || 'Bilinmeyen hata');
    return { data };
  } catch (err) {
    return { error: err && err.message ? err.message : 'Bağlantı hatası' };
  }
}

function toast(kind, text, ms = 4200) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast--${kind === 'ok' ? 'ok' : 'err'}`;
  el.setAttribute('role', 'status');
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s ease';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ---------- bağlantı / üst bar / alt şerit ---------- */

function setConn(mode, text) {
  const pill = $('#connStatus');
  pill.classList.remove('conn--loading', 'conn--ok', 'conn--bad');
  pill.classList.add(mode === 'ok' ? 'conn--ok' : mode === 'bad' ? 'conn--bad' : 'conn--loading');
  $('#connText').textContent = text;
}

function renderMeta() {
  const m = state.meta;
  $('#serverVersion').textContent = state.server?.version ? `v${state.server.version}` : 'v–';
  if (!m) {
    $('#infoStats').textContent = 'katalog ···';
    $('#infoState').textContent = '';
    return;
  }
  $('#infoStats').textContent =
    `${m.catalogCount} katalog · ${m.visibleCount} görünür · oh-my: ${m.hasOhMy ? 'var' : 'yok'}`;
  const p = String(m.statePath || '');
  const short = p.length > 42 ? '…' + p.slice(-41) : p;
  const st = $('#infoState');
  st.textContent = `state: ${short}`;
  st.title = p;
}

/* ---------- ajan listesi ---------- */

function filledCount(agentId) {
  const c = chainOf(agentId);
  return ['primary', 'secondary', 'tertiary'].filter((k) => c[k]).length;
}

function renderAgents() {
  const list = $('#agentList');
  $('#agentCount').textContent = String(state.agents.length);
  if (state.agents.length === 0) {
    list.innerHTML = '<li class="empty-note">Ajan bulunamadı.</li>';
    return;
  }
  list.innerHTML = state.agents.map((a) => {
    const sel = a.id === state.selectedAgent;
    const c = chainOf(a.id);
    const dirty = state.dirty.has(a.id);
    const pips = ['primary', 'secondary', 'tertiary']
      .map((k, i) => `<span class="slot-pip${c[k] ? ' slot-pip--on' : ''}" aria-hidden="true">${i + 1}</span>`)
      .join('');
    const modelLine = a.current
      ? `<span class="agent-model">${esc(a.current)}</span>`
      : '<span class="agent-model agent-model--none">model yok</span>';
    return `<li>
      <button type="button" class="agent-row" data-agent="${esc(a.id)}"
        aria-selected="${sel ? 'true' : 'false'}">
        <span class="agent-main">
          <span class="agent-name">${dirty ? '<span class="dirty-dot" title="Kaydedilmemiş değişiklik" aria-hidden="true"></span>' : ''}${esc(a.id)}</span>
          ${modelLine}
        </span>
        <span class="slots-mini" title="${filledCount(a.id)}/3 slot dolu">${pips}</span>
      </button>
    </li>`;
  }).join('');
}

/* ---------- zincir editörü ---------- */

function renderChain() {
  const body = $('#chainBody');
  const agent = state.agents.find((a) => a.id === state.selectedAgent);
  if (!agent) {
    body.innerHTML = '<p class="empty-note">Düzenlemek için soldan bir ajan seç.</p>';
    updateActionbar();
    return;
  }
  const c = chainOf(agent.id);
  const cur = agent.current;
  const curName = cur ? modelByFullId(cur)?.name : null;

  const slots = SLOT_DEFS.map((def, i) => {
    const fid = c[def.key];
    const m = fid ? modelByFullId(fid) : null;
    const inner = fid
      ? `<div class="slot-info">
           <div class="slot-label">${i + 1}. ${esc(def.label)}${def.req ? ' <span class="req">(zorunlu)</span>' : ''}</div>
           <div class="slot-model">${esc(fid)}</div>
           <div class="slot-name">${esc(m?.name || shortId(fid))}</div>
         </div>
         <button type="button" class="pick-btn" data-pick="${i}">Değiştir</button>
         <button type="button" class="icon-btn" data-clear="${i}" aria-label="${i + 1}. slotu temizle">&times;</button>`
      : `<div class="slot-info">
           <div class="slot-label">${i + 1}. ${esc(def.label)}${def.req ? ' <span class="req">(zorunlu)</span>' : ''}</div>
           <div class="slot-name">boş — henüz model seçilmedi</div>
         </div>
         <button type="button" class="pick-btn" data-pick="${i}">+ Model seç</button>`;
    return `<li class="slot${fid ? ' slot--filled' : ' slot--empty'}">${'<span class="slot-num" aria-hidden="true">' + (i + 1) + '</span>'}${inner}</li>`;
  });

  // slotlar arasına akış göstergesi ekle
  const arrow = `<li class="flow" aria-hidden="true">
      <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
        <path d="M5 1v9m0 0L1.5 6.5M5 10l3.5-3.5" stroke="#5b6366" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg><span>yanıt vermezse</span>
    </li>`;

  body.innerHTML = `
    <div class="chain-title-row">
      <h2>${esc(agent.id)}</h2>
      <span class="chain-agent-id">agent</span>
    </div>
    <p class="chain-current">şu an etkin:${
      cur ? `<code>${esc(cur)}</code>` : '<span class="none">atanmamış</span>'
    }${curName && curName !== shortId(cur) ? `<br><span style="font-size:11.5px">${esc(curName)}</span>` : ''}</p>
    <p class="help">1. model yanıt vermezse otomatik 2.&rsquo;ye, o da vermezse 3.&rsquo;ye geçilir.</p>
    <ol class="slot-list" style="list-style:none">
      ${slots[0]}${arrow}${slots[1]}${arrow}${slots[2]}
    </ol>`;
  updateActionbar();
}

function updateActionbar() {
  const n = state.dirty.size;
  const save = $('#saveBtn');
  save.disabled = n === 0;
  save.textContent = 'Kaydet';
  const hint = $('#dirtyHint');
  if (n === 0) {
    hint.textContent = state.connected ? 'değişiklik yok' : '';
    hint.classList.remove('dirty-hint--dirty');
  } else {
    hint.textContent = `${n} ajanda kaydedilmemiş değişiklik`;
    hint.classList.add('dirty-hint--dirty');
  }
}

/* ---------- drawer (model seçici) ---------- */

function filteredModels() {
  const q = state.drawerQuery.trim().toLocaleLowerCase('tr');
  if (!q) return state.models;
  return state.models.filter((m) =>
    m.providerID.toLocaleLowerCase('tr').includes(q) ||
    m.id.toLocaleLowerCase('tr').includes(q) ||
    m.name.toLocaleLowerCase('tr').includes(q) ||
    fullId(m).toLocaleLowerCase('tr').includes(q));
}

function flatRows() {
  // gruplu görünümdeki düz satır listesi (klavye gezinmesi için)
  const out = [];
  for (const m of filteredModels()) out.push(m);
  return out;
}

function renderDrawerList() {
  const box = $('#modelList');
  const rows = flatRows();
  const currentFid = state.drawerSlot != null
    ? chainOf(state.selectedAgent)[SLOT_DEFS[state.drawerSlot].key]
    : null;
  if (state.drawerActive >= rows.length) state.drawerActive = Math.max(0, rows.length - 1);

  $('#modelEmpty').hidden = rows.length !== 0;
  box.innerHTML = '';
  if (rows.length === 0) return;

  let lastProv = null;
  rows.forEach((m, idx) => {
    if (m.providerID !== lastProv) {
      lastProv = m.providerID;
      const count = rows.filter((x) => x.providerID === lastProv).length;
      const h = document.createElement('div');
      h.className = 'provider-head';
      h.innerHTML = `<span>${esc(lastProv)}</span><span class="n">${count}</span>`;
      box.appendChild(h);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'model-row' +
      (idx === state.drawerActive ? ' model-row--active' : '') +
      (fullId(m) === currentFid ? ' model-row--picked' : '');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', fullId(m) === currentFid ? 'true' : 'false');
    b.dataset.idx = String(idx);
    b.id = `model-opt-${idx}`;
    b.innerHTML = `<span class="tick" aria-hidden="true">✓</span>
      <span class="m-main">
        <span class="m-name">${esc(m.name)}</span>
        <span class="m-id">${esc(fullId(m))}</span>
      </span>`;
    box.appendChild(b);
  });

  const active = $(`#model-opt-${state.drawerActive}`, box);
  if (active) {
    $('#modelSearch').setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else {
    $('#modelSearch').removeAttribute('aria-activedescendant');
  }
}

let lastFocus = null;

function openDrawer(slotIdx) {
  if (!state.selectedAgent) return;
  state.drawerSlot = slotIdx;
  state.drawerQuery = '';
  state.drawerActive = 0;
  lastFocus = document.activeElement;
  const def = SLOT_DEFS[slotIdx];
  $('#drawerTitle').textContent = `${slotIdx + 1}. slot — model seç`;
  $('#drawerSub').textContent = `${state.selectedAgent} · ${def.label.toLocaleLowerCase('tr')}`;
  $('#drawerOverlay').hidden = false;
  $('#drawer').hidden = false;
  const input = $('#modelSearch');
  input.value = '';
  renderDrawerList();
  input.focus();
  document.addEventListener('keydown', onGlobalKey, true);
}

function closeDrawer() {
  state.drawerSlot = null;
  $('#drawerOverlay').hidden = true;
  $('#drawer').hidden = true;
  document.removeEventListener('keydown', onGlobalKey, true);
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function pickModel(m) {
  const slotIdx = state.drawerSlot;
  if (slotIdx == null || !state.selectedAgent) return;
  const key = SLOT_DEFS[slotIdx].key;
  state.chains[state.selectedAgent][key] = fullId(m);
  refreshDirty(state.selectedAgent);
  closeDrawer();
  renderAgents();
  renderChain();
}

function moveActive(delta) {
  const n = flatRows().length;
  if (n === 0) return;
  state.drawerActive = (state.drawerActive + delta + n) % n;
  renderDrawerList();
}

function onGlobalKey(e) {
  if (state.drawerSlot == null) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeDrawer();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveActive(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveActive(-1);
  } else if (e.key === 'Enter' && document.activeElement === $('#modelSearch')) {
    e.preventDefault();
    const rows = flatRows();
    if (rows[state.drawerActive]) pickModel(rows[state.drawerActive]);
  }
}

/* ---------- yükleme ---------- */

async function load() {
  setConn('loading', 'bağlanıyor…');
  $('#banner').hidden = true;
  const { data, error } = await api('/api/state');
  if (error || !data) {
    state.connected = false;
    setConn('bad', 'bağlantı yok');
    $('#banner').hidden = false;
    $('#agentList').innerHTML = '<li class="empty-note">Veri yüklenemedi — sunucuya ulaşılamıyor.</li>';
    $('#chainBody').innerHTML = '<p class="empty-note">Sunucu yanıt vermiyor. Banner üzerindeki “Tekrar dene” ile yeniden bağlan.</p>';
    updateActionbar();
    renderMeta();
    return;
  }
  state.connected = true;
  setConn('ok', 'bağlı · :37337');
  state.server = data.server || null;
  state.meta = data.meta || null;
  state.agents = Array.isArray(data.agents) ? data.agents : [];
  state.models = Array.isArray(data.models) ? data.models : [];
  state.original = {};
  state.chains = {};
  state.dirty.clear();
  for (const a of state.agents) {
    const c = {
      primary: a.chain?.primary ?? null,
      secondary: a.chain?.secondary ?? null,
      tertiary: a.chain?.tertiary ?? null,
    };
    state.original[a.id] = { ...c };
    state.chains[a.id] = { ...c };
  }
  if (!state.selectedAgent || !state.chains[state.selectedAgent]) {
    state.selectedAgent = state.agents[0]?.id || null;
  }
  renderMeta();
  renderAgents();
  renderChain();
}

/* ---------- kaydet / uygula ---------- */

function setBusy(btn, busy, label) {
  btn.classList.toggle('btn--busy', busy);
  btn.disabled = busy ? true : btn.disabled;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
    delete btn.dataset.label;
  }
  if (!busy) updateActionbar();
}

function buildPayload() {
  const chains = {};
  for (const a of state.agents) chains[a.id] = { ...chainOf(a.id) };
  return { chains };
}

async function doSave(silent = false) {
  // 1. slot zorunlu kontrolü (istemci tarafı; sunucu da doğrular)
  const missing = state.agents.filter(
    (a) => state.dirty.has(a.id) && !chainOf(a.id).primary);
  if (missing.length > 0) {
    if (!silent) toast('err', `1. slot zorunlu: ${missing.map((a) => a.id).join(', ')}`);
    return false;
  }
  const btn = $('#saveBtn');
  if (!silent) setBusy(btn, true, 'Kaydediliyor…');
  const { data, error } = await api('/api/save', {
    method: 'POST',
    body: JSON.stringify(buildPayload()),
  });
  if (!silent) setBusy(btn, false);
  if (error || !data) {
    if (!silent) toast('err', `Kaydedilemedi: ${error || 'bilinmeyen hata'}`);
    return false;
  }
  for (const id of state.dirty) state.original[id] = { ...state.chains[id] };
  state.dirty.clear();
  renderAgents();
  updateActionbar();
  if (!silent) toast('ok', 'Kaydedildi.');
  return true;
}

async function onApply() {
  if (!state.connected) {
    toast('err', 'Sunucuya ulaşılamıyor — önce bağlantıyı kur.');
    return;
  }
  if (!window.confirm('Seçimler opencode yapılandırmasına uygulanacak. Devam edilsin mi?')) return;
  const btn = $('#applyBtn');
  setBusy(btn, true, 'Uygulanıyor…');
  try {
    if (state.dirty.size > 0) {
      const ok = await doSave(true);
      if (!ok) {
        toast('err', 'Önce kaydetme başarısız oldu — uygulanmadı.');
        return;
      }
      toast('ok', 'Kaydedildi.');
    }
    const { data, error } = await api('/api/apply', { method: 'POST' });
    if (error || !data) {
      toast('err', `Uygulanamadı: ${error || 'bilinmeyen hata'}`);
      return;
    }
    const names = Array.isArray(data.agents) ? data.agents : [];
    let msg = names.length > 0 ? `Uygulandı (${names.length} ajan).` : 'Uygulandı.';
    if (data.reload && data.reload !== 'ok') {
      msg += ' Etkili olması için opencode\u2019u yeniden başlatın.';
    }
    toast('ok', msg, 6000);
    // sunucu current değerlerini döndürmüyor; tazele ki "şu an etkin" güncellensin
    await load();
  } finally {
    setBusy(btn, false);
  }
}

/* ---------- olaylar ---------- */

function bind() {
  $('#retryBtn').addEventListener('click', load);

  $('#agentList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-agent]');
    if (!btn) return;
    state.selectedAgent = btn.dataset.agent;
    renderAgents();
    renderChain();
  });

  $('#agentList').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== ' ') return;
    const btn = e.target.closest('[data-agent]');
    if (!btn) return;
    e.preventDefault();
    const rows = [...$('#agentList').querySelectorAll('[data-agent]')];
    const i = rows.indexOf(btn);
    if (e.key === 'Enter' || e.key === ' ') {
      state.selectedAgent = btn.dataset.agent;
      renderAgents();
      renderChain();
      $(`[data-agent="${CSS.escape(state.selectedAgent)}"]`)?.focus();
    } else {
      const next = rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
      next?.focus();
    }
  });

  $('#chainBody').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      openDrawer(Number(pick.dataset.pick));
      return;
    }
    const clear = e.target.closest('[data-clear]');
    if (clear && state.selectedAgent) {
      const key = SLOT_DEFS[Number(clear.dataset.clear)].key;
      state.chains[state.selectedAgent][key] = null;
      refreshDirty(state.selectedAgent);
      renderAgents();
      renderChain();
    }
  });

  $('#saveBtn').addEventListener('click', () => doSave(false));
  $('#applyBtn').addEventListener('click', onApply);

  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerOverlay').addEventListener('click', closeDrawer);

  $('#modelSearch').addEventListener('input', (e) => {
    state.drawerQuery = e.target.value;
    state.drawerActive = 0;
    renderDrawerList();
  });

  $('#modelList').addEventListener('click', (e) => {
    const row = e.target.closest('.model-row');
    if (!row) return;
    const rows = flatRows();
    const m = rows[Number(row.dataset.idx)];
    if (m) pickModel(m);
  });

  $('#modelList').addEventListener('mousemove', (e) => {
    const row = e.target.closest('.model-row');
    if (!row) return;
    const idx = Number(row.dataset.idx);
    if (idx !== state.drawerActive) {
      state.drawerActive = idx;
      renderDrawerList();
    }
  });
}

bind();
load();
