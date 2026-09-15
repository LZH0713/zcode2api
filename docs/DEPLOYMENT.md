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
**Chromium param 提供器**（`captcha_node/param_provider.js`）：容器内 Xvfb 虚拟屏 +
有头 Chromium 运行官方无痕 SDK（headless 会被 F001 拒绝），本地 HTTP `/param`
提供一次性 verifyParam，带复用窗口（45s）/失败延迟重试/持久 profile，Python 侧
看门狗自动重启，jsdom 求解器仅作兜底。取参耗时约 5-20s（数据中心 IP 约 60-90s
放行一发，阿里云侧节奏限制）。

实测结论（2026-09-16）：
- 提供器产出的 param **真实有效**（上游 3007=无效/缺失，3012=验证码已通过但被业务风控拦）
- `billing/*`（额度/预览）接口全部正常；**仅 `/v1/messages` 返回 3012 unusual activity**
- 3012 与以下因素均无关（逐一排除）：请求头（已完整复刻 App `withZCodeSourceHeaders`）、
  X-Device-Mid（真实设备/服务器随机均试）、IP 类型（家宽/机房均试）、TLS 指纹
  （真 Chrome fetch 转发仍 3012）、origin（file:// 与 http 均试）、请求体画像
  （stream+system+metadata 均试）、账号（两账号均复现）、App 版本（3.11.2 完全一致）
- 剩余嫌疑：池内 JWT 经 `oauth/cli` 流签发，与 App 的 web OAuth 会话绑定存在差异；
  或活动账号的消息通道被上游整体门禁
- 下一步排查：用 ZCode 桌面 App 直接登录池内账号试发消息（判定账号级门禁 vs
  签发通道差异）；若为后者，需实现 web 流 OAuth + Cookie 捕获并随请求携带
