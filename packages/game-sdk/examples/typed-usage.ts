import {
  ArcaneGame,
  createMatchConnection,
  type LeaderboardRecord,
  type StorageItem,
} from "../index.js";

type Progress = { level: number; unlocked: string[] };

/** Persist your own JSON schema with an explicit version check. */
export async function saveProgress(game: ArcaneGame): Promise<StorageItem<Progress>> {
  const saved = await game.storage.read<Progress>({ key: "progress" });
  const progress: Progress = "item" in saved
    ? { level: 1, unlocked: [] }
    : { ...saved.value, level: saved.value.level + 1 };
  return game.storage.write({
    key: "progress",
    value: progress,
    expectedVersion: "item" in saved ? 0 : saved.version,
  });
}

/** Profile, social and ranking fields retain their actual result types. */
export async function readCommunity(game: ArcaneGame) {
  const context = await game.context.get();
  const profile = await game.profile.get();
  const updated = await game.profile.update({
    displayName: "拖把成精",
    metadata: { favoriteRobot: "sweeper" },
    expectedVersion: profile.version,
  });
  const relations = await game.friends.list();
  const channels = await game.chat.channels();
  const dm = channels.channels.find(channel => channel.type === "dm");
  if (dm?.type === "dm") {
    await game.profile.get({ gameUserId: dm.gameUserId });
    const history = await game.chat.history({ channelId: dm.channelId, limit: 20 });
    if (history.cursor) {
      await game.chat.history({ channelId: dm.channelId, before: history.cursor });
    }
  }
  const party = await game.party.get();
  if (party.party) {
    await game.party.ready({ partyId: party.party.partyId, ready: true });
    if (party.party.cursor) {
      await game.party.get({ partyId: party.party.partyId, cursor: party.party.cursor, limit: 100 });
    }
  }
  const board = await game.leaderboards.list({ leaderboardId: "wins", limit: 10 });
  const ownRank: number | null = board.ownRecord?.rank ?? null;
  const records: LeaderboardRecord[] = board.records;
  const wallet = await game.economy.get();
  const achievements = await game.achievements.list();
  const tournaments = await game.tournaments.list();
  const active = tournaments.tournaments.find(event => event.status === "active");
  if (active) {
    const joined = await game.tournaments.join({ tournamentId: active.id });
    const standings = await game.tournaments.standings({ tournamentId: active.id });
    console.log(joined.duplicate, standings.ownRecord?.score);
  }
  await game.social.open({ tab: "account" });
  return { context, updated, relations, ownRank, records, coins: wallet.currencies.coins, achievements };
}

/** The trusted release enables up to 10,000 social members; this team chooses 128. */
export async function createConfiguredTeam(leader: ArcaneGame, joiningPlayer: ArcaneGame) {
  const { party } = await leader.party.create({ maxMembers: 128, joinPolicy: "code" });
  if (!party.joinCode) throw new Error("Leader did not receive an invitation code");
  await joiningPlayer.party.join({ partyId: party.partyId, joinCode: party.joinCode });
  let page = (await joiningPlayer.party.get({ partyId: party.partyId, limit: 100 })).party;
  const members = [];
  while (page) {
    members.push(...page.members);
    if (!page.cursor) break;
    page = (await joiningPlayer.party.get({ partyId: party.partyId, limit: 100, cursor: page.cursor })).party;
  }
  // Use memberCount for the whole team; self is independent of the current page.
  const ownReady = page?.self?.ready ?? false;
  return { members, ownReady, memberCount: page?.memberCount ?? 0 };
}

/** Queueing and final results use opaque IDs, including after settlement. */
export async function joinTurnMatch(game: ArcaneGame) {
  const queued = await game.matchmaking.join({ mode: "default" });
  if (!queued.queue) return;
  const polled = await game.matchmaking.status({ queueId: queued.queue.queueId });
  if (polled.queue?.status !== "matched" || !polled.queue.matchRunId) return;
  const matchRunId = polled.queue.matchRunId;
  const match = await game.match.get({ matchRunId });
  if (match.result) {
    const profile = await game.profile.get();
    const ownResult = match.result.results.find(result => result.gameUserId === profile.gameUserId);
    // Abandoned matches have null rank; pending matches have no result.
    console.log(ownResult?.rank, match.result.reason);
    return;
  }
  const ticket = await game.match.ticket({ matchRunId });
  const connection = createMatchConnection(ticket, {
    maxReconnectAttempts: 2,
    refreshTicket: ({ signal }) => game.match.ticket({ matchRunId }, { signal }),
  });
  await connection.ready;
  return connection;
}

/** These examples must fail to type-check; no network calls are executed. */
function invalidCalls(game: ArcaneGame) {
  // @ts-expect-error profile mutations require a compare-and-swap version
  game.profile.update({ displayName: "Player" });
  // @ts-expect-error a caller cannot override a profile result with an arbitrary generic
  game.profile.get<{ coins: number }>();
  // @ts-expect-error storage mutations require a numeric version, including first create
  game.storage.write({ key: "progress", value: { level: 1 }, expectedVersion: null });
  // @ts-expect-error functions are not JSON save values
  game.storage.write({ key: "progress", value: { level: () => 1 }, expectedVersion: 0 });
  // @ts-expect-error missing required target player
  game.friends.request({ displayName: "Player" });
  // @ts-expect-error decimal message cursors are strings, not numbers
  game.chat.history({ channelId: "global", before: 123 });
  // @ts-expect-error ready must be an explicit boolean
  game.party.ready({ partyId: "party" });
  // @ts-expect-error code admission requires the shared code
  game.party.join({ partyId: "party" });
  // @ts-expect-error join policy is an explicit supported value
  game.party.create({ maxMembers: 128, joinPolicy: "public" });
  // @ts-expect-error party matchmaking is not implemented
  game.matchmaking.join({ partyId: "party" });
  // @ts-expect-error only the default matchmaking mode is supported
  game.matchmaking.join({ mode: "ranked" });
  // @ts-expect-error a ticket requires a matchRunId or entry intent
  game.match.ticket();
  // @ts-expect-error leaderboard identifier is required
  game.leaderboards.list({ limit: 10 });
  // @ts-expect-error achievement claim requires achievementId
  game.achievements.claim({ id: "first_win" });
  // @ts-expect-error tournament APIs use tournamentId, not leaderboardId
  game.tournaments.standings({ leaderboardId: "wins" });
  // @ts-expect-error host UI selects a tab, not a view
  game.social.open({ view: "friends" });
}
void invalidCalls;
