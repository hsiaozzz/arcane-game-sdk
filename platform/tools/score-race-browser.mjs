import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createNakamaBridge } from '../server/nakama.mjs';

process.loadEnvFile(new URL('../.local-data/platform.env', import.meta.url));
const gateway = process.env.ARCANE_PUBLIC_URL || 'http://127.0.0.1:7400';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(gateway).hostname), 'Browser QA only accepts the isolated local stack');
const directory = new URL('../.local-data/score-race-browser/', import.meta.url); await mkdir(directory, { recursive: true });
const checks = [], errors = [], captures = [], contexts = [], began = performance.now();
const gameId = `score-browser-${Date.now().toString(36)}`, environment = 'development', releaseId = 'qa';
let browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = page => page.frameLocator('iframe[data-arcane-game-frame]');
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(40); }
  throw Object.assign(new Error('BROWSER_TIMEOUT'), { code: 'BROWSER_TIMEOUT' });
}
async function run(name, task) {
  const started = performance.now();
  try { await task(); checks.push({ name, passed: true, durationMs: Math.round(performance.now() - started) }); console.log(`PASS ${name}`); }
  catch (error) {
    checks.push({ name, passed: false, code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : error.name || 'BROWSER_FAILED' });
    throw Object.assign(new Error('BROWSER_STOPPED'), { code: 'BROWSER_STOPPED' });
  }
}
async function capture(page, name) {
  await page.screenshot({ path: fileURLToPath(new URL(name, directory)), fullPage: true,
    mask: [page.locator('input[type="password"], input[type="email"], input[aria-label*="邀请码"]')] }); captures.push(name);
}
async function score(page) { return Number(/：\s*(\d+)/.exec(await frame(page).locator('#scores li.self').innerText())?.[1]); }
async function answer(page, targetScore) {
  await pause(160); await frame(page).locator('.answers button.target').click();
  await until(async () => (await score(page)) === targetScore);
}
try {
  const bridge = createNakamaBridge({ url: process.env.NAKAMA_URL, serverKey: process.env.NAKAMA_SERVER_KEY,
    httpKey: process.env.NAKAMA_HTTP_KEY, gatewayKey: process.env.ARCANE_GATEWAY_KEY, adminKey: process.env.ARCANE_ADMIN_KEY });
  await run('isolate a two-player score-race release from the installed template', async () => {
    const source = await bridge.dispatch('admin.getGame', { gameId: 'arcane-score-race', environment: 'development', releaseId: 'dev' });
    await bridge.dispatch('admin.registerGame', { gameId, environment, releaseId, publisherId: 'arcane-score-browser',
      buildHash: 'trusted-score-browser-v1', entryUrl: source.entryUrl,
      manifest: { ...source.manifest, multiplayer: { adapter: 'score-race-v1', minPlayers: 2, maxPlayers: 2 } } });
  });
  browser = await chromium.launch({ ...(process.argv.includes('--chromium') ? {} : { channel: 'chrome' }), headless: true });
  contexts.push(await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' }));
  contexts.push(await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' }));
  const pages = await Promise.all(contexts.map(context => context.newPage())), [desktop, mobile] = pages;
  pages.forEach((page, i) => page.on('pageerror', error => errors.push({ device: i ? 'mobile' : 'desktop', code: error.name || 'PAGE_ERROR' })));
  await run('desktop and mobile boot in separate opaque sandbox identities', async () => {
    await Promise.all(pages.map(page => page.goto(`${gateway}/play/${gameId}?environment=${environment}&releaseId=${releaseId}`)));
    await Promise.all(pages.map(async page => {
      await until(async () => (await frame(page).locator('#status').innerText()).includes('准备好了'));
      const sandbox = await page.locator('iframe[data-arcane-game-frame]').getAttribute('sandbox');
      assert.ok(!sandbox.includes('allow-same-origin'));
      const child = page.frames().find(item => item.parentFrame() === page.mainFrame());
      assert.equal(await child.evaluate(() => globalThis.origin), 'null');
    }));
    await capture(mobile, 'mobile-ready.png');
  });
  await run('two browsers match, answer 19 legal challenges and display their own ranks', async () => {
    await frame(desktop).locator('#join').click(); await frame(mobile).locator('#join').click();
    await Promise.all(pages.map(page => until(async () => (await frame(page).locator('.answers button.target').count()) === 1)));
    for (let point = 1; point <= 9; point++) { await answer(desktop, point); await answer(mobile, point); }
    await answer(desktop, 10);
    await until(async () => (await frame(desktop).locator('#status').innerText()).includes('第 1 名') && (await frame(mobile).locator('#status').innerText()).includes('第 2 名'));
    assert.equal(await score(mobile), 9);
    await capture(desktop, 'desktop-settlement.png'); await capture(mobile, 'mobile-settlement.png');
  });
  await run('both community panels recover verified leaderboard ranks', async () => {
    for (const [index, page] of pages.entries()) {
      await frame(page).locator('#community').click();
      const dialog = page.getByRole('dialog', { name: '游戏社区' });
      await until(async () => (await dialog.innerText()).includes(`我的排名：${index + 1}`));
      await capture(page, index ? 'mobile-leaderboard.png' : 'desktop-leaderboard.png');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    }
  });
  await run('desktop/mobile layouts fit and have zero uncaught script exceptions', async () => {
    for (const page of pages) {
      const child = page.frames().find(item => item.parentFrame() === page.mainFrame());
      const dimensions = await child.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(dimensions.scroll <= dimensions.width + 1);
    }
    assert.deepEqual(errors, []);
  });
} catch (error) {
  if (error.code !== 'BROWSER_STOPPED') checks.push({ name: 'browser setup', passed: false, code: error.name || 'BROWSER_FAILED' });
} finally {
  await Promise.allSettled(contexts.map(context => context.request.post(`${gateway}/v1/logout`, { headers: { Origin: new URL(gateway).origin }, data: {} })));
  await Promise.allSettled(contexts.map(context => context.close())); await browser?.close();
  const report = { date: new Date().toISOString(), durationMs: Math.round(performance.now() - began),
    backend: 'official Nakama + PostgreSQL + Gateway + actual browser SDK/WS', checks, pageErrors: errors, screenshots: captures,
    passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length };
  await writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2) + '\n');
  console.log(`Score browser: ${report.passed} passed, ${report.failed} failed.`); if (report.failed) process.exitCode = 1;
}
