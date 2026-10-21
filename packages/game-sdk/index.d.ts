export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface RequestOptions { timeoutMs?: number; signal?: AbortSignal }
export interface PlatformEvent { event: string; data: JsonValue }
export interface Transport {
  readonly ready?: Promise<void>;
  request(method: string, params?: JsonObject, options?: RequestOptions): Promise<unknown>;
  subscribe?(listener: (event: PlatformEvent) => void): () => void;
  close?(): void;
}
export interface HostBootstrap {
  protocol: "arcane-game-sdk";
  version: 1;
  hostOrigin: string;
  channelId: string;
}
export interface ConnectOptions extends RequestOptions {
  transport?: Transport;
  bootstrap?: HostBootstrap;
  window?: Window;
}
export class ArcaneError extends Error {
  constructor(code: string, message: string, status?: number, details?: unknown);
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
}
/** Advanced custom transports only. Built-in namespaces use the concrete contracts below. */
export type RpcMethod = <T = JsonValue>(params?: JsonObject, options?: RequestOptions) => Promise<T>;
export type EmptyParams = Record<string, never>;
export type Capability = "profile" | "storage" | "friends" | "chat" | "party" | "matchmaking" | "match" | "leaderboards" | "achievements" | "economy" | "tournaments";
/** The platform admits 2–100 players; each trusted adapter may enforce a smaller tested limit. */
export interface MultiplayerConfig { adapter: string; minPlayers: number; maxPlayers: number }
export interface PartyConfig { maxMembers: number }
export interface GameContext {
  gameId: string;
  environment: string;
  releaseId: string;
  buildHash: string;
  sdkVersion: "0.1";
  capabilities: Capability[];
  /** Opaque ID scoped to this game and environment. */
  gameUserId: string;
  party: PartyConfig;
  multiplayer: MultiplayerConfig | null;
}
export interface ContextApi {
  get(params?: EmptyParams, options?: RequestOptions): Promise<GameContext>;
}
export interface PlayerIdentity { gameUserId: string; displayName: string }
export interface PlayerProfile extends PlayerIdentity { avatar: string; metadata: JsonObject; version: number }
export interface ProfileGetParams { gameUserId?: string }
export interface ProfileUpdateParams {
  /** Current version from profile.get/update. Required for every update. */
  expectedVersion: number;
  displayName?: string;
  avatar?: string;
  metadata?: JsonObject;
}
export interface ProfileApi {
  get(params?: ProfileGetParams, options?: RequestOptions): Promise<PlayerProfile>;
  update(params: ProfileUpdateParams, options?: RequestOptions): Promise<PlayerProfile>;
}
export interface StorageKeyParams { collection?: string; key: string }
export interface StorageWriteParams<T extends JsonValue = JsonValue> extends StorageKeyParams {
  value: T;
  /** 0 creates a new item; an update requires its current version. */
  expectedVersion: number;
}
export interface StorageDeleteParams extends StorageKeyParams { expectedVersion: number }
export interface StorageListParams {
  collection?: string;
  /** Integer from 1 to 50. */
  limit?: number;
  cursor?: string;
}
export interface StorageItem<T = JsonValue> {
  collection: string;
  key: string;
  value: T;
  version: number;
  updatedAt: number;
}
export interface MissingStorageItem { item: null }
export type StorageReadResult<T = JsonValue> = StorageItem<T> | MissingStorageItem;
export interface StorageListResult<T = JsonValue> { items: StorageItem<T>[]; cursor: string | null }
export interface StorageApi {
  /** T describes your saved JSON schema; it does not validate persisted data at runtime. */
  read<T = JsonValue>(params: StorageKeyParams, options?: RequestOptions): Promise<StorageReadResult<T>>;
  write<T extends JsonValue = JsonValue>(params: StorageWriteParams<T>, options?: RequestOptions): Promise<StorageItem<T>>;
  delete(params: StorageDeleteParams, options?: RequestOptions): Promise<{ deleted: true }>;
  list<T = JsonValue>(params?: StorageListParams, options?: RequestOptions): Promise<StorageListResult<T>>;
}
export interface PlayerParams { gameUserId: string }
export interface FriendsListResult {
  friends: PlayerIdentity[];
  incoming: PlayerIdentity[];
  outgoing: PlayerIdentity[];
  blocked: PlayerIdentity[];
}
export interface FriendsApi {
  list(params?: EmptyParams, options?: RequestOptions): Promise<FriendsListResult>;
  request(params: PlayerParams, options?: RequestOptions): Promise<{ status: "requested" }>;
  accept(params: PlayerParams, options?: RequestOptions): Promise<{ status: "accepted" }>;
  remove(params: PlayerParams, options?: RequestOptions): Promise<{ removed: true }>;
  block(params: PlayerParams, options?: RequestOptions): Promise<{ blocked: true }>;
}
export type ChatChannel =
  | { channelId: string; type: "global" }
  | { channelId: string; type: "dm"; gameUserId: string }
  | { channelId: string; type: "party" };
export interface ChatMessage extends PlayerIdentity {
  /** Decimal string, retained as a string to avoid integer precision loss. */
  id: string;
  channelId: string;
  text: string;
  createdAt: number;
}
export interface ChatHistoryParams {
  channelId: string;
  /** Integer from 1 to 50. */
  limit?: number;
  /** Message ID from the previous history cursor. */
  before?: string;
}
export interface ChatSendParams { channelId: string; text: string }
export interface ChatHistoryResult { messages: ChatMessage[]; cursor: string | null }
export interface ChatApi {
  channels(params?: EmptyParams, options?: RequestOptions): Promise<{ channels: ChatChannel[] }>;
  history(params: ChatHistoryParams, options?: RequestOptions): Promise<ChatHistoryResult>;
  send(params: ChatSendParams, options?: RequestOptions): Promise<{ message: ChatMessage }>;
}
export interface PartyMember extends PlayerIdentity { ready: boolean; status: "invited" | "member" }
export type PartyJoinPolicy = "invite" | "code";
export interface PartySummary { partyId: string; leaderId: string; createdAt: number; maxMembers: number; memberCount: number; inviteCount: number; readyCount: number; joinPolicy: PartyJoinPolicy }
export interface Party extends PartySummary { members: PartyMember[]; cursor: string | null; self: PartyMember | null; /** Present only for the leader of a code-enabled party. Treat as a bearer secret. */ joinCode?: string }
export interface PartyParams { partyId: string }
/** May select a smaller capacity than the trusted release's party.maxMembers (platform maximum 10,000). */
export interface PartyCreateParams { maxMembers?: number; joinPolicy?: PartyJoinPolicy }
/** Members use a live keyset page (1–100 rows). Invitations have a separate cursor and share the limit. */
export interface PartyGetParams { partyId?: string; cursor?: string; inviteCursor?: string; limit?: number }
export interface PartyInviteParams extends PartyParams { gameUserId: string }
export interface PartyJoinParams extends PartyParams { joinCode: string }
export interface PartyReadyParams extends PartyParams { ready: boolean }
export interface PartyInvitation { partyId: string; party: PartySummary }
export interface PartyGetResult { party: Party | null; invites: PartyInvitation[]; inviteCursor: string | null }
export interface PartyResult { party: Party }
export interface PartyApi {
  create(params?: PartyCreateParams, options?: RequestOptions): Promise<PartyResult>;
  get(params?: PartyGetParams, options?: RequestOptions): Promise<PartyGetResult>;
  invite(params: PartyInviteParams, options?: RequestOptions): Promise<{ invited: true }>;
  accept(params: PartyParams, options?: RequestOptions): Promise<PartyResult>;
  join(params: PartyJoinParams, options?: RequestOptions): Promise<PartyResult>;
  leave(params: PartyParams, options?: RequestOptions): Promise<{ left: true }>;
  ready(params: PartyReadyParams, options?: RequestOptions): Promise<PartyResult>;
}
export interface MatchmakingJoinParams { mode?: "default" }
export interface MatchmakingQueueParams { queueId?: string }
export interface MatchmakingQueue {
  queueId: string;
  status: "waiting" | "matched" | "cancelled" | "finished";
  matchRunId: string | null;
  adapterId: string;
  gameUserIds: string[];
  releaseId: string;
  createdAt: number;
}
export interface MatchmakingResult { queue: MatchmakingQueue | null }
export interface MatchmakingApi {
  /** Current implementation queues one player. Party queueing is unsupported. */
  join(params?: MatchmakingJoinParams, options?: RequestOptions): Promise<MatchmakingResult>;
  status(params?: MatchmakingQueueParams, options?: RequestOptions): Promise<MatchmakingResult>;
  cancel(params?: MatchmakingQueueParams, options?: RequestOptions): Promise<{ cancelled: boolean }>;
}
export interface MatchGetParams { matchRunId: string }
export interface MatchPlayerResult { gameUserId: string; rank: number | null; won: boolean; score: number; points: number }
export interface MatchResult {
  adapterId: string;
  releaseId: string;
  reason: "finished" | "abandoned";
  finishedAt: number;
  results: MatchPlayerResult[];
}
/** Public projection for turn-based-v1; private input sequences are never included. */
export interface TurnPublicState {
  players: string[];
  status?: "waiting" | "playing" | "finished";
  stones?: number;
  maxTake?: number;
  turn?: string;
  move?: number;
  deadline?: number | null;
  startedAt?: number;
  winner?: string | null;
  reason?: string;
  finishedAt?: number;
  lastMove?: { player: string | null; take: number | null };
  settlement?: "pending" | "confirmed";
}
/** Scores are aligned with players. The challenge is present only on the player's WS connection. */
export interface ScoreRacePublicState {
  status: "waiting" | "playing" | "finished";
  players: string[];
  scores?: number[];
  targetScore?: number;
  deadline?: number | null;
  startedAt?: number;
  finishedAt?: number;
  winner?: string | null;
  reason?: string;
  settlement?: "pending" | "confirmed";
  connected?: number;
  required?: number;
}
export interface ScoreRaceSocketState extends ScoreRacePublicState { challenge?: { id: string; target: number } }
export interface PublicMatch {
  matchRunId: string;
  adapterId: string;
  gameUserIds: string[];
  status: "registered" | "settled";
  releaseId: string;
  createdAt: number;
  config: MultiplayerConfig;
  /** Null until the authoritative result has committed. */
  result: MatchResult | null;
  /** Only explicitly approved adapter projections are exposed; never private authority state. */
  state: TurnPublicState | ScoreRacePublicState | null;
}
export interface MatchRunTicketParams { matchRunId: string }
export interface EntryMatchTicketParams { intent: "entry"; adapterId?: string }
export interface MatchTicket {
  endpoint: string;
  ticket: string;
  expiresAt?: number;
  protocol: string;
  gameUserId?: string;
  [key: string]: unknown;
}
export interface IssuedMatchTicket extends MatchTicket { expiresAt: number; adapterId: string; gameUserId: string }
export interface MatchRunTicket extends IssuedMatchTicket { matchRunId: string }
export interface EntryMatchTicket extends IssuedMatchTicket { protocol: "robo-rumble-v1" }
export interface MatchApi {
  get(params: MatchGetParams, options?: RequestOptions): Promise<PublicMatch>;
  ticket(params: MatchRunTicketParams, options?: RequestOptions): Promise<MatchRunTicket>;
  ticket(params: EntryMatchTicketParams, options?: RequestOptions): Promise<EntryMatchTicket>;
  ticket(params: MatchRunTicketParams | EntryMatchTicketParams, options?: RequestOptions): Promise<MatchRunTicket | EntryMatchTicket>;
}
export interface PaginationParams {
  /** Integer from 1 to 50. */
  limit?: number;
  /** Integer from 0 to 1000. */
  offset?: number;
}
export interface LeaderboardListParams extends PaginationParams { leaderboardId: string }
export interface LeaderboardRecord extends PlayerIdentity { rank: number; score: number }
export interface LeaderboardListResult {
  leaderboardId: string;
  /** "all_time" or the UTC start date of the current daily/weekly period. */
  period: string;
  records: LeaderboardRecord[];
  ownRecord: LeaderboardRecord | null;
  total: number;
}
export interface LeaderboardsApi {
  list(params: LeaderboardListParams, options?: RequestOptions): Promise<LeaderboardListResult>;
}
export interface CoinReward { coins: number }
export interface Achievement {
  id: string;
  name: string;
  event: "match.won" | "match.played";
  target: number;
  count: number;
  completed: boolean;
  claimed: boolean;
  reward: CoinReward;
}
export interface AchievementClaimParams { achievementId: string }
export interface AchievementClaimResult { claimed: true; duplicate: boolean; reward: CoinReward; balance: number }
export interface AchievementsApi {
  list(params?: EmptyParams, options?: RequestOptions): Promise<{ achievements: Achievement[] }>;
  claim(params: AchievementClaimParams, options?: RequestOptions): Promise<AchievementClaimResult>;
}
export interface EconomyBalance { currencies: { coins: number }; version: number }
export interface EconomyApi { get(params?: EmptyParams, options?: RequestOptions): Promise<EconomyBalance> }
export interface Tournament {
  id: string;
  name: string;
  startAt: number;
  endAt: number;
  leaderboardId: string;
  joined: boolean;
  status: "upcoming" | "active" | "finished";
}
export interface TournamentParams { tournamentId: string }
export interface TournamentStandingsParams extends TournamentParams, PaginationParams {}
export interface TournamentsApi {
  list(params?: EmptyParams, options?: RequestOptions): Promise<{ tournaments: Tournament[] }>;
  join(params: TournamentParams, options?: RequestOptions): Promise<{ joined: true; duplicate: boolean }>;
  /** Scores are independent event totals, not filtered lifetime leaderboard scores. */
  standings(params: TournamentStandingsParams, options?: RequestOptions): Promise<LeaderboardListResult>;
}
export type SocialTab = "profile" | "friends" | "chat" | "party" | "leaderboards" | "achievements" | "account";
export interface SocialOpenParams { tab?: SocialTab }
export interface SocialApi { open(params?: SocialOpenParams, options?: RequestOptions): Promise<{ opened: true }> }
export class ArcaneGame {
  static connect(options?: ConnectOptions): Promise<ArcaneGame>;
  constructor(transport: Transport, options?: RequestOptions);
  readonly context: ContextApi;
  readonly profile: ProfileApi;
  readonly storage: StorageApi;
  readonly friends: FriendsApi;
  readonly chat: ChatApi;
  readonly party: PartyApi;
  readonly matchmaking: MatchmakingApi;
  readonly match: MatchApi;
  readonly leaderboards: LeaderboardsApi;
  readonly achievements: AchievementsApi;
  readonly economy: EconomyApi;
  readonly tournaments: TournamentsApi;
  readonly social: SocialApi;
  on(event: string, listener: (data: JsonValue, event: string) => void): () => void;
  close(): void;
}
export interface HttpTransportOptions {
  gatewayUrl: string;
  /** Short-lived token scoped to this game. Never a platform/Nakama session. */
  gameToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export function createHttpTransport(options: HttpTransportOptions): Transport;
export interface HostTransportOptions extends RequestOptions {
  bootstrap?: HostBootstrap;
  window?: Window;
  MessageChannelImpl?: typeof MessageChannel;
}
export function createHostTransport(options?: HostTransportOptions): Transport;
export interface MatchState { state: JsonValue; ack: number | null; serverTime: number | null }
export interface MatchConnection {
  readonly ready: Promise<void>;
  readonly status: "connecting" | "connected" | "reconnecting" | "closed";
  /** Sends exactly once, or throws. It never queues input while disconnected. */
  sendInput(input: JsonObject): number;
  onState(listener: (packet: MatchState) => void): () => void;
  on(event: "state", listener: (packet: MatchState) => void): () => void;
  on(event: "status", listener: (packet: { status: string }) => void): () => void;
  on(event: "error", listener: (error: ArcaneError) => void): () => void;
  close(): void;
}
export interface MatchConnectionOptions extends RequestOptions {
  WebSocketImpl?: typeof WebSocket;
  reconnectAttempts?: number;
  maxReconnectAttempts?: number;
  refreshTicket?: (options: { signal: AbortSignal }) => Promise<MatchTicket>;
  serializeJoin?: (ticket: MatchTicket) => string;
  serializeInput?: (packet: { seq: number; input: JsonObject }) => string;
  parseMessage?: (data: string) => { type: string; state?: JsonValue; ack?: number; serverTime?: number; error?: unknown };
  now?: () => number;
}
export function createMatchConnection(ticket: MatchTicket, options?: MatchConnectionOptions): MatchConnection;
export const SDK_VERSION: "0.1.0";
export const PROTOCOL_VERSION: 1;
export const RPC_METHODS: readonly string[];
