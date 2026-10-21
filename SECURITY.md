# Security policy

## Supported version

安全修复面向最新的 `0.1.x` 版本。此项目尚处于早期版本，部署者需要自行评估目标环境并维护数据库、Nakama、Node.js 和反向代理。

## Reporting a vulnerability

请使用本仓库 **Security → Advisories → Report a vulnerability** 私下报告授权绕过、数据泄露、会话/票据问题或结算作弊路径：

[Private vulnerability report](https://github.com/hsiaozzz/arcane-game-sdk/security/advisories/new)

报告应包含受影响版本、前置条件、最小复现步骤、影响范围和可用的修复建议。使用测试账号和测试数据；分享日志前删除密钥、Cookie、Bearer token、入场票据、邀请码、邮箱及个人数据。不要将可利用细节或凭据直接发到公开 Issue。当前不承诺固定响应时间，也未设立漏洞奖励计划。

## Trust boundaries

- 生成游戏和客户端输入视为不可信。SDK 的本地参数检查不能代替宿主隔离与服务端授权。
- 平台会话保留在可信宿主的 HttpOnly Cookie 中；Nakama runtime key、发布凭据、签名密钥和服务器 workload token 不进入游戏。
- 生产环境使用 HTTPS/WSS、独立可信宿主与内容 origin、明确的 origin 白名单；只对外开放反向代理。
- 比赛 authority 校验输入并提交结果；服务端执行版本检查、不可变结算和幂等奖励。
- 生产数据库和密钥备份须设置访问控制并加密；开发堆栈及其凭据不直接作为生产配置。

运行与部署边界见 [平台指南](platform/README.md)。
