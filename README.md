# Arcane Game SDK

[![CI](https://github.com/hsiaozzz/arcane-game-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/hsiaozzz/arcane-game-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/hsiaozzz/arcane-game-sdk)](https://github.com/hsiaozzz/arcane-game-sdk/releases/latest)

**为浏览器游戏提供统一的多人、社交和持久化能力。** `@arcane/game-sdk` 是无运行时依赖的 ESM 包；本仓库同时开源可信宿主、Node.js Gateway、Nakama OSS runtime、数据库 schema 和两个可运行的多人示例。

一个游戏通过同一套 API 使用资料、存档、好友、聊天、队伍、匹配、排行榜、成就、奖励账本与积分赛事。游戏声明所需能力，平台按玩家、游戏、环境和发行版本授权。游戏客户端不能自行提交排行榜分数、结算比赛或发放货币。

## 下载与安装

最新稳定版本：**0.1.0**。直接从 GitHub Release 下载，无需 npm 账号。

| 文件 | 用途 |
| --- | --- |
| [arcane-game-sdk-0.1.0.tgz](https://github.com/hsiaozzz/arcane-game-sdk/releases/download/v0.1.0/arcane-game-sdk-0.1.0.tgz) | npm 可安装包，含源码、TypeScript 类型及 API 文档 |
| [arcane-game-sdk-0.1.0.browser.mjs](https://github.com/hsiaozzz/arcane-game-sdk/releases/download/v0.1.0/arcane-game-sdk-0.1.0.browser.mjs) | 已打包的浏览器 ESM；下载后在自己的静态站点托管 |
| [arcane-game-sdk-0.1.0.zip](https://github.com/hsiaozzz/arcane-game-sdk/releases/download/v0.1.0/arcane-game-sdk-0.1.0.zip) | SDK 文件与文档的 ZIP 包 |
| [SHA256SUMS](https://github.com/hsiaozzz/arcane-game-sdk/releases/download/v0.1.0/SHA256SUMS) | 下载文件的 SHA-256 校验值 |
| [完整项目源码](https://github.com/hsiaozzz/arcane-game-sdk/archive/refs/tags/v0.1.0.zip) | SDK、配套后端、示例及测试 |

```bash
npm install https://github.com/hsiaozzz/arcane-game-sdk/releases/download/v0.1.0/arcane-game-sdk-0.1.0.tgz
```

目前尚未发布到 npm registry；`npm install @arcane/game-sdk` 不作为此版本的安装方式。SDK 需要运行中的 Arcane 兼容宿主与后端，单独安装包不会自动创建多人服务器。

## 先体验完整示例

安装 Git、Node.js 22+（推荐 24 LTS）与 npm，然后在普通用户终端执行：

```bash
git clone https://github.com/hsiaozzz/arcane-game-sdk.git
cd arcane-game-sdk
npm ci
npm run platform:local
```

启动器下载固定版本并校验摘要的官方 Nakama，启动本地 PostgreSQL、Gateway 和内置比赛服务器，随机生成私有开发凭据。保持终端运行，打开：

- [双人取石](http://127.0.0.1:7400/play/arcane-take-away)：回合制完整匹配与结算。
- [反应竞速](http://127.0.0.1:7400/play/arcane-score-race)：可配置 2–100 人的轻量多人玩法。

用两个不同浏览器或普通窗口与无痕窗口模拟独立玩家；同一浏览器的普通标签页共享登录身份。Windows x64 已进行真实完整栈验证；macOS Intel/Apple Silicon、Linux x64/arm64 提供原生启动路径和安装说明，目前未完成这两种系统的实际全栈验收。详细条件、测试与 Docker 部署见 [平台指南](platform/README.md)。

## 游戏中调用

下面代码在**已配置的可信宿主**加载的游戏中运行。示例入口展示了宿主如何建立隔离的 iframe 和 MessagePort。

```js
import { ArcaneGame } from '@arcane/game-sdk';

const sdk = await ArcaneGame.connect();
const context = await sdk.context.get();

await sdk.storage.write({
  key: 'progress', value: { level: 3 }, expectedVersion: 0,
});
await sdk.social.open({ tab: 'friends' });

const { party } = await sdk.party.create({
  maxMembers: 128, joinPolicy: 'code',
});
// 发行版能力清单须允许至少 128 人队伍。
// 私下分享 partyId / joinCode，其他玩家调用 sdk.party.join(...)。

await sdk.matchmaking.join({ mode: 'default' });
// 继续查询匹配状态、领取比赛票据并连接对应 authority，见 API 文档。
```

`expectedVersion: 0` 仅创建新存档；更新已有存档需先读取当前版本。断开时调用 `sdk.close()`。没有配置宿主的普通网页会收到 `SDK_NOT_CONFIGURED`，平台根密钥、登录会话和 Nakama 凭据都不应传给游戏。

## 能力与边界

| 能力 | v0.1.0 行为 |
| --- | --- |
| 身份、资料、存档 | 游客/邮箱账号、版本检查与游戏/环境隔离；没有邮箱验证、找回密码 UI 或游客合并 |
| 好友、聊天 | 好友申请、屏蔽、公共/私聊/队伍历史；宿主手动刷新，未提供通用实时消息推送 |
| 社交 Party | 每游戏配置 1–10,000 人，默认 32；邀请或邀请码、准备状态、分页与全队计数 |
| 匹配、多人 | 个人排队；平台层配置 2–100 人，内置反应竞速覆盖该范围，取石规则固定两人 |
| 排行榜、成就、奖励 | 由可信比赛结果驱动，事务结算与幂等奖励；客户端只读金币余额 |
| 积分赛事 | 时间窗、报名与关联积分榜；未提供淘汰赛签表或自动奖金结算 |

**队伍人数、匹配人数与实时模拟容量是不同限制。** 万人队伍表示可持久化和分页读取的社交状态，不表示万人实时战斗，也不代表万人同时在线压测。具体游戏人数还受 authority 的规则和硬件约束。`minPlayers: 2, maxPlayers: 100` 达到两人即组局；固定百人场应配置 `100/100`。Party 暂不支持整队排队。

单进程 authority 负责房间状态；当前没有分布式房间归属、自动扩容或跨地域调度。百人链路可通过仓库内的负载工具在目标环境复验，回环延迟不代表公网体验。配置示例见 [capacity manifest](platform/examples/configurable-capacity.manifest.json)。

## 架构与文档

浏览器游戏 → 受限 MessagePort → 可信宿主/Gateway → Nakama OSS runtime → PostgreSQL。比赛输入使用带短期入场票据的 WebSocket，由可信 authority 校验并提交结果。宿主持有 HttpOnly 会话，游戏仅得到所声明的能力。

- [SDK 快速说明](packages/game-sdk/README.md)、[API 与传输契约](packages/game-sdk/API.md)、[TypeScript 示例](packages/game-sdk/examples/typed-usage.ts)
- [平台运行、部署与配置](platform/README.md)、[运维 CLI](platform/tools/OPERATIONS.md)
- [Nakama runtime 契约](platform/nakama/CONTRACT.md)、[反应竞速实现](platform/examples/score-race/README.md)
- [贡献说明](CONTRIBUTING.md)、[安全报告](SECURITY.md)、[第三方说明](THIRD_PARTY_NOTICES.md)

采用 Nakama 开源版和独立实现的公共系统；不包含、也不要求商业 Hiro 代码或许可。MIT 适用于本项目原创代码；第三方组件保留各自许可。本仓库不包含原平台的私有配置、数据库、游戏美术素材或历史仓库内容。

## English overview

Arcane Game SDK is a dependency-free browser ESM client with TypeScript declarations, paired with an open-source trusted host, Node.js gateway, Nakama OSS runtime and PostgreSQL schema. It exposes scoped profiles, saves, friends, chat, parties, solo matchmaking, authoritative matches, leaderboards, achievements, currency reads and score-window tournaments.

Download the npm-compatible tarball or browser bundle from [GitHub Releases](https://github.com/hsiaozzz/arcane-game-sdk/releases/latest). Run `npm ci` and `npm run platform:local` to start the two included demos. The SDK requires a configured host/backend; the package does not provision a service by itself. Social parties support configurable stored membership up to 10,000, while multiplayer registration supports 2–100 players subject to the selected authority. These are configuration limits, not claims of arbitrary real-time game capacity or production concurrency.

The original code is MIT licensed. Nakama OSS is a separate Apache-2.0 component; no commercial Hiro code is included. Contributions and reproducible issue reports are welcome.
