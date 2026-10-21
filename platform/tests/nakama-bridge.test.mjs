import test from 'node:test';
import assert from 'node:assert/strict';
import { createNakamaBridge } from '../server/nakama.mjs';

test('Nakama symbolic errors preserve stable SDK conflict codes', async () => {
  for (const [message, code] of [['PROFILE_VERSION_CONFLICT', 'PROFILE_VERSION_CONFLICT'], ['SAVE_VERSION_CONFLICT: stale save', 'SAVE_VERSION_CONFLICT'], ['already exists', 'CONFLICT']]) {
    const bridge = createNakamaBridge({ url: 'http://private.test', serverKey: 'server'.repeat(8), httpKey: 'http'.repeat(8),
      gatewayKey: 'gateway'.repeat(8), adminKey: 'admin'.repeat(8), fetchImpl: async () => new Response(JSON.stringify({ code: 6, message }), { status: 409 }) });
    await assert.rejects(bridge.dispatch('profile.update'), error => error.code === code && error.status === 409);
  }
});
