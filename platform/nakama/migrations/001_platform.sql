-- Applied by the runtime before accepting RPCs. No cross-request BEGIN/COMMIT:
-- each arcane_execute call is one database transaction on one pool connection.
CREATE TABLE IF NOT EXISTS arcane_schema_migrations(version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS arcane_games(game_id TEXT NOT NULL, environment TEXT NOT NULL, publisher_id TEXT NOT NULL, current_release_id TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY(game_id,environment));
CREATE TABLE IF NOT EXISTS arcane_releases(game_id TEXT NOT NULL, environment TEXT NOT NULL, release_id TEXT NOT NULL, publisher_id TEXT NOT NULL, build_hash TEXT NOT NULL, entry_url TEXT, active BOOLEAN NOT NULL DEFAULT true, manifest JSONB NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,release_id), FOREIGN KEY(game_id,environment) REFERENCES arcane_games(game_id,environment));
ALTER TABLE arcane_releases ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS arcane_users(game_id TEXT NOT NULL, environment TEXT NOT NULL, platform_user_id TEXT NOT NULL, nakama_user_id UUID NOT NULL, game_user_id TEXT NOT NULL, profile JSONB NOT NULL DEFAULT '{"displayName":"Player","avatar":"","metadata":{}}', profile_version INTEGER NOT NULL DEFAULT 1, created_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,platform_user_id), UNIQUE(game_id,environment,game_user_id));
CREATE TABLE IF NOT EXISTS arcane_saves(game_id TEXT NOT NULL, environment TEXT NOT NULL, game_user_id TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL, version INTEGER NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,game_user_id,collection,key));
CREATE TABLE IF NOT EXISTS arcane_relations(game_id TEXT NOT NULL, environment TEXT NOT NULL, owner_id TEXT NOT NULL, target_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('requested','friend','blocked')), created_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,owner_id,target_id), CHECK(owner_id<>target_id));
CREATE INDEX IF NOT EXISTS arcane_relations_incoming ON arcane_relations(game_id,environment,target_id,state);
CREATE TABLE IF NOT EXISTS arcane_chat_messages(id BIGSERIAL PRIMARY KEY, game_id TEXT NOT NULL, environment TEXT NOT NULL, channel_id TEXT NOT NULL, sender_id TEXT NOT NULL, text TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS arcane_chat_channel ON arcane_chat_messages(game_id,environment,channel_id,id DESC);
CREATE TABLE IF NOT EXISTS arcane_chat_rates(game_id TEXT NOT NULL, environment TEXT NOT NULL, game_user_id TEXT NOT NULL, bucket BIGINT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(game_id,environment,game_user_id));
CREATE TABLE IF NOT EXISTS arcane_parties(game_id TEXT NOT NULL, environment TEXT NOT NULL, party_id TEXT NOT NULL, leader_id TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,party_id));
-- Existing parties retain their previous capacity; new parties freeze their
-- requested capacity explicitly, independently of later release definitions.
ALTER TABLE arcane_parties ADD COLUMN IF NOT EXISTS max_members INTEGER NOT NULL DEFAULT 8 CHECK(max_members BETWEEN 1 AND 10000);
ALTER TABLE arcane_parties ADD COLUMN IF NOT EXISTS join_code TEXT CHECK(join_code IS NULL OR join_code~'^[0-9a-f]{64}$');
CREATE TABLE IF NOT EXISTS arcane_party_members(game_id TEXT NOT NULL, environment TEXT NOT NULL, party_id TEXT NOT NULL, game_user_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('invited','member')), ready BOOLEAN NOT NULL DEFAULT false, joined_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,party_id,game_user_id), FOREIGN KEY(game_id,environment,party_id) REFERENCES arcane_parties(game_id,environment,party_id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS arcane_one_party ON arcane_party_members(game_id,environment,game_user_id) WHERE status='member';
CREATE INDEX IF NOT EXISTS arcane_party_page ON arcane_party_members(game_id,environment,party_id,status,game_user_id);
CREATE INDEX IF NOT EXISTS arcane_party_invitations ON arcane_party_members(game_id,environment,game_user_id,party_id) WHERE status='invited';
CREATE TABLE IF NOT EXISTS arcane_matches(game_id TEXT NOT NULL, environment TEXT NOT NULL, match_run_id TEXT NOT NULL, release_id TEXT NOT NULL, adapter_id TEXT NOT NULL, roster JSONB NOT NULL, mode TEXT NOT NULL, config JSONB NOT NULL, state JSONB, state_version INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'registered', created_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,match_run_id));
CREATE INDEX IF NOT EXISTS arcane_active_matches ON arcane_matches(adapter_id,created_at,game_id,environment,match_run_id) WHERE status<>'settled';
CREATE TABLE IF NOT EXISTS arcane_host_sessions(session_id TEXT PRIMARY KEY, platform_user_id UUID NOT NULL, expires_at BIGINT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT false, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS arcane_host_sessions_expiry ON arcane_host_sessions(expires_at);
CREATE TABLE IF NOT EXISTS arcane_match_tickets(nonce TEXT PRIMARY KEY, game_id TEXT NOT NULL, environment TEXT NOT NULL, match_run_id TEXT NOT NULL, game_user_id TEXT NOT NULL, expires_at BIGINT NOT NULL, consumed_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS arcane_queues(game_id TEXT NOT NULL, environment TEXT NOT NULL, game_user_id TEXT NOT NULL, queue_id TEXT NOT NULL, release_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, match_run_id TEXT, created_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,game_user_id));
CREATE INDEX IF NOT EXISTS arcane_waiting_queue ON arcane_queues(game_id,environment,release_id,mode,created_at) WHERE status='waiting';
CREATE TABLE IF NOT EXISTS arcane_settlements(game_id TEXT NOT NULL, environment TEXT NOT NULL, match_run_id TEXT NOT NULL, payload JSONB NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,match_run_id));
CREATE TABLE IF NOT EXISTS arcane_match_results(game_id TEXT NOT NULL, environment TEXT NOT NULL, match_run_id TEXT NOT NULL, game_user_id TEXT NOT NULL, rank INTEGER, score BIGINT NOT NULL, points BIGINT NOT NULL, finished_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,match_run_id,game_user_id));
CREATE TABLE IF NOT EXISTS arcane_board_records(game_id TEXT NOT NULL, environment TEXT NOT NULL, board_id TEXT NOT NULL, period_key TEXT NOT NULL, game_user_id TEXT NOT NULL, score BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,board_id,period_key,game_user_id));
CREATE TABLE IF NOT EXISTS arcane_achievements(game_id TEXT NOT NULL, environment TEXT NOT NULL, game_user_id TEXT NOT NULL, achievement_id TEXT NOT NULL, count BIGINT NOT NULL DEFAULT 0, definition JSONB NOT NULL, earned_at BIGINT, claimed_at BIGINT, PRIMARY KEY(game_id,environment,game_user_id,achievement_id));
CREATE TABLE IF NOT EXISTS arcane_wallets(game_id TEXT NOT NULL, environment TEXT NOT NULL, game_user_id TEXT NOT NULL, coins BIGINT NOT NULL DEFAULT 0 CHECK(coins>=0), version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(game_id,environment,game_user_id));
CREATE TABLE IF NOT EXISTS arcane_currency_ledger(game_id TEXT NOT NULL, environment TEXT NOT NULL, game_user_id TEXT NOT NULL, source TEXT NOT NULL, amount BIGINT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,game_user_id,source));
CREATE TABLE IF NOT EXISTS arcane_tournament_entries(game_id TEXT NOT NULL, environment TEXT NOT NULL, tournament_id TEXT NOT NULL, game_user_id TEXT NOT NULL, joined_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,tournament_id,game_user_id));
CREATE TABLE IF NOT EXISTS arcane_tournament_scores(game_id TEXT NOT NULL, environment TEXT NOT NULL, tournament_id TEXT NOT NULL, game_user_id TEXT NOT NULL, score BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(game_id,environment,tournament_id,game_user_id));

CREATE OR REPLACE FUNCTION arcane_assert(ok BOOLEAN, code INTEGER, msg TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', 'ARCANE:'||code::text||':'||msg; END IF;
END $$;

CREATE OR REPLACE FUNCTION arcane_period(stamp BIGINT, period TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE period WHEN 'daily' THEN to_char(to_timestamp(stamp/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD') WHEN 'weekly' THEN to_char(date_trunc('week',to_timestamp(stamp/1000.0) AT TIME ZONE 'UTC'),'YYYY-MM-DD') ELSE 'all_time' END
$$;

CREATE OR REPLACE FUNCTION arcane_party_summary(g TEXT,e TEXT,p TEXT) RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('partyId',a.party_id,'leaderId',a.leader_id,'createdAt',a.created_at,'maxMembers',a.max_members,'joinPolicy',CASE WHEN a.join_code IS NULL THEN 'invite' ELSE 'code' END,'memberCount',count(*) FILTER(WHERE b.status='member'),'inviteCount',count(*) FILTER(WHERE b.status='invited'),'readyCount',count(*) FILTER(WHERE b.status='member' AND b.ready)) FROM arcane_parties a LEFT JOIN arcane_party_members b ON b.game_id=a.game_id AND b.environment=a.environment AND b.party_id=a.party_id WHERE a.game_id=g AND a.environment=e AND a.party_id=p GROUP BY a.game_id,a.environment,a.party_id
$$;

CREATE OR REPLACE FUNCTION arcane_party_page(g TEXT,e TEXT,p TEXT,viewer TEXT,after_id TEXT,page_limit INTEGER) RETURNS JSONB LANGUAGE sql STABLE AS $$
 WITH page AS (SELECT b.game_user_id,jsonb_build_object('gameUserId',b.game_user_id,'displayName',u.profile->>'displayName','ready',b.ready,'status',b.status) AS value FROM arcane_party_members b JOIN arcane_users u ON u.game_id=b.game_id AND u.environment=b.environment AND u.game_user_id=b.game_user_id WHERE b.game_id=g AND b.environment=e AND b.party_id=p AND (after_id IS NULL OR b.game_user_id>after_id) ORDER BY b.game_user_id LIMIT page_limit+1), visible AS (SELECT * FROM page ORDER BY game_user_id LIMIT page_limit)
 SELECT arcane_party_summary(g,e,p)||jsonb_build_object('members',COALESCE((SELECT jsonb_agg(value ORDER BY game_user_id) FROM visible),'[]'::jsonb),'cursor',CASE WHEN (SELECT count(*) FROM page)>page_limit THEN (SELECT max(game_user_id) FROM visible) ELSE NULL END,'self',(SELECT jsonb_build_object('gameUserId',b.game_user_id,'displayName',u.profile->>'displayName','ready',b.ready,'status',b.status) FROM arcane_party_members b JOIN arcane_users u ON u.game_id=b.game_id AND u.environment=b.environment AND u.game_user_id=b.game_user_id WHERE b.game_id=g AND b.environment=e AND b.party_id=p AND b.game_user_id=viewer))||COALESCE((SELECT jsonb_build_object('joinCode',join_code) FROM arcane_parties WHERE game_id=g AND environment=e AND party_id=p AND leader_id=viewer AND join_code IS NOT NULL),'{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION arcane_party_json(g TEXT,e TEXT,p TEXT) RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT arcane_party_page(g,e,p,NULL,NULL,50)
$$;

CREATE OR REPLACE FUNCTION arcane_match_json(mt arcane_matches) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('gameId',mt.game_id,'environment',mt.environment,'matchRunId',mt.match_run_id,'adapterId',mt.adapter_id,'gameUserIds',mt.roster,'status',mt.status,'releaseId',mt.release_id,'createdAt',mt.created_at,'config',mt.config,'state',mt.state,'stateVersion',mt.state_version)
$$;

CREATE OR REPLACE FUNCTION arcane_match_queue(g TEXT,e TEXT,r TEXT,m TEXT,config JSONB,stamp BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE roster JSONB; run TEXT; min_p INTEGER; max_p INTEGER;
BEGIN
  -- A transaction-scoped namespace lock makes grouping deterministic without
  -- holding locks across HTTP calls or splitting a roster under concurrency.
  PERFORM pg_advisory_xact_lock(hashtextextended('arcane-queue:'||g||':'||e||':'||r||':'||m,0));
  min_p:=(config->>'minPlayers')::integer; max_p:=(config->>'maxPlayers')::integer;
  SELECT jsonb_agg(game_user_id ORDER BY game_user_id) INTO roster FROM (SELECT game_user_id FROM arcane_queues WHERE game_id=g AND environment=e AND release_id=r AND mode=m AND status='waiting' ORDER BY created_at,game_user_id LIMIT max_p FOR UPDATE) q;
  IF COALESCE(jsonb_array_length(roster),0)<min_p THEN RETURN; END IF;
  run:='m_'||replace(gen_random_uuid()::text,'-','');
  INSERT INTO arcane_matches(game_id,environment,match_run_id,release_id,adapter_id,roster,mode,config,created_at) VALUES(g,e,run,r,config->>'adapter',roster,m,config-'endpoint',stamp);
  UPDATE arcane_queues SET status='matched',match_run_id=run WHERE game_id=g AND environment=e AND release_id=r AND mode=m AND status='waiting' AND roster ? game_user_id;
END $$;

CREATE OR REPLACE FUNCTION arcane_settle(g TEXT,e TEXT,p JSONB,stamp BIGINT) RETURNS JSONB LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE mt arcane_matches%ROWTYPE; existing JSONB; rel JSONB; canon JSONB; results JSONB; entry JSONB; definition RECORD; tournament RECORD; user_id TEXT; delta BIGINT; target BIGINT; period_key TEXT; finished BIGINT; reason TEXT; was_inserted INTEGER;
BEGIN
  SELECT * INTO mt FROM arcane_matches WHERE game_id=g AND environment=e AND match_run_id=p->>'matchRunId' FOR UPDATE;
  PERFORM arcane_assert(FOUND,5,'MATCH_NOT_REGISTERED');
  PERFORM arcane_assert(mt.adapter_id=p->>'adapterId',7,'ADAPTER_MISMATCH');
  reason:=p->>'reason'; finished:=COALESCE((p->>'finishedAt')::bigint,mt.created_at);
  PERFORM arcane_assert(reason IN ('finished','abandoned'),3,'INVALID_MATCH_REASON');
  PERFORM arcane_assert(finished>=mt.created_at-1000 AND finished<=stamp+30000,3,'INVALID_FINISHED_AT');
  SELECT manifest INTO rel FROM arcane_releases WHERE game_id=g AND environment=e AND release_id=mt.release_id;
  results:=p->'results';
  PERFORM arcane_assert(jsonb_typeof(results)='array' AND jsonb_array_length(results)=jsonb_array_length(mt.roster),3,'RESULT_ROSTER_MISMATCH');
  PERFORM arcane_assert((SELECT count(DISTINCT v->>'gameUserId') FROM jsonb_array_elements(results) v)=jsonb_array_length(mt.roster),3,'DUPLICATE_RESULT_PLAYER');
  FOR entry IN SELECT value FROM jsonb_array_elements(results) ORDER BY value->>'gameUserId' LOOP
    user_id:=entry->>'gameUserId';
    PERFORM arcane_assert(mt.roster ? user_id,7,'RESULT_PLAYER_NOT_REGISTERED');
    PERFORM arcane_assert(jsonb_typeof(entry->'score')='number' AND (entry->>'score')~'^[0-9]+$' AND (entry->>'score')::numeric<=1000000000,3,'INVALID_MATCH_SCORE');
    PERFORM arcane_assert(jsonb_typeof(entry->'points')='number' AND (entry->>'points')~'^[0-9]+$' AND (entry->>'points')::numeric<=1000000000,3,'INVALID_MATCH_POINTS');
    IF reason='finished' THEN
      PERFORM arcane_assert(jsonb_typeof(entry->'rank')='number' AND (entry->>'rank')~'^[0-9]+$' AND (entry->>'rank')::integer BETWEEN 1 AND (mt.config->>'maxPlayers')::integer,3,'INVALID_MATCH_RANK');
      PERFORM arcane_assert(NOT entry ? 'won' OR jsonb_typeof(entry->'won')='boolean',3,'INVALID_WON_FLAG');
    ELSE
      PERFORM arcane_assert(entry->'rank' IS NULL OR entry->'rank'='null'::jsonb,3,'ABANDONED_RANK_MUST_BE_NULL');
    END IF;
  END LOOP;
  IF reason='finished' THEN PERFORM arcane_assert((SELECT count(DISTINCT v->>'rank') FROM jsonb_array_elements(results) v)=jsonb_array_length(mt.roster),3,'DUPLICATE_RESULT_RANK'); END IF;
  SELECT jsonb_agg(jsonb_build_object('gameUserId',value->>'gameUserId','rank',CASE WHEN reason='finished' THEN value->'rank' ELSE 'null'::jsonb END,'won',CASE WHEN reason='finished' THEN COALESCE((value->>'won')::boolean,(value->>'rank')::integer=1) ELSE false END,'score',CASE WHEN reason='finished' THEN (value->>'score')::bigint ELSE 0 END,'points',CASE WHEN reason='finished' THEN (value->>'points')::bigint ELSE 0 END) ORDER BY value->>'gameUserId') INTO results FROM jsonb_array_elements(results);
  canon:=jsonb_build_object('adapterId',mt.adapter_id,'releaseId',mt.release_id,'reason',reason,'finishedAt',finished,'results',results);
  SELECT payload INTO existing FROM arcane_settlements WHERE game_id=g AND environment=e AND match_run_id=mt.match_run_id;
  IF FOUND THEN
    PERFORM arcane_assert(existing=canon,6,'SETTLEMENT_REPLAY_CONFLICT');
    RETURN jsonb_build_object('matchRunId',mt.match_run_id,'status','settled','duplicate',true,'reason',reason);
  END IF;
  INSERT INTO arcane_settlements(game_id,environment,match_run_id,payload,created_at) VALUES(g,e,mt.match_run_id,canon,stamp);
  FOR entry IN SELECT value FROM jsonb_array_elements(results) LOOP
    user_id:=entry->>'gameUserId';
    INSERT INTO arcane_match_results(game_id,environment,match_run_id,game_user_id,rank,score,points,finished_at) VALUES(g,e,mt.match_run_id,user_id,(entry->>'rank')::integer,(entry->>'score')::bigint,(entry->>'points')::bigint,finished);
    IF reason='abandoned' THEN CONTINUE; END IF;
    FOR definition IN SELECT key,value FROM jsonb_each(COALESCE(rel->'leaderboards','{}'::jsonb)) ORDER BY key LOOP
      delta:=CASE definition.value->>'metric' WHEN 'wins' THEN CASE WHEN (entry->>'won')::boolean THEN 1 ELSE 0 END WHEN 'score' THEN (entry->>'score')::bigint ELSE (entry->>'points')::bigint END;
      period_key:=arcane_period(finished,definition.value->>'period');
      INSERT INTO arcane_board_records AS b(game_id,environment,board_id,period_key,game_user_id,score,updated_at) VALUES(g,e,definition.key,period_key,user_id,delta,finished)
      ON CONFLICT(game_id,environment,board_id,period_key,game_user_id) DO UPDATE SET score=CASE WHEN definition.value->>'operator'='best' THEN CASE WHEN definition.value->>'sort'='ascending' THEN LEAST(b.score,EXCLUDED.score) ELSE GREATEST(b.score,EXCLUDED.score) END ELSE b.score+EXCLUDED.score END,updated_at=GREATEST(b.updated_at,EXCLUDED.updated_at);
    END LOOP;
    FOR definition IN SELECT key,value FROM jsonb_each(COALESCE(rel->'achievements','{}'::jsonb)) ORDER BY key LOOP
      delta:=CASE WHEN definition.value->>'event'='match.played' OR (entry->>'won')::boolean THEN 1 ELSE 0 END;
      IF delta=0 THEN CONTINUE; END IF;
      target:=(definition.value->>'target')::bigint;
      INSERT INTO arcane_achievements AS a(game_id,environment,game_user_id,achievement_id,count,definition,earned_at) VALUES(g,e,user_id,definition.key,delta,definition.value,CASE WHEN delta>=target THEN finished ELSE NULL END)
      ON CONFLICT(game_id,environment,game_user_id,achievement_id) DO UPDATE SET count=a.count+EXCLUDED.count,definition=CASE WHEN a.earned_at IS NULL THEN EXCLUDED.definition ELSE a.definition END,earned_at=COALESCE(a.earned_at,CASE WHEN a.count+EXCLUDED.count>=target THEN finished ELSE NULL END);
    END LOOP;
    FOR tournament IN SELECT key,value FROM jsonb_each(COALESCE(rel->'tournaments','{}'::jsonb)) ORDER BY key LOOP
      IF finished<(tournament.value->>'startAt')::bigint OR finished>(tournament.value->>'endAt')::bigint OR NOT EXISTS(SELECT 1 FROM arcane_tournament_entries WHERE game_id=g AND environment=e AND tournament_id=tournament.key AND game_user_id=user_id AND joined_at<=finished) THEN CONTINUE; END IF;
      SELECT rel->'leaderboards'->(tournament.value->>'leaderboardId') INTO existing;
      delta:=CASE existing->>'metric' WHEN 'wins' THEN CASE WHEN (entry->>'won')::boolean THEN 1 ELSE 0 END WHEN 'score' THEN (entry->>'score')::bigint ELSE (entry->>'points')::bigint END;
      INSERT INTO arcane_tournament_scores AS t(game_id,environment,tournament_id,game_user_id,score,updated_at) VALUES(g,e,tournament.key,user_id,delta,finished)
      ON CONFLICT(game_id,environment,tournament_id,game_user_id) DO UPDATE SET score=CASE WHEN existing->>'operator'='best' THEN CASE WHEN existing->>'sort'='ascending' THEN LEAST(t.score,EXCLUDED.score) ELSE GREATEST(t.score,EXCLUDED.score) END ELSE t.score+EXCLUDED.score END,updated_at=GREATEST(t.updated_at,EXCLUDED.updated_at);
    END LOOP;
  END LOOP;
  UPDATE arcane_matches SET status='settled' WHERE game_id=g AND environment=e AND match_run_id=mt.match_run_id;
  UPDATE arcane_queues SET status='finished' WHERE game_id=g AND environment=e AND match_run_id=mt.match_run_id;
  RETURN jsonb_build_object('matchRunId',mt.match_run_id,'status','settled','duplicate',false,'reason',reason);
END $$;

CREATE OR REPLACE FUNCTION arcane_execute_inner(g TEXT,e TEXT,r TEXT,platform_id TEXT,method TEXT,p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE stamp BIGINT:=(extract(epoch FROM clock_timestamp())*1000)::bigint; rel arcane_releases%ROWTYPE; game arcane_games%ROWTYPE; usr arcane_users%ROWTYPE; other arcane_users%ROWTYPE; own_id TEXT; v_target_id TEXT; data JSONB; items JSONB; own_record JSONB; found_data RECORD; def JSONB; id TEXT; c TEXT; k TEXT; n INTEGER; lim INTEGER:=COALESCE((p->>'limit')::integer,50); off INTEGER:=COALESCE((p->>'offset')::integer,0); version_n INTEGER; v_period_key TEXT; party arcane_parties%ROWTYPE; mt arcane_matches%ROWTYPE; queue arcane_queues%ROWTYPE; ach arcane_achievements%ROWTYPE; wallet arcane_wallets%ROWTYPE; num BIGINT; rows_n INTEGER; descending BOOLEAN; next_key TEXT;
BEGIN
  IF method='admin.createSession' THEN
    PERFORM arcane_assert((p->>'expiresAt')::bigint>stamp AND (p->>'expiresAt')::bigint<=stamp+2592000000,3,'INVALID_SESSION_EXPIRY');
    INSERT INTO arcane_host_sessions(session_id,platform_user_id,expires_at,created_at) VALUES(p->>'sessionId',(p->>'platformUserId')::uuid,(p->>'expiresAt')::bigint,stamp) ON CONFLICT DO NOTHING;
    SELECT * INTO found_data FROM arcane_host_sessions WHERE session_id=p->>'sessionId';
    PERFORM arcane_assert(found_data.platform_user_id=(p->>'platformUserId')::uuid AND found_data.expires_at=(p->>'expiresAt')::bigint AND NOT found_data.revoked,6,'SESSION_REGISTRATION_CONFLICT');
    RETURN jsonb_build_object('sessionId',found_data.session_id,'platformUserId',found_data.platform_user_id::text,'expiresAt',found_data.expires_at,'revoked',found_data.revoked);
  END IF;
  IF method IN ('admin.getSession','admin.revokeSession') THEN
    IF method='admin.revokeSession' THEN UPDATE arcane_host_sessions SET revoked=true WHERE session_id=p->>'sessionId'; END IF;
    SELECT * INTO found_data FROM arcane_host_sessions WHERE session_id=p->>'sessionId'; PERFORM arcane_assert(FOUND,16,'SESSION_NOT_FOUND');
    IF method='admin.getSession' THEN PERFORM arcane_assert(NOT found_data.revoked AND found_data.expires_at>stamp,16,'SESSION_EXPIRED_OR_REVOKED'); END IF;
    RETURN jsonb_build_object('sessionId',found_data.session_id,'platformUserId',found_data.platform_user_id::text,'expiresAt',found_data.expires_at,'revoked',found_data.revoked);
  END IF;
  IF method='admin.pendingMatches' THEN
    SELECT COALESCE(jsonb_agg(arcane_match_json(q::arcane_matches) ORDER BY q.created_at),'[]'::jsonb) INTO items FROM (SELECT * FROM arcane_matches WHERE adapter_id=p->>'adapterId' AND status<>'settled' AND state IS NOT NULL AND state->>'status'='finished' AND (p->>'gameId' IS NULL OR game_id=p->>'gameId') AND (p->>'environment' IS NULL OR environment=p->>'environment') AND (p->>'releaseId' IS NULL OR release_id=p->>'releaseId') ORDER BY created_at LIMIT lim) q;
    RETURN jsonb_build_object('matches',items);
  END IF;
  IF method='admin.activeMatches' THEN
    lim:=COALESCE((p->>'limit')::integer,100); items:='[]'::jsonb; n:=0; next_key:=NULL;
    FOR mt IN SELECT * FROM arcane_matches WHERE adapter_id=p->>'adapterId' AND status<>'settled'
      AND (p->>'gameId' IS NULL OR game_id=p->>'gameId') AND (p->>'environment' IS NULL OR environment=p->>'environment') AND (p->>'releaseId' IS NULL OR release_id=p->>'releaseId')
      AND (p->>'after' IS NULL OR (created_at,game_id,environment,match_run_id)>((((p->>'after')::jsonb)->>0)::bigint,((p->>'after')::jsonb)->>1,((p->>'after')::jsonb)->>2,((p->>'after')::jsonb)->>3))
      ORDER BY created_at,game_id,environment,match_run_id LIMIT lim+1 LOOP
      n:=n+1;
      IF n>lim THEN RETURN jsonb_build_object('matches',items,'cursor',next_key); END IF;
      items:=items||jsonb_build_array(arcane_match_json(mt));
      next_key:=jsonb_build_array(mt.created_at,mt.game_id,mt.environment,mt.match_run_id)::text;
    END LOOP;
    RETURN jsonb_build_object('matches',items,'cursor',NULL);
  END IF;
  IF method='admin.registerGame' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('arcane-register:'||g,0));
    PERFORM arcane_assert(NOT EXISTS(SELECT 1 FROM arcane_games WHERE game_id=g AND publisher_id<>p->>'publisherId'),6,'PUBLISHER_IMMUTABLE');
    SELECT * INTO game FROM arcane_games WHERE game_id=g AND environment=e FOR UPDATE;
    IF FOUND THEN PERFORM arcane_assert(game.publisher_id=p->>'publisherId',6,'PUBLISHER_IMMUTABLE');
    ELSE INSERT INTO arcane_games(game_id,environment,publisher_id,current_release_id) VALUES(g,e,p->>'publisherId',''); END IF;
    SELECT * INTO rel FROM arcane_releases WHERE game_id=g AND environment=e AND release_id=r;
    IF FOUND THEN
      PERFORM arcane_assert(rel.publisher_id=p->>'publisherId' AND rel.build_hash=p->>'buildHash' AND rel.entry_url IS NOT DISTINCT FROM p->>'entryUrl' AND rel.manifest=p->'manifest',6,'RELEASE_IMMUTABLE');
    ELSE
      -- Existing semantic identifiers cannot silently change scoring between
      -- releases; publish a new board/tournament ID to change its semantics.
      FOR found_data IN SELECT x.key,x.value FROM arcane_releases q CROSS JOIN LATERAL jsonb_each(COALESCE(q.manifest->'leaderboards','{}'::jsonb)) x WHERE q.game_id=g AND q.environment=e LOOP
        IF p->'manifest'->'leaderboards' ? found_data.key THEN PERFORM arcane_assert(p->'manifest'->'leaderboards'->found_data.key=found_data.value,6,'LEADERBOARD_DEFINITION_IMMUTABLE'); END IF;
      END LOOP;
      FOR found_data IN SELECT x.key,x.value FROM arcane_releases q CROSS JOIN LATERAL jsonb_each(COALESCE(q.manifest->'tournaments','{}'::jsonb)) x WHERE q.game_id=g AND q.environment=e LOOP
        IF p->'manifest'->'tournaments' ? found_data.key THEN PERFORM arcane_assert(p->'manifest'->'tournaments'->found_data.key=found_data.value,6,'TOURNAMENT_DEFINITION_IMMUTABLE'); END IF;
      END LOOP;
      INSERT INTO arcane_releases(game_id,environment,release_id,publisher_id,build_hash,entry_url,active,manifest,created_at) VALUES(g,e,r,p->>'publisherId',p->>'buildHash',p->>'entryUrl',COALESCE((p->>'activate')::boolean,true),p->'manifest',stamp) RETURNING * INTO rel;
      IF rel.active THEN UPDATE arcane_games SET current_release_id=r WHERE game_id=g AND environment=e; END IF;
    END IF;
    RETURN jsonb_build_object('gameId',g,'environment',e,'releaseId',r,'publisherId',p->>'publisherId','buildHash',p->>'buildHash','entryUrl',p->>'entryUrl','active',rel.active,'manifest',p->'manifest');
  END IF;
  SELECT * INTO game FROM arcane_games WHERE game_id=g AND environment=e;
  PERFORM arcane_assert(FOUND,5,'GAME_NOT_REGISTERED');
  IF method IN ('admin.getMatch','admin.saveMatchState','admin.consumeMatchTicket') THEN
    SELECT * INTO mt FROM arcane_matches WHERE game_id=g AND environment=e AND match_run_id=p->>'matchRunId' FOR UPDATE;
    PERFORM arcane_assert(FOUND,5,'MATCH_NOT_REGISTERED');
    IF method='admin.getMatch' THEN RETURN arcane_match_json(mt); END IF;
    PERFORM arcane_assert(mt.release_id=p->>'releaseId' AND mt.adapter_id=p->>'adapterId',7,'MATCH_CONTEXT_MISMATCH');
    PERFORM arcane_assert(mt.status<>'settled',9,'MATCH_ALREADY_SETTLED');
    IF method='admin.consumeMatchTicket' THEN
      PERFORM arcane_assert(mt.roster ? (p->>'gameUserId'),7,'MATCH_ACCESS_DENIED');
      PERFORM arcane_assert((p->>'expiresAt')::bigint>stamp AND (p->>'expiresAt')::bigint<=stamp+60000,16,'MATCH_TICKET_EXPIRED');
      INSERT INTO arcane_match_tickets VALUES(p->>'nonce',g,e,mt.match_run_id,p->>'gameUserId',(p->>'expiresAt')::bigint,stamp) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS n=ROW_COUNT; PERFORM arcane_assert(n=1,7,'MATCH_TICKET_REPLAY');
      RETURN jsonb_build_object('consumed',true);
    END IF;
    PERFORM arcane_assert(mt.state_version=(p->>'expectedVersion')::integer,6,'MATCH_STATE_VERSION_CONFLICT');
    PERFORM arcane_assert(mt.state IS NULL OR mt.state->>'status'<>'finished' OR mt.state=p->'state',9,'FINISHED_MATCH_STATE_IMMUTABLE');
    UPDATE arcane_matches SET state=p->'state',state_version=state_version+1 WHERE game_id=g AND environment=e AND match_run_id=mt.match_run_id RETURNING state_version INTO n;
    RETURN jsonb_build_object('stateVersion',n);
  END IF;
  IF method='admin.getGame' THEN r:=COALESCE(NULLIF(r,''),game.current_release_id); END IF;
  IF method='admin.settleMatch' THEN RETURN arcane_settle(g,e,p,stamp); END IF;
  SELECT * INTO rel FROM arcane_releases WHERE game_id=g AND environment=e AND release_id=r;
  PERFORM arcane_assert(FOUND,5,'RELEASE_NOT_REGISTERED');
  IF method='admin.getGame' THEN RETURN jsonb_build_object('gameId',g,'environment',e,'releaseId',r,'publisherId',rel.publisher_id,'buildHash',rel.build_hash,'entryUrl',rel.entry_url,'active',rel.active,'manifest',rel.manifest,'enabled',game.enabled); END IF;
  IF method='admin.activateGame' THEN
    PERFORM arcane_assert(rel.build_hash=p->>'buildHash',6,'RELEASE_HASH_MISMATCH');
    UPDATE arcane_releases SET active=true WHERE game_id=g AND environment=e AND release_id=r;
    UPDATE arcane_games SET current_release_id=r WHERE game_id=g AND environment=e;
    RETURN jsonb_build_object('gameId',g,'environment',e,'releaseId',r,'buildHash',rel.build_hash,'active',true);
  END IF;
  IF method='admin.consumeAdmissionTicket' THEN
    PERFORM arcane_assert(game.enabled AND rel.active AND rel.manifest->'multiplayer'->>'adapter'=p->>'adapterId',7,'ADAPTER_MISMATCH');
    PERFORM arcane_assert(EXISTS(SELECT 1 FROM arcane_users WHERE game_id=g AND environment=e AND game_user_id=p->>'gameUserId'),7,'PLAYER_NOT_REGISTERED');
    PERFORM arcane_assert((p->>'expiresAt')::bigint>stamp AND (p->>'expiresAt')::bigint<=stamp+60000,16,'MATCH_TICKET_EXPIRED');
    INSERT INTO arcane_match_tickets VALUES(p->>'nonce',g,e,'',p->>'gameUserId',(p->>'expiresAt')::bigint,stamp) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n=ROW_COUNT; PERFORM arcane_assert(n=1,7,'MATCH_TICKET_REPLAY');
    RETURN jsonb_build_object('consumed',true);
  END IF;
  IF method='admin.registerMatch' THEN
    PERFORM arcane_assert(rel.active,7,'RELEASE_NOT_ACTIVE');
    SELECT jsonb_agg(value ORDER BY value) INTO data FROM jsonb_array_elements_text(p->'gameUserIds');
    PERFORM arcane_assert((SELECT count(*) FROM arcane_users WHERE game_id=g AND environment=e AND data ? game_user_id)=jsonb_array_length(data),7,'MATCH_PLAYER_NOT_REGISTERED');
    SELECT * INTO mt FROM arcane_matches WHERE game_id=g AND environment=e AND match_run_id=p->>'matchRunId' FOR UPDATE;
    IF FOUND THEN PERFORM arcane_assert(mt.release_id=r AND mt.adapter_id=p->>'adapterId' AND mt.roster=data AND mt.mode=COALESCE(p->>'mode','default'),6,'MATCH_REGISTRATION_IMMUTABLE');
    ELSE INSERT INTO arcane_matches(game_id,environment,match_run_id,release_id,adapter_id,roster,mode,config,created_at) VALUES(g,e,p->>'matchRunId',r,p->>'adapterId',data,COALESCE(p->>'mode','default'),(rel.manifest->'multiplayer')-'endpoint',stamp) RETURNING * INTO mt; END IF;
    RETURN jsonb_build_object('matchRunId',mt.match_run_id,'status',mt.status,'gameUserIds',mt.roster,'adapterId',mt.adapter_id,'releaseId',mt.release_id,'mode',mt.mode);
  END IF;
  PERFORM arcane_assert(game.enabled,7,'GAME_DISABLED');
  PERFORM arcane_assert(rel.active,7,'RELEASE_NOT_ACTIVE');
  INSERT INTO arcane_users(game_id,environment,platform_user_id,nakama_user_id,game_user_id,created_at) VALUES(g,e,platform_id,platform_id::uuid,'gusr_'||replace(gen_random_uuid()::text,'-',''),stamp) ON CONFLICT(game_id,environment,platform_user_id) DO NOTHING;
  SELECT * INTO usr FROM arcane_users WHERE game_id=g AND environment=e AND platform_user_id=platform_id FOR UPDATE;
  own_id:=usr.game_user_id;
  INSERT INTO arcane_wallets(game_id,environment,game_user_id) VALUES(g,e,own_id) ON CONFLICT DO NOTHING;
  IF method='context.get' THEN RETURN jsonb_build_object('gameId',g,'environment',e,'releaseId',r,'buildHash',rel.build_hash,'sdkVersion',rel.manifest->>'sdkVersion','capabilities',rel.manifest->'capabilities','gameUserId',own_id,'party',jsonb_build_object('maxMembers',COALESCE((rel.manifest->'party'->>'maxMembers')::integer,32)),'multiplayer',(rel.manifest->'multiplayer')-'endpoint'); END IF;
  IF method='profile.get' THEN
    SELECT * INTO other FROM arcane_users WHERE game_id=g AND environment=e AND game_user_id=COALESCE(p->>'gameUserId',own_id);
    PERFORM arcane_assert(FOUND,5,'PLAYER_NOT_FOUND');
    RETURN other.profile||jsonb_build_object('gameUserId',other.game_user_id,'version',other.profile_version);
  END IF;
  IF method='profile.update' THEN
    PERFORM arcane_assert(usr.profile_version=(p->>'expectedVersion')::integer,6,'PROFILE_VERSION_CONFLICT');
    UPDATE arcane_users SET profile=profile||(p-'expectedVersion'),profile_version=profile_version+1 WHERE game_id=g AND environment=e AND platform_user_id=platform_id RETURNING * INTO usr;
    RETURN usr.profile||jsonb_build_object('gameUserId',own_id,'version',usr.profile_version);
  END IF;
  IF method LIKE 'storage.%' THEN
    c:=COALESCE(p->>'collection','default'); k:=p->>'key';
    IF method='storage.list' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('collection',collection,'key',key,'value',value,'version',version,'updatedAt',updated_at) ORDER BY key),'[]'::jsonb) INTO items FROM (SELECT * FROM arcane_saves WHERE game_id=g AND environment=e AND game_user_id=own_id AND collection=c AND key>COALESCE(p->>'cursor','') ORDER BY key LIMIT lim) q;
      next_key:=CASE WHEN jsonb_array_length(items)=lim THEN items->(lim-1)->>'key' ELSE NULL END;
      RETURN jsonb_build_object('items',items,'cursor',next_key);
    END IF;
    SELECT value,version,updated_at INTO found_data FROM arcane_saves WHERE game_id=g AND environment=e AND game_user_id=own_id AND collection=c AND key=k;
    version_n:=CASE WHEN FOUND THEN found_data.version ELSE 0 END;
    IF method='storage.read' THEN IF version_n=0 THEN RETURN jsonb_build_object('item',NULL); END IF; RETURN jsonb_build_object('collection',c,'key',k,'value',found_data.value,'version',version_n,'updatedAt',found_data.updated_at); END IF;
    PERFORM arcane_assert(version_n=(p->>'expectedVersion')::integer,6,'SAVE_VERSION_CONFLICT');
    IF method='storage.delete' THEN
      PERFORM arcane_assert(version_n>0,5,'SAVE_NOT_FOUND'); DELETE FROM arcane_saves WHERE game_id=g AND environment=e AND game_user_id=own_id AND collection=c AND key=k; RETURN jsonb_build_object('deleted',true);
    END IF;
    IF version_n=0 THEN PERFORM arcane_assert((SELECT count(*) FROM arcane_saves WHERE game_id=g AND environment=e AND game_user_id=own_id)<100,8,'SAVE_KEY_LIMIT'); END IF;
    INSERT INTO arcane_saves(game_id,environment,game_user_id,collection,key,value,version,updated_at) VALUES(g,e,own_id,c,k,p->'value',version_n+1,stamp) ON CONFLICT(game_id,environment,game_user_id,collection,key) DO UPDATE SET value=EXCLUDED.value,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at;
    RETURN jsonb_build_object('collection',c,'key',k,'value',p->'value','version',version_n+1,'updatedAt',stamp);
  END IF;
  IF method='friends.list' THEN
    SELECT jsonb_build_object('friends',COALESCE(jsonb_agg(jsonb_build_object('gameUserId',u.game_user_id,'displayName',u.profile->>'displayName')) FILTER(WHERE a.owner_id=own_id AND a.state='friend'),'[]'::jsonb),'outgoing',COALESCE(jsonb_agg(jsonb_build_object('gameUserId',u.game_user_id,'displayName',u.profile->>'displayName')) FILTER(WHERE a.owner_id=own_id AND a.state='requested'),'[]'::jsonb),'incoming',COALESCE(jsonb_agg(jsonb_build_object('gameUserId',u.game_user_id,'displayName',u.profile->>'displayName')) FILTER(WHERE a.target_id=own_id AND a.state='requested'),'[]'::jsonb),'blocked',COALESCE(jsonb_agg(jsonb_build_object('gameUserId',u.game_user_id,'displayName',u.profile->>'displayName')) FILTER(WHERE a.owner_id=own_id AND a.state='blocked'),'[]'::jsonb)) INTO data FROM arcane_relations a JOIN arcane_users u ON u.game_id=g AND u.environment=e AND u.game_user_id=CASE WHEN a.owner_id=own_id THEN a.target_id ELSE a.owner_id END WHERE a.game_id=g AND a.environment=e AND ((a.owner_id=own_id) OR (a.target_id=own_id AND a.state='requested'));
    RETURN data;
  END IF;
  IF method LIKE 'friends.%' THEN
    v_target_id:=p->>'gameUserId'; PERFORM arcane_assert(v_target_id<>own_id,3,'CANNOT_FRIEND_SELF');
    PERFORM arcane_assert(EXISTS(SELECT 1 FROM arcane_users WHERE game_id=g AND environment=e AND game_user_id=v_target_id),5,'PLAYER_NOT_FOUND');
    PERFORM pg_advisory_xact_lock(hashtextextended('arcane-friend:'||g||':'||e||':'||LEAST(own_id,v_target_id)||':'||GREATEST(own_id,v_target_id),0));
    IF method='friends.block' THEN
      DELETE FROM arcane_relations a WHERE a.game_id=g AND a.environment=e AND a.owner_id=v_target_id AND a.target_id=own_id AND a.state<>'blocked';
      INSERT INTO arcane_relations(game_id,environment,owner_id,target_id,state,created_at) VALUES(g,e,own_id,v_target_id,'blocked',stamp) ON CONFLICT(game_id,environment,owner_id,target_id) DO UPDATE SET state='blocked',created_at=stamp;
      RETURN jsonb_build_object('blocked',true);
    END IF;
    IF method='friends.remove' THEN DELETE FROM arcane_relations WHERE arcane_relations.game_id=g AND arcane_relations.environment=e AND ((arcane_relations.owner_id=own_id AND arcane_relations.target_id=v_target_id) OR (arcane_relations.owner_id=v_target_id AND arcane_relations.target_id=own_id)) AND (arcane_relations.state<>'blocked' OR arcane_relations.owner_id=own_id); RETURN jsonb_build_object('removed',true); END IF;
    PERFORM arcane_assert(NOT EXISTS(SELECT 1 FROM arcane_relations a WHERE a.game_id=g AND a.environment=e AND a.state='blocked' AND ((a.owner_id=own_id AND a.target_id=v_target_id) OR(a.owner_id=v_target_id AND a.target_id=own_id))),7,'PLAYER_BLOCKED');
    IF method='friends.accept' THEN
      PERFORM arcane_assert(EXISTS(SELECT 1 FROM arcane_relations a WHERE a.game_id=g AND a.environment=e AND a.owner_id=v_target_id AND a.target_id=own_id AND a.state='requested'),9,'NO_INCOMING_FRIEND_REQUEST');
      INSERT INTO arcane_relations(game_id,environment,owner_id,target_id,state,created_at) VALUES(g,e,own_id,v_target_id,'friend',stamp),(g,e,v_target_id,own_id,'friend',stamp) ON CONFLICT(game_id,environment,owner_id,target_id) DO UPDATE SET state='friend'; RETURN jsonb_build_object('status','accepted');
    END IF;
    PERFORM arcane_assert(NOT EXISTS(SELECT 1 FROM arcane_relations a WHERE a.game_id=g AND a.environment=e AND a.owner_id=own_id AND a.target_id=v_target_id AND a.state='friend'),9,'ALREADY_FRIENDS');
    PERFORM arcane_assert((SELECT count(*) FROM arcane_relations WHERE game_id=g AND environment=e AND owner_id=own_id)<100,8,'FRIEND_LIMIT');
    INSERT INTO arcane_relations(game_id,environment,owner_id,target_id,state,created_at) VALUES(g,e,own_id,v_target_id,'requested',stamp) ON CONFLICT(game_id,environment,owner_id,target_id) DO NOTHING; RETURN jsonb_build_object('status','requested');
  END IF;
  IF method='chat.channels' THEN
    items:=jsonb_build_array(jsonb_build_object('channelId','global','type','global'));
    SELECT items||COALESCE(jsonb_agg(jsonb_build_object('channelId','dm:'||LEAST(own_id,a.target_id)||':'||GREATEST(own_id,a.target_id),'type','dm','gameUserId',a.target_id)),'[]'::jsonb) INTO items FROM arcane_relations a WHERE a.game_id=g AND a.environment=e AND a.owner_id=own_id AND a.state='friend';
    SELECT items||COALESCE(jsonb_agg(jsonb_build_object('channelId','party:'||party_id,'type','party')),'[]'::jsonb) INTO items FROM arcane_party_members WHERE game_id=g AND environment=e AND game_user_id=own_id AND status='member';
    RETURN jsonb_build_object('channels',items);
  END IF;
  IF method LIKE 'chat.%' THEN
    c:=p->>'channelId';
    IF c<>'global' THEN
      IF left(c,3)='dm:' THEN
        v_target_id:=CASE WHEN split_part(c,':',2)=own_id THEN split_part(c,':',3) WHEN split_part(c,':',3)=own_id THEN split_part(c,':',2) ELSE NULL END;
        PERFORM arcane_assert(v_target_id IS NOT NULL AND c='dm:'||LEAST(own_id,v_target_id)||':'||GREATEST(own_id,v_target_id) AND EXISTS(SELECT 1 FROM arcane_relations a WHERE a.game_id=g AND a.environment=e AND a.owner_id=own_id AND a.target_id=v_target_id AND a.state='friend'),7,'CHANNEL_ACCESS_DENIED');
      ELSIF left(c,6)='party:' THEN
        PERFORM arcane_assert(EXISTS(SELECT 1 FROM arcane_party_members WHERE game_id=g AND environment=e AND game_user_id=own_id AND party_id=substr(c,7) AND status='member'),7,'CHANNEL_ACCESS_DENIED');
      ELSE PERFORM arcane_assert(false,7,'CHANNEL_ACCESS_DENIED'); END IF;
    END IF;
    IF method='chat.send' THEN
      INSERT INTO arcane_chat_rates AS cr(game_id,environment,game_user_id,bucket,count) VALUES(g,e,own_id,stamp/10000,1) ON CONFLICT(game_id,environment,game_user_id) DO UPDATE SET bucket=EXCLUDED.bucket,count=CASE WHEN cr.bucket=EXCLUDED.bucket THEN cr.count+1 ELSE 1 END RETURNING count INTO n;
      PERFORM arcane_assert(n<=5,8,'CHAT_RATE_LIMIT');
      INSERT INTO arcane_chat_messages(game_id,environment,channel_id,sender_id,text,created_at) VALUES(g,e,c,own_id,p->>'text',stamp) RETURNING id INTO num;
      RETURN jsonb_build_object('message',jsonb_build_object('id',num::text,'channelId',c,'gameUserId',own_id,'displayName',usr.profile->>'displayName','text',p->>'text','createdAt',stamp));
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',q.id::text,'channelId',q.channel_id,'gameUserId',q.sender_id,'displayName',u.profile->>'displayName','text',q.text,'createdAt',q.created_at) ORDER BY q.id),'[]'::jsonb),min(q.id)::text INTO items,next_key FROM (SELECT * FROM arcane_chat_messages WHERE game_id=g AND environment=e AND channel_id=c AND (p->>'before' IS NULL OR id<(p->>'before')::bigint) ORDER BY id DESC LIMIT lim) q JOIN arcane_users u ON u.game_id=g AND u.environment=e AND u.game_user_id=q.sender_id;
    RETURN jsonb_build_object('messages',items,'cursor',CASE WHEN jsonb_array_length(items)=lim THEN next_key ELSE NULL END);
  END IF;
  IF method LIKE 'party.%' THEN
    id:=p->>'partyId';
    IF method='party.create' THEN
      PERFORM arcane_assert(NOT EXISTS(SELECT 1 FROM arcane_party_members WHERE game_id=g AND environment=e AND game_user_id=own_id AND status='member'),9,'ALREADY_IN_PARTY');
      n:=COALESCE((rel.manifest->'party'->>'maxMembers')::integer,32);
      PERFORM arcane_assert(n BETWEEN 1 AND 10000,3,'INVALID_PARTY_MAX_MEMBERS');
      n:=COALESCE((p->>'maxMembers')::integer,n); PERFORM arcane_assert(n BETWEEN 1 AND LEAST(COALESCE((rel.manifest->'party'->>'maxMembers')::integer,32),10000),3,'INVALID_PARTY_MAX_MEMBERS');
      PERFORM arcane_assert(p->>'joinPolicy' IS NULL OR p->>'joinPolicy' IN ('invite','code'),3,'INVALID_PARTY_JOIN_POLICY');
      id:='p_'||replace(gen_random_uuid()::text,'-',''); INSERT INTO arcane_parties(game_id,environment,party_id,leader_id,created_at,max_members,join_code) VALUES(g,e,id,own_id,stamp,n,CASE WHEN p->>'joinPolicy'='code' THEN replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','') ELSE NULL END); INSERT INTO arcane_party_members VALUES(g,e,id,own_id,'member',false,stamp); RETURN jsonb_build_object('party',arcane_party_page(g,e,id,own_id,NULL,50));
    END IF;
    IF method='party.get' THEN
      IF id IS NULL THEN SELECT party_id INTO id FROM arcane_party_members WHERE game_id=g AND environment=e AND game_user_id=own_id AND status='member'; END IF;
      IF id IS NOT NULL THEN PERFORM arcane_assert(EXISTS(SELECT 1 FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND game_user_id=own_id),7,'PARTY_ACCESS_DENIED'); END IF;
      PERFORM arcane_assert(lim BETWEEN 1 AND 100,3,'INVALID_LIMIT');
      WITH page AS (SELECT party_id FROM arcane_party_members WHERE game_id=g AND environment=e AND game_user_id=own_id AND status='invited' AND (p->>'inviteCursor' IS NULL OR party_id>p->>'inviteCursor') ORDER BY party_id LIMIT lim+1), visible AS (SELECT party_id FROM page ORDER BY party_id LIMIT lim)
      SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('partyId',party_id,'party',arcane_party_summary(g,e,party_id)) ORDER BY party_id) FROM visible),'[]'::jsonb),CASE WHEN (SELECT count(*) FROM page)>lim THEN (SELECT max(party_id) FROM visible) ELSE NULL END INTO items,next_key;
      RETURN jsonb_build_object('party',arcane_party_page(g,e,id,own_id,p->>'cursor',lim),'invites',items,'inviteCursor',next_key);
    END IF;
    SELECT * INTO party FROM arcane_parties WHERE game_id=g AND environment=e AND party_id=id FOR UPDATE; PERFORM arcane_assert(FOUND,5,'PARTY_NOT_FOUND');
    IF method='party.join' THEN
      PERFORM arcane_assert(party.join_code IS NOT NULL AND party.join_code=p->>'joinCode',7,'PARTY_JOIN_DENIED');
      IF EXISTS(SELECT 1 FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND game_user_id=own_id AND status='member') THEN RETURN jsonb_build_object('party',arcane_party_page(g,e,id,own_id,NULL,50)); END IF;
      PERFORM arcane_assert((SELECT count(*) FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND status='member')<party.max_members,8,'PARTY_FULL');
      PERFORM arcane_assert(NOT EXISTS(SELECT 1 FROM arcane_party_members WHERE game_id=g AND environment=e AND game_user_id=own_id AND status='member'),9,'ALREADY_IN_PARTY');
      INSERT INTO arcane_party_members VALUES(g,e,id,own_id,'member',false,stamp) ON CONFLICT(game_id,environment,party_id,game_user_id) DO UPDATE SET status='member',ready=false,joined_at=stamp;
      RETURN jsonb_build_object('party',arcane_party_page(g,e,id,own_id,NULL,50));
    END IF;
    IF method='party.invite' THEN
      PERFORM arcane_assert(party.leader_id=own_id,7,'PARTY_LEADER_REQUIRED'); v_target_id:=p->>'gameUserId';
      PERFORM arcane_assert(EXISTS(SELECT 1 FROM arcane_relations a WHERE a.game_id=g AND a.environment=e AND a.owner_id=own_id AND a.target_id=v_target_id AND a.state='friend'),7,'FRIEND_REQUIRED');
      IF EXISTS(SELECT 1 FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND game_user_id=v_target_id) THEN RETURN jsonb_build_object('invited',true); END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('arcane-party-invites:'||g||':'||e||':'||v_target_id,0));
      PERFORM arcane_assert((SELECT count(*) FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND status='member')<party.max_members,8,'PARTY_FULL');
      PERFORM arcane_assert((SELECT count(*) FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND status='invited')<party.max_members,8,'PARTY_INVITE_LIMIT');
      PERFORM arcane_assert((SELECT count(*) FROM arcane_party_members WHERE game_id=g AND environment=e AND game_user_id=v_target_id AND status='invited')<100,8,'PLAYER_PARTY_INVITE_LIMIT');
      INSERT INTO arcane_party_members VALUES(g,e,id,v_target_id,'invited',false,stamp) ON CONFLICT DO NOTHING; RETURN jsonb_build_object('invited',true);
    END IF;
    IF method='party.accept' THEN
      PERFORM arcane_assert(EXISTS(SELECT 1 FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND game_user_id=own_id AND status='invited'),7,'PARTY_INVITATION_REQUIRED');
      PERFORM arcane_assert((SELECT count(*) FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND status='member')<party.max_members,8,'PARTY_FULL');
      PERFORM arcane_assert(NOT EXISTS(SELECT 1 FROM arcane_party_members WHERE game_id=g AND environment=e AND game_user_id=own_id AND status='member'),9,'ALREADY_IN_PARTY');
      UPDATE arcane_party_members SET status='member',joined_at=stamp,ready=false WHERE game_id=g AND environment=e AND party_id=id AND game_user_id=own_id; RETURN jsonb_build_object('party',arcane_party_page(g,e,id,own_id,NULL,50));
    END IF;
    PERFORM arcane_assert(EXISTS(SELECT 1 FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND game_user_id=own_id AND status='member'),7,'PARTY_MEMBER_REQUIRED');
    IF method='party.ready' THEN UPDATE arcane_party_members SET ready=(p->>'ready')::boolean WHERE game_id=g AND environment=e AND party_id=id AND game_user_id=own_id; RETURN jsonb_build_object('party',arcane_party_page(g,e,id,own_id,NULL,50)); END IF;
    DELETE FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND game_user_id=own_id;
    SELECT game_user_id INTO v_target_id FROM arcane_party_members WHERE game_id=g AND environment=e AND party_id=id AND status='member' ORDER BY joined_at,game_user_id LIMIT 1;
    IF v_target_id IS NULL THEN DELETE FROM arcane_parties WHERE game_id=g AND environment=e AND party_id=id; ELSIF party.leader_id=own_id THEN UPDATE arcane_parties SET leader_id=v_target_id WHERE game_id=g AND environment=e AND party_id=id; END IF;
    RETURN jsonb_build_object('left',true);
  END IF;
  IF method LIKE 'matchmaking.%' THEN
    IF p ? 'partyId' THEN PERFORM arcane_assert(false,9,'PARTY_MATCHMAKING_UNSUPPORTED'); END IF;
    def:=rel.manifest->'multiplayer'; PERFORM arcane_assert(def IS NOT NULL,9,'MULTIPLAYER_NOT_CONFIGURED');
    UPDATE arcane_queues SET status='cancelled' WHERE game_id=g AND environment=e AND status='waiting' AND created_at<stamp-600000;
    SELECT * INTO queue FROM arcane_queues WHERE game_id=g AND environment=e AND game_user_id=own_id;
    IF p ? 'queueId' THEN PERFORM arcane_assert(queue.queue_id=p->>'queueId',5,'QUEUE_NOT_FOUND'); END IF;
    IF method='matchmaking.cancel' THEN UPDATE arcane_queues SET status='cancelled' WHERE game_id=g AND environment=e AND game_user_id=own_id AND status='waiting'; GET DIAGNOSTICS n=ROW_COUNT; RETURN jsonb_build_object('cancelled',n=1); END IF;
    IF method='matchmaking.join' AND (queue.game_user_id IS NULL OR queue.status IN ('cancelled','finished')) THEN
      INSERT INTO arcane_queues(game_id,environment,game_user_id,queue_id,release_id,mode,status,created_at) VALUES(g,e,own_id,'q_'||replace(gen_random_uuid()::text,'-',''),r,COALESCE(p->>'mode','default'),'waiting',stamp) ON CONFLICT(game_id,environment,game_user_id) DO UPDATE SET queue_id=EXCLUDED.queue_id,release_id=EXCLUDED.release_id,mode=EXCLUDED.mode,status='waiting',match_run_id=NULL,created_at=stamp RETURNING * INTO queue;
    END IF;
    IF queue.game_user_id IS NULL THEN RETURN jsonb_build_object('queue',NULL); END IF;
    PERFORM arcane_assert(queue.release_id=r,9,'QUEUE_RELEASE_MISMATCH');
    IF queue.status='waiting' THEN PERFORM arcane_match_queue(g,e,r,queue.mode,def,stamp); SELECT * INTO queue FROM arcane_queues WHERE game_id=g AND environment=e AND game_user_id=own_id; END IF;
    SELECT * INTO mt FROM arcane_matches WHERE game_id=g AND environment=e AND match_run_id=queue.match_run_id;
    RETURN jsonb_build_object('queue',jsonb_build_object('queueId',queue.queue_id,'status',queue.status,'matchRunId',queue.match_run_id,'adapterId',def->>'adapter','gameUserIds',COALESCE(mt.roster,'[]'::jsonb),'releaseId',queue.release_id,'createdAt',queue.created_at));
  END IF;
  IF method='match.get' THEN
    SELECT * INTO mt FROM arcane_matches WHERE game_id=g AND environment=e AND match_run_id=p->>'matchRunId'; PERFORM arcane_assert(FOUND,5,'MATCH_NOT_FOUND');
    PERFORM arcane_assert(mt.roster ? own_id AND mt.release_id=r,7,'MATCH_ACCESS_DENIED');
    own_record:=NULL;
    IF mt.status='settled' THEN SELECT payload INTO own_record FROM arcane_settlements WHERE game_id=g AND environment=e AND match_run_id=mt.match_run_id; END IF;
    data:=NULL;
    -- Platform-owned templates have explicit public projections. Other
    -- adapters must define their own projection before exposing state.
    IF mt.adapter_id='turn-based-v1' AND mt.state IS NOT NULL THEN
      SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO data FROM jsonb_each(mt.state)
        WHERE key=ANY(ARRAY['status','stones','maxTake','turn','move','deadline','startedAt','winner','reason','finishedAt']);
      IF jsonb_typeof(mt.state->'lastMove')='object' THEN data:=data||jsonb_build_object('lastMove',jsonb_build_object('player',mt.state->'lastMove'->'player','take',mt.state->'lastMove'->'take')); END IF;
      data:=data||jsonb_build_object('players',mt.roster);
      IF mt.state->>'status'='finished' THEN data:=data||jsonb_build_object('settlement',CASE WHEN mt.status='settled' THEN 'confirmed' ELSE 'pending' END); END IF;
    END IF;
    IF mt.adapter_id='score-race-v1' AND mt.state IS NOT NULL THEN
      SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO data FROM jsonb_each(mt.state)
        WHERE key=ANY(ARRAY['status','scores','targetScore','deadline','startedAt','winner','reason','finishedAt']);
      data:=data||jsonb_build_object('players',mt.roster,'settlement',CASE WHEN mt.status='settled' THEN 'confirmed' ELSE 'pending' END);
    END IF;
    RETURN jsonb_build_object('matchRunId',mt.match_run_id,'adapterId',mt.adapter_id,'gameUserIds',mt.roster,'status',mt.status,'releaseId',mt.release_id,'createdAt',mt.created_at,'config',mt.config,'result',own_record,'state',data);
  END IF;
  IF method='economy.get' THEN SELECT * INTO wallet FROM arcane_wallets WHERE game_id=g AND environment=e AND game_user_id=own_id; RETURN jsonb_build_object('currencies',jsonb_build_object('coins',wallet.coins),'version',wallet.version); END IF;
  IF method='achievements.list' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',q.id,'name',q.definition->>'name','event',q.definition->>'event','target',(q.definition->>'target')::bigint,'count',q.count,'completed',q.earned_at IS NOT NULL,'claimed',q.claimed_at IS NOT NULL,'reward',q.definition->'reward') ORDER BY q.id),'[]'::jsonb) INTO items FROM (SELECT d.key AS id,CASE WHEN a.earned_at IS NOT NULL THEN a.definition ELSE d.value END AS definition,COALESCE(a.count,0) AS count,a.earned_at,a.claimed_at FROM jsonb_each(COALESCE(rel.manifest->'achievements','{}'::jsonb)) d LEFT JOIN arcane_achievements a ON a.game_id=g AND a.environment=e AND a.game_user_id=own_id AND a.achievement_id=d.key UNION ALL SELECT a.achievement_id,a.definition,a.count,a.earned_at,a.claimed_at FROM arcane_achievements a WHERE a.game_id=g AND a.environment=e AND a.game_user_id=own_id AND a.earned_at IS NOT NULL AND NOT COALESCE(rel.manifest->'achievements','{}'::jsonb) ? a.achievement_id) q;
    RETURN jsonb_build_object('achievements',items);
  END IF;
  IF method='achievements.claim' THEN
    id:=p->>'achievementId'; SELECT * INTO ach FROM arcane_achievements WHERE game_id=g AND environment=e AND game_user_id=own_id AND achievement_id=id FOR UPDATE;
    PERFORM arcane_assert(FOUND AND ach.earned_at IS NOT NULL,9,'ACHIEVEMENT_NOT_COMPLETED');
    IF ach.claimed_at IS NULL THEN
      num:=COALESCE((ach.definition->'reward'->>'coins')::bigint,0);
      INSERT INTO arcane_currency_ledger VALUES(g,e,own_id,'achievement:'||id,num,stamp);
      UPDATE arcane_wallets SET coins=coins+num,version=version+1 WHERE game_id=g AND environment=e AND game_user_id=own_id;
      UPDATE arcane_achievements SET claimed_at=stamp WHERE game_id=g AND environment=e AND game_user_id=own_id AND achievement_id=id;
    END IF;
    SELECT * INTO wallet FROM arcane_wallets WHERE game_id=g AND environment=e AND game_user_id=own_id;
    RETURN jsonb_build_object('claimed',true,'duplicate',ach.claimed_at IS NOT NULL,'reward',ach.definition->'reward','balance',wallet.coins);
  END IF;
  IF method='tournaments.list' THEN
    SELECT COALESCE(jsonb_agg(d.value||jsonb_build_object('id',d.key,'joined',EXISTS(SELECT 1 FROM arcane_tournament_entries WHERE game_id=g AND environment=e AND tournament_id=d.key AND game_user_id=own_id),'status',CASE WHEN stamp<(d.value->>'startAt')::bigint THEN 'upcoming' WHEN stamp>(d.value->>'endAt')::bigint THEN 'finished' ELSE 'active' END) ORDER BY d.key),'[]'::jsonb) INTO items FROM jsonb_each(COALESCE(rel.manifest->'tournaments','{}'::jsonb)) d; RETURN jsonb_build_object('tournaments',items);
  END IF;
  IF method LIKE 'tournaments.%' THEN
    id:=p->>'tournamentId'; def:=rel.manifest->'tournaments'->id; PERFORM arcane_assert(def IS NOT NULL,5,'TOURNAMENT_NOT_FOUND');
    IF method='tournaments.join' THEN
      PERFORM arcane_assert(stamp>=(def->>'startAt')::bigint AND stamp<=(def->>'endAt')::bigint,9,'TOURNAMENT_NOT_ACTIVE');
      INSERT INTO arcane_tournament_entries VALUES(g,e,id,own_id,stamp) ON CONFLICT DO NOTHING; GET DIAGNOSTICS n=ROW_COUNT; RETURN jsonb_build_object('joined',true,'duplicate',n=0);
    END IF;
    p:=p||jsonb_build_object('leaderboardId',def->>'leaderboardId');
  END IF;
  IF method='leaderboards.list' OR method='tournaments.standings' THEN
    c:=p->>'leaderboardId'; def:=rel.manifest->'leaderboards'->c; PERFORM arcane_assert(def IS NOT NULL,5,'LEADERBOARD_NOT_FOUND'); descending:=def->>'sort'='descending'; v_period_key:=arcane_period(stamp,def->>'period');
    WITH source AS (SELECT game_user_id,score FROM arcane_board_records WHERE game_id=g AND environment=e AND board_id=c AND arcane_board_records.period_key=v_period_key AND method='leaderboards.list' UNION ALL SELECT game_user_id,score FROM arcane_tournament_scores WHERE game_id=g AND environment=e AND tournament_id=id AND method='tournaments.standings'), ranked AS (SELECT s.game_user_id,s.score,row_number() OVER(ORDER BY CASE WHEN descending THEN -s.score ELSE s.score END,s.game_user_id) AS rank,u.profile->>'displayName' AS name FROM source s JOIN arcane_users u ON u.game_id=g AND u.environment=e AND u.game_user_id=s.game_user_id) SELECT (SELECT COALESCE(jsonb_agg(jsonb_build_object('gameUserId',z.game_user_id,'displayName',z.name,'score',z.score,'rank',z.rank) ORDER BY z.rank),'[]'::jsonb) FROM (SELECT * FROM ranked ORDER BY rank LIMIT lim OFFSET off) z),(SELECT jsonb_build_object('gameUserId',z.game_user_id,'displayName',z.name,'score',z.score,'rank',z.rank) FROM ranked z WHERE z.game_user_id=own_id),(SELECT count(*) FROM ranked) INTO items,own_record,num;
    RETURN jsonb_build_object('leaderboardId',c,'period',v_period_key,'records',items,'ownRecord',own_record,'total',num);
  END IF;
  PERFORM arcane_assert(false,3,'METHOD_NOT_IMPLEMENTED'); RETURN NULL;
END $$;

-- Calling the inner function in this exception block creates a PostgreSQL
-- subtransaction: any invariant failure rolls back ALL mutations in that RPC.
CREATE OR REPLACE FUNCTION arcane_execute(g TEXT,e TEXT,r TEXT,platform_id TEXT,method TEXT,p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE result JSONB; msg TEXT;
BEGIN
  result:=arcane_execute_inner(g,e,r,platform_id,method,p); RETURN result;
EXCEPTION WHEN OTHERS THEN
  msg:=SQLERRM;
  IF left(msg,7)='ARCANE:' THEN RETURN jsonb_build_object('_error',jsonb_build_object('code',split_part(msg,':',2)::integer,'message',split_part(msg,':',3))); END IF;
  IF SQLSTATE IN ('23505','40001','40P01') THEN RETURN jsonb_build_object('_error',jsonb_build_object('code',6,'message','CONCURRENT_OPERATION_RETRY')); END IF;
  RAISE WARNING 'Arcane database operation failed: % %',SQLSTATE,msg;
  RETURN jsonb_build_object('_error',jsonb_build_object('code',13,'message','DATABASE_OPERATION_FAILED'));
END $$;

INSERT INTO arcane_schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
