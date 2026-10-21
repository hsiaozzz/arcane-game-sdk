import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { createNakamaBridge } from '../server/nakama.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.loadEnvFile(path.join(root, 'platform/.local-data/platform.env'));
const output = path.join(root, 'platform/.local-data/browser-smoke');
await mkdir(output, { recursive: true });
const gateway = new URL(process.env.ARCANE_PUBLIC_URL).origin;
assert.ok(process.env.ARCANE_LOCAL_DEVELOPMENT === 'true' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(gateway).hostname), 'Smoke tests only accept the isolated local development stack');
const useBundledChromium = process.argv.includes('--chromium');
const startedAt = new Date().toISOString(), began = performance.now();
const checks = [], captures = [], pageErrors = [], consoleErrors = [], httpFailures = [], pages = [];
let checkpoint = '';
let browser, contexts = [], registered = false;
const gameId = `browser-smoke-${Date.now().toString(36)}`;
const environment = 'development', releaseId = 'qa';
const gameUrl = `${gateway}/play/${gameId}?environment=${environment}&releaseId=${releaseId}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const codeFor = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : error?.name === 'TimeoutError' ? 'BROWSER_TIMEOUT' : error?.name === 'AssertionError' ? 'ASSERTION_FAILED' : 'BROWSER_CHECK_FAILED';
function fail(code) { return Object.assign(new Error(code), { code }); }
async function eventually(check, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await check(); if (result) return result; await pause(75); }
  throw fail('BROWSER_TIMEOUT');
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, name), fullPage: true,
    mask: [page.locator('input[type="password"], input[type="email"], input[aria-label*="邀请码"]')] });
  captures.push(name);
}
async function run(name, task, { fatal = false } = {}) {
  const at = performance.now();
  checkpoint = '';
  try { await task(); checks.push({ name, status: 'passed', durationMs: Math.round(performance.now() - at) }); console.log(`PASS ${name}`); return true; }
  catch (error) {
    const code = codeFor(error);
    checks.push({ name, status: 'failed', code, ...(checkpoint ? { checkpoint } : {}), durationMs: Math.round(performance.now() - at) }); console.error(`FAIL ${name} (${code}${checkpoint ? `; ${checkpoint}` : ''})`);
    for (const [index, page] of pages.entries()) await screenshot(page, `failure-${checks.length}-${index}.png`).catch(() => {});
    if (fatal) throw fail('BROWSER_STOPPED');
    return false;
  }
}
function watch(page, device) {
  const stats = { sessionRequests: 0, bootstrapRequests: 0, matchInputs: 0, websocketErrors: 0 };
  const methods = new Map();
  page.on('pageerror', error => {
    const code = /localStorage|sessionStorage|Access is denied/.test(error.message) ? 'OPAQUE_STORAGE_SECURITY_ERROR' : error.name === 'SecurityError' ? 'BROWSER_SECURITY_ERROR' : 'BROWSER_PAGE_ERROR';
    pageErrors.push({ device, code });
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const source = message.location().url;
    let pathname;
    try { pathname = new URL(source).pathname; } catch { /* Console events need not have a URL. */ }
    const status = Number(/status of (\d{3})/.exec(message.text())?.[1]) || undefined;
    const code = pathname === '/v1/logout' && status === 401 ? 'EXPECTED_SIGNED_OUT_PROBE'
      : pathname === '/favicon.ico' && status === 404 ? 'MISSING_FAVICON'
      : /CORS|cross-origin/i.test(message.text()) ? 'CORS_CONSOLE_ERROR'
      : /net::|Failed to load resource/.test(message.text()) ? 'NETWORK_CONSOLE_ERROR' : 'BROWSER_CONSOLE_ERROR';
    consoleErrors.push({ device, code, ...(pathname ? { path: pathname } : {}),
      ...(methods.has(source) ? { method: methods.get(source) } : pathname === '/favicon.ico' ? { method: 'GET' } : {}),
      ...(status ? { status } : {}) });
  });
  page.on('request', request => {
    methods.set(request.url(), request.method());
    if (methods.size > 512) methods.delete(methods.keys().next().value);
    const url = new URL(request.url());
    if (url.pathname === '/v1/session' && request.method() === 'POST') stats.sessionRequests++;
    if (url.pathname === '/v1/bootstrap' && request.method() === 'POST') stats.bootstrapRequests++;
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname, status = response.status();
    httpFailures.push({ device, method: response.request().method(), path: pathname, status,
      code: pathname === '/v1/logout' && status === 401 ? 'EXPECTED_SIGNED_OUT_PROBE' : pathname === '/favicon.ico' && status === 404 ? 'MISSING_FAVICON' : 'HTTP_ERROR' });
  });
  page.on('websocket', socket => {
    socket.on('framesent', event => { try { if (JSON.parse(String(event.payload)).type === 'input') stats.matchInputs++; } catch { /* Binary game frames are not RPCs. */ } });
    socket.on('socketerror', () => stats.websocketErrors++);
  });
  pages.push(page);
  return stats;
}
const game = page => page.frameLocator('iframe[data-arcane-game-frame]');
const closeCommunity = page => page.getByRole('dialog', { name: '游戏社区' }).getByRole('button', { name: '关闭', exact: true }).click();
async function community(page, tab) {
  checkpoint = `open community ${tab}`;
  const existing = page.getByRole('dialog', { name: '游戏社区' });
  if (!(await existing.isVisible())) await page.locator('#community').click();
  const dialog = page.getByRole('dialog', { name: '游戏社区' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: tab, exact: true }).click();
  checkpoint = `render community ${tab}`;
  return dialog;
}
async function opaqueChecks(page) {
  const iframe = page.locator('iframe[data-arcane-game-frame]');
  const sandbox = await iframe.getAttribute('sandbox');
  assert.ok(sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin'));
  const url = new URL(await iframe.getAttribute('src'));
  assert.equal(url.searchParams.get('arcaneHostOrigin'), gateway);
  assert.match(url.searchParams.get('arcaneChannel'), /^[a-f0-9]{48}$/);
  assert.ok([...url.searchParams.keys()].every(key => !/token|ticket|password|secret|auth/i.test(key)));
  const child = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
  const security = await child.evaluate(() => {
    let parentDenied = false, storageDenied = false;
    try { void parent.document.body; } catch { parentDenied = true; }
    try { void localStorage.length; } catch { storageDenied = true; }
    return { origin: globalThis.origin, parentDenied, storageDenied,
      hasRawCredential: Object.keys(window.__ARCANE_GAME__ || {}).some(key => /token|ticket|password|secret/i.test(key)) };
  });
  assert.deepEqual(security, { origin: 'null', parentDenied: true, storageDenied: true, hasRawCredential: false });
}
try {
  const bridge = createNakamaBridge({ url: process.env.NAKAMA_URL, serverKey: process.env.NAKAMA_SERVER_KEY,
    httpKey: process.env.NAKAMA_HTTP_KEY, gatewayKey: process.env.ARCANE_GATEWAY_KEY, adminKey: process.env.ARCANE_ADMIN_KEY });
  await run('register isolated browser QA release', async () => {
    const source = await bridge.dispatch('admin.getGame', { gameId: 'arcane-take-away', environment: 'development', releaseId: 'dev' });
    await bridge.dispatch('admin.registerGame', { gameId, environment, releaseId, publisherId: 'arcane-browser-smoke',
      buildHash: 'real-browser-smoke', entryUrl: source.entryUrl, manifest: { ...source.manifest, party: { maxMembers: 128 } } });
    registered = true;
  }, { fatal: true });
  browser = await chromium.launch({ ...(useBundledChromium ? {} : { channel: 'chrome' }), headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-dev-shm-usage'] });
  contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' }),
    browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'zh-CN' }),
  ]);
  const [desktop, mobile] = await Promise.all(contexts.map(context => context.newPage()));
  const stats = [watch(desktop, 'desktop'), watch(mobile, 'mobile')];
  await run('desktop and mobile boot real hosted games in opaque frames', async () => {
    await Promise.all([desktop.goto(gameUrl), mobile.goto(gameUrl)]);
    await Promise.all([game(desktop).locator('#join').waitFor(), game(mobile).locator('#join').waitFor()]);
    await eventually(async () => await game(desktop).locator('#join').isEnabled() && await game(mobile).locator('#join').isEnabled());
    await Promise.all([opaqueChecks(desktop), opaqueChecks(mobile)]);
    assert.ok(stats.every(value => value.sessionRequests >= 1 && value.bootstrapRequests >= 1));
    await screenshot(desktop, 'desktop-take-away-ready.png');
    await screenshot(mobile, 'mobile-take-away-ready.png');
  }, { fatal: true });

  await run('desktop and mobile save Chinese profile names through the UI', async () => {
    for (const [page, name] of [[desktop, '星石浏览器一号'], [mobile, '星石浏览器二号']]) {
      await game(page).locator('#name').fill(name);
      await game(page).locator('#save-name').click();
      await game(page).locator('#notice').filter({ hasText: '昵称已保存' }).waitFor();
      assert.equal(await game(page).locator('#error').innerText(), '');
    }
  });

  await run('two browser players match and legally finish a real authoritative game', async () => {
    await game(desktop).locator('#join').click();
    await game(mobile).locator('#join').click();
    await eventually(async () => (await game(desktop).locator('#notice').innerText()).includes('剩余 21') && (await game(mobile).locator('#notice').innerText()).includes('剩余 21'));
    await screenshot(mobile, 'mobile-take-away-playing.png');
    for (let moves = 0; moves < 24; moves++) {
      const texts = await Promise.all([game(desktop).locator('#notice').innerText(), game(mobile).locator('#notice').innerText()]);
      if (texts.every(text => /最后一颗星|摘星了/.test(text))) break;
      const page = texts[0].startsWith('轮到你了') ? desktop : texts[1].startsWith('轮到你了') ? mobile : null;
      if (!page) { await pause(80); continue; }
      const before = texts[page === desktop ? 0 : 1];
      let clicked = false;
      for (const count of [3, 2, 1]) {
        const take = game(page).locator(`.take[data-take="${count}"]`);
        if (await take.isEnabled()) { await take.click(); clicked = true; break; }
      }
      assert.ok(clicked, 'Current player has no legal move');
      await eventually(async () => (await game(page).locator('#notice').innerText()) !== before);
    }
    await Promise.all([game(desktop).locator('#stats').filter({ hasText: '我的排名 #' }).waitFor(), game(mobile).locator('#stats').filter({ hasText: '我的排名 #' }).waitFor()]);
    assert.ok(stats.every(value => value.matchInputs > 0));
    assert.equal(await game(desktop).locator('#error').innerText(), '');
    assert.equal(await game(mobile).locator('#error').innerText(), '');
    await screenshot(desktop, 'desktop-take-away-settlement.png');
    await screenshot(mobile, 'mobile-take-away-settlement.png');
  }, { fatal: true });

  await run('trusted community switches friends chat and achievements on both layouts', async () => {
    for (const [page, prefix] of [[desktop, 'desktop'], [mobile, 'mobile']]) {
      let dialog = await community(page, '好友');
      await dialog.getByRole('button', { name: '添加好友', exact: true }).waitFor();
      await screenshot(page, `${prefix}-community-friends.png`);
      dialog = await community(page, '聊天');
      await dialog.getByRole('combobox', { name: '聊天频道' }).waitFor();
      await dialog.getByRole('textbox', { name: '输入消息' }).fill('真实浏览器已接入，一起摘星！');
      await dialog.getByRole('button', { name: '发送', exact: true }).click();
      await dialog.getByText('真实浏览器已接入，一起摘星！', { exact: false }).waitFor();
      await screenshot(page, `${prefix}-community-chat.png`);
      dialog = await community(page, '成就');
      await dialog.getByText('迈出第一步', { exact: false }).waitFor();
      await screenshot(page, `${prefix}-community-achievements.png`);
      await closeCommunity(page);
    }
  });

  await run('desktop creates a configured code party and mobile joins with private readiness state', async () => {
    checkpoint = 'create 128-capacity desktop code party';
    let leader = await community(desktop, '队伍');
    await leader.getByRole('spinbutton', { name: '队伍人数上限', exact: true }).fill('128');
    await leader.getByRole('combobox', { name: '队伍加入方式', exact: true }).selectOption('code');
    await leader.getByRole('button', { name: '创建队伍', exact: true }).click();
    const leaderSummary = leader.getByText(/^队伍：p_.*1\/128 人/);
    await leaderSummary.waitFor();
    const partyId = /队伍：(p_[a-f0-9]{32})/.exec(await leaderSummary.innerText())?.[1];
    const codeField = leader.getByRole('textbox', { name: '队伍邀请码（仅队长可见）', exact: true });
    const joinCode = await codeField.inputValue();
    // Never persist this bearer code in a log, checkpoint, screenshot or report.
    assert.ok(partyId && /^[a-f0-9]{64}$/.test(joinCode));
    checkpoint = 'mobile enters the shared party code';
    const member = await community(mobile, '队伍');
    await member.getByRole('textbox', { name: '队伍 ID', exact: true }).fill(partyId);
    await member.getByLabel('队伍邀请码', { exact: true }).fill(joinCode);
    await member.getByRole('button', { name: '使用邀请码加入', exact: true }).click();
    await member.getByText(/^队伍：p_.*2\/128 人/).waitFor();
    assert.equal(await member.getByLabel('队伍邀请码（仅队长可见）', { exact: true }).count(), 0);
    checkpoint = 'member toggles own readiness';
    await member.getByRole('button', { name: '准备', exact: true }).click();
    await member.getByRole('button', { name: '取消准备', exact: true }).waitFor();
    await member.getByText(/^队伍：p_.*1 人已准备/).waitFor();
    checkpoint = 'leader refresh sees total and ready counts without changing self readiness';
    leader = await community(desktop, '队伍');
    await leader.getByText(/^队伍：p_.*2\/128 人.*1 人已准备/).waitFor();
    await leader.getByRole('button', { name: '准备', exact: true }).waitFor();
    assert.ok(await leader.getByLabel('队伍邀请码（仅队长可见）', { exact: true }).isVisible());
    // Leave and close both views so subsequent account checks start cleanly.
    checkpoint = 'both browsers leave the temporary party';
    await member.getByRole('button', { name: '离开队伍', exact: true }).click();
    await member.getByRole('button', { name: '创建队伍', exact: true }).waitFor();
    await closeCommunity(mobile);
    await leader.getByRole('button', { name: '离开队伍', exact: true }).click();
    await leader.getByRole('button', { name: '创建队伍', exact: true }).waitFor();
    await closeCommunity(desktop);
  });

  await run('email account creation leaves the hosted game usable after identity switch', async () => {
    const dialog = await community(desktop, '账号');
    await dialog.getByRole('combobox', { name: '账号操作' }).selectOption('create');
    const suffix = randomBytes(8).toString('hex');
    await dialog.getByRole('textbox', { name: '邮箱', exact: true }).fill(`browser-${suffix}@example.invalid`);
    await dialog.getByLabel('密码（至少 8 位）', { exact: true }).fill(randomBytes(18).toString('base64url'));
    await dialog.getByRole('button', { name: '新建邮箱账号', exact: true }).click();
    await dialog.getByRole('button', { name: '退出当前账号', exact: true }).waitFor();
    await eventually(async () => (await dialog.getByRole('textbox', { name: '邮箱', exact: true }).inputValue()) === '');
    await screenshot(desktop, 'desktop-account-created.png');
    await closeCommunity(desktop);
    await eventually(async () => await game(desktop).locator('#save-name').isVisible());
    await game(desktop).locator('#name').fill('换号后仍能玩');
    await game(desktop).locator('#save-name').click();
    await pause(500);
    const error = await game(desktop).locator('#error').innerText();
    if (/关闭|切换|closed|SESSION_CHANGED/i.test(error)) throw fail('GAME_SDK_CLOSED_AFTER_ACCOUNT_CHANGE');
    await game(desktop).locator('#notice').filter({ hasText: '昵称已保存' }).waitFor();
  });

  await run('logout refresh stays signed out until explicit guest choice', async () => {
    const dialog = await community(desktop, '账号');
    await dialog.getByRole('button', { name: '退出当前账号', exact: true }).click();
    const count = stats[0].sessionRequests;
    await desktop.reload();
    await game(desktop).locator('#notice').waitFor();
    await pause(600);
    assert.equal(stats[0].sessionRequests, count, 'Refreshing after logout must not silently authenticate a guest');
    let account = await community(desktop, '账号');
    await account.getByRole('button', { name: '以游客身份继续', exact: true }).waitFor();
    await screenshot(desktop, 'desktop-account-signed-out.png');
    await account.getByRole('button', { name: '以游客身份继续', exact: true }).click();
    await account.getByRole('button', { name: '退出当前账号', exact: true }).waitFor();
    await closeCommunity(desktop);
    await eventually(async () => await game(desktop).locator('#join').isEnabled());
    assert.ok(stats[0].sessionRequests > count);
    await screenshot(desktop, 'desktop-explicit-guest-restored.png');
  });

  await run('real browser pages report zero uncaught JavaScript errors', async () => {
    assert.equal(pageErrors.length, 0);
  });
} catch (error) {
  if (error.code !== 'BROWSER_STOPPED') {
    const code = codeFor(error); checks.push({ name: 'browser setup', status: 'failed', code, durationMs: 0 }); console.error(`FAIL browser setup (${code})`);
  }
} finally {
  // No cookie jar, trace, request body, credentials or platform identity is persisted.
  await Promise.allSettled(contexts.map(context => context.close()));
  await browser?.close();
  const report = { startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - began),
    backend: 'real-nakama-postgresql', browser: useBundledChromium ? 'bundled-chromium-headless' : 'system-chrome-headless', devices: [{ width: 1280, height: 900 }, { width: 390, height: 844 }],
    isolatedRelease: registered, passed: checks.filter(check => check.status === 'passed').length,
    failed: checks.filter(check => check.status === 'failed').length, checks, pageErrors, consoleErrors, httpFailures, screenshots: captures };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Browser smoke: ${report.passed} passed, ${report.failed} failed (${report.durationMs}ms). Sanitized report/screenshots saved.`);
  if (report.failed) process.exitCode = 1;
}
