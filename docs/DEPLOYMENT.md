# 部署记录

## 当前环境

- 服务器：`45.205.27.30`
- SSH 用户：`root`
- 部署目录：`/opt/zcode2api`
- 容器：`zcode2api`
- 镜像：`zcode2api:latest`
- 外部端口：`3010`
- 容器端口：`3000`
- 持久化目录：`/opt/zcode2api/data:/data`
- 重启策略：`unless-stopped`
- Compose：`docker-compose 1.29.2`

端口 `3000` 已被服务器上的 `new-api` 占用，因此本服务使用 `3010:3000` 映射。

## 访问地址

- 管理后台：`http://45.205.27.30:3010/admin/login`
- Anthropic Messages API：`http://45.205.27.30:3010/v1/messages`

管理密码和账号 Token 未记录在仓库中，保存在服务器运行数据中。

## 部署命令

```bash
cd /opt/zcode2api
docker-compose up -d --build
docker-compose logs -f
```

## 已验证项目

- 容器正常运行并设置 `unless-stopped`
- Python 3.13 与 Node.js 20 运行时可用
- 管理页面公网返回 HTTP 200
- 额度刷新接口可成功获取账号额度
- 未鉴权访问管理 API 返回 HTTP 401
- Token 复制接口返回 `Cache-Control: no-store`

## 功能改动

- 额度请求增加持久化 `X-Device-Mid`，修复新版 ZCode API 的 `code=3001 parameter error`
- 按套餐和模型分别保存额度 bucket，支持 Global Build 与 Start Plan 同时展示
- 保存额度到期时间，已过期 bucket 不参与调度
- 任一未过期 bucket 有余额时账号保持可调度
- 管理后台支持复制完整 Token，接口仅限后台鉴权访问
- 账号首列优先显示 JWT 中的邮箱、手机号或用户标识
- 额度界面改为套餐/模型与进度数值分行显示，避免长名称重叠
- 账号池新增「领取活动」：页头批量 + 每行单账号，复用无痕求解器过验证后调 `billing/claim` 领取活动额度，成功后自动刷新额度

## 更新流程

本地修改完成后，将变更同步到 `/opt/zcode2api`，再执行：

```bash
docker-compose up -d --build
curl -sS http://127.0.0.1:3010/admin/login
```

更新前不要删除 `/opt/zcode2api/data`，其中包含账号数据库及设备标识。

## 验证码架构（2026-09 重构）与已知阻塞

阿里云 2026-06 起升级风控，**jsdom 求解器 100% 被拒（F001）**，已改为主路径
**Chromium param 提供器 v2**（`captcha_node/param_provider.js`）：容器内 Xvfb 虚拟屏 +
**零 CDP** 有头 Chromium（不使用 puppeteer —— CDP 连接会被风控识别为自动化环境，
既触发 F001 节流又拉高验证结果的风险分）打开工作页 `captcha_page.html`，页面自循环
「init SDK → 无痕验证 → POST /report 上报 param → 刷新重 init」（对齐 App 每次
验证前重 init 的语义），param 按 45s 复用窗口供给网关，Chromium 崩溃自动重启
（启动前清理 profile 遗留锁）。jsdom 求解器仅作兜底。实测零 CDP 模式下无 F001
节流，param 持续稳定产出（每 ~60s 一发）。

### 3012 阻塞（上游账号级风控，2026-09-16 排查结论）

`/v1/zcode-plan/anthropic/v1/messages` 对池内账号返回 `3012 unusual activity`。

- 验证码层已完全打通：干净 param 通过上游验证（3007=参数无效/缺失，3012=验证已过但业务风控拦截）
- 已逐一排除所有请求侧变量：请求头（完整复刻 App `withZCodeSourceHeaders` +
  归因头 `x-session-id/x-query-id/x-zcode-trace-id/x-zcode-session-type`）、
  X-Device-Mid、IP 类型（家宽/机房）、TLS（curl/Node undici/真 Chrome）、origin、
  Cookie、请求体画像、App 版本（3.11.2）、param 质量（零 CDP 干净浏览器）
- **关键发现**：App 存在客户端请求签名机制（Ed25519 + PoW，头 `X-Client-Sig/
  X-Client-Pow/X-Client-Nonce/X-App-Id`，握手端点 `/api/paas/c1f3a7e2/v2/client`，
  算法已完整逆向记录于代码评审记录），签名凭证为 `apiKeyId.apiKeySecret` 形态，
  但该凭证只随官方 App 的登录通道下发；当前 App 调握手路径返回 404 → 失败放行
  （fail-open 发未签名请求），说明服务端按「官方客户端会话」信用放行
- 池内账号曾经历长时间 3012 失败请求，账号风险分已被推高。**建议静置 24-48h 后
  重试**（网关现在具备干净 param + 全对齐请求头）；billing/preview 等额度接口
  不受影响，Start Plan 额度仍在有效期内
