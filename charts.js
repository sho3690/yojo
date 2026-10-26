// グラフ。evilcharts（~/.claude/skills/evilcharts）の作法を ECharts で再現する:
// 細い線 0.8px・上から下へ淡くなる塗り・Y の破線グリッドだけ・軸線なしの点の目盛り・吹き出しは自前の HTML。
// 色はアプリの青1色（--chart）と、ふだんの範囲の灰色だけ。ECharts は推移の画面を開いたときに読み込む。

let loading = null;
function loadECharts() {
  if (globalThis.echarts) return Promise.resolve(globalThis.echarts);
  return (loading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = './vendor/echarts.min.js';
    s.onload = () => res(globalThis.echarts);
    s.onerror = () => { loading = null; s.remove(); rej(new Error('echarts')); };
    document.head.append(s);
  }));
}

const live = new Set();
let ro = null;
export function disposeCharts() { for (const c of live) c.dispose(); live.clear(); }

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  return { bg: v('--surface'), fg: v('--text'), muted: v('--text-3'), border: v('--border'), line: v('--chart') };
}
function withAlpha(color, a) {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; }
  const r = color.match(/rgba?\(([^)]+)\)/);
  if (!r) return color;
  const [x, y, z] = r[1].split(',').map(s => s.trim());
  return `rgba(${x}, ${y}, ${z}, ${a})`;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 目盛りが切りのいい数になるように、上下に少し余白をとった範囲を作る
function niceBounds(vals, fromZero, interval) {
  if (!vals.length) return [undefined, undefined];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (fromZero) lo = Math.min(0, lo);
  const span = hi - lo || Math.abs(hi) * 0.2 || 1;
  lo -= fromZero ? 0 : span * 0.15; hi += span * 0.15;
  let step = interval || 10 ** Math.floor(Math.log10(span));
  if (!interval && span / step < 2.5) step /= 2;
  return [fromZero && lo >= 0 ? 0 : Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

// spec: { el, kind: 'line'|'bar', points: [{ day, v }], label, fmt, axis, base: { mean, sd, n }, min, max, labelOf, sparse }
// sparse: 自分の記録のように飛び飛びの値。点を打って線でつなぐ（塗りはしない）
function option(echarts, s, t, animate) {
  const cats = s.points.map(p => p.day);
  const data = s.points.map(p => (p.v == null ? null : p.v));
  const few = s.points.length <= 14;
  const showBase = s.base && s.base.n >= 7 && s.base.mean != null;
  const lo = showBase ? s.base.mean - s.base.sd : null, hi = showBase ? s.base.mean + s.base.sd : null;
  const mark = showBase ? {
    markArea: { silent: true, itemStyle: { color: withAlpha(t.muted, 0.12) }, data: [[{ yAxis: lo }, { yAxis: hi }]] },
    markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: t.muted, width: 0.8, type: [3, 3] }, data: [{ yAxis: s.base.mean }] },
  } : {};
  const main = s.kind === 'bar'
    ? { type: 'bar', name: s.label, data, barMaxWidth: 14, itemStyle: { color: t.line, borderRadius: [2, 2, 0, 0] }, ...mark,
      animationDuration: animate ? 500 : 0, animationEasing: 'cubicOut', animationDelay: i => (animate ? i * (few ? 50 : 8) : 0) }
    : { type: 'line', name: s.label, data, connectNulls: !!s.sparse, lineStyle: { width: 0.8, color: t.line }, itemStyle: { color: t.line },
      symbol: 'circle', symbolSize: few || s.sparse ? 5 : 3, showSymbol: few || !!s.sparse, showAllSymbol: few || !!s.sparse,
      areaStyle: s.area === false ? undefined : { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: withAlpha(t.line, 0.16) }, { offset: 1, color: withAlpha(t.line, 0) }]) },
      ...mark, animationDuration: animate ? 1000 : 0, animationEasing: 'cubicOut' };
  const ext = [...data.filter(v => v != null), ...(showBase ? [lo, hi] : [])];
  const [yMin, yMax] = niceBounds(ext, s.kind === 'bar', s.interval);
  return {
    animation: !!animate,
    grid: { left: 4, right: 16, top: 12, bottom: 4, containLabel: true },   // 右端の日付が欠けないように
    xAxis: {
      type: 'category', data: cats, boundaryGap: s.kind === 'bar',
      axisLine: { show: false },
      axisTick: { show: true, alignWithLabel: true, length: 0.5, interval: few ? 0 : 'auto', lineStyle: { color: t.border, width: 3, cap: 'round' } },
      splitLine: { show: false },
      axisLabel: { color: t.muted, fontSize: 10, margin: 8, hideOverlap: true, formatter: s.labelOf },
    },
    yAxis: {
      type: 'value', splitNumber: 3, interval: s.interval,
      min: s.min ?? yMin, max: s.max ?? yMax,
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { show: true, lineStyle: { color: t.border, type: [3, 3], width: 1 } },
      axisLabel: { color: t.muted, fontSize: 10, margin: 8, formatter: s.axis || (v => v.toLocaleString('ja-JP')) },
    },
    tooltip: {
      trigger: 'axis', confine: true, backgroundColor: 'transparent', borderWidth: 0, padding: 0, extraCssText: 'box-shadow:none;',
      axisPointer: { type: 'line', lineStyle: { color: t.border, width: 0.8, type: [3, 3] } },
      formatter(params) {
        const p = (Array.isArray(params) ? params : [params])[0];
        if (!p) return '';
        const v = p.value;
        const rows = [`<div class="tt-row"><i class="tt-sw"></i><span>${esc(s.label)}</span><b>${v == null ? '—' : esc(s.fmt(v))}</b></div>`];
        if (showBase) rows.push(`<div class="tt-row"><i class="tt-sw base"></i><span>ふだん</span><b>${esc(s.fmt(s.base.mean))}</b></div>`);
        return `<div class="tt"><div class="tt-head">${esc(s.tipDay ? s.tipDay(p.name) : p.name)}</div>${rows.join('')}</div>`;
      },
    },
    series: [main],
  };
}

// 描く。first=true のときだけ表示のアニメーションをする（更新や色の切り替えでは即時に）
export async function mountCharts(specs, { first = false } = {}) {
  let echarts;
  try { echarts = await loadECharts(); } catch { for (const s of specs) s.el.replaceChildren(Object.assign(document.createElement('p'), { className: 'chart-empty', textContent: 'グラフを読み込めませんでした' })); return; }
  disposeCharts();
  const t = tokens();
  for (const s of specs) {
    if (!s.el.isConnected) continue;
    const c = echarts.init(s.el, null, { renderer: 'canvas' });
    c.setOption(option(echarts, s, t, first));
    live.add(c);
  }
  if (!ro && 'ResizeObserver' in globalThis) {
    let raf = 0;
    ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { for (const c of live) c.resize(); }); });
    ro.observe(document.documentElement);
  }
}
