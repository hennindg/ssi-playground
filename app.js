"use strict";

// Interactive SSI-cov: page logic and plots. The computation itself is Python (python/ssi_core.py),
// running in worker.js. This file reads the controls, asks the worker for results and draws them.

const FS = 2;                 // sample rate [Hz]
const MAX_MODES = 6;
const REPEAT_COUNT = 20;
const MAX_TOEPLITZ = 1080;    // largest Toeplitz matrix size (block rows x sensors)

const state = {
  modes: [
    { f: 0.14, z: 0.5 },
    { f: 0.21, z: 1.0 },
    { f: 0.28, z: 1.5 },
    { f: 0.36, z: 2.5 },
    { f: 0.45, z: 3.5 },
  ],
  seed: 1,
  last: null,          // last detailed result (stabilization diagram, shapes, record)
  lastParams: null,    // the settings that produced it
  runs: [],            // light results of every record run with the current settings
  runsKey: "",         // the settings those runs belong to
  wantDetailed: false,
  repeatLeft: 0,
  pythonReady: false,
  busy: false,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Worker (Python)
// ---------------------------------------------------------------------------------------------

const worker = new Worker("worker.js");
const pending = new Map();
let nextId = 1;

worker.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "status") {
    setStatus("busy", msg.text);
  } else if (msg.type === "ready") {
    state.pythonReady = true;
    setStatus("ready", "Ready");
    requestDetailedRun(0);
  } else if (msg.type === "error") {
    setStatus("error", "Python failed to load");
    console.error(msg.text);
  } else if (msg.type === "result") {
    const job = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) job.reject(new Error(msg.error));
    else job.resolve(msg.result);
  }
};

function compute(params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, params });
  });
}

function setStatus(kind, text) {
  $("status").className = "status " + kind;
  $("status-text").textContent = text;
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

function readParams() {
  return {
    freqs: state.modes.map((m) => m.f),
    dampings: state.modes.map((m) => m.z / 100),
    sensors: +$("sensors").value,
    noise: +$("noise").value / 100,
    duration_min: +$("duration").value,
    fs: FS,
    block_rows: +$("rows").value,
    max_order: +$("order").value,
  };
}

const settingsKey = (params) => JSON.stringify(params);

function renderModeList() {
  const list = $("mode-list");
  list.innerHTML = "";
  state.modes.forEach((mode, k) => {
    const row = document.createElement("div");
    row.className = "mode-row";
    row.innerHTML = `
      <span class="mode-index">${k + 1}</span>
      <input type="number" step="0.005" min="0.02" max="0.95" value="${mode.f}" aria-label="Mode ${k + 1} frequency in Hz">
      <input type="number" step="0.1" min="0.1" max="9.5" value="${mode.z}" aria-label="Mode ${k + 1} damping in percent">
      <button class="remove" title="Remove mode" aria-label="Remove mode ${k + 1}">&times;</button>`;
    const [fInput, zInput] = row.querySelectorAll("input");
    fInput.addEventListener("input", () => updateMode(k, "f", fInput, 0.02, 0.95));
    zInput.addEventListener("input", () => updateMode(k, "z", zInput, 0.1, 9.5));
    const remove = row.querySelector(".remove");
    remove.disabled = state.modes.length <= 1;
    remove.addEventListener("click", () => {
      state.modes.splice(k, 1);
      modesChanged();
    });
    list.appendChild(row);
  });
  $("add-mode").disabled = state.modes.length >= MAX_MODES;
}

function updateMode(k, key, input, min, max) {
  const value = parseFloat(input.value);
  const valid = Number.isFinite(value) && value >= min && value <= max;
  input.classList.toggle("invalid", !valid);
  if (!valid) return;
  state.modes[k][key] = value;
  requestDetailedRun(350);
}

function modesChanged() {
  renderModeList();
  // Mode k has k half-waves; with fewer sensors than modes the shapes cannot all be told apart
  const sensors = $("sensors");
  sensors.min = Math.max(2, state.modes.length);
  if (+sensors.value < +sensors.min) sensors.value = sensors.min;
  updateSliderLabels();
  requestDetailedRun(150);
}

$("add-mode").addEventListener("click", () => {
  const lastF = state.modes.length ? state.modes[state.modes.length - 1].f : 0.1;
  state.modes.push({ f: +Math.min(0.95, lastF + 0.08).toFixed(3), z: 1.0 });
  modesChanged();
});

function updateSliderLabels() {
  // The Toeplitz matrix is (rows x sensors) squared; above ~1080 the decomposition gets slow
  // in the browser (it grows with the cube of the size), so fewer block rows are allowed with many sensors.
  $("rows").max = Math.min(120, Math.floor(MAX_TOEPLITZ / +$("sensors").value / 5) * 5);
  const rows = +$("rows").value;
  const sensors = +$("sensors").value;
  const highestOrder = Math.min(+$("order").value, (rows - 1) * sensors);
  $("sensors-out").textContent = sensors;
  $("noise-out").textContent = $("noise").value + " %";
  $("duration-out").textContent = $("duration").value + " min";
  $("rows-out").textContent = `${rows} · lag ${((2 * rows - 1) / FS).toFixed(1)} s`;
  $("order-out").textContent = highestOrder;
  for (const id of ["sensors", "noise", "duration", "rows", "order"]) {
    const s = $(id);
    s.style.setProperty("--fill", (100 * (s.value - s.min)) / (s.max - s.min) + "%");
  }
}

for (const id of ["sensors", "noise", "duration", "rows", "order"]) {
  $(id).addEventListener("input", () => {
    updateSliderLabels();
    requestDetailedRun(250);
  });
}

$("new-record").addEventListener("click", () => {
  state.seed = nextUnusedSeed();
  requestDetailedRun(0);
});

$("repeat").addEventListener("click", () => {
  state.repeatLeft = state.repeatLeft > 0 ? 0 : REPEAT_COUNT;
  updateRunInfo();
  pump();
});

// ---------------------------------------------------------------------------------------------
// Running: one job at a time; a detailed run of the latest settings always goes first
// ---------------------------------------------------------------------------------------------

let debounceTimer = null;

function requestDetailedRun(delay) {
  clearTimeout(debounceTimer);
  document.querySelector(".results").classList.add("stale");   // fade the plots until the new result is in
  debounceTimer = setTimeout(() => {
    state.wantDetailed = true;
    pump();
  }, delay);
}

function nextUnusedSeed() {
  return Math.max(state.seed, ...state.runs.map((r) => r.seed)) + 1;
}

async function pump() {
  if (state.busy || !state.pythonReady) return;
  state.busy = true;
  try {
    while (true) {
      if (state.wantDetailed) {
        state.wantDetailed = false;
        await detailedRun();
      } else if (state.repeatLeft > 0) {
        await repeatStep();
      } else {
        break;
      }
    }
  } catch (err) {
    console.error(err);
    setStatus("error", "Error, see console");
    state.repeatLeft = 0;
  } finally {
    state.busy = false;
    updateRunInfo();
  }
}

async function detailedRun() {
  const params = readParams();
  setStatus("busy", "Running");
  const result = await compute({ ...params, seed: state.seed, details: true });
  if (settingsKey(params) !== state.runsKey) state.repeatLeft = 0;   // settings changed: stop repeating
  state.last = result;
  state.lastParams = params;
  addRun(params, result);
  state.lastTime = result.timing.simulate + result.timing.ssi;
  setStatus("ready", "Ready");
  renderAll();
  if (!state.wantDetailed) document.querySelector(".results").classList.remove("stale");
}

async function repeatStep() {
  const params = readParams();
  if (settingsKey(params) !== state.runsKey) {
    state.repeatLeft = 0;
    return;
  }
  setStatus("busy", "Running");
  const seed = nextUnusedSeed();
  const result = await compute({ ...params, seed, details: false });
  if (settingsKey(readParams()) !== state.runsKey) return;          // changed while computing
  addRun(params, result);
  state.repeatLeft -= 1;
  setStatus("ready", "Ready");
  renderDamping();
  renderTable();
  updateRunInfo();
}

function addRun(params, result) {
  const key = settingsKey(params);
  if (key !== state.runsKey) {
    state.runs = [];
    state.runsKey = key;
  }
  if (state.runs.some((r) => r.seed === result.seed)) return;
  // identified damping and frequency for each true mode (null when the mode was not found)
  state.runs.push({
    seed: result.seed,
    damping: result.matches.map((i) => (i >= 0 ? result.modes[i].damping : null)),
    freq: result.matches.map((i) => (i >= 0 ? result.modes[i].freq : null)),
  });
}

function updateRunInfo() {
  const n = state.runs.length;
  const time = state.lastTime ? ` · ${state.lastTime.toFixed(2)} s per record` : "";
  let text = `${n} record${n === 1 ? "" : "s"} with these settings${time}`;
  if (state.repeatLeft > 0) text = `Running record ${REPEAT_COUNT - state.repeatLeft + 1} of ${REPEAT_COUNT}`;
  $("run-info").textContent = state.pythonReady ? text : "";
  $("repeat").textContent = state.repeatLeft > 0 ? "Stop" : `Run ${REPEAT_COUNT} records`;
  $("new-record").disabled = state.repeatLeft > 0;
}

// ---------------------------------------------------------------------------------------------
// Plot helpers (plain SVG)
// ---------------------------------------------------------------------------------------------

const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(NS, tag);
  for (const key in attrs) el.setAttribute(key, attrs[key]);
  if (parent) parent.appendChild(el);
  return el;
}

function linearScale(d0, d1, r0, r1) {
  const f = (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
  f.invert = (p) => d0 + ((p - r0) / (r1 - r0)) * (d1 - d0);
  return f;
}

function niceTicks(min, max, count) {
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const n = raw / power;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * power;
  const ticks = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function newSvg(container) {
  container.innerHTML = "";
  const w = container.clientWidth;
  const h = container.clientHeight;
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h }, container);
  return { svg, w, h };
}

function placeholder(container, text) {
  const { svg, w, h } = newSvg(container);
  const t = svgEl("text", { x: w / 2, y: h / 2, "text-anchor": "middle", class: "loading-text" }, svg);
  t.textContent = text;
}

const tooltip = $("tooltip");

function showTooltip(html, clientX, clientY) {
  tooltip.innerHTML = html;
  tooltip.classList.add("show");
  const box = tooltip.getBoundingClientRect();
  let left = clientX + 14;
  let top = clientY + 14;
  if (left + box.width > window.innerWidth - 8) left = clientX - box.width - 14;
  if (top + box.height > window.innerHeight - 8) top = clientY - box.height - 14;
  tooltip.style.left = left + "px";
  tooltip.style.top = top + "px";
}

function hideTooltip() {
  tooltip.classList.remove("show");
}

const pct = (v, digits = 2) => (100 * v).toFixed(digits);
const signed = (v, digits) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(digits);

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values) {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, values.length - 1));
}

// ---------------------------------------------------------------------------------------------
// Record: a short piece of three channels
// ---------------------------------------------------------------------------------------------

function renderTrace() {
  const r = state.last;
  const container = $("trace");
  const { svg, w, h } = newSvg(container);
  const m = { l: 64, r: 4, t: 4, b: 18 };
  const traces = r.trace.y;
  const n = traces[0].length;
  const lane = (h - m.t - m.b) / traces.length;
  const amp = Math.max(...traces.map((t) => Math.max(...t.map(Math.abs))));
  const x = linearScale(0, n - 1, m.l, w - m.r);
  const minutes = n / r.trace.fs / 60;

  traces.forEach((t, c) => {
    const mid = m.t + lane * (c + 0.5);
    const y = linearScale(-amp, amp, mid + lane / 2 - 2, mid - lane / 2 + 2);
    svgEl("line", { x1: m.l, x2: w - m.r, y1: mid, y2: mid, class: "trace-zero" }, svg);
    // thin the line for narrow screens: at most two points per pixel
    const stride = Math.max(1, Math.floor(n / (2 * (w - m.l))));
    let d = "";
    for (let i = 0; i < n; i += stride) d += (i ? "L" : "M") + x(i).toFixed(1) + "," + y(t[i]).toFixed(1);
    svgEl("path", { d, class: "trace-line" }, svg);
    const label = svgEl("text", { x: 0, y: mid + 4, class: "tick" }, svg);
    label.textContent = `x/L ${r.trace.x[c].toFixed(2)}`;
  });

  for (let t = 0; t <= minutes + 1e-9; t += 2) {
    const anchor = t + 2 > minutes + 1e-9 ? "end" : "middle";     // keep the last label inside the panel
    const label = svgEl("text", { x: x(t * 60 * r.trace.fs), y: h - 2, class: "tick", "text-anchor": anchor }, svg);
    label.textContent = t + (t === 0 ? "" : " min");
  }
  $("record-note").textContent = `first ${Math.round(minutes)} min · ${r.trace.y.length} of ${r.sensor_x.length} sensors · seed ${r.seed}`;
}

// ---------------------------------------------------------------------------------------------
// Stabilization diagram
// ---------------------------------------------------------------------------------------------

function renderStab() {
  const r = state.last;
  const params = state.lastParams;
  const container = $("stab");
  const { svg, w, h } = newSvg(container);
  const m = { l: 34, r: 10, t: 18, b: 30 };

  const fTop = Math.max(...params.freqs);
  const fMax = Math.min(1, Math.max(0.3, Math.ceil(fTop * 1.25 * 10) / 10));
  const x = linearScale(0, fMax, m.l, w - m.r);
  const y = linearScale(0, r.max_order + 2, h - m.b, m.t);

  // grid
  const grid = svgEl("g", { class: "grid" }, svg);
  const xTicks = niceTicks(0, fMax, Math.max(3, Math.round((w - m.l) / 90)));
  const yTicks = niceTicks(0, r.max_order, 6);
  for (const t of xTicks) svgEl("line", { x1: x(t), x2: x(t), y1: m.t, y2: h - m.b }, grid);
  for (const t of yTicks) svgEl("line", { x1: m.l, x2: w - m.r, y1: y(t), y2: y(t) }, grid);

  // spectrum in the background (shape only: its peaks show where the energy is)
  const sy = linearScale(-45, 0, h - m.b, m.t + 4);
  let area = `M${x(r.spectrum.freq[0]).toFixed(1)},${h - m.b}`;
  let line = "";
  r.spectrum.freq.forEach((f, i) => {
    if (f > fMax) return;
    const py = sy(Math.max(-45, r.spectrum.db[i])).toFixed(1);
    area += `L${x(f).toFixed(1)},${py}`;
    line += (line ? "L" : "M") + `${x(f).toFixed(1)},${py}`;
  });
  const lastF = Math.min(fMax, r.spectrum.freq[r.spectrum.freq.length - 1]);
  area += `L${x(lastF).toFixed(1)},${h - m.b}Z`;
  svgEl("path", { d: area, class: "spectrum-area" }, svg);
  svgEl("path", { d: line, class: "spectrum-line" }, svg);

  // true frequencies
  params.freqs.forEach((f, k) => {
    svgEl("line", { x1: x(f), x2: x(f), y1: m.t, y2: h - m.b, class: "true-line" }, svg);
    const label = svgEl("text", { x: x(f), y: m.t - 6, "text-anchor": "middle", class: "tick" }, svg);
    label.textContent = k + 1;
  });

  // poles: other poles first, stable on top
  const points = [];
  const others = svgEl("g", {}, svg);
  const stable = svgEl("g", {}, svg);
  const p = r.poles;
  for (let i = 0; i < p.freq.length; i++) {
    if (p.freq[i] > fMax) continue;
    const px = x(p.freq[i]);
    const py = y(p.order[i]);
    if (p.stable[i]) svgEl("circle", { cx: px, cy: py, r: 2.8, class: "pole-stable" }, stable);
    else svgEl("circle", { cx: px, cy: py, r: 1.7, class: "pole-other" }, others);
    points.push({ px, py, i });
  }

  // axes
  svgEl("line", { x1: m.l, x2: w - m.r, y1: h - m.b, y2: h - m.b, class: "axis-line" }, svg);
  const decimals = xTicks.length > 1 && xTicks[1] - xTicks[0] < 0.1 - 1e-9 ? 2 : 1;
  for (const t of xTicks) {
    const label = svgEl("text", { x: x(t), y: h - m.b + 15, "text-anchor": "middle", class: "tick" }, svg);
    label.textContent = t.toFixed(decimals);
  }
  for (const t of yTicks) {
    const label = svgEl("text", { x: m.l - 8, y: y(t) + 3.5, "text-anchor": "end", class: "tick" }, svg);
    label.textContent = t;
  }
  svgEl("text", { x: w - m.r, y: h - 2, "text-anchor": "end", class: "axis-title" }, svg).textContent = "Frequency [Hz]";
  svgEl("text", { x: 0, y: m.t - 6, class: "axis-title" }, svg).textContent = "Order";

  // hover: nearest pole
  const ring = svgEl("circle", { r: 6, class: "hover-ring", visibility: "hidden" }, svg);
  const hit = svgEl("rect", { x: m.l, y: m.t, width: w - m.l - m.r, height: h - m.t - m.b, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (event) => {
    const box = svg.getBoundingClientRect();
    const mx = event.clientX - box.left;
    const my = event.clientY - box.top;
    let best = null;
    let bestD = 14 * 14;
    for (const pt of points) {
      const d = (pt.px - mx) ** 2 + (pt.py - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = pt;
      }
    }
    if (!best) {
      ring.setAttribute("visibility", "hidden");
      hideTooltip();
      return;
    }
    ring.setAttribute("cx", best.px);
    ring.setAttribute("cy", best.py);
    ring.setAttribute("visibility", "visible");
    const i = best.i;
    showTooltip(
      `${p.freq[i].toFixed(4)} Hz<br>ζ ${pct(p.damping[i])} %<br>` +
        `<span class="tt-muted">order ${p.order[i]} · ${p.stable[i] ? "stable" : "not stable"}</span>`,
      event.clientX,
      event.clientY
    );
  });
  hit.addEventListener("mouseleave", () => {
    ring.setAttribute("visibility", "hidden");
    hideTooltip();
  });
}

// ---------------------------------------------------------------------------------------------
// Mode shapes: one small chart per true mode
// ---------------------------------------------------------------------------------------------

function renderShapes() {
  const r = state.last;
  const container = $("shapes");
  container.innerHTML = "";
  const xs = r.sensor_x;

  r.true_shapes.forEach((trueShape, k) => {
    const card = document.createElement("div");
    card.className = "shape-card";
    const match = r.matches[k];
    const macText = match >= 0 ? `MAC ${r.macs[k].toFixed(3)}` : "not found";
    card.innerHTML = `<div class="shape-title"><span>Mode ${k + 1}</span><span class="mono">${macText}</span></div>`;
    container.appendChild(card);

    const svg = svgEl("svg", {}, card);
    const w = card.clientWidth - 20;
    const h = 64;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const x = linearScale(0, 1, 4, w - 4);
    const y = linearScale(-1.2, 1.2, h - 4, 4);

    svgEl("line", { x1: x(0), x2: x(1), y1: y(0), y2: y(0), class: "axis-line" }, svg);
    let d = "";
    for (let i = 0; i <= 120; i++) {
      const u = i / 120;
      d += (i ? "L" : "M") + x(u).toFixed(1) + "," + y(Math.sin((k + 1) * Math.PI * u)).toFixed(1);
    }
    svgEl("path", { d, class: "shape-true" }, svg);

    if (match >= 0) {
      // scale the identified shape onto the true one (least squares), so the two can be compared
      const shape = r.modes[match].shape;
      let top = 0;
      let bottom = 0;
      shape.forEach((v, i) => {
        top += v * trueShape[i];
        bottom += v * v;
      });
      const a = top / bottom;
      shape.forEach((v, i) => svgEl("circle", { cx: x(xs[i]), cy: y(a * v), r: 3.2, class: "pole-stable" }, svg));
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Damping: true value, every record, and the mean
// ---------------------------------------------------------------------------------------------

function jitter(seed) {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return s - Math.floor(s) - 0.5;
}

function renderDamping() {
  const params = state.lastParams;
  const container = $("damping");
  const { svg, w, h } = newSvg(container);
  const m = { l: 34, r: 8, t: 14, b: 40 };
  const nModes = params.freqs.length;
  const runs = state.runs;

  const all = params.dampings.slice();
  runs.forEach((run) => run.damping.forEach((z) => z !== null && all.push(z)));
  const zMax = Math.max(...all) * 1.15;
  const y = linearScale(0, 100 * zMax, h - m.b, m.t);
  const band = (w - m.l - m.r) / nModes;
  const half = Math.min(18, band * 0.32);

  const grid = svgEl("g", { class: "grid" }, svg);
  const yTicks = niceTicks(0, 100 * zMax, 5);
  for (const t of yTicks) {
    svgEl("line", { x1: m.l, x2: w - m.r, y1: y(t), y2: y(t) }, grid);
    const label = svgEl("text", { x: m.l - 8, y: y(t) + 3.5, "text-anchor": "end", class: "tick" }, svg);
    label.textContent = t;
  }
  svgEl("text", { x: 0, y: m.t - 4, class: "axis-title" }, svg).textContent = "ζ [%]";
  svgEl("line", { x1: m.l, x2: w - m.r, y1: h - m.b, y2: h - m.b, class: "axis-line" }, svg);

  for (let k = 0; k < nModes; k++) {
    const cx = m.l + band * (k + 0.5);
    const values = runs.map((run) => run.damping[k]).filter((z) => z !== null);
    const truth = params.dampings[k];

    svgEl("line", { x1: cx - half, x2: cx + half, y1: y(100 * truth), y2: y(100 * truth), class: "true-mark" }, svg);
    runs.forEach((run) => {
      const z = run.damping[k];
      if (z === null) return;
      svgEl("circle", { cx: cx + jitter(run.seed) * half * 1.3, cy: y(100 * z), r: 3.2, class: "pole-stable faded" }, svg);
    });

    const label = svgEl("text", { x: cx, y: h - m.b + 15, "text-anchor": "middle", class: "tick" }, svg);
    label.textContent = `Mode ${k + 1}`;
    if (values.length) {
      const avg = mean(values);
      svgEl("line", { x1: cx - half * 0.8, x2: cx + half * 0.8, y1: y(100 * avg), y2: y(100 * avg), class: "mean-mark" }, svg);
      const bias = svgEl("text", { x: cx, y: h - m.b + 30, "text-anchor": "middle", class: "tick" }, svg);
      bias.textContent = signed(100 * (avg - truth), 2);
    }

    // hover target: the whole column
    const hit = svgEl("rect", { x: cx - band / 2, y: m.t, width: band, height: h - m.t - m.b, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (event) => {
      let html = `Mode ${k + 1}<br><span class="tt-muted">true</span> ${pct(truth)} %`;
      if (values.length) {
        html += `<br><span class="tt-muted">mean</span> ${pct(mean(values))} %` +
          `<br><span class="tt-muted">bias</span> ${signed(100 * (mean(values) - truth), 2)} %-pt` +
          `<br><span class="tt-muted">std</span> ${values.length > 1 ? pct(std(values)) : "–"} %-pt` +
          `<br><span class="tt-muted">found in</span> ${values.length} / ${runs.length}`;
      }
      showTooltip(html, event.clientX, event.clientY);
    });
    hit.addEventListener("mouseleave", hideTooltip);
  }
  const biasTitle = svgEl("text", { x: 0, y: h - m.b + 30, class: "axis-title" }, svg);
  biasTitle.textContent = "bias";
}

// ---------------------------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------------------------

function renderTable() {
  const r = state.last;
  const params = state.lastParams;
  const body = $("table").querySelector("tbody");
  body.innerHTML = "";
  params.freqs.forEach((fTrue, k) => {
    const zTrue = params.dampings[k];
    const match = r.matches[k];
    const found = match >= 0 ? r.modes[match] : null;
    const values = state.runs.map((run) => run.damping[k]).filter((z) => z !== null);
    const avg = values.length ? mean(values) : null;
    const cells = [
      `${k + 1}`,
      fTrue.toFixed(3),
      found ? found.freq.toFixed(4) : "–",
      found ? signed((100 * (found.freq - fTrue)) / fTrue, 2) + " %" : "–",
      pct(zTrue) + " %",
      found ? pct(found.damping) + " %" : "–",
      avg !== null ? pct(avg) + " %" : "–",
      avg !== null ? signed(100 * (avg - zTrue), 2) : "–",
      found ? r.macs[k].toFixed(4) : "–",
    ];
    const row = document.createElement("tr");
    row.innerHTML = cells.map((c, i) => `<td class="${c === "–" || i === 0 ? "muted" : ""}">${c}</td>`).join("");
    body.appendChild(row);
  });
  const n = state.runs.length;
  $("table-note").textContent = `identified: seed ${r.seed} · mean and bias: ${n} record${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------------------------
// Drawing everything, resizing, theme
// ---------------------------------------------------------------------------------------------

function renderAll() {
  if (!state.last) return;
  renderTrace();
  renderStab();
  renderShapes();
  renderDamping();
  renderTable();
  updateRunInfo();
}

let resizeFrame = null;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (state.last) renderAll();
    else showPlaceholders();
  });
}).observe(document.querySelector(".results"));

function showPlaceholders() {
  placeholder($("trace"), "");
  placeholder($("stab"), "Loading Python and numpy (first visit takes a few seconds)");
  placeholder($("damping"), "");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("ssi-theme", theme);
  } catch (err) {
    // storage blocked: the theme just is not remembered
  }
}

$("theme").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});

(function init() {
  let theme = "dark";
  try {
    theme = localStorage.getItem("ssi-theme") || "dark";
  } catch (err) {
    // ignore
  }
  document.documentElement.dataset.theme = theme;
  renderModeList();
  updateSliderLabels();
  showPlaceholders();
  setStatus("busy", "Loading Python");
})();
