// Browser smoke test: serves web/, plays a full daily game and a survivor game in headless
// Chromium against the real engine and data, and checks the end screens render with no
// console errors and no third-party requests.
//
// Needs Playwright (a local `npm i -D playwright`, or a global install) and the built data
// (web/data, from the pipeline); skipped without them.
// Set UI_SCREENSHOTS=<dir> to also save phone and desktop screenshots along the way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gameAvailable, serve } from './server.js';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // fall through to a global install
  }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return await import(join(root, 'playwright', 'index.mjs'));
  } catch {
    return null;
  }
}

const pw = await loadPlaywright();
let skip = false;
if (!pw) skip = 'Playwright is not installed (npm i -D playwright); skipping the browser smoke test';
else if (!gameAvailable()) skip = 'web/js/engine or web/data/spots/index.json is missing (build the data first); skipping the browser smoke test';
const SHOTS = process.env.UI_SCREENSHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 900 };

// a small seeded generator so the calls made are repeatable
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function openPage(browser, base, { viewport, scheme = 'light', motion = 'reduce', hash = '' }) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: motion, hasTouch: viewport === PHONE });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) problems.push(`third-party request: ${r.url()}`); });
  await page.goto(base + hash);
  return { context, page, problems };
}

async function shot(page, name, fullPage = false) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
}

/** Make calls until the end-of-game card shows. Returns the number of decisions made. */
async function playToEnd(page, random, { tag }) {
  let made = 0;
  for (let step = 0; step < 250; step += 1) {
    const el = await page.waitForSelector(
      '.dock-prompt .prompt:not(:has(button[disabled])), .dock-prompt > .btn, .end-card', { timeout: 120000 });
    const cls = await el.getAttribute('class');
    if (cls.includes('end-card')) return made;
    if (cls.includes('btn')) {
      await el.click();
      continue;
    }
    if (step === 2) await shot(page, `${tag}-prompt`);
    const keys = await page.locator('.dock-prompt .key:not([disabled])').all();
    await keys[Math.floor(random() * keys.length)].click();
    const calls = await page.locator('.dock-prompt .key.call:not([disabled])').all();
    if (calls.length) await calls[Math.floor(random() * calls.length)].click();
    made += 1;
    if (made === 3) await shot(page, `${tag}-result`);
  }
  throw new Error('the game did not end within 250 steps');
}

test('daily: play a full drive, see the end card and the day summary', { skip, timeout: 600000 }, async () => {
  const server = await serve();
  const browser = await pw.chromium.launch();
  try {
    for (const [viewport, tag, scheme] of [[PHONE, 'phone-daily', 'light'], [DESKTOP, 'desktop-daily', 'dark']]) {
      const { context, page, problems } = await openPage(browser, server.url, { viewport, scheme });
      // first visit: the help sheet greets the player
      await page.getByRole('dialog').waitFor({ timeout: 60000 });
      await shot(page, `${tag}-help`);
      await page.getByRole('button', { name: "Let's go" }).click();
      await page.waitForSelector('.intro-card');
      assert.match(await page.locator('.intro-state').innerText(), /UP BY|DOWN BY|TIED/i);
      await shot(page, `${tag}-intro`);
      await page.keyboard.press('Enter');   // primary action: take the field
      await page.waitForSelector('.screen.game .sb');
      // keyboard: a digit opens a play family, Backspace goes back
      const first = await page.waitForSelector('.dock-prompt .prompt:not(:has(button[disabled]))', { timeout: 120000 });
      if (await first.$('.fam')) {
        await page.keyboard.press('1');
        await page.waitForSelector('.dock-prompt .calls');
        await page.keyboard.press('Backspace');
        await page.waitForSelector('.dock-prompt .families .fam');
      }
      await shot(page, `${tag}-field`);
      const made = await playToEnd(page, rng(7), { tag });
      assert.ok(made > 0, 'at least one decision was made');
      const end = page.locator('.end-card');
      assert.match(await end.locator('.end-head').innerText(), /WIN|LOSE|TIE|HALFTIME/i);
      assert.ok(await end.locator('.squares .grade').count() > 0, 'grade squares render');
      await shot(page, `${tag}-end`, true);
      await end.locator('.btn-primary').click();
      const summary = page.locator('.score-card');
      await summary.waitFor();
      assert.match(await summary.locator('.big-caption').innerText(), /Better than \d+% of NFL play-callers|Score unavailable/);
      assert.match(await summary.locator('.share-text').inputValue(), /^FOSS 2-Minute Drill #\d+\n/);
      await shot(page, `${tag}-summary`, true);
      // a reload on the same day goes straight to the summary
      await page.reload();
      await page.locator('.score-card').waitFor();
      // the stats sheet opens and closes with Escape
      await page.getByRole('button', { name: 'Your stats' }).click();
      await page.getByRole('dialog').waitFor();
      await shot(page, `${tag}-stats`);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.deepEqual(problems, []);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test('survivor: play a game to the end and reach the next step', { skip, timeout: 600000 }, async () => {
  const server = await serve();
  const browser = await pw.chromium.launch();
  try {
    const { context, page, problems } = await openPage(browser, server.url, { viewport: PHONE, hash: '#survivor', scheme: 'dark' });
    await page.getByRole('button', { name: "Let's go" }).click({ timeout: 60000 });
    await page.waitForSelector('.intro-card');
    assert.match(await page.locator('.intro-card .eyebrow').innerText(), /Survivor · Game 1/i);
    await shot(page, 'phone-survivor-intro');
    await page.locator('.start').click();
    await playToEnd(page, rng(11), { tag: 'phone-survivor' });
    const button = page.locator('.end-card .btn-primary');
    const label = await button.innerText();
    assert.match(label, /Next game|Your run/);
    await shot(page, 'phone-survivor-end', true);
    await button.click();
    if (/Your run/.test(label)) {
      await page.locator('.run-card').waitFor();
      assert.match(await page.locator('.share-text').inputValue(), /^FOSS 2-Minute Drill Survivor\nSurvived \d+ games?\n/);
      await shot(page, 'phone-survivor-run', true);
    } else {
      await page.locator('.intro-card').waitFor();
      assert.match(await page.locator('.intro-card .eyebrow').innerText(), /Survivor · Game 2/i);
    }
    assert.deepEqual(problems, []);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
