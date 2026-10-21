// Host-owned UI. Untrusted game code receives only the open/closed result.
export function createSocialOverlay({ client, account, manifest = {}, document = globalThis.document, onClose } = {}) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#020617bf;display:none;align-items:center;justify-content:center;padding:12px;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{font:14px system-ui;color:#e2e8f0}*{box-sizing:border-box}section{background:#101827;border:1px solid #334155;border-radius:18px;width:min(760px,100%);max-height:90dvh;overflow:auto;padding:20px}header,nav,.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}header{justify-content:space-between}h2{margin:0;font-size:20px}nav{margin:18px 0}button,input,select{font:inherit;border:1px solid #475569;border-radius:9px;padding:10px;background:#17253b;color:#f1f5f9}button{cursor:pointer;min-height:42px}button.active{background:#0e7490}button:disabled{opacity:.5;cursor:wait}input{min-width:0;flex:1}form,.item{margin:12px 0}.item{padding:12px;background:#172033;border-radius:9px}.muted{color:#94a3b8;font-size:12px}#status{white-space:pre-wrap;min-height:22px;color:#67e8f9}p{overflow-wrap:anywhere}main{min-height:160px}';
  shadow.appendChild(style);
  const section = document.createElement('section');
  section.setAttribute('role', 'dialog'); section.setAttribute('aria-modal', 'true'); section.setAttribute('aria-label', '游戏社区');
  shadow.appendChild(section);
  const element = (tag, text, parent = section) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); parent.appendChild(node); return node; };
  const header = element('header'); element('h2', '游戏社区', header);
  const closeButton = element('button', '关闭', header);
  const nav = element('nav'); const status = element('p', '', section); status.id = 'status'; status.setAttribute('role', 'status');
  const main = element('main');
  const capabilities = new Set(manifest.capabilities || []);
  const tabs = [['profile', '我的资料'], ['friends', '好友'], ['chat', '聊天'], ['party', '队伍'], ['leaderboards', '排行榜'], ['achievements', '成就']].filter(([id]) => capabilities.has(id));
  if (account) tabs.push(['account', '账号']);
  let selected = tabs[0]?.[0]; let generation = 0; let destroyed = false; let previousFocus;
  const buttons = new Map();
  const notify = (text) => { status.textContent = text || ''; };
  async function run(operation, button) {
    if (button) button.disabled = true;
    try { notify('正在连接平台…'); const value = await operation(); notify(''); return value; }
    catch (error) { notify(error?.message || '平台暂时不可用，请稍后重试'); return null; }
    finally { if (button) button.disabled = false; }
  }
  const call = (method, params = {}) => client.request(method, params);
  const action = (parent, text, callback) => { const button = element('button', text, parent); button.type = 'button'; button.addEventListener('click', () => run(callback, button)); return button; };
  const input = (parent, placeholder, value = '') => { const node = element('input', null, parent); node.placeholder = placeholder; node.setAttribute('aria-label', placeholder); node.value = value; return node; };
  const item = (text, parent = main) => { const row = element('div', null, parent); row.className = 'item'; element('p', text, row); return row; };
  async function render() {
    const current = ++generation;
    main.replaceChildren();
    for (const [id, button] of buttons) button.classList.toggle('active', id === selected);
    const valid = () => !destroyed && current === generation;
    await run(async () => {
      if (selected === 'account') {
        const state = await account.status(); if (!valid()) return;
        item(state.authenticated ? `当前浏览器会话：${state.displayName || '已登录玩家'}` : '当前已退出登录。请选择账号或游客模式。');
        element('p', '登录其他账号会切换当前身份。新建邮箱账号不会合并游客的存档、好友或成绩。', main).className = 'muted';
        const form = element('form', null, main);
        const mode = element('select', null, form); mode.setAttribute('aria-label', '账号操作');
        element('option', '登录其他账号', mode).value = 'login';
        element('option', '新建邮箱账号', mode).value = 'create';
        const email = input(form, '邮箱'); email.type = 'email'; email.required = true; email.maxLength = 254; email.autocomplete = 'username';
        const password = input(form, '密码（至少 8 位）'); password.type = 'password'; password.required = true; password.minLength = 8; password.maxLength = 128; password.autocomplete = 'current-password';
        const submit = element('button', '登录其他账号', form); submit.type = 'submit';
        mode.addEventListener('change', () => { const create = mode.value === 'create'; submit.textContent = create ? '新建邮箱账号' : '登录其他账号'; password.autocomplete = create ? 'new-password' : 'current-password'; });
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const credentials = { email: email.value.trim(), password: password.value, create: mode.value === 'create' };
          password.value = '';
          run(async () => {
            try { await account.login(credentials); }
            catch (error) { if (valid()) await render(); throw error; }
            if (valid()) await render();
          }, submit);
        });
        if (state.authenticated) action(main, '退出当前账号', async () => {
          try { await account.logout(); }
          catch (error) { if (valid()) await render(); throw error; }
          close();
        });
        else action(main, '以游客身份继续', async () => { await account.guest(); if (valid()) await render(); });
      } else if (selected === 'profile') {
        const profile = await call('profile.get'); if (!valid()) return;
        item(`玩家 ID：${profile.gameUserId}`);
        const form = element('form', null, main); const name = input(form, '显示名称', profile.displayName); name.maxLength = 32;
        const save = element('button', '保存资料', form); save.type = 'submit';
        form.addEventListener('submit', (event) => { event.preventDefault(); run(async () => { await call('profile.update', { displayName: name.value.trim(), expectedVersion: profile.version }); await render(); }, save); });
        if (capabilities.has('economy')) { const wallet = await call('economy.get'); if (valid()) item(`金币：${wallet.currencies?.coins || 0}`); }
      } else if (selected === 'friends') {
        const lists = await call('friends.list'); if (!valid()) return;
        const form = element('form', null, main); const target = input(form, '输入对方玩家 ID'); const send = element('button', '添加好友', form);
        form.addEventListener('submit', (event) => { event.preventDefault(); run(async () => { await call('friends.request', { gameUserId: target.value.trim() }); await render(); }, send); });
        for (const [key, title] of [['incoming', '收到的申请'], ['outgoing', '已发送申请'], ['friends', '我的好友']]) {
          element('h3', title, main);
          if (!lists[key]?.length) element('p', '暂无记录', main).className = 'muted';
          for (const friend of lists[key] || []) {
            const row = item(`${friend.displayName || '玩家'} · ${friend.gameUserId}`);
            if (key === 'incoming') action(row, '接受', async () => { await call('friends.accept', { gameUserId: friend.gameUserId }); await render(); });
            if (key === 'friends') action(row, '移除', async () => { await call('friends.remove', { gameUserId: friend.gameUserId }); await render(); });
          }
        }
      } else if (selected === 'chat') {
        const { channels } = await call('chat.channels'); if (!valid()) return;
        const select = element('select', null, main); select.setAttribute('aria-label', '聊天频道');
        for (const channel of channels || []) { const option = element('option', channel.name || channel.channelId, select); option.value = channel.channelId; }
        const messages = element('div', null, main);
        async function history() { const data = await call('chat.history', { channelId: select.value, limit: 30 }); if (!valid()) return; messages.replaceChildren(); for (const message of data.messages || []) item(`${message.displayName || message.sender?.displayName || message.gameUserId || '玩家'}：${message.text}`, messages); }
        select.addEventListener('change', () => run(history));
        if (select.value) await history();
        const form = element('form', null, main); const text = input(form, '输入消息'); text.maxLength = 280; const send = element('button', '发送', form);
        form.addEventListener('submit', (event) => { event.preventDefault(); run(async () => { if (!text.value.trim()) return; await call('chat.send', { channelId: select.value, text: text.value.trim() }); text.value = ''; await history(); }, send); });
        action(main, '刷新消息', history);
      } else if (selected === 'party') {
        const data = await call('party.get'); if (!valid()) return;
        if (!data.party) {
          const form = element('form', null, main); const capacity = input(form, '队伍人数上限', String(manifest.party?.maxMembers || 32)); capacity.type = 'number'; capacity.min = '1'; capacity.max = String(manifest.party?.maxMembers || 32); capacity.step = '1'; capacity.required = true;
          const policy = element('select', null, form); policy.setAttribute('aria-label', '队伍加入方式'); element('option', '好友邀请', policy).value = 'invite'; element('option', '分享邀请码', policy).value = 'code';
          const create = element('button', '创建队伍', form); create.type = 'submit';
          form.addEventListener('submit', event => { event.preventDefault(); run(async () => { await call('party.create', { maxMembers: Number(capacity.value), joinPolicy: policy.value }); await render(); }, create); });
          const joinForm = element('form', null, main); const partyId = input(joinForm, '队伍 ID'); partyId.required = true; const code = input(joinForm, '队伍邀请码'); code.type = 'password'; code.required = true; code.maxLength = 64; const join = element('button', '使用邀请码加入', joinForm); join.type = 'submit';
          joinForm.addEventListener('submit', event => { event.preventDefault(); run(async () => { await call('party.join', { partyId: partyId.value.trim(), joinCode: code.value.trim() }); code.value = ''; await render(); }, join); });
        }
        const invitations = element('div', null, main);
        async function invitePage(page) {
          for (const invite of page.invites || []) action(item(`队伍邀请：${invite.partyId} · ${invite.party.memberCount}/${invite.party.maxMembers} 人`, invitations), '接受邀请', async () => { await call('party.accept', { partyId: invite.partyId }); await render(); });
          if (page.inviteCursor) { const more = action(invitations, '更多邀请', async () => { const next = await call('party.get', { inviteCursor: page.inviteCursor }); if (!valid()) return; more.remove(); await invitePage(next); }); }
        }
        await invitePage(data);
        if (data.party) {
          const party = data.party; item(`队伍：${party.partyId} · ${party.memberCount}/${party.maxMembers} 人 · ${party.readyCount} 人已准备`);
          if (party.joinCode) { const code = input(main, '队伍邀请码（仅队长可见）', party.joinCode); code.readOnly = true; element('p', '将队伍 ID 和邀请码私下分享给成员；持码者可加入，仍受人数上限约束。', main).className = 'muted'; }
          const members = element('div', null, main);
          async function memberPage(page) {
            for (const member of page.members || []) item(`${member.displayName || member.gameUserId}${member.status === 'invited' ? ' · 待接受邀请' : member.ready ? ' · 已准备' : ' · 等待准备'}`, members);
            if (page.cursor) { const more = action(members, '更多成员', async () => { const next = await call('party.get', { partyId: party.partyId, cursor: page.cursor }); if (!valid()) return; more.remove(); await memberPage(next.party); }); }
          }
          await memberPage(party);
          const form = element('form', null, main); const target = input(form, '好友玩家 ID'); const invite = element('button', '邀请好友', form);
          form.addEventListener('submit', (event) => { event.preventDefault(); run(async () => { await call('party.invite', { partyId: party.partyId, gameUserId: target.value.trim() }); await render(); }, invite); });
          action(main, party.self?.ready ? '取消准备' : '准备', async () => { await call('party.ready', { partyId: party.partyId, ready: !party.self?.ready }); await render(); });
          action(main, '离开队伍', async () => { await call('party.leave', { partyId: party.partyId }); await render(); });
        }
        element('p', '队伍用于社交邀请；本版本匹配仍为个人排队。', main).className = 'muted';
      } else if (selected === 'leaderboards') {
        const ids = Object.keys(manifest.leaderboards || {});
        if (!ids.length) { item('此游戏尚未配置排行榜。'); return; }
        const select = element('select', null, main); select.setAttribute('aria-label', '排行榜'); for (const id of ids) element('option', id, select).value = id;
        const list = element('div', null, main);
        async function load() { const data = await call('leaderboards.list', { leaderboardId: select.value, limit: 30 }); if (!valid()) return; list.replaceChildren(); if (data.ownRecord) item(`我的排名：${data.ownRecord.rank} · ${data.ownRecord.score} 分`, list); for (const record of data.records || []) item(`${record.rank}. ${record.displayName || '玩家'} · ${record.score} 分`, list); if (!data.records?.length) item('还没有已验证的比赛成绩。', list); }
        select.addEventListener('change', () => run(load)); await load();
      } else if (selected === 'achievements') {
        const data = await call('achievements.list'); if (!valid()) return;
        if (!data.achievements?.length) item('此游戏尚未配置成就。');
        for (const achievement of data.achievements || []) { const row = item(`${achievement.name} · ${achievement.count}/${achievement.target}${achievement.claimed ? ' · 已领取' : ''}`); if (achievement.completed && !achievement.claimed) action(row, '领取奖励', async () => { await call('achievements.claim', { achievementId: achievement.id }); await render(); }); }
      } else item('此游戏尚未启用社区功能。');
    });
  }
  for (const [id, title] of tabs) { const button = action(nav, title, async () => { selected = id; await render(); }); buttons.set(id, button); }
  function close() { host.style.display = 'none'; ++generation; main.replaceChildren(); previousFocus?.focus?.(); onClose?.(); }
  closeButton.addEventListener('click', close);
  host.addEventListener('click', (event) => { if (event.composedPath()[0] === host) close(); });
  host.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Escape') close(); });
  document.body.appendChild(host);
  return {
    open({ tab } = {}) { if (destroyed) return; previousFocus = document.activeElement; if (tabs.some(([id]) => id === tab)) selected = tab; host.style.display = 'flex'; closeButton.focus(); render(); },
    destroy() { destroyed = true; ++generation; host.remove(); }
  };
}
