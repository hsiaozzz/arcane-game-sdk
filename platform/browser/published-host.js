import { createGameHostBroker } from './host-broker.js';

// Run this module only on a platform-owned page. The supplied HTML always
// executes inside an opaque sandbox, including when its files share a server.
export function mountPublishedGame({ container = document.body, html, manifest, gatewayUrl, gameId, environment = 'production', releaseId, iframe: suppliedFrame } = {}) {
  if (!gameId || !releaseId || !manifest) throw new Error('A registered game release is required');
  const iframe = suppliedFrame || document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-forms allow-modals');
  iframe.title = 'Game';
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#020617;';
  if (!suppliedFrame) container.appendChild(iframe);
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:fixed;top:10px;right:10px;z-index:10000;font:14px system-ui;max-width:80%;color:#f8fafc;background:#0f172ae8;border:1px solid #334155;padding:8px;border-radius:12px;';
  const button = document.createElement('button');
  button.textContent = '游戏社区'; button.style.cssText = 'padding:10px;border:0;border-radius:8px;background:#0e7490;color:white;font:inherit;cursor:pointer;';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  toolbar.append(button, status); container.appendChild(toolbar);
  const broker = createGameHostBroker({ iframe, gatewayUrl, manifest, gameId, environment, releaseId, onState(state) { status.textContent = state.message || ''; } });
  button.addEventListener('click', () => broker.request('social.open', {}).catch((error) => { status.textContent = error.message; }));
  const config = JSON.stringify(broker.config).replace(/</g, '\\u003c');
  iframe.srcdoc = String(html).replace(/<head\b[^>]*>/i, (head) => `${head}<script>window.__ARCANE_GAME__=${config};<\/script>`);
  return { iframe, broker, destroy() { broker.close(); toolbar.remove(); if (!suppliedFrame) iframe.remove(); } };
}
