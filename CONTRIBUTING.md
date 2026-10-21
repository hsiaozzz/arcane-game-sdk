# Contributing

欢迎提交问题、文档改进与代码变更。请在 [Issues](https://github.com/hsiaozzz/arcane-game-sdk/issues) 描述可复现的问题；安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发环境

使用 Node.js 22+（推荐 24 LTS）、npm 和 Git。在仓库根目录执行：

```bash
npm ci
npm run sdk:build
npm run sdk:test
npm run sdk:typecheck
npm run platform:test
```

真实数据库与 Nakama 验证需要先在另一个终端运行 `npm run platform:local`，然后执行 `npm run platform:test:local`。独立单元测试在未配置真实服务时会跳过对应集成用例；请区分通过与跳过。浏览器、Party 和百人负载测试的前置条件见 [平台指南](platform/README.md)。这些工具会写开发数据库，不用于生产环境。

## 提交变更

1. Fork 仓库并为变更建立分支。
2. 说明触发问题的条件、预期行为及实际结果；错误日志先脱敏。
3. 将修改限制在一个可审阅的问题范围，运行与变更有关的检查。
4. 提交 Pull Request，说明行为变化、验证方式和兼容性影响。

SDK 参数/结果变化应同步更新 `index.d.ts`、API 文档及必要的契约测试。后端变更保留游戏/环境/发行版隔离、权限检查、数据库事务和结算幂等性。不要让游戏客户端获得任意 RPC、结算、排行榜写入或发币权限。

不要提交 `.env`、`platform/.local-data/`、数据库、账号/票据/邀请码、浏览器会话、私钥、第三方私有资源或生产日志。测试使用随机生成的临时凭据或明确的虚构 fixture；不复制生产数据。

贡献应为你有权按本项目 MIT 许可证提供的原创内容。新增第三方依赖时说明用途、许可及分发要求，并更新锁文件和第三方说明。

## 复现 Release 工件

在干净检出中，安装锁定依赖并运行相关检查后执行：

```bash
npm ci
npm test
npm run sdk:typecheck
npm run sdk:release
```

`sdk:release` 会重新构建浏览器 ESM，使用 SDK 的 `files` 白名单打包，在 `dist/` 生成 npm `.tgz`、浏览器 `.mjs`、SDK `.zip` 和 `SHA256SUMS`。该命令只生成本地工件，不创建 GitHub Release 或发布到 npm。ZIP 的路径和时间元数据固定；文件内容与校验值随版本源文件变化。

发布者应在独立本地栈完成 `platform:test:local` 与适当的 smoke 验证，审查最终源文件和压缩包，确认版本常量、类型声明、清单、文档下载链接与浏览器 banner 一致，再对已审查提交打版本 tag 并上传这些工件到 GitHub Release。`PROTOCOL_VERSION` 和能力清单的 schema/sdk 兼容版本与 npm 包版本含义不同，不应在补丁发布时机械递增。发行前复查依赖许可与漏洞，保留准确的测试范围和平台验证限制。
