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
