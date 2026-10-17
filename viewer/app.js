'use strict';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#chart');
const ctx = canvas.getContext('2d');

const LIST_LIMIT = 300;
const MA_PERIODS = [7, 21];

const state = {
  stocks: [],
  filtered: [],
  current: null,
  currentData: null,
  bars: [],
  ma: {},
  view: { start: 0, end: 0 },
  hover: -1,
  mouseY: null,
  drag: null,
  preset: 250,
  cache: new Map(),
  colors: {},
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const fmtPrice = (v) => v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAxis = (v) => (v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2));
const fmtBig = (v) => {
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.?0+$/, '')}亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  return Math.round(v).toLocaleString('zh-CN');
};

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  state.colors = {
    surface: v('--surface'),
    ink: v('--ink'),
    muted: v('--muted'),
    grid: v('--grid'),
    axis: v('--axis'),
    up: v('--up'),
    down: v('--down'),
    ma7: v('--ma7'),
    ma21: v('--ma21'),
  };
}

/* ---------------- 数据 ---------------- */

async function init() {
  readColors();
  try {
    const [metaRes, stocksRes] = await Promise.all([fetch('/api/meta'), fetch('/api/stocks')]);
    if (!metaRes.ok || !stocksRes.ok) throw new Error('接口不可用');
    const meta = await metaRes.json();
    const data = await stocksRes.json();
    state.stocks = data.stocks;
    state.filtered = state.stocks;
    $('#meta').textContent = `${meta.stocks} 只 · ${fmtDate(meta.firstDate)} ~ ${fmtDate(meta.lastDate)}`;
    renderList();
    const def = state.stocks.find((s) => s.code === 'sh600519') || state.stocks[0];
    if (def) selectStock(def.code);
  } catch (err) {
    $('#meta').textContent = `加载失败：${err.message}`;
  }

  new ResizeObserver(draw).observe($('#chartWrap'));
  bindEvents();
}

function renderList() {
  const shown = state.filtered.slice(0, LIST_LIMIT);
  $('#list').innerHTML = shown.map((s) => `
    <div class="row${state.current === s.code ? ' active' : ''}" role="option" aria-selected="${state.current === s.code}" data-code="${s.code}">
      <span class="name">${esc(s.name)}</span><span class="code">${s.code}</span>
    </div>`).join('');
  $('#listHint').textContent = state.filtered.length > LIST_LIMIT
    ? `显示前 ${LIST_LIMIT} 条 / 共 ${state.filtered.length} 条，输入搜索缩小范围`
    : `共 ${state.filtered.length} 条`;
}

async function selectStock(code) {
  if (!code) return;
  state.current = code;
  renderList();
  $('#list .row.active')?.scrollIntoView({ block: 'nearest' });

  let data = state.cache.get(code);
  if (!data) {
    try {
      const res = await fetch(`/api/kline?code=${encodeURIComponent(code)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      state.cache.set(code, data);
    } catch (err) {
      $('#legend').textContent = `加载失败：${err.message}`;
      return;
    }
  }

  state.currentData = data;
  state.bars = data.k;
  state.ma = {};
  for (const p of MA_PERIODS) state.ma[p] = calcMA(state.bars, p);

  applyPreset(state.preset);
  updateHeader();
  updateLegend();
  draw();
}

function calcMA(bars, p) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= p) sum -= bars[i - p].c;
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

function applyPreset(n) {
  const len = state.bars.length;
  const count = n === 0 ? len : Math.min(n, len);
  state.view = { start: Math.max(0, len - count), end: len };
  state.hover = -1;
  state.mouseY = null;
  setPressed(n);
}

function setPressed(n) {
  document.querySelectorAll('.ranges button[data-n]').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.n) === n));
  });
}

function clearPressed() {
  document.querySelectorAll('.ranges button[data-n]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
}

function updateHeader() {
  const bars = state.bars;
  if (!bars.length) {
    $('#stockName').textContent = '—';
    $('#stockCode').textContent = '';
    $('#lastPrice').textContent = '—';
    $('#delta').textContent = '';
    return;
  }
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;
  const chg = last.c - prev.c;
  const pct = prev.c ? (chg / prev.c) * 100 : 0;
  const cls = chg >= 0 ? 'up' : 'down';

  $('#stockName').textContent = state.currentData?.name || state.current;
  $('#stockCode').textContent = state.current;
  $('#lastPrice').textContent = fmtPrice(last.c);
  $('#lastPrice').className = `last ${cls}`;
  $('#delta').textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}  ${chg >= 0 ? '+' : ''}${pct.toFixed(2)}% · ${fmtDate(last.date)}`;
  $('#delta').className = `delta ${cls}`;
}

function updateLegend(index) {
  if (!state.bars.length) {
    $('#legend').innerHTML = '';
    return;
  }
  let i = index;
  if (i == null) i = state.hover >= 0 ? state.hover : state.bars.length - 1;
  $('#legend').innerHTML = MA_PERIODS.map((p) => {
    const v = state.ma[p]?.[i];
    return `<span><i class="sw" style="background:var(--ma${p})"></i>MA${p}<b>${v == null ? '—' : fmtPrice(v)}</b></span>`;
  }).join('');
}

/* ---------------- 绘图 ---------------- */

function geom() {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const pad = { top: 10, right: 64, bottom: 22, left: 10 };
  const priceH = Math.max(60, Math.round((H - pad.top - pad.bottom) * 0.76));
  const volTop = pad.top + priceH + 18;
  const volH = Math.max(18, H - pad.bottom - volTop);
  return { W, H, pad, priceTop: pad.top, priceH, volTop, volH, plotW: W - pad.left - pad.right };
}

function draw() {
  const g = geom();
  const { W, H } = g;
  if (!W || !H) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = state.colors.surface;
  ctx.fillRect(0, 0, W, H);

  const bars = state.bars;
  if (!bars.length) {
    ctx.fillStyle = state.colors.muted;
    ctx.font = '12px system-ui, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('选择左侧股票查看K线', W / 2, H / 2);
    return;
  }

  const { start, end } = state.view;
  const n = end - start;
  if (n <= 0) return;
  const step = g.plotW / n;
  const xAt = (i) => g.pad.left + (i - start + 0.5) * step;

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = start; i < end; i++) {
    if (bars[i].l < lo) lo = bars[i].l;
    if (bars[i].h > hi) hi = bars[i].h;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  const padP = (hi - lo) * 0.06 || Math.max(Math.abs(hi) * 0.01, 0.01);
  lo -= padP;
  hi += padP;
  const yAt = (p) => g.priceTop + ((hi - p) / (hi - lo)) * g.priceH;

  // 水平网格与价格刻度
  ctx.font = '10px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (let t = 0; t <= 4; t++) {
    const p = hi - ((hi - lo) * t) / 4;
    const y = Math.round(yAt(p)) + 0.5;
    ctx.strokeStyle = state.colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.pad.left, y);
    ctx.lineTo(W - g.pad.right, y);
    ctx.stroke();
    ctx.fillStyle = state.colors.muted;
    ctx.fillText(fmtAxis(p), W - g.pad.right + 8, y);
  }

  const bodyW = Math.max(1, Math.min(step * 0.62, 12));

  // K线与均线（裁剪在价格区内）
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.pad.left, g.priceTop, g.plotW, g.priceH);
  ctx.clip();

  for (let i = start; i < end; i++) {
    const b = bars[i];
    const up = b.c >= b.o;
    const color = up ? state.colors.up : state.colors.down;
    const x = xAt(i);
    const xw = Math.round(x) + 0.5;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xw, yAt(b.h));
    ctx.lineTo(xw, yAt(b.l));
    ctx.stroke();

    const yTop = yAt(Math.max(b.o, b.c));
    const yBottom = yAt(Math.min(b.o, b.c));
    ctx.fillRect(x - bodyW / 2, yTop, bodyW, Math.max(1, yBottom - yTop));
  }

  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  for (const p of MA_PERIODS) {
    ctx.strokeStyle = state.colors[`ma${p}`];
    ctx.beginPath();
    let started = false;
    for (let i = start; i < end; i++) {
      const v = state.ma[p][i];
      if (v == null) continue;
      const x = xAt(i);
      const y = yAt(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // 成交量
  let maxV = 0;
  for (let i = start; i < end; i++) if (bars[i].v > maxV) maxV = bars[i].v;
  if (maxV > 0) {
    ctx.globalAlpha = 0.55;
    for (let i = start; i < end; i++) {
      const b = bars[i];
      const up = b.c >= b.o;
      ctx.fillStyle = up ? state.colors.up : state.colors.down;
      const h = (b.v / maxV) * g.volH;
      const y = g.volTop + g.volH - h;
      ctx.fillRect(xAt(i) - bodyW / 2, y, bodyW, Math.max(1, h));
    }
    ctx.globalAlpha = 1;
  }

  // 日期刻度
  ctx.fillStyle = state.colors.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const tickCount = clamp(Math.floor(g.plotW / 96), 2, 8);
  const seen = new Set();
  for (let t = 0; t <= tickCount; t++) {
    const idx = Math.round(start + ((n - 1) * t) / tickCount);
    const d = bars[idx].date;
    const label = n > 280 ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : `${d.slice(4, 6)}-${d.slice(6, 8)}`;
    if (seen.has(label)) continue;
    seen.add(label);
    const x = clamp(xAt(idx), 36, W - g.pad.right - 20);
    ctx.fillText(label, x, H - 7);
  }

  // 十字光标
  if (state.hover >= start && state.hover < end) {
    const x = Math.round(xAt(state.hover)) + 0.5;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, g.priceTop);
    ctx.lineTo(x, g.volTop + g.volH);
    if (state.mouseY != null && state.mouseY >= g.priceTop && state.mouseY <= g.priceTop + g.priceH) {
      ctx.moveTo(g.pad.left, Math.round(state.mouseY) + 0.5);
      ctx.lineTo(W - g.pad.right, Math.round(state.mouseY) + 0.5);
    }
    ctx.stroke();
    ctx.restore();

    // 右侧价格气泡
    if (state.mouseY != null && state.mouseY >= g.priceTop && state.mouseY <= g.priceTop + g.priceH) {
      const price = hi - ((state.mouseY - g.priceTop) / g.priceH) * (hi - lo);
      chipRight(fmtAxis(price), state.mouseY, W - g.pad.right);
    }
    // 底部日期气泡
    chipBottom(fmtDate(bars[state.hover].date), x, H);
  }
}

function chipRight(text, y, plotRight) {
  const g = geom();
  const w = Math.max(52, text.length * 6 + 12);
  const yy = clamp(y, g.priceTop + 9, g.priceTop + g.priceH - 9);
  ctx.fillStyle = state.colors.axis;
  roundRect(plotRight - w / 2 - 2, yy - 9, w, 18, 4);
  ctx.fill();
  ctx.fillStyle = state.colors.ink;
  ctx.font = '10px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, plotRight - w / 2 - 2 + w / 2, yy);
}

function chipBottom(text, x, H) {
  const g = geom();
  const w = 74;
  const xx = clamp(x, g.pad.left + w / 2, g.W - g.pad.right - w / 2);
  ctx.fillStyle = state.colors.axis;
  roundRect(xx - w / 2, H - 20, w, 16, 4);
  ctx.fill();
  ctx.fillStyle = state.colors.ink;
  ctx.font = '10px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, xx, H - 12);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------------- 交互 ---------------- */

function hitTest(px) {
  const g = geom();
  const n = state.view.end - state.view.start;
  if (n <= 0) return { index: -1, g };
  const step = g.plotW / n;
  const i = state.view.start + Math.floor((px - g.pad.left) / step);
  return { index: clamp(i, state.view.start, state.view.end - 1), g };
}

function showTooltip(ev) {
  const tip = $('#tooltip');
  const i = state.hover;
  if (i < 0) { tip.hidden = true; return; }

  const b = state.bars[i];
  const prev = state.bars[i - 1];
  const chg = prev ? b.c - prev.c : 0;
  const pct = prev ? (chg / prev.c) * 100 : 0;
  const cls = chg >= 0 ? 'up' : 'down';
  const row = (k, v) => `<div class="t-row"><span>${k}</span><b>${v}</b></div>`;

  tip.innerHTML = `
    <div class="t-date">${fmtDate(b.date)}</div>
    ${row('开盘', fmtPrice(b.o))}
    ${row('最高', fmtPrice(b.h))}
    ${row('最低', fmtPrice(b.l))}
    ${row('收盘', fmtPrice(b.c))}
    ${row('涨跌', `<span class="${cls}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)} ${chg >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`)}
    ${row('成交量', `${fmtBig(b.v)}股`)}
    ${row('成交额', fmtBig(b.t))}`;
  tip.hidden = false;

  const wrap = $('#chartWrap');
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = ev.offsetX + 16;
  if (left + tw > wrap.clientWidth - 8) left = ev.offsetX - tw - 16;
  let top = ev.offsetY + 14;
  if (top + th > wrap.clientHeight - 8) top = ev.offsetY - th - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function bindEvents() {
  const menuBtn = $('#menuBtn');
  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;
  const setSidebar = (open) => {
    sidebar.classList.toggle('open', open);
    scrim.classList.toggle('show', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  };

  menuBtn.addEventListener('click', () => setSidebar(!sidebar.classList.contains('open')));
  scrim.addEventListener('click', () => setSidebar(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setSidebar(false);
  });

  $('#list').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    selectStock(row.dataset.code);
    if (isNarrow()) setSidebar(false);
  });

  $('#search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    state.filtered = q
      ? state.stocks.filter((s) => s.code.includes(q) || s.name.toLowerCase().includes(q))
      : state.stocks;
    renderList();
  });

  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.filtered[0]) {
      e.target.blur();
      selectStock(state.filtered[0].code);
      if (isNarrow()) setSidebar(false);
    }
  });

  document.querySelectorAll('.ranges button[data-n]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.preset = Number(btn.dataset.n);
      applyPreset(state.preset);
      updateLegend();
      draw();
    });
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!state.bars.length) return;

    if (state.drag) {
      const { g } = hitTest(e.offsetX);
      const count = state.drag.end - state.drag.start;
      const step = g.plotW / count;
      const shift = Math.round((e.clientX - state.drag.x) / step);
      const start = clamp(state.drag.start - shift, 0, state.bars.length - count);
      state.view = { start, end: start + count };
      clearPressed();
      state.hover = -1;
      $('#tooltip').hidden = true;
      draw();
      return;
    }

    const { index } = hitTest(e.offsetX);
    state.hover = index;
    state.mouseY = e.offsetY;
    updateLegend(index);
    showTooltip(e);
    draw();
  });

  canvas.addEventListener('mouseleave', () => {
    state.hover = -1;
    state.mouseY = null;
    state.drag = null;
    $('#tooltip').hidden = true;
    updateLegend();
    draw();
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !state.bars.length) return;
    state.drag = { x: e.clientX, start: state.view.start, end: state.view.end };
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mouseup', () => {
    if (state.drag) {
      state.drag = null;
      canvas.style.cursor = 'crosshair';
    }
  });

  canvas.addEventListener('wheel', (e) => {
    if (!state.bars.length) return;
    e.preventDefault();
    const { g } = hitTest(e.offsetX);
    const cur = state.view.end - state.view.start;
    const next = e.deltaY > 0 ? cur * 1.15 : cur / 1.15;
    const count = Math.round(clamp(next, 8, state.bars.length));
    if (count === cur) return;

    const ratio = clamp((e.offsetX - g.pad.left) / g.plotW, 0, 1);
    const anchor = state.view.start + ratio * cur;
    const start = Math.round(clamp(anchor - ratio * count, 0, state.bars.length - count));
    state.view = { start, end: start + count };
    clearPressed();
    state.hover = -1;
    $('#tooltip').hidden = true;
    updateLegend();
    draw();
  }, { passive: false });

  canvas.addEventListener('dblclick', () => {
    applyPreset(state.preset);
    updateLegend();
    draw();
  });
}

init();
