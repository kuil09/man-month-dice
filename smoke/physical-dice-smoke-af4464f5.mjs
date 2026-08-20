import fs from 'node:fs';
import { chromium } from 'playwright-core';

const errors = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  const url = message.location().url || '';
  if (message.type() === 'error' && !url.endsWith('/favicon.ico')) {
    errors.push(`console: ${message.text()} @ ${url}`);
  }
});

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
try {
  await page.waitForFunction(
    () => document.querySelector('#diceTray')?.dataset.renderer === 'three-cannon',
    null,
    { timeout: 20000 },
  );
} catch (error) {
  const state = await page.evaluate(() => ({
    dataset: { ...document.querySelector('#diceTray')?.dataset },
    body: document.body.innerText.slice(0, 1000),
  }));
  throw new Error(`Renderer initialization timed out: ${JSON.stringify({ state, errors, original: error.message })}`);
}

const initial = await page.evaluate(() => {
  const tray = document.querySelector('#diceTray');
  const canvas = tray?.querySelector('canvas.dice-canvas');
  return {
    renderer: tray?.dataset.renderer || '',
    physics: tray?.dataset.physics || '',
    faceLabels: tray?.dataset.faceLabels || '',
    numberedFaces: Number(tray?.dataset.numberedFaces || 0),
    separateNumberObjects: Number(tray?.dataset.separateNumberObjects || 0),
    canvasWidth: canvas?.width || 0,
    canvasHeight: canvas?.height || 0,
    htmlDiceNodes: tray?.querySelectorAll('.die').length || 0,
    debug: window.__MAN_MONTH_DICE_DEBUG__?.(),
  };
});

if (initial.renderer !== 'three-cannon' || initial.physics !== 'cannon-es') {
  throw new Error(`Three.js/Cannon renderer state is invalid: ${JSON.stringify(initial)}`);
}
if (initial.faceLabels !== 'surface-material' || initial.separateNumberObjects !== 0 || initial.htmlDiceNodes !== 0) {
  throw new Error(`Numbers are not exclusively embedded in die surface materials: ${JSON.stringify(initial)}`);
}
if (initial.canvasWidth < 100 || initial.canvasHeight < 100 || initial.numberedFaces < 30) {
  throw new Error(`Canvas or numbered face count is invalid: ${JSON.stringify(initial)}`);
}
if (!initial.debug || initial.debug.separateNumberObjects !== 0 || initial.debug.numberedFaces < 30) {
  throw new Error(`Surface-number diagnostics are invalid: ${JSON.stringify(initial)}`);
}
for (const die of initial.debug.dice) {
  if (!die.numeralsInSurfaceMaterial || die.separateNumberObjects !== 0 || die.numberedFaces !== die.sides) {
    throw new Error(`A die face number is detached from its material: ${JSON.stringify(die)}`);
  }
}
if (errors.length) throw new Error(errors.join(' | '));

await page.click('#rollButton');
await page.waitForFunction(
  () => document.querySelector('#diceTray')?.classList.contains('is-rolling'),
  null,
  { timeout: 5000 },
);
await page.waitForTimeout(450);
const moving = await page.evaluate(() => window.__MAN_MONTH_DICE_DEBUG__?.());
if (!moving || moving.physicsBodies < 5) {
  throw new Error(`Rigid bodies did not enter the simulation: ${JSON.stringify(moving)}`);
}
if (!moving.dice.some((die) => die.speed > 0.05 || die.angularSpeed > 0.05)) {
  throw new Error(`Dice never acquired physical velocity: ${JSON.stringify(moving)}`);
}

await page.waitForFunction(() => {
  const tray = document.querySelector('#diceTray');
  const button = document.querySelector('#rollButton');
  return Boolean(tray?.dataset.lastRoll) && !button?.disabled && !tray.classList.contains('is-rolling');
}, null, { timeout: 30000 });

const final = await page.evaluate(() => ({
  total: Number(document.querySelector('#diceTray')?.dataset.lastRoll || 0),
  detail: document.querySelector('#rollDetail')?.textContent || '',
  summary: document.querySelector('#rollTotal')?.textContent || '',
  historyCount: document.querySelectorAll('#rollHistory li:not(.history-empty)').length,
  debug: window.__MAN_MONTH_DICE_DEBUG__?.(),
}));
const topFaces = final.debug.topFaces.split(',').filter(Boolean).map(Number);
const detailValues = final.detail.match(/\d+/g)?.map(Number) || [];
const sortedTopFaces = [...topFaces].sort((a, b) => a - b);
const sortedDetailValues = [...detailValues].sort((a, b) => a - b);
if (final.debug.physics !== 'cannon-es' || final.debug.physicsSteps < 5) {
  throw new Error(`Physics simulation did not advance: ${JSON.stringify(final)}`);
}
if (!topFaces.length || topFaces.reduce((sum, value) => sum + value, 0) !== final.total) {
  throw new Error(`Final upward faces do not determine the total: ${JSON.stringify({ final, topFaces })}`);
}
if (sortedDetailValues.join(',') !== sortedTopFaces.join(',')) {
  throw new Error(`UI detail differs from the physically upward faces: ${JSON.stringify({ detailValues, topFaces })}`);
}
if (!/EFFORT POINTS/.test(final.summary) || final.historyCount < 1) {
  throw new Error(`The physical roll was not committed to the UI: ${JSON.stringify(final)}`);
}
for (const die of final.debug.dice) {
  if (!die.hasBody || !die.numeralsInSurfaceMaterial || die.separateNumberObjects !== 0) {
    throw new Error(`Final die is not a numbered rigid body: ${JSON.stringify(die)}`);
  }
}
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
fs.writeFileSync(
  process.env.RESULT_PATH,
  `${JSON.stringify({ initial, moving, final, errors }, null, 2)}\n`,
);
await browser.close();
