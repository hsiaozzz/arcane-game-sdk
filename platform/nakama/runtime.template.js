/* Arcane platform, Nakama OSS 3.41+. ES5 only; generated index.js includes the
 * SQL migration verbatim. Runtime secrets and internal user IDs are server-only. */
var ARCANE_MIGRATION = "__ARCANE_MIGRATION__";
var ARCANE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var ARCANE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
var ARCANE_USER = /^gusr_[0-9a-f]{32}$/;
var ARCANE_CAPS = ["profile","storage","friends","chat","party","matchmaking","match","leaderboards","achievements","economy","tournaments"];
var ARCANE_PUBLIC = ["context.get","profile.get","profile.update","storage.read","storage.write","storage.delete","storage.list","friends.list","friends.request","friends.accept","friends.remove","friends.block","chat.channels","chat.history","chat.send","party.create","party.get","party.invite","party.accept","party.join","party.leave","party.ready","matchmaking.join","matchmaking.status","matchmaking.cancel","match.get","leaderboards.list","achievements.list","achievements.claim","economy.get","tournaments.list","tournaments.join","tournaments.standings"];
var ARCANE_ADMIN = ["admin.registerGame","admin.activateGame","admin.getGame","admin.registerMatch","admin.settleMatch","admin.createSession","admin.getSession","admin.revokeSession","admin.getMatch","admin.saveMatchState","admin.pendingMatches","admin.activeMatches","admin.consumeMatchTicket","admin.consumeAdmissionTicket"];

function arcaneFail(message, code) { throw {message:message,code:code||3}; }
function arcaneObject(value, label) { if (!value || typeof value!=="object" || Array.isArray(value)) arcaneFail("INVALID_"+label); return value; }
function arcaneString(value, min, max, label) { if (typeof value!=="string" || value.length<min || value.length>max || /[\x00-\x1f\x7f]/.test(value)) arcaneFail("INVALID_"+label); return value; }
function arcaneId(value,label) { if (typeof value!=="string" || !ARCANE_ID.test(value)) arcaneFail("INVALID_"+label); return value; }
function arcaneGameUser(value) { if (typeof value!=="string" || !ARCANE_USER.test(value)) arcaneFail("INVALID_GAME_USER_ID"); return value; }
function arcaneInt(value,min,max,label) { if (typeof value!=="number" || !isFinite(value) || Math.floor(value)!==value || value<min || value>max) arcaneFail("INVALID_"+label); return value; }
function arcaneHas(list,value) { return list.indexOf(value)!==-1; }
function arcaneBytes(value) {
  var text=typeof value==="string"?value:JSON.stringify(value),n=0,i,c;
  for(i=0;i<text.length;i++){c=text.charCodeAt(i);if(c<128)n++;else if(c<2048)n+=2;else if(c>=55296&&c<=56319&&i+1<text.length&&text.charCodeAt(i+1)>=56320&&text.charCodeAt(i+1)<=57343){n+=4;i++;}else n+=3;}
  return n;
}
function arcaneBound(value,limit,label) { if(arcaneBytes(value)>limit)arcaneFail(label+"_TOO_LARGE",8); }
function arcaneOnly(value,keys) { var names=Object.keys(value);for(var i=0;i<names.length;i++)if(!arcaneHas(keys,names[i]))arcaneFail("UNKNOWN_FIELD_"+names[i]); }
function arcaneSecretEqual(a,b) {
  /* No early prefix exit. JavaScript/Goja does not promise strict timing, so
   * this is best-effort constant-work comparison, not a crypto primitive. */
  if(typeof a!=="string"||typeof b!=="string"||a.length>256||b.length>256)return false;
  var diff=a.length^b.length;for(var i=0;i<256;i++)diff|=(i<a.length?a.charCodeAt(i):0)^(i<b.length?b.charCodeAt(i):0);return diff===0;
}
function arcaneAdapters(ctx) {
  var raw=(ctx.env&&ctx.env.ARCANE_ADAPTER_IDS)||"turn-based-v1,score-race-v1,robo-rumble-authoritative-v1";
  return raw.split(",").map(function(x){return x.replace(/^\s+|\s+$/g,"");}).filter(function(x){return !!x;});
}
function arcaneAdapter(ctx,id) {arcaneId(id,"ADAPTER_ID");if(!arcaneHas(arcaneAdapters(ctx),id))arcaneFail("ADAPTER_NOT_TRUSTED",7);return id;}
function arcaneManifest(ctx,m) {
  arcaneObject(m,"MANIFEST");arcaneBound(m,32768,"MANIFEST");
  if(m.schemaVersion!=="1.0"||m.sdkVersion!=="0.1")arcaneFail("UNSUPPORTED_MANIFEST_VERSION");
  if(!Array.isArray(m.capabilities)||m.capabilities.length>ARCANE_CAPS.length)arcaneFail("INVALID_CAPABILITIES");
  var seen={},i,key,def,keys;
  for(i=0;i<m.capabilities.length;i++){key=m.capabilities[i];if(!arcaneHas(ARCANE_CAPS,key)||seen[key])arcaneFail("INVALID_CAPABILITIES");seen[key]=true;}
  if(m.party!==undefined){arcaneObject(m.party,"PARTY_CONFIG");arcaneOnly(m.party,["maxMembers"]);arcaneInt(m.party.maxMembers,1,10000,"PARTY_MAX_MEMBERS");}
  if(m.multiplayer!==undefined){
    arcaneObject(m.multiplayer,"MULTIPLAYER");arcaneOnly(m.multiplayer,["adapter","minPlayers","maxPlayers","endpoint"]);arcaneAdapter(ctx,m.multiplayer.adapter);
    arcaneInt(m.multiplayer.minPlayers,2,100,"MIN_PLAYERS");arcaneInt(m.multiplayer.maxPlayers,m.multiplayer.minPlayers,100,"MAX_PLAYERS");
    if(m.multiplayer.adapter==="turn-based-v1"&&(m.multiplayer.minPlayers!==2||m.multiplayer.maxPlayers!==2))arcaneFail("TURN_ADAPTER_REQUIRES_TWO_PLAYERS");
    if(m.multiplayer.adapter==="robo-rumble-authoritative-v1"&&m.multiplayer.maxPlayers>12)arcaneFail("ROBO_ADAPTER_PLAYER_LIMIT");
    if(m.multiplayer.endpoint!==undefined&&(typeof m.multiplayer.endpoint!=="string"||!/^\/[A-Za-z0-9/_-]{0,127}$/.test(m.multiplayer.endpoint)))arcaneFail("UNTRUSTED_MULTIPLAYER_ENDPOINT",7);
  }
  if(arcaneHas(m.capabilities,"matchmaking")&&!m.multiplayer)arcaneFail("MULTIPLAYER_REQUIRED");
  var maps=["leaderboards","achievements","tournaments"];
  for(i=0;i<maps.length;i++){key=maps[i];if(m[key]===undefined)continue;arcaneObject(m[key],key.toUpperCase());if(Object.keys(m[key]).length>100)arcaneFail("DEFINITION_LIMIT",8);}
  keys=Object.keys(m.leaderboards||{});
  for(i=0;i<keys.length;i++){key=arcaneId(keys[i],"LEADERBOARD_ID");def=arcaneObject(m.leaderboards[key],"LEADERBOARD");arcaneOnly(def,["sort","period","writePolicy","metric","operator"]);if(!arcaneHas(["ascending","descending"],def.sort)||!arcaneHas(["all_time","daily","weekly"],def.period)||def.writePolicy!=="verified_match_result"||!arcaneHas(["points","wins","score"],def.metric)||!arcaneHas(["sum","best"],def.operator))arcaneFail("INVALID_LEADERBOARD_DEFINITION");}
  keys=Object.keys(m.achievements||{});
  for(i=0;i<keys.length;i++){key=arcaneId(keys[i],"ACHIEVEMENT_ID");def=arcaneObject(m.achievements[key],"ACHIEVEMENT");arcaneOnly(def,["name","event","target","reward"]);arcaneString(def.name,1,80,"ACHIEVEMENT_NAME");if(!arcaneHas(["match.won","match.played"],def.event))arcaneFail("INVALID_ACHIEVEMENT_EVENT");arcaneInt(def.target,1,1000000000,"ACHIEVEMENT_TARGET");arcaneObject(def.reward,"ACHIEVEMENT_REWARD");arcaneOnly(def.reward,["coins"]);arcaneInt(def.reward.coins,0,1000000000,"REWARD_COINS");}
  keys=Object.keys(m.tournaments||{});
  for(i=0;i<keys.length;i++){key=arcaneId(keys[i],"TOURNAMENT_ID");def=arcaneObject(m.tournaments[key],"TOURNAMENT");arcaneOnly(def,["name","startAt","endAt","leaderboardId"]);arcaneString(def.name,1,80,"TOURNAMENT_NAME");arcaneInt(def.startAt,0,8640000000000000,"TOURNAMENT_START");arcaneInt(def.endAt,def.startAt+1,8640000000000000,"TOURNAMENT_END");if(!Object.prototype.hasOwnProperty.call(m.leaderboards||{},def.leaderboardId))arcaneFail("TOURNAMENT_LEADERBOARD_NOT_CONFIGURED");}
  return m;
}
function arcaneRelease(nk,g,e,r) {
  var rows=nk.sqlQuery("SELECT r.manifest::text AS manifest,r.active,g.enabled FROM arcane_releases r JOIN arcane_games g ON g.game_id=r.game_id AND g.environment=r.environment WHERE r.game_id=$1 AND r.environment=$2 AND r.release_id=$3",[g,e,r]);
  if(!rows.length)arcaneFail("RELEASE_NOT_REGISTERED",5);if(!rows[0].enabled)arcaneFail("GAME_DISABLED",7);
  if(!rows[0].active)arcaneFail("RELEASE_NOT_ACTIVE",7);
  var manifest=rows[0].manifest;return typeof manifest==="string"?JSON.parse(manifest):manifest;
}
function arcaneParams(method,p) {
  if(p.limit!==undefined)arcaneInt(p.limit,1,arcaneHas(["admin.pendingMatches","admin.activeMatches","party.get"],method)?100:50,"LIMIT");
  if(method==="admin.activeMatches"&&p.after!==undefined){
    arcaneString(p.after,1,512,"MATCH_CURSOR");var cursor;try{cursor=JSON.parse(p.after);}catch(cursorError){arcaneFail("INVALID_MATCH_CURSOR");}
    if(!Array.isArray(cursor)||cursor.length!==4)arcaneFail("INVALID_MATCH_CURSOR");
    arcaneInt(cursor[0],0,9007199254740991,"MATCH_CURSOR");arcaneId(cursor[1],"MATCH_CURSOR");arcaneId(cursor[2],"MATCH_CURSOR");arcaneId(cursor[3],"MATCH_CURSOR");
  }
  if(p.offset!==undefined)arcaneInt(p.offset,0,1000,"OFFSET");
  if(p.gameUserId!==undefined)arcaneGameUser(p.gameUserId);
  if(method==="profile.update"){
    arcaneOnly(p,["displayName","avatar","metadata","expectedVersion"]);arcaneInt(p.expectedVersion,1,2147483646,"EXPECTED_VERSION");
    if(p.displayName!==undefined){arcaneString(p.displayName,1,32,"DISPLAY_NAME");p.displayName=p.displayName.replace(/^\s+|\s+$/g,"");if(!p.displayName)arcaneFail("INVALID_DISPLAY_NAME");}
    if(p.avatar!==undefined){arcaneString(p.avatar,0,2048,"AVATAR");if(p.avatar&&!/^(https:\/\/|\/(?!\/))/.test(p.avatar))arcaneFail("INVALID_AVATAR");}
    if(p.metadata!==undefined){arcaneObject(p.metadata,"METADATA");arcaneBound(p.metadata,4096,"PROFILE_METADATA");}
  }
  if(method.indexOf("storage.")===0){
    p.collection=arcaneId(p.collection===undefined?"default":p.collection,"COLLECTION");
    if(method!=="storage.list")arcaneId(p.key,"SAVE_KEY");
    if(p.cursor!==undefined)arcaneId(p.cursor,"CURSOR");
    if(method==="storage.write"||method==="storage.delete")arcaneInt(p.expectedVersion,0,2147483646,"EXPECTED_VERSION");
    if(method==="storage.write"){if(p.value===undefined)arcaneFail("SAVE_VALUE_REQUIRED");arcaneBound(p.value,16384,"SAVE_VALUE");}
  }
  if(method.indexOf("friends.")===0&&method!=="friends.list")arcaneGameUser(p.gameUserId);
  if(method==="chat.send"||method==="chat.history"){
    arcaneString(p.channelId,1,160,"CHANNEL_ID");
    if(p.before!==undefined&&(typeof p.before!=="string"||!/^\d{1,18}$/.test(p.before)))arcaneFail("INVALID_MESSAGE_CURSOR");
    if(method==="chat.send"){arcaneString(p.text,1,280,"CHAT_TEXT");p.text=p.text.replace(/^\s+|\s+$/g,"");if(!p.text)arcaneFail("INVALID_CHAT_TEXT");}
  }
  if(method.indexOf("party.")===0&&method!=="party.create"&&!(method==="party.get"&&p.partyId===undefined))arcaneId(p.partyId,"PARTY_ID");
  if(method==="party.create"){arcaneOnly(p,["maxMembers","joinPolicy"]);if(p.maxMembers!==undefined)arcaneInt(p.maxMembers,1,10000,"PARTY_MAX_MEMBERS");if(p.joinPolicy!==undefined&&!arcaneHas(["invite","code"],p.joinPolicy))arcaneFail("INVALID_PARTY_JOIN_POLICY");}
  if(method==="party.join"){arcaneOnly(p,["partyId","joinCode"]);if(typeof p.joinCode!=="string"||!/^([0-9a-f]{64})$/.test(p.joinCode))arcaneFail("INVALID_PARTY_JOIN_CODE");}
  if(method==="party.get"){arcaneOnly(p,["partyId","cursor","limit","inviteCursor"]);if(p.cursor!==undefined)arcaneGameUser(p.cursor);if(p.inviteCursor!==undefined)arcaneId(p.inviteCursor,"PARTY_INVITE_CURSOR");}
  if(method==="party.invite")arcaneGameUser(p.gameUserId);
  if(method==="party.ready"&&typeof p.ready!=="boolean")arcaneFail("INVALID_READY");
  if(method.indexOf("matchmaking.")===0){if(p.partyId!==undefined)arcaneFail("PARTY_MATCHMAKING_UNSUPPORTED",9);if(p.mode!==undefined&&p.mode!=="default")arcaneFail("UNSUPPORTED_MATCHMAKING_MODE");if(p.queueId!==undefined)arcaneId(p.queueId,"QUEUE_ID");}
  if(method==="leaderboards.list")arcaneId(p.leaderboardId,"LEADERBOARD_ID");
  if(method==="achievements.claim")arcaneId(p.achievementId,"ACHIEVEMENT_ID");
  if(method==="tournaments.join"||method==="tournaments.standings")arcaneId(p.tournamentId,"TOURNAMENT_ID");
  if(method==="match.get"||method==="admin.registerMatch"||method==="admin.settleMatch"||method==="admin.getMatch"||method==="admin.saveMatchState"||method==="admin.consumeMatchTicket")arcaneId(p.matchRunId,"MATCH_RUN_ID");
  if(method==="admin.registerMatch"){
    if(!Array.isArray(p.gameUserIds)||p.gameUserIds.length<2||p.gameUserIds.length>100)arcaneFail("INVALID_MATCH_ROSTER");
    var seen={};for(var i=0;i<p.gameUserIds.length;i++){arcaneGameUser(p.gameUserIds[i]);if(seen[p.gameUserIds[i]])arcaneFail("DUPLICATE_MATCH_PLAYER");seen[p.gameUserIds[i]]=true;}
    if(p.mode!==undefined)arcaneId(p.mode,"MATCH_MODE");
  }
  if(method==="admin.settleMatch"){
    if(!arcaneHas(["finished","abandoned"],p.reason)||!Array.isArray(p.results)||p.results.length<2||p.results.length>100)arcaneFail("INVALID_MATCH_RESULTS");
    for(var j=0;j<p.results.length;j++){var result=arcaneObject(p.results[j],"MATCH_RESULT");arcaneOnly(result,["gameUserId","rank","score","points","won"]);arcaneGameUser(result.gameUserId);arcaneInt(result.score,0,1000000000,"MATCH_SCORE");arcaneInt(result.points,0,1000000000,"MATCH_POINTS");if(result.won!==undefined&&typeof result.won!=="boolean")arcaneFail("INVALID_WON_FLAG");if(p.reason==="finished")arcaneInt(result.rank,1,100,"MATCH_RANK");else if(result.rank!==undefined&&result.rank!==null)arcaneFail("ABANDONED_RANK_MUST_BE_NULL");}
    if(p.finishedAt!==undefined)arcaneInt(p.finishedAt,0,Date.now()+30000,"FINISHED_AT");
  }
  if(method==="admin.saveMatchState"){arcaneInt(p.expectedVersion,0,2147483646,"EXPECTED_VERSION");arcaneObject(p.state,"MATCH_STATE");arcaneBound(p.state,32768,"MATCH_STATE");}
  if(method==="admin.consumeMatchTicket"||method==="admin.consumeAdmissionTicket"){arcaneString(p.nonce,16,128,"TICKET_NONCE");arcaneGameUser(p.gameUserId);arcaneInt(p.expiresAt,0,Date.now()+60000,"TICKET_EXPIRY");}
  if(method==="admin.createSession"||method==="admin.getSession"||method==="admin.revokeSession")arcaneString(p.sessionId,16,128,"SESSION_ID");
  if(method==="admin.createSession"){if(!ARCANE_UUID.test(p.platformUserId||""))arcaneFail("INVALID_PLATFORM_USER_ID");arcaneInt(p.expiresAt,0,Date.now()+2592000000,"SESSION_EXPIRY");}
  return p;
}
function arcaneDispatch(ctx,logger,nk,payload) {
  if(ctx.userId)arcaneFail("SERVER_ONLY_RPC",7);
  if(typeof payload!=="string")arcaneFail("JSON_PAYLOAD_REQUIRED");arcaneBound(payload,131072,"REQUEST");
  var data;try{data=JSON.parse(payload);}catch(e){arcaneFail("INVALID_JSON");}arcaneObject(data,"REQUEST");
  var method=data.method;if(!arcaneHas(ARCANE_PUBLIC,method)&&!arcaneHas(ARCANE_ADMIN,method))arcaneFail("UNKNOWN_METHOD");
  var admin=method.indexOf("admin.")===0,env=ctx.env||{},expected=env[admin?"ARCANE_ADMIN_KEY":"ARCANE_GATEWAY_KEY"];
  if(typeof expected!=="string"||expected.length<32||env.ARCANE_ADMIN_KEY===env.ARCANE_GATEWAY_KEY||!arcaneSecretEqual(data.gatewayKey,expected))arcaneFail("INVALID_GATEWAY_CREDENTIAL",7);
  var p=arcaneParams(method,arcaneObject(data.params===undefined?{}:data.params,"PARAMS")),g="",e="",r="",platformId="",manifest;
  var globalAdmin=admin&&arcaneHas(["admin.createSession","admin.getSession","admin.revokeSession","admin.pendingMatches","admin.activeMatches"],method);
  if(!globalAdmin){
    var context=admin?p:arcaneObject(data.context,"CONTEXT");g=arcaneId(context.gameId,"GAME_ID");e=arcaneId(context.environment,"ENVIRONMENT");
    if(context.releaseId!==undefined)r=arcaneId(context.releaseId,"RELEASE_ID");
    if(!admin&&!r)arcaneFail("RELEASE_ID_REQUIRED");
  }
  if(admin){
    if(method==="admin.registerGame"){
      arcaneId(p.releaseId,"RELEASE_ID");arcaneString(p.publisherId,1,128,"PUBLISHER_ID");arcaneString(p.buildHash,1,128,"BUILD_HASH");arcaneManifest(ctx,p.manifest);
      if(p.entryUrl!==undefined){arcaneString(p.entryUrl,1,2048,"ENTRY_URL");if(!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9_./%~-]*)?$/.test(p.entryUrl))arcaneFail("INVALID_ENTRY_URL");}
      if(p.activate!==undefined&&typeof p.activate!=="boolean")arcaneFail("INVALID_ACTIVATE");
    }
    if(method==="admin.activateGame"){arcaneId(p.releaseId,"RELEASE_ID");arcaneString(p.buildHash,1,128,"BUILD_HASH");}
    if(arcaneHas(["admin.registerMatch","admin.settleMatch","admin.saveMatchState","admin.pendingMatches","admin.activeMatches","admin.consumeMatchTicket","admin.consumeAdmissionTicket"],method))arcaneAdapter(ctx,p.adapterId);
    if(method==="admin.registerMatch"){
      manifest=arcaneRelease(nk,g,e,r);if(!manifest.multiplayer||manifest.multiplayer.adapter!==p.adapterId)arcaneFail("ADAPTER_MISMATCH",7);
      if(p.gameUserIds.length<manifest.multiplayer.minPlayers||p.gameUserIds.length>manifest.multiplayer.maxPlayers)arcaneFail("INVALID_MATCH_ROSTER_SIZE");
    }
    if(arcaneHas(["admin.saveMatchState","admin.consumeMatchTicket","admin.consumeAdmissionTicket"],method))arcaneId(p.releaseId,"RELEASE_ID");
  }else{
    manifest=arcaneRelease(nk,g,e,r);arcaneManifest(ctx,manifest);
    var cap=method.split(".")[0];if(method!=="context.get"&&!arcaneHas(manifest.capabilities,cap)&&!(cap==="match"&&arcaneHas(manifest.capabilities,"matchmaking")))arcaneFail("CAPABILITY_DISABLED",7);
    platformId=data.context.platformUserId;if(typeof platformId!=="string"||!ARCANE_UUID.test(platformId))arcaneFail("INVALID_PLATFORM_USER_ID",16);platformId=platformId.toLowerCase();
    var users=nk.usersGetId([platformId]);if(!users||users.length!==1)arcaneFail("PLATFORM_USER_NOT_FOUND",16);
  }
  var rows=nk.sqlQuery("SELECT arcane_execute($1,$2,$3,$4,$5,$6::jsonb)::text AS result",[g,e,r,platformId,method,JSON.stringify(p)]);
  if(!rows.length)arcaneFail("DATABASE_RESULT_MISSING",13);var value=rows[0].result;if(typeof value==="string")value=JSON.parse(value);
  if(value&&value._error)arcaneFail(value._error.message,value._error.code);
  return JSON.stringify(value);
}
function InitModule(ctx,logger,nk,initializer) {
  var env=ctx.env||{};
  if(!env.ARCANE_GATEWAY_KEY||env.ARCANE_GATEWAY_KEY.length<32||!env.ARCANE_ADMIN_KEY||env.ARCANE_ADMIN_KEY.length<32||env.ARCANE_GATEWAY_KEY===env.ARCANE_ADMIN_KEY)throw Error("Distinct ARCANE_GATEWAY_KEY and ARCANE_ADMIN_KEY of at least 32 characters are required");
  /* One exec is one connection: the explicit transaction never leaks into
   * another request. Advisory lock also serializes concurrent server startup. */
  nk.sqlExec("BEGIN; SELECT pg_advisory_xact_lock(6040827001); "+ARCANE_MIGRATION+" COMMIT;",[]);
  initializer.registerRpc("arcane_dispatch",arcaneDispatch);
  logger.info("Arcane OSS platform runtime ready (schema 1)");
}
