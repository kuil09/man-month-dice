const STORAGE_KEY = 'man-month-dice:poc:v1';

const FACTORS = [
  { key: 'novelty', label: '기술/도메인 새로움', low: '익숙함', high: '처음 해봄' },
  { key: 'integration', label: '연동 범위', low: '고립됨', high: '여러 시스템' },
  { key: 'dependency', label: '외부 의존성', low: '거의 없음', high: '통제 불가' },
  { key: 'verification', label: '검증 비용', low: '즉시 확인', high: '비싸고 느림' },
  { key: 'reversibility', label: '실패의 가역성', low: '쉽게 되돌림', high: '되돌리기 어려움' },
];

const DEFAULT_STATE = {
  questName: '',
  parallelism: 2,
  factors: { novelty: 2, integration: 2, dependency: 2, verification: 2, reversibility: 2 },
  history: [],
};

const state = loadState();
const factorControls = document.querySelector('#factorControls');
const questName = document.querySelector('#questName');
const parallelism = document.querySelector('#parallelism');
const diceNotation = document.querySelector('#diceNotation');
const poolExplanation = document.querySelector('#poolExplanation');
const diceTray = document.querySelector('#diceTray');
const riskLedger = document.querySelector('#riskLedger');
const rollHistory = document.querySelector('#rollHistory');
const p50 = document.querySelector('#p50');
const p80 = document.querySelector('#p80');
const p95 = document.querySelector('#p95');
const rollTotal = document.querySelector('#rollTotal');
const rollDetail = document.querySelector('#rollDetail');

questName.value = state.questName;
parallelism.value = state.parallelism;

for (const factor of FACTORS) {
  const wrapper = document.createElement('label');
  wrapper.className = 'factor';
  wrapper.innerHTML = `
    <span class="factor-head"><span>${factor.label}</span><strong data-value>${state.factors[factor.key]}/4</strong></span>
    <input type="range" min="0" max="4" step="1" value="${state.factors[factor.key]}" data-factor="${factor.key}">
    <small>${factor.low} ←────────→ ${factor.high}</small>
  `;
  factorControls.append(wrapper);
}

factorControls.addEventListener('input', (event) => {
  const input = event.target.closest('[data-factor]');
  if (!input) return;
  state.factors[input.dataset.factor] = Number(input.value);
  input.parentElement.querySelector('[data-value]').textContent = `${input.value}/4`;
  persistAndRender();
});

questName.addEventListener('input', () => {
  state.questName = questName.value;
  saveState();
});

parallelism.addEventListener('input', () => {
  state.parallelism = clamp(Number(parallelism.value) || 1, 1, 12);
  parallelism.value = state.parallelism;
  persistAndRender();
});

document.querySelector('#rollButton').addEventListener('click', () => {
  const pool = buildPool(state.factors);
  const roll = rollPool(pool);
  state.history.unshift({
    id: crypto.randomUUID?.() ?? String(Date.now()),
    questName: state.questName.trim() || 'UNTITLED QUEST',
    total: roll.total,
    detail: roll.detail,
    at: Date.now(),
  });
  state.history = state.history.slice(0, 30);
  saveState();
  renderRoll(roll);
  renderHistory();
});

document.querySelector('#resetButton').addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

function persistAndRender() {
  saveState();
  renderModel();
}

function renderModel() {
  const pool = buildPool(state.factors);
  diceNotation.textContent = notation(pool);
  poolExplanation.textContent = `${pool.length}개의 불확실성 다이스 · 병렬 처리 슬롯 ${state.parallelism}. 인원 수는 다이스 값을 나누지 않는다.`;
  renderEmptyTray(pool);
  renderRiskLedger();

  const samples = simulate(pool, 12000);
  p50.textContent = percentile(samples, .50);
  p80.textContent = percentile(samples, .80);
  p95.textContent = `${percentile(samples, .95)}+`;
}

function renderEmptyTray(pool) {
  diceTray.innerHTML = '';
  if (!pool.length) {
    diceTray.innerHTML = '<div class="empty-tray">NO DICE<br>모든 위험을 0으로 낮췄다.</div>';
    return;
  }
  for (const die of pool) {
    const el = document.createElement('div');
    el.className = `die d${die.sides}`;
    el.innerHTML = `<span class="value">?</span><span class="kind">D${die.sides}${die.explodes ? '!' : ''}</span>`;
    diceTray.append(el);
  }
}

function renderRoll(roll) {
  diceTray.innerHTML = '';
  for (const item of roll.items) {
    const el = document.createElement('div');
    el.className = `die d${item.sides}${item.exploded ? ' exploded' : ''}`;
    el.innerHTML = `<span class="value">${item.total}</span><span class="kind">D${item.sides}${item.exploded ? '!' : ''}</span>`;
    diceTray.append(el);
  }
  rollTotal.textContent = `${roll.total} EFFORT POINTS`;
  rollDetail.textContent = roll.detail;
}

function renderRiskLedger() {
  riskLedger.innerHTML = '';
  for (const factor of FACTORS) {
    const value = state.factors[factor.key];
    const row = document.createElement('div');
    row.className = 'risk-row';
    row.innerHTML = `
      <span>${factor.label}</span>
      <div class="risk-track"><div class="risk-fill" style="width:${value * 25}%"></div></div>
      <output>${value}/4</output>
    `;
    riskLedger.append(row);
  }
}

function renderHistory() {
  rollHistory.innerHTML = '';
  if (!state.history.length) {
    rollHistory.innerHTML = '<li class="history-empty">아직 굴린 기록이 없다.</li>';
    return;
  }
  for (const item of state.history) {
    const li = document.createElement('li');
    const date = new Date(item.at);
    li.innerHTML = `<strong>${escapeHtml(item.questName)} · ${item.total}</strong><time>${date.toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}</time>`;
    rollHistory.append(li);
  }
}

function buildPool(factors) {
  const pool = [];
  for (const factor of FACTORS) {
    const level = factors[factor.key];
    if (level <= 0) continue;
    const sides = [0, 4, 6, 8, 12][level];
    pool.push({ sides, explodes: level === 4 });
    if (level >= 3 && (factor.key === 'integration' || factor.key === 'verification')) {
      pool.push({ sides: Math.max(4, sides - 2), explodes: false });
    }
  }
  return pool;
}

function notation(pool) {
  if (!pool.length) return '0';
  const grouped = new Map();
  for (const die of pool) {
    const key = `${die.sides}:${die.explodes}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  return [...grouped.entries()].map(([key, count]) => {
    const [sides, explodes] = key.split(':');
    return `${count > 1 ? count : ''}d${sides}${explodes === 'true' ? '!' : ''}`;
  }).join(' + ');
}

function rollPool(pool, random = secureRandom) {
  const items = [];
  let total = 0;
  for (const die of pool) {
    const rolled = rollDie(die, random);
    total += rolled.total;
    items.push({ ...die, ...rolled });
  }
  const detail = items.map(item => item.parts.join(' + ')).join('  |  ') || '0';
  return { total, items, detail };
}

function rollDie(die, random) {
  const parts = [];
  let exploded = false;
  let total = 0;
  for (let depth = 0; depth < 6; depth++) {
    const value = Math.floor(random() * die.sides) + 1;
    parts.push(value);
    total += value;
    if (!(die.explodes && value === die.sides)) break;
    exploded = true;
  }
  return { total, parts, exploded };
}

function simulate(pool, count) {
  const samples = new Array(count);
  for (let i = 0; i < count; i++) samples[i] = rollPool(pool, Math.random).total;
  samples.sort((a, b) => a - b);
  return samples;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function secureRandom() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 4294967296;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function escapeHtml(value) { return value.replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? { ...structuredClone(DEFAULT_STATE), ...saved, factors: { ...DEFAULT_STATE.factors, ...saved.factors } } : structuredClone(DEFAULT_STATE);
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

renderModel();
renderHistory();
