// ══════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════
const CFG = {
  ITEM_COUNT: 18,
  SEED: 42,
  SPEEDS: { slow: 12000, normal: 6000, fast: 4000 },
  COL_IDS: ['eval','plan','impl','test'],
  COL_NAMES: { eval:'Evaluierung', plan:'Planning', impl:'Umsetzung', test:'Testing' },
  SLOTS:     { eval: 3, plan: 3, impl: 2, test: 2 },
  EFFORT:    { eval:[1,2], plan:[1,2], impl:[1,2], test:[1,2] },
  R2_LIMITS: { ideen:8, eval:3, plan:3, impl:2, test:2 },
  BLOCK_CHANCE: 0.04,
  BLOCK_DURATION: [2,4],
  REWORK_CHANCE: 0.15,
  CFD_COLORS: {
    ideen:'#94a3b8', eval:'#a78bfa', plan:'#60a5fa',
    impl:'#34d399', test:'#f87171', fertig:'#10b981'
  },
  CFD_LABELS: {
    ideen:'Ideen Speicher', eval:'Evaluierung', plan:'Planning',
    impl:'Umsetzung', test:'Testing', fertig:'Fertig'
  }
};

// ══════════════════════════════════════════════════════
// SEEDED RNG
// ══════════════════════════════════════════════════════
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return ((s >>> 0) / 0xFFFFFFFF);
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

// ══════════════════════════════════════════════════════
// ITEM POOL (identical across rounds)
// ══════════════════════════════════════════════════════
function generatePool(seed) {
  const rng = makeRng(seed);
  return Array.from({length: CFG.ITEM_COUNT}, (_, i) => ({
    id: `T${String(i+1).padStart(2,'0')}`,
    baseEffort: {
      eval: randInt(rng, ...CFG.EFFORT.eval),
      plan: randInt(rng, ...CFG.EFFORT.plan),
      impl: randInt(rng, ...CFG.EFFORT.impl),
      test: randInt(rng, ...CFG.EFFORT.test),
    }
  }));
}

const ITEM_POOL = generatePool(CFG.SEED);

// ══════════════════════════════════════════════════════
// SIMULATION CLASS
// ══════════════════════════════════════════════════════
class Simulation {
  constructor({ days, wipLimits, usePull, enableBlockers, enableRework, runLabel }) {
    this.days       = days;
    this.wipLimits  = wipLimits;   // { ideen, eval, plan, impl, test } – null = unlimited
    this.usePull    = usePull;
    this.enableBlockers = enableBlockers || false;
    this.enableRework   = enableRework   || false;
    this.runLabel   = runLabel || 'Durchlauf';

    this.currentDay = 0;
    this.cfdData    = [];
    this.fertig     = [];
    this.rng        = makeRng(CFG.SEED + 1000);

    // Clone pool
    this.ideenSpeicher = ITEM_POOL.map(t => ({
      id: t.id,
      effortLeft: { ...t.baseEffort },
      reworkCount: 0,
      state: 'pool',
      entryDay: null,
      doneDay: null,
      blockLeft: 0,
      stageEntry: {},
      progress: {},
    }));

    // Columns
    this.cols = {
      eval: { id:'eval', inProgress:[], waitZone:[] },
      plan: { id:'plan', inProgress:[], waitZone:[] },
      impl: { id:'impl', inProgress:[], waitZone:[] },
      test: { id:'test', inProgress:[], waitZone:[] },
    };
    this.colOrder = ['eval','plan','impl','test'];
  }

  getWIP(colId) {
    const col = this.cols[colId];
    return col.inProgress.length + col.waitZone.length;
  }

  canEnter(colId) {
    const limit = this.wipLimits[colId];
    if (limit === null) return true;
    return this.cols[colId].inProgress.length < limit;
  }

  // Phase 1: Work — reduce effort, handle blockers
  tickWork() {
    this.currentDay++;

    for (const cid of this.colOrder) {
      const col = this.cols[cid];
      const activeCount = col.inProgress.length;
      const capacity = CFG.SLOTS[cid];
      const efficiency = activeCount <= capacity ? 1.0 : capacity / activeCount;

      for (const item of col.inProgress) {
        if (item.blockLeft > 0) {
          item.blockLeft--;
          item.state = 'blocked';
          if (item.blockLeft === 0) item.state = 'inProgress';
          continue;
        }
        item.state = 'inProgress';

        if (!item.progress[cid]) item.progress[cid] = 0;
        item.progress[cid] += efficiency;
        while (item.progress[cid] >= 1 && item.effortLeft[cid] > 0) {
          item.effortLeft[cid]--;
          item.progress[cid] -= 1;
        }

        if (this.enableBlockers && this.rng() < CFG.BLOCK_CHANCE) {
          item.blockLeft = randInt(this.rng, ...CFG.BLOCK_DURATION);
          item.state = 'blocked';
        }
      }
    }
  }

  // Phase 2: Move — completed items to waitZone, pull/push into next columns, CFD
  tickMove() {
    // Complete items → waitZone
    for (const cid of this.colOrder) {
      const col = this.cols[cid];
      const done = col.inProgress.filter(i => i.effortLeft[cid] <= 0 && i.blockLeft === 0);
      for (const item of done) {
        col.inProgress = col.inProgress.filter(x => x !== item);
        item.state = 'waiting';
        item.progress[cid] = 0;
        col.waitZone.push(item);
      }
    }

    // Testing.waitZone → Fertig (with optional rework)
    const testCol = this.cols['test'];
    while (testCol.waitZone.length > 0) {
      const item = testCol.waitZone.shift();
      if (this.enableRework && item.reworkCount < 2 && this.rng() < CFG.REWORK_CHANCE) {
        // Rework: item goes back to impl inProgress, then must pass test again
        item.reworkCount++;
        item.effortLeft['impl'] = randInt(this.rng, ...CFG.EFFORT.impl);
        item.effortLeft['test'] = randInt(this.rng, ...CFG.EFFORT.test);
        item.progress['impl'] = 0;
        item.progress['test'] = 0;
        if (item._lastPct) { item._lastPct['impl'] = 0; item._lastPct['test'] = 0; }
        item.state = 'inProgress';
        item.stageEntry['impl'] = this.currentDay;
        this.cols['impl'].inProgress.push(item);
      } else {
        item.state = 'done';
        item.doneDay = this.currentDay;
        item.leadTime = this.currentDay - item.entryDay;
        this.fertig.push(item);
      }
    }

    // Move items: right to left
    for (let i = this.colOrder.length - 1; i >= 0; i--) {
      const cid = this.colOrder[i];
      const col  = this.cols[cid];
      const slots = CFG.SLOTS[cid];
      const source = i === 0
        ? this.ideenSpeicher
        : this.cols[this.colOrder[i-1]].waitZone;

      if (this.usePull) {
        while (source.length > 0) {
          if (!this.canEnter(cid)) break;
          const item = source.shift();
          item.state = 'inProgress';
          if (item.entryDay === null) item.entryDay = this.currentDay;
          item.stageEntry[cid] = this.currentDay;
          item.progress[cid] = 0;
          if (item._lastPct) item._lastPct[cid] = 0;
          col.inProgress.push(item);
        }
      } else {
        if (i === 0) {
          while (source.length > 0 && col.inProgress.length < slots) {
            const item = source.shift();
            item.state = 'inProgress';
            if (item.entryDay === null) item.entryDay = this.currentDay;
            item.stageEntry[cid] = this.currentDay;
            item.progress[cid] = 0;
            col.inProgress.push(item);
          }
        } else {
          while (source.length > 0) {
            const item = source.shift();
            item.state = 'inProgress';
            if (item.entryDay === null) item.entryDay = this.currentDay;
            item.stageEntry[cid] = this.currentDay;
            item.progress[cid] = 0;
            col.inProgress.push(item);
          }
        }
      }
    }

    // 5. Record CFD
    const snap = { day: this.currentDay };
    snap.ideen = this.ideenSpeicher.length;
    for (const cid of this.colOrder) {
      snap[cid] = this.getWIP(cid);
    }
    snap.fertig = this.fertig.length;
    this.cfdData.push(snap);
  }

  // Combined tick for headless/test usage
  tick() {
    this.tickWork();
    this.tickMove();
  }

  getMetrics() {
    const done = this.fertig;
    const n = done.length;
    const lts = done.map(i => i.leadTime).sort((a,b)=>a-b);
    const avgLT = n ? (lts.reduce((s,x)=>s+x,0)/n).toFixed(1) : '-';
    const minLT = n ? lts[0] : '-';
    const maxLT = n ? lts[lts.length-1] : '-';
    const throughput = n;
    const throughputPerDay = n ? (n / this.days).toFixed(2) : '0';

    // Average WIP over simulation
    const avgWIP = this.cfdData.length
      ? (this.cfdData.reduce((s, snap) => {
          return s + CFG.COL_IDS.reduce((ss, cid) => ss + (snap[cid]||0), 0);
        }, 0) / this.cfdData.length).toFixed(1)
      : '-';

    // Items started but not finished
    const allItems = [
      ...this.ideenSpeicher,
      ...CFG.COL_IDS.flatMap(cid => [...this.cols[cid].inProgress, ...this.cols[cid].waitZone]),
      ...this.fertig
    ];
    const started = allItems.filter(i => i.entryDay !== null && i.state !== 'done').length;

    return { avgLT, minLT, maxLT, throughput, throughputPerDay, avgWIP, started };
  }

  isDone() { return this.currentDay >= this.days; }
}

// ══════════════════════════════════════════════════════
// APP STATE
// ══════════════════════════════════════════════════════
const S = {
  mode: null,
  currentSim: null,
  r1Results: null,
  r2Results: null,
  freeRuns: [],
  tickTimer: null,
  speed: 'normal',
  paused: false,
  movePhaseActive: false,
  afterSimPhase: null,  // 'reflect' | 'compare' | 'results'
};

// ══════════════════════════════════════════════════════
// VIEW MANAGEMENT
// ══════════════════════════════════════════════════════
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${id}`).classList.add('active');
}

// ══════════════════════════════════════════════════════
// BOARD RENDERING
// ══════════════════════════════════════════════════════
function itemEl(item, currentCol, isNew, phase) {
  const el = document.createElement('div');

  // Find base effort for this item from ITEM_POOL
  const poolItem = ITEM_POOL.find(p => p.id === item.id);
  const baseEffort = poolItem ? poolItem.baseEffort : {};

  // Determine if item just completed its work in this column
  const isCompleted = phase === 1 && item.state === 'inProgress' && currentCol && item.effortLeft[currentCol] <= 0;
  el.className = `item state-${isCompleted ? 'completed' : item.state}${isNew ? ' entering' : ''}`;

  // Progress bar
  const progWrap = document.createElement('div');
  progWrap.className = 'item-progress';
  const progBar = document.createElement('div');
  progBar.className = 'item-progress-bar';
  if (!item._lastPct) item._lastPct = {};
  if (isCompleted) {
    progBar.style.width = '100%';
    item._lastPct[currentCol] = 100;
  } else if (item.state === 'inProgress' && currentCol) {
    const total = baseEffort[currentCol] || 1;
    const left = item.effortLeft[currentCol] || 0;
    const frac = item.progress[currentCol] || 0;
    const pct = Math.max(0, Math.min(100, ((total - left + frac) / total) * 100));
    progBar.style.width = pct + '%';
    // Only animate progress fill in Phase 1 (work phase)
    if (phase === 1) {
      progBar.classList.add('animate');
      const fromPct = item._lastPct[currentCol] || 0;
      progBar.style.setProperty('--from-pct', fromPct + '%');
      const speed = (typeof S !== 'undefined' && S.speed) ? CFG.SPEEDS[S.speed] : 4000;
      progBar.style.setProperty('--fill-dur', (speed * 0.85 / 1000) + 's');
    }
    item._lastPct[currentCol] = pct;
  } else {
    progBar.style.width = '0%';
    if (currentCol) item._lastPct[currentCol] = 0;
  }
  progWrap.appendChild(progBar);
  el.appendChild(progWrap);

  // Blocked badge (top-right)
  if (item.state === 'blocked' || item.blockLeft > 0) {
    const badge = document.createElement('div');
    badge.className = 'item-blocked-badge';
    badge.textContent = '⛔';
    badge.title = `Blockiert (${item.blockLeft} Tage)`;
    el.appendChild(badge);
  }

  // ID row
  const idRow = document.createElement('div');
  idRow.className = 'item-id';
  idRow.textContent = item.id.replace('T','');
  el.appendChild(idRow);

  // Rework label
  if (item.reworkCount > 0) {
    const label = document.createElement('div');
    label.className = 'item-rework-label';
    label.textContent = '↩ Rückläufer';
    el.appendChild(label);
  }

  // Effort tiles (4 columns: E P U T)
  const grid = document.createElement('div');
  grid.className = 'item-efforts';
  for (const cid of CFG.COL_IDS) {
    const tile = document.createElement('div');
    tile.className = 'effort-tile';
    tile.textContent = baseEffort[cid] || '?';
    // Highlight current active phase
    if (item.state === 'inProgress' && currentCol === cid) tile.classList.add('active-phase');
    // Mark completed phases
    if (item.effortLeft[cid] === 0 && baseEffort[cid] > 0) tile.classList.add('done-phase');
    grid.appendChild(tile);
  }
  el.appendChild(grid);

  el.title = `${item.id} | ${CFG.COL_IDS.map(c => CFG.COL_NAMES[c]+':'+item.effortLeft[c]).join(', ')}`;
  return el;
}

function renderBoard(sim, phase, newItemIds) {
  const isNew = newItemIds ? (id => newItemIds.has(id)) : (() => false);
  const p = phase || 0; // 0 = static, 1 = work phase, 2 = move phase

  // Ideen Speicher
  const ideenEl = document.getElementById('col-ideen-items');
  ideenEl.innerHTML = '';
  sim.ideenSpeicher.forEach(item => ideenEl.appendChild(itemEl(item, null, false, p)));
  document.getElementById('wip-ideen').textContent = sim.ideenSpeicher.length;

  // Active columns + wait zones
  for (const cid of CFG.COL_IDS) {
    const col = sim.cols[cid];
    const actEl  = document.getElementById(`col-${cid}-active`);
    actEl.innerHTML = '';
    col.inProgress.forEach(item => actEl.appendChild(itemEl(item, cid, isNew(item.id + cid), p)));

    // Wait zone (between this column and the next)
    const wzEl = document.getElementById(`wz-${cid}`);
    if (wzEl) {
      const label = wzEl.querySelector('.wait-zone-label');
      wzEl.innerHTML = '';
      if (label) wzEl.appendChild(label);
      col.waitZone.forEach(item => wzEl.appendChild(itemEl(item, null, false, p)));
    }

    // WIP badge — only count active items (not waitZone)
    const wip   = col.inProgress.length;
    const limit = sim.wipLimits[cid];
    const badge = document.getElementById(`wip-${cid}`);
    badge.textContent = limit === null ? `${wip}/∞` : `${wip}/${limit}`;
    badge.className = 'wip-badge ' + (
      limit === null ? 'wip-ok' :
      wip >= limit   ? 'wip-full' :
      wip >= limit * 0.8 ? 'wip-ok' : 'wip-ok'
    );
    if (limit !== null && wip >= limit) badge.className = 'wip-badge wip-full';
  }

  // Fertig
  const fertigEl = document.getElementById('col-fertig-items');
  fertigEl.innerHTML = '';
  sim.fertig.forEach(item => fertigEl.appendChild(itemEl(item, null, isNew(item.id + 'fertig'), p)));
  document.getElementById('wip-fertig').textContent = sim.fertig.length;

  // Counters
  const totalWIP = CFG.COL_IDS.reduce((s,cid) => s + sim.getWIP(cid), 0);
  document.getElementById('counter-wip').textContent = totalWIP;
  document.getElementById('counter-done').textContent = sim.fertig.length;
  document.getElementById('day-display').textContent = `Tag ${sim.currentDay} / ${sim.days}`;
}

// ══════════════════════════════════════════════════════
// SIMULATION LOOP
// ══════════════════════════════════════════════════════
function startLoop(sim, afterPhase) {
  S.afterSimPhase = afterPhase;
  S.paused = false;
  S.currentSim = sim;
  clearInterval(S.tickTimer);
  document.getElementById('btn-pause').textContent = '⏸ Pause';
  scheduleNext();
}

function scheduleNext() {
  clearInterval(S.tickTimer);
  S.tickTimer = setInterval(doTick, CFG.SPEEDS[S.speed]);
}

function doTick() {
  if (S.paused || S.movePhaseActive) return;
  const sim = S.currentSim;
  if (!sim || sim.isDone()) {
    clearInterval(S.tickTimer);
    onSimDone();
    return;
  }

  // Snapshot which items are in which columns BEFORE changes
  const before = {};
  for (const cid of CFG.COL_IDS) {
    before[cid] = new Set(sim.cols[cid].inProgress.map(i => i.id));
  }
  const fertigBefore = new Set(sim.fertig.map(i => i.id));

  // Phase 1: Work — effort reduction, show completed items at 100%
  sim.tickWork();
  renderBoard(sim, 1);

  // Phase 2: Move — after a delay, move items to next columns
  const moveDelay = Math.min(CFG.SPEEDS[S.speed] * 0.35, 2500);
  S.movePhaseActive = true;
  setTimeout(() => {
    sim.tickMove();

    // Find items that are newly in a column (not there before)
    const newIds = new Set();
    for (const cid of CFG.COL_IDS) {
      for (const item of sim.cols[cid].inProgress) {
        if (!before[cid].has(item.id)) newIds.add(item.id + cid);
      }
    }
    for (const item of sim.fertig) {
      if (!fertigBefore.has(item.id)) newIds.add(item.id + 'fertig');
    }

    renderBoard(sim, 2, newIds);
    S.movePhaseActive = false;

    if (sim.isDone()) {
      clearInterval(S.tickTimer);
      // Wait for slide-in animations to finish before showing button
      setTimeout(onSimDone, 800);
    }
  }, moveDelay);
}

function onSimDone() {
  // Hide pause, show "Zur Auswertung" button
  document.getElementById('btn-pause').style.display = 'none';
  document.getElementById('btn-to-results').style.display = '';
}

function proceedToResults() {
  document.getElementById('btn-to-results').style.display = 'none';
  const sim = S.currentSim;
  const phase = S.afterSimPhase;

  if (phase === 'reflect') {
    S.r1Results = sim;
    showReflection();
  } else if (phase === 'compare') {
    S.r2Results = sim;
    showComparison();
  } else if (phase === 'results') {
    S.freeRuns.push(sim);
    showResults(sim);
  }
}

// ══════════════════════════════════════════════════════
// CFD CHART
// ══════════════════════════════════════════════════════
function drawCFD(canvasId, cfdData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth || 600;
  const H = canvas.clientHeight || 200;
  canvas.width = W;
  canvas.height = H;
  ctx.clearRect(0,0,W,H);

  if (!cfdData || cfdData.length === 0) return;

  const keys = ['fertig','test','impl','plan','eval','ideen'];
  const colors = keys.map(k => CFG.CFD_COLORS[k]);
  const days = cfdData.length;
  const maxTotal = CFG.ITEM_COUNT;

  const padL=32, padR=8, padT=8, padB=24;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  // Compute stacked values
  const stacked = cfdData.map(snap => {
    const vals = [];
    let acc = 0;
    for (const k of keys) {
      acc += snap[k] || 0;
      vals.push(acc);
    }
    return vals;
  });

  // Draw stacked areas
  for (let ki = keys.length - 1; ki >= 0; ki--) {
    ctx.beginPath();
    ctx.fillStyle = colors[ki];
    ctx.globalAlpha = 0.85;

    for (let d = 0; d < days; d++) {
      const x = padL + (d / Math.max(days-1,1)) * chartW;
      const y = padT + chartH - (stacked[d][ki] / maxTotal) * chartH;
      if (d === 0) ctx.moveTo(x, padT + chartH);
      ctx.lineTo(x, y);
    }
    // bottom of previous layer
    for (let d = days-1; d >= 0; d--) {
      const x = padL + (d / Math.max(days-1,1)) * chartW;
      const prevY = ki > 0
        ? padT + chartH - (stacked[d][ki-1] / maxTotal) * chartH
        : padT + chartH;
      ctx.lineTo(x, prevY);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Axes
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT+chartH);
  ctx.lineTo(padL+chartW, padT+chartH);
  ctx.stroke();

  // Y labels
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  [0, 0.5, 1].forEach(p => {
    const y = padT + chartH - p * chartH;
    ctx.fillText(Math.round(p * maxTotal), padL-3, y+4);
  });

  // X labels
  ctx.textAlign = 'center';
  const step = Math.ceil(days / 5);
  for (let d = 0; d < days; d += step) {
    const x = padL + (d / Math.max(days-1,1)) * chartW;
    ctx.fillText(cfdData[d].day, x, padT+chartH+14);
  }
}

function renderCFDLegend(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  const keys = ['ideen','eval','plan','impl','test','fertig'];
  keys.forEach(k => {
    const div = document.createElement('div');
    div.className = 'legend-item';
    div.innerHTML = `<span class="legend-dot" style="background:${CFG.CFD_COLORS[k]}"></span>${CFG.CFD_LABELS[k]}`;
    el.appendChild(div);
  });
}

// ══════════════════════════════════════════════════════
// METRICS HTML
// ══════════════════════════════════════════════════════
function metricsHTML(m) {
  return `
    <div class="metric-card highlight">
      <div class="m-value">${m.throughput}</div>
      <div class="m-label">Fertiggestellt</div>
      <div class="m-sub">${m.throughputPerDay}/Tag</div>
    </div>
    <div class="metric-card">
      <div class="m-value">${m.started}</div>
      <div class="m-label">Angefangen, nicht fertig</div>
      <div class="m-sub">noch im System</div>
    </div>
    <div class="metric-card">
      <div class="m-value">${m.avgLT}</div>
      <div class="m-label">⌀ Durchlaufzeit</div>
      <div class="m-sub">Min ${m.minLT} · Max ${m.maxLT} Tage</div>
    </div>
    <div class="metric-card">
      <div class="m-value">${m.avgWIP}</div>
      <div class="m-label">⌀ WIP</div>
      <div class="m-sub">aktive Spalten</div>
    </div>
  `;
}

function compareMetricHTML(m1, m2) {
  function delta(v1, v2, lowerBetter) {
    const n1 = parseFloat(v1), n2 = parseFloat(v2);
    if (isNaN(n1)||isNaN(n2)||v1==='-'||v2==='-') return '';
    const pct = Math.round(((n2-n1)/n1)*100);
    const better = lowerBetter ? pct < 0 : pct > 0;
    const sign = pct > 0 ? '+' : '';
    return `<div class="delta ${better?'better':'worse'}">${sign}${pct}%</div>`;
  }
  return `
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="m-value">${m1.throughput}</div>
        <div class="m-label">Fertiggestellt</div>
        ${delta(m1.throughput, m2.throughput, false)}
      </div>
      <div class="metric-card">
        <div class="m-value">${m1.started}</div>
        <div class="m-label">Angefangen, nicht fertig</div>
        ${delta(m1.started, m2.started, true)}
      </div>
      <div class="metric-card">
        <div class="m-value">${m1.avgLT}</div>
        <div class="m-label">⌀ Durchlaufzeit</div>
        ${delta(m1.avgLT, m2.avgLT, true)}
      </div>
      <div class="metric-card">
        <div class="m-value">${m1.avgWIP}</div>
        <div class="m-label">⌀ WIP</div>
        ${delta(m1.avgWIP, m2.avgWIP, true)}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════
// CAUSE-EFFECT TEXTS
// ══════════════════════════════════════════════════════
function causeEffectR1(m) {
  const wipVal = m.avgWIP !== '-' ? `<strong>${m.avgWIP} Aufgaben</strong>` : 'viele Aufgaben';
  const ltVal  = m.avgLT !== '-'  ? `<strong>${m.avgLT} Tage</strong>`       : 'lang';
  const doneVal = `<strong>${m.throughput} von ${CFG.ITEM_COUNT}</strong>`;
  return `
    In Runde 1 waren durchschnittlich ${wipVal} gleichzeitig im System. Da keine Begrenzung der parallelen Arbeit existierte,
    wurden Aufgaben kontinuierlich in den nächsten Schritt gedrückt – unabhängig davon, ob dort Kapazität frei war
    (<strong>Push-Logik</strong>). Dabei entstand ein zusätzlicher Effekt: Wenn mehr Aufgaben in einer Spalte steckten als
    das Team dort gleichzeitig bearbeiten konnte, sank die Effizienz – Kontextwechsel und Koordinationsaufwand bremsten
    die Bearbeitung. Die durchschnittliche Durchlaufzeit betrug ${ltVal},
    obwohl die reine Bearbeitungszeit deutlich kürzer war – der Rest war Wartezeit und Overhead.
    Trotz hoher Auslastung aller Stationen wurden nur ${doneVal} Aufgaben tatsächlich abgeschlossen.
  `;
}

function causeEffectCompare(m1, m2) {
  const lt1 = parseFloat(m1.avgLT), lt2 = parseFloat(m2.avgLT);
  const ltPct = lt1 > 0 ? Math.round(((lt1-lt2)/lt1)*100) : 0;
  const done1 = m1.throughput, done2 = m2.throughput;
  const doneDiff = done2 - done1;
  return `
    Durch die WIP-Limits wurden in Runde 2 maximal <strong>${CFG.R2_LIMITS.eval + CFG.R2_LIMITS.plan + CFG.R2_LIMITS.impl + CFG.R2_LIMITS.test} Aufgaben</strong>
    gleichzeitig in den aktiven Spalten gehalten – deutlich weniger als in Runde 1. Die <strong>Pull-Logik</strong>
    sorgte dafür, dass neue Aufgaben erst dann in den nächsten Schritt gezogen wurden, wenn dort Kapazität frei war.
    Dadurch blieb die Effizienz hoch: Kein Team wurde durch überfüllte Warteschlangen gebremst.
    ${ltPct > 0 ? `Die durchschnittliche Durchlaufzeit sank um <strong>${ltPct}%</strong>` : 'Die Durchlaufzeit veränderte sich'},
    weil Aufgaben nicht mehr in langen Warteschlangen steckten und der Multitasking-Overhead entfiel.
    ${doneDiff > 0 ? `Es wurden <strong>${doneDiff} Aufgaben mehr</strong> fertiggestellt` : done2 > 0 ? 'Der Durchsatz blieb ähnlich' : ''}.
    Das System arbeitet nun mit besserer <strong>Flow-Effizienz</strong>: weniger Wartezeit, weniger Kontextwechsel, mehr echte Bearbeitung.
  `;
}

// ══════════════════════════════════════════════════════
// SHOW PHASES
// ══════════════════════════════════════════════════════
function showReflection() {
  const sim = S.r1Results;
  const m   = sim.getMetrics();
  showView('reflect');
  document.getElementById('r1-metrics').innerHTML = metricsHTML(m);
  document.getElementById('r1-cause-effect').innerHTML = causeEffectR1(m);
  setTimeout(() => {
    drawCFD('cfd-r1', sim.cfdData);
    renderCFDLegend('cfd-legend-r1');
  }, 100);
}

function showComparison() {
  const sim1 = S.r1Results, sim2 = S.r2Results;
  const m1   = sim1.getMetrics(), m2 = sim2.getMetrics();
  showView('compare');

  document.getElementById('compare-r1-metrics').innerHTML = compareMetricHTML(m1, m1);
  document.getElementById('compare-r2-metrics').innerHTML = compareMetricHTML(m2, m2);
  // Actually show R1 vs R2 side by side with deltas
  document.getElementById('compare-r1-metrics').innerHTML = metricsHTML(m1);
  document.getElementById('compare-r2-metrics').innerHTML = metricsHTML(m2);
  document.getElementById('compare-cause-effect').innerHTML = causeEffectCompare(m1, m2);

  setTimeout(() => {
    drawCFD('cfd-compare-r1', sim1.cfdData);
    drawCFD('cfd-compare-r2', sim2.cfdData);
    renderCFDLegend('cfd-legend-compare');
  }, 100);
}

function showResults(sim) {
  const m = sim.getMetrics();
  const runNr = S.freeRuns.length;
  showView('results');
  document.getElementById('free-run-nr').textContent = runNr;

  // Config summary
  const lims = sim.wipLimits;
  const limStrs = CFG.COL_IDS.map(c => `${CFG.COL_NAMES[c]}: ${lims[c]===null?'∞':lims[c]}`).join(' · ');
  document.getElementById('free-config-summary').innerHTML =
    `<strong>WIP-Limits:</strong> ${limStrs} · <strong>Tage:</strong> ${sim.days}` +
    (sim.enableBlockers?' · Blockierungen: an':'') +
    (sim.enableRework?' · Rückläufer: an':'');

  document.getElementById('free-metrics').innerHTML = metricsHTML(m);

  // Comparison section
  let compHTML = '';
  if (S.r1Results && S.r2Results) {
    const m1 = S.r1Results.getMetrics(), m2 = S.r2Results.getMetrics();
    compHTML = `
      <hr class="divider">
      <h3>Vergleich mit Standardpfad</h3>
      <div class="compare-grid">
        <div class="compare-col r1"><h3>Runde 1 (Push)</h3>${metricsHTML(m1)}</div>
        <div class="compare-col r2"><h3>Runde 2 (Kanban)</h3>${metricsHTML(m2)}</div>
      </div>
      <div class="compare-col" style="margin-top:12px"><h3 style="background:#dbeafe;color:#1e40af;padding:8px;border-radius:6px;margin-bottom:12px">Eigener Durchlauf</h3>${metricsHTML(m)}</div>
    `;
  } else if (S.freeRuns.length > 1) {
    const prev = S.freeRuns[S.freeRuns.length - 2];
    const mp = prev.getMetrics();
    compHTML = `
      <hr class="divider">
      <h3>Vergleich mit letztem Durchlauf</h3>
      <div class="compare-grid">
        <div class="compare-col r1"><h3>Durchlauf ${runNr-1}</h3>${metricsHTML(mp)}</div>
        <div class="compare-col r2"><h3>Durchlauf ${runNr}</h3>${metricsHTML(m)}</div>
      </div>
    `;
  } else {
    compHTML = `<p class="text-muted mt-16">Starten Sie einen weiteren Durchlauf, um Ergebnisse zu vergleichen.</p>`;
  }
  document.getElementById('free-comparison-section').innerHTML = compHTML;

  setTimeout(() => {
    drawCFD('cfd-free', sim.cfdData);
    renderCFDLegend('cfd-legend-free');
  }, 100);
}

function showClosing() {
  showView('closing');
  let html = '';

  if (S.r1Results && S.r2Results) {
    const m1 = S.r1Results.getMetrics(), m2 = S.r2Results.getMetrics();
    html += `
      <h3>Gesamtvergleich</h3>
      <div class="compare-grid" style="margin-top:12px">
        <div class="compare-col r1"><h3>Runde 1 – Push</h3>${metricsHTML(m1)}</div>
        <div class="compare-col r2"><h3>Runde 2 – Kanban</h3>${metricsHTML(m2)}</div>
      </div>
    `;
  }

  if (S.freeRuns.length > 0) {
    const last = S.freeRuns[S.freeRuns.length-1];
    const mf = last.getMetrics();
    html += `<h3 style="margin-top:20px">Ihr bestes Experiment</h3><div style="margin-top:12px">${metricsHTML(mf)}</div>`;
  }

  if (!S.r1Results && !S.r2Results && S.freeRuns.length === 0) {
    html = '<p class="text-muted">Keine Simulationsdaten vorhanden.</p>';
  }

  document.getElementById('closing-summary').innerHTML = html;
}

// ══════════════════════════════════════════════════════
// CONFIG VIEW
// ══════════════════════════════════════════════════════
function buildConfigView() {
  const grid = document.getElementById('config-wip-grid');
  grid.innerHTML = '';

  const cols = [
    { id: 'ideen', name: 'Ideen Speicher', default: 8 },
    ...CFG.COL_IDS.map(id => ({ id, name: CFG.COL_NAMES[id], default: CFG.R2_LIMITS[id] }))
  ];

  cols.forEach(col => {
    const isNoLimit = false;
    const div = document.createElement('div');
    div.className = 'config-item';
    div.innerHTML = `
      <div class="col-name">${col.name}</div>
      <label>WIP-Limit</label>
      <input type="number" id="wip-cfg-${col.id}" min="1" max="99" value="${col.default}" ${isNoLimit?'disabled':''}>
      <div class="nolimit-check">
        <input type="checkbox" id="nolimit-${col.id}">
        <label for="nolimit-${col.id}">Kein Limit (∞)</label>
      </div>
    `;
    grid.appendChild(div);

    setTimeout(() => {
      const cb = document.getElementById(`nolimit-${col.id}`);
      const inp = document.getElementById(`wip-cfg-${col.id}`);
      if (cb && inp) {
        cb.addEventListener('change', () => { inp.disabled = cb.checked; });
      }
    }, 0);
  });

  // Reference data
  const refEl = document.getElementById('config-ref-data');
  if (S.r1Results && S.r2Results) {
    const m1 = S.r1Results.getMetrics(), m2 = S.r2Results.getMetrics();
    refEl.innerHTML = `
      <div class="ref-data">
        <strong>Referenzwerte:</strong>
        Runde 1 (Push): ${m1.throughput} fertig · ⌀ DLZ ${m1.avgLT} Tage &nbsp;|&nbsp;
        Runde 2 (Kanban): ${m2.throughput} fertig · ⌀ DLZ ${m2.avgLT} Tage
      </div>
    `;
  } else {
    refEl.innerHTML = '';
  }
}

function readConfig() {
  const cols = ['ideen', ...CFG.COL_IDS];
  const limits = {};
  cols.forEach(id => {
    const cb  = document.getElementById(`nolimit-${id}`);
    const inp = document.getElementById(`wip-cfg-${id}`);
    if (!inp) return;
    limits[id] = cb && cb.checked ? null : Math.max(1, parseInt(inp.value) || 3);
  });
  return limits;
}

// ══════════════════════════════════════════════════════
// START SIMULATION
// ══════════════════════════════════════════════════════
function launchSim(options, afterPhase) {
  const sim = new Simulation(options);

  // Init board WIP badges
  CFG.COL_IDS.forEach(cid => {
    const badge = document.getElementById(`wip-${cid}`);
    const limit = options.wipLimits[cid];
    badge.textContent = limit === null ? `0/∞` : `0/${limit}`;
  });
  document.getElementById('wip-ideen').textContent = CFG.ITEM_COUNT;
  document.getElementById('wip-fertig').textContent = '0';

  // Phase badge
  const phaseNames = { reflect:'Runde 1', compare:'Runde 2', results:'Freies Exp.' };
  document.getElementById('sim-phase-badge').textContent = phaseNames[afterPhase] || 'Simulation';

  // Show board but wait for user to click Start
  S.currentSim = sim;
  S.afterSimPhase = afterPhase;
  S.paused = false;
  document.getElementById('btn-start-sim').style.display = '';
  document.getElementById('btn-pause').style.display = 'none';

  showView('sim');
  renderBoard(sim);
  // Simulation does NOT start yet – user must click "▶ Simulation starten"
}

// ══════════════════════════════════════════════════════
// EVENT HANDLERS
// ══════════════════════════════════════════════════════

// Start view
document.getElementById('btn-standard-mode').addEventListener('click', () => {
  S.mode = 'standard';
  showView('intro');
});
document.getElementById('btn-free-mode').addEventListener('click', () => {
  S.mode = 'free';
  buildConfigView();
  showView('config');
});
document.getElementById('toggle-overview').addEventListener('click', () => {
  const body = document.getElementById('overview-body');
  const icon = document.getElementById('toggle-icon');
  body.classList.toggle('open');
  icon.textContent = body.classList.contains('open') ? '▲' : '▼';
});

// Intro view
document.getElementById('btn-back-to-start').addEventListener('click', () => showView('start'));
document.getElementById('btn-start-r1').addEventListener('click', () => {
  const days = parseInt(document.getElementById('r1-duration').value);
  launchSim({
    days,
    wipLimits: { ideen:null, eval:null, plan:null, impl:null, test:null },
    usePull: false,
    runLabel: 'Runde 1'
  }, 'reflect');
});

// Simulation controls
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.speed = btn.dataset.speed;
    if (!S.paused) scheduleNext();
  });
});
document.getElementById('btn-start-sim').addEventListener('click', () => {
  document.getElementById('btn-start-sim').style.display = 'none';
  document.getElementById('btn-pause').style.display = '';
  startLoop(S.currentSim, S.afterSimPhase);
});
document.getElementById('btn-to-results').addEventListener('click', proceedToResults);
document.getElementById('btn-pause').addEventListener('click', () => {
  S.paused = !S.paused;
  document.getElementById('btn-pause').textContent = S.paused ? '▶ Weiter' : '⏸ Pause';
});

// Reflection view
document.getElementById('btn-start-r2').addEventListener('click', () => {
  const days = S.r1Results ? S.r1Results.days : 15;
  launchSim({
    days,
    wipLimits: { ...CFG.R2_LIMITS },
    usePull: true,
    runLabel: 'Runde 2'
  }, 'compare');
});

// Comparison view
document.getElementById('btn-go-free').addEventListener('click', () => {
  buildConfigView();
  showView('config');
});
document.getElementById('btn-go-closing-from-compare').addEventListener('click', showClosing);

// Config view
document.getElementById('btn-back-from-config').addEventListener('click', () => {
  if (S.mode === 'free') showView('start');
  else showView('compare');
});
document.getElementById('btn-start-free').addEventListener('click', () => {
  const wipLimits = readConfig();
  const days = parseInt(document.getElementById('free-duration').value);
  const allNoLimit = Object.values(wipLimits).every(v => v === null);
  launchSim({
    days,
    wipLimits,
    usePull: !allNoLimit,
    enableBlockers: document.getElementById('cfg-blockers').checked,
    enableRework:   document.getElementById('cfg-rework').checked,
    runLabel: `Exp. ${S.freeRuns.length + 1}`
  }, 'results');
});

// Results view
document.getElementById('btn-again-free').addEventListener('click', () => {
  buildConfigView();
  showView('config');
});
document.getElementById('btn-go-closing-from-results').addEventListener('click', showClosing);

// Closing view
document.getElementById('btn-restart').addEventListener('click', () => {
  clearInterval(S.tickTimer);
  S.r1Results = null;
  S.r2Results = null;
  S.freeRuns = [];
  S.currentSim = null;
  S.paused = false;
  showView('start');
});

// Re-draw CFDs on window resize
window.addEventListener('resize', () => {
  const view = document.querySelector('.view.active');
  if (!view) return;
  const id = view.id;
  if (id === 'view-reflect' && S.r1Results) drawCFD('cfd-r1', S.r1Results.cfdData);
  if (id === 'view-compare' && S.r1Results && S.r2Results) {
    drawCFD('cfd-compare-r1', S.r1Results.cfdData);
    drawCFD('cfd-compare-r2', S.r2Results.cfdData);
  }
  if (id === 'view-results' && S.freeRuns.length > 0) {
    drawCFD('cfd-free', S.freeRuns[S.freeRuns.length-1].cfdData);
  }
});