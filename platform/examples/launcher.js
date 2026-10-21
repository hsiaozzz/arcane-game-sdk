import { createGameHostBroker } from '/platform/browser/host-broker.js';

const gameId = location.pathname.split('/')[2] || 'arcane-take-away';
const query = new URLSearchParams(location.search);
const environment = query.get('environment') || 'development', releaseId = query.get('releaseId') || 'dev';
const stage = document.querySelector('#stage'), status = document.querySelector('#status');
let broker;
try {
  const response = await fetch(`/v1/releases/${encodeURIComponent(gameId)}/${encodeURIComponent(environment)}/${encodeURIComponent(releaseId)}`);
  const descriptor = await response.json();
  if (!response.ok) throw new Error(descriptor.error?.message || '游戏版本尚未登记。');
  const iframe = document.createElement('iframe');
  iframe.title = descriptor.manifest.title || gameId;
  iframe.dataset.arcaneGameFrame = '';
  iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-forms allow-modals');
  stage.append(iframe);
  broker = createGameHostBroker({ iframe, gatewayUrl: location.origin, gameId, environment, releaseId,
    manifest: descriptor.manifest, onState(state) { status.textContent = state.message || (state.status === 'connected' ? '公共服务已连接' : '正在连接…'); } });
  const entry = new URL(descriptor.entryUrl, location.origin);
  entry.searchParams.set('arcaneHostOrigin', broker.config.hostOrigin);
  entry.searchParams.set('arcaneChannel', broker.config.channelId);
  iframe.src = entry.href;
  document.querySelector('#community').onclick = () => broker.request('social.open', { tab: 'friends' }).catch(error => { status.textContent = error.message; });
  status.textContent = '进入游戏后可打开社区';
} catch (error) {
  const message = document.createElement('p'); message.id = 'error'; message.textContent = error.message; stage.append(message);
  status.textContent = '连接未完成';
}
addEventListener('pagehide', () => broker?.close(), { once: true });
