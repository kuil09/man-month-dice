import { DiceTray3D } from './dice3d.js';

const STORAGE_KEY = 'man-month-dice:poc:v1';
const MAX_PHYSICAL_ROLL_MS = 7500;
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
const rollButton = document.querySelector('#rollButton');
const resetButton = document.querySelector('#resetButton');

let isRolling = false;
let dice3D = null;
try {
  dice3D = new DiceTray3D(diceTray);
  window.__MAN_MONTH_DICE_DEBUG__ = () => dice3D?.debugState() ?? null;
} catch (error) {
  console.warn('Three.js renderer unavailable; using accessible 2D fallback.', error);
  diceTray.dataset.renderer = 'fallback';
  diceTray.classList.add('is-fallback');
}

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
  if (!input || isRolling) return;
  state.factors[input.dataset.factor] = Number(input.value);
  input.parentElement.querySelector('[data-value]').textContent = `${input.value}/4`;
  persistAndRender();
});
questName.addEventListener('input', () => {
  state.questName = questName.value;
  saveState();
});
parallelism.addEventListener('input', () => {
  if (isRolling) return;
  state.parallelism = clamp(Number(parallelism.value) || 1, 1, 12);
  parallelism.value = state.parallelism;
  persistAndRender();
});

rollButton.addEventListener('click', async () => {
  if (isRolling) return;
  const pool = buildPool(state.factors);
  let roll;
  isRolling = true;
  delete diceTray.dataset.lastRoll;
  setEstimationControlsDisabled(true);
  rollButton.textContent = 'ROLLING…';
  rollTotal.textContent = 'ROLLING THE UNCERTAINTY';
  rollDetail.textContent = '중력, 충돌, 마찰과 각운동량이 가능한 프로젝트 현실 하나를 결정하고 있다.';

  try {
    if (dice3D) {
      dice3D.announce(`${pool.length}개의 물리 다이스를 굴리는 중.`);
      roll = await withTimeout(
        dice3D.roll(pool),
        MAX_PHYSICAL_ROLL_MS,
        'Physical dice roll exceeded its time budget.',
      );
    } else {
      roll = rollPool(pool);
      renderFallbackRoll(roll);
      await delay(window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 360);
    }
  } catch (error) {
    console.error('Physical dice roll failed; using the accessible fallback.', error);
    dice3D?.dispose();
    dice3D = null;
    window.__MAN_MONTH_DICE_DEBUG__ = () => null;
    diceTray.dataset.renderer = 'fallback';
    diceTray.dataset.physics = 'fallback';
    diceTray.classList.remove('has-webgl', 'is-rolling', 'is-empty');
    diceTray.classList.add('is-fallback');
    roll = rollPool(pool);
    renderFallbackRoll(roll);
    await delay(window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 360);
  }

  try {
    state.history.unshift({
      id: crypto.randomUUID?.() ?? String(Date.now()),
      questName: state.questName.trim() || 'UNTITLED QUEST',
      total: roll.total,
      detail: roll.detail,
      at: Date.now(),
    });
    state.history = state.history.slice(0, 30);
    saveState();
    renderRollSummary(roll);
    renderHistory();
  } finally {
    isRolling = false;
    setEstimationControlsDisabled(false);
    rollButton.textContent = 'ROLL THE ESTIMATE';
  }
});

resetButton.addEventListener('click', () => {
  if (isRolling) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) dice3D?.dispose();
});

function persistAndRender() {
  saveState();
  renderModel();
}
function renderModel() {
  const pool = buildPool(state.factors);
  diceNotation.textContent = notation(pool);
  poolExplanation.textContent = `${pool.length}개의 불확실성 다이스 · 병렬 처리 슬롯 ${state.parallelism}. 인원 수는 다이스 값을 나누지 않는다.`;
  renderPool(pool);
  renderRiskLedger();
  const samples = simulate(pool, 12000);
  p50.textContent = percentile(samples, .50);
  p80.textContent = percentile(samples, .80);
  p95.textContent = `${percentile(samples, .95)}+`;
}
function renderPool(pool) {
  const narration = pool.length
    ? `${notation(pool)}. 아직 굴리지 않은 3D 다이스 ${pool.length}개.`
    : '모든 위험을 0으로 낮춰 굴릴 다이스가 없다.';
  if (dice3D) {
    dice3D.showPool(pool);
    dice3D.announce(narration);
    return;
  }
  renderFallbackPool(pool);
  const narrationElement = document.querySelector('#diceNarration');
  if (narrationElement) narrationElement.textContent = narration;
}
function renderFallbackPool(pool) {
  diceTray.innerHTML = '';
  if (!pool.length) {
    diceTray.innerHTML = '<div class="empty-tray">NO DICE<br>모든 위험을 0으로 낮췄다.</div>';
    return;
  }
  for (const die of pool) {
    const element = document.createElement('div');
    element.className = `die d${die.sides}`;
    element.innerHTML = `<span class="value">?</span><span class="kind">D${die.sides}${die.explodes ? '!' : ''}</span>`;
    diceTray.append(element);
  }
}
function renderFallbackRoll(roll) {
  diceTray.innerHTML = '';
  for (const item of roll.items) {
    const element = document.createElement('div');
    element.className = `die d${item.sides}${item.exploded ? ' exploded' : ''}`;
    element.innerHTML = `<span class="value">${item.total}</span><span class="kind">D${item.sides}${item.exploded ? '!' : ''}</span>`;
    diceTray.append(element);
  }
}
function renderRollSummary(roll) {
  rollTotal.textContent = `${roll.total} EFFORT POINTS`;
  rollDetail.textContent = roll.detail;
  diceTray.dataset.lastRoll = String(roll.total);
  dice3D?.announce(`결과 ${roll.total} effort points. ${roll.detail}`);
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
    const listItem = document.createElement('li');
    const date = new Date(item.at);
    listItem.innerHTML = `<strong>${escapeHtml(item.questName)} · ${item.total}</strong><time>${date.toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}</time>`;
    rollHistory.append(listItem);
  }
}
function setEstimationControlsDisabled(disabled) {
  rollButton.disabled = disabled;
  resetButton.disabled = disabled;
  parallelism.disabled = disabled;
  for (const input of factorControls.querySelectorAll('input')) input.disabled = disabled;
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
  const detail = items.map((item) => item.parts.join(' + ')).join('  |  ') || '0';
  return { total, items, detail };
}
function rollDie(die, random) {
  const parts = [];
  let exploded = false;
  let total = 0;
  for (let depth = 0; depth < 6; depth += 1) {
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
  for (let index = 0; index < count; index += 1) samples[index] = rollPool(pool, Math.random).total;
  samples.sort((a, b) => a - b);
  return samples;
}
function percentile(sorted, probability) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * probability))];
}
function secureRandom() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 4294967296;
}
function withTimeout(promise, milliseconds, message) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}
function delay(milliseconds) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved
      ? { ...structuredClone(DEFAULT_STATE), ...saved, factors: { ...DEFAULT_STATE.factors, ...saved.factors } }
      : structuredClone(DEFAULT_STATE);
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

renderModel();
renderHistory();
