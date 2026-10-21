import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

// Real PostgreSQL integration; uses an isolated schema and never alters local player data.
test('configured party capacity, concurrent admission and 10,000-member bounded pages', { skip: !process.env.ARCANE_TEST_DATABASE_URL, timeout: 90000 }, async t => {
  const schema = 'arcane_party_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Client({ connectionString: process.env.ARCANE_TEST_DATABASE_URL }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.ARCANE_TEST_DATABASE_URL, max: 8, options: `-c search_path=${schema},public` });
  const gameId = 'party-capacity', environment = 'test', releaseId = 'r1';
  const owner = randomUUID(), second = randomUUID(), third = randomUUID();
  const call = async (method, params = {}, user = owner, release = releaseId) => {
    const { rows } = await pool.query('SELECT arcane_execute($1,$2,$3,$4,$5,$6::jsonb) AS result', [gameId, environment, params.releaseId ?? release, user, method, JSON.stringify(params)]);
    if (rows[0].result?._error) throw Object.assign(new Error(rows[0].result._error.message), { code: rows[0].result._error.code });
    return rows[0].result;
  };
  const manifest = { schemaVersion: '1.0', sdkVersion: '0.1', capabilities: ['profile', 'party', 'friends'], party: { maxMembers: 10000 } };
  const register = (release, config = manifest) => call('admin.registerGame', { gameId, environment, releaseId: release, publisherId: 'owner', buildHash: release, manifest: config });
  try {
    const migration = await readFile(new URL('../nakama/migrations/001_platform.sql', import.meta.url), 'utf8');
    await pool.query(migration); await pool.query(migration);
    await register(releaseId);
    const a = (await call('context.get')).gameUserId, b = (await call('context.get', {}, second)).gameUserId, c = (await call('context.get', {}, third)).gameUserId;
    await t.test('release and creation both limit capacity, frozen after release changes', async () => {
      assert.equal((await call('context.get')).party.maxMembers, 10000);
      await assert.rejects(call('party.create', { maxMembers: 10001 }), { message: 'INVALID_PARTY_MAX_MEMBERS' });
      await register('small', { ...manifest, party: { maxMembers: 2 } });
      await assert.rejects(call('party.create', { maxMembers: 3 }, owner, 'small'), { message: 'INVALID_PARTY_MAX_MEMBERS' });
      const created = (await call('party.create', { maxMembers: 2 })).party;
      assert.equal(created.maxMembers, 2); assert.equal(created.memberCount, 1); assert.equal(created.self.gameUserId, a);
      assert.equal((await call('party.get', {}, owner, 'small')).party.maxMembers, 2);
    });
    await t.test('concurrent invited accepts cannot overfill final slot', async () => {
      const partyId = (await call('party.get')).party.partyId;
      for (const [user, id] of [[second, b], [third, c]]) { await call('friends.request', { gameUserId: id }); await call('friends.accept', { gameUserId: a }, user); await call('party.invite', { partyId, gameUserId: id }); }
      const results = await Promise.allSettled([call('party.accept', { partyId }, second), call('party.accept', { partyId }, third)]);
      assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
      assert.equal(results.filter(x => x.status === 'rejected' && x.reason.message === 'PARTY_FULL').length, 1);
      assert.equal((await call('party.get')).party.memberCount, 2);
      await call('party.leave', { partyId });
    });
    await t.test('shared codes admit non-friends, remain leader-only, and serialize capacity', async () => {
      const d = randomUUID(), e = randomUUID();
      await call('context.get', {}, d); await call('context.get', {}, e);
      const party = (await call('party.create', { maxMembers: 2, joinPolicy: 'code' })).party;
      assert.equal(party.joinPolicy, 'code'); assert.match(party.joinCode, /^[0-9a-f]{64}$/);
      await assert.rejects(call('party.get', { partyId: party.partyId }, d), { message: 'PARTY_ACCESS_DENIED' });
      await assert.rejects(call('party.join', { partyId: party.partyId, joinCode: '0'.repeat(64) }, d), { message: 'PARTY_JOIN_DENIED' });
      const joins = await Promise.allSettled([call('party.join', { partyId: party.partyId, joinCode: party.joinCode }, d), call('party.join', { partyId: party.partyId, joinCode: party.joinCode }, e)]);
      assert.equal(joins.filter(x => x.status === 'fulfilled').length, 1);
      assert.equal(joins.filter(x => x.status === 'rejected' && x.reason.message === 'PARTY_FULL').length, 1);
      const member = joins[0].status === 'fulfilled' ? d : e;
      const joined = (await call('party.get', { partyId: party.partyId }, member)).party;
      assert.equal('joinCode' in joined, false); assert.equal(joined.memberCount, 2);
      assert.equal((await call('party.join', { partyId: party.partyId, joinCode: party.joinCode }, member)).party.memberCount, 2);
      assert.equal('joinCode' in (await pool.query('SELECT arcane_party_summary($1,$2,$3) AS party', [gameId, environment, party.partyId])).rows[0].party, false);
      await call('party.leave', { partyId: party.partyId });
      assert.equal((await call('party.get', { partyId: party.partyId }, member)).party.joinCode, party.joinCode);
    });
    await t.test('10,000 SQL-seeded members page without omissions, readiness stays bounded', async () => {
      const party = (await call('party.create', { maxMembers: 10000 })).party;
      assert.equal((await call('party.get', {}, owner, 'small')).party.maxMembers, 10000);
      const start = performance.now();
      // Bulk fixture setup intentionally bypasses per-player friendship/invitation RPCs.
      // The measured operations below execute the same public SQL RPC used by Nakama.
      await pool.query(`INSERT INTO arcane_users(game_id,environment,platform_user_id,nakama_user_id,game_user_id,profile,created_at)
        SELECT $1,$2,gen_random_uuid()::text,gen_random_uuid(),'gusr_'||lpad(to_hex(i),32,'0'),jsonb_build_object('displayName',repeat('扫',32)),i FROM generate_series(1,9999) i`, [gameId, environment]);
      await pool.query(`INSERT INTO arcane_party_members SELECT $1,$2,$3,'gusr_'||lpad(to_hex(i),32,'0'),'member',false,i FROM generate_series(1,9999) i`, [gameId, environment, party.partyId]);
      await pool.query('ANALYZE arcane_users; ANALYZE arcane_party_members; ANALYZE arcane_parties');
      const seedMs = performance.now() - start, pages = [], seen = new Set(); let cursor, largestBytes = 0;
      do {
        const at = performance.now(), result = await call('party.get', { partyId: party.partyId, limit: 100, ...(cursor ? { cursor } : {}) });
        pages.push(performance.now() - at); largestBytes = Math.max(largestBytes, Buffer.byteLength(JSON.stringify(result)));
        assert.equal(result.party.memberCount, 10000); assert.equal(result.party.maxMembers, 10000); assert.equal(result.party.self.gameUserId, a);
        assert.ok(result.party.members.length <= 100);
        for (const member of result.party.members) { assert.equal(seen.has(member.gameUserId), false); seen.add(member.gameUserId); }
        cursor = result.party.cursor;
      } while (cursor);
      assert.equal(seen.size, 10000); assert.equal(pages.length, 100); assert.ok(largestBytes < 65536);
      const readyTimes = [];
      for (let i = 0; i < 20; i++) {
        const at = performance.now(), result = await call('party.ready', { partyId: party.partyId, ready: i % 2 === 0 }); readyTimes.push(performance.now() - at);
        assert.equal(result.party.self.ready, i % 2 === 0); assert.equal(result.party.readyCount, i % 2 === 0 ? 1 : 0); assert.equal(result.party.members.length, 50);
      }
      const p95 = values => [...values].sort((x,y) => x-y)[Math.ceil(values.length * .95)-1];
      t.diagnostic(JSON.stringify({ dataset: 'SQL-seeded 10,000 members, not 10,000 invitation flows', seedMs: Math.round(seedMs), pages: pages.length, pageLimit: 100, pageP95Ms: +p95(pages).toFixed(2), readyP95Ms: +p95(readyTimes).toFixed(2), largestResponseBytes: largestBytes }));
    });
    await t.test('pending invitation summaries have independent bounded keyset pages', async () => {
      await pool.query(`INSERT INTO arcane_users(game_id,environment,platform_user_id,nakama_user_id,game_user_id,created_at)
        SELECT $1,$2,gen_random_uuid()::text,gen_random_uuid(),'gusr_'||lpad(to_hex(i),32,'0'),i FROM generate_series(20000,20099) i`, [gameId, environment]);
      await pool.query(`INSERT INTO arcane_parties(game_id,environment,party_id,leader_id,created_at,max_members)
        SELECT $1,$2,'p_inv_'||i,'gusr_'||lpad(to_hex(i),32,'0'),i,10000 FROM generate_series(20000,20099) i`, [gameId, environment]);
      await pool.query(`INSERT INTO arcane_party_members SELECT $1,$2,'p_inv_'||i,'gusr_'||lpad(to_hex(i),32,'0'),'member',false,i FROM generate_series(20000,20099) i`, [gameId, environment]);
      await pool.query(`INSERT INTO arcane_party_members SELECT $1,$2,'p_inv_'||i,$3,'invited',false,i FROM generate_series(20000,20099) i`, [gameId, environment, a]);
      let inviteCursor; const ids = new Set();
      do {
        const page = await call('party.get', { limit: 7, ...(inviteCursor ? { inviteCursor } : {}) });
        assert.ok(page.invites.length <= 7); assert.equal(page.party.memberCount, 10000); assert.equal(page.party.members.length, 7);
        for (const invite of page.invites) { assert.equal(ids.has(invite.partyId), false); ids.add(invite.partyId); assert.equal('members' in invite.party, false); assert.equal(invite.party.memberCount, 1); }
        inviteCursor = page.inviteCursor;
      } while (inviteCursor);
      assert.equal(ids.size, 100);
    });
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
