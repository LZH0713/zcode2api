#!/usr/bin/env bash
# zcode2api 一键验收脚本
# 用法: ./scripts/verify.sh [网关地址] [网关密钥]
#   默认: http://45.205.27.30:3010 / 从服务器 docker-compose 读取
set -euo pipefail

GW="${1:-http://45.205.27.30:3010}"
KEY="${2:-80787f7b9c2c6cd4b8cb212d18845851}"
SSH_HOST="${SSH_HOST:-root@45.205.27.30}"

echo "── 1/4 容器与提供器 ──"
ssh -o BatchMode=yes "$SSH_HOST" '
docker ps --filter name=zcode2api --format "容器: {{.Status}}"
docker exec zcode2api python -c "
import urllib.request, json
h = json.load(urllib.request.urlopen(\"http://127.0.0.1:3931/health\", timeout=5))
print(\"提供器: mints=%s fails=%s paramAge=%sms\" % (h[\"mints\"], h[\"fails\"], h[\"paramAgeMs\"]))
" 2>/dev/null || echo "提供器: 不可达"
'

echo "── 2/4 网关消息端点（关键验收）──"
BODY='{"model":"glm-5.3","max_tokens":30,"messages":[{"role":"user","content":"回复两个字：成功"}]}'
RESP=$(curl -s -m 150 -X POST "$GW/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" -d "$BODY") || RESP="(请求失败)"
echo "$RESP" | head -c 400; echo

echo "── 3/4 结果判定 ──"
case "$RESP" in
  *'"content"'*|*message_start*|*"text"*) echo "✅ 验收通过：网关可正常对话" ;;
  *"3012"*) echo "⏳ 上游风控仍拦截（3012）：继续静置，等待下次探测" ;;
  *"3007"*|*"captcha"*) echo "❌ 验证码层失败：检查提供器（docker logs zcode2api）" ;;
  *"1113"*) echo "⚠️ 额度/余额问题" ;;
  *) echo "❓ 其他响应，请人工查看" ;;
esac

echo "── 4/4 管理后台 ──"
curl -s -o /dev/null -m 10 -w "admin页:%{http_code} " "$GW/admin/login"
curl -s -o /dev/null -m 10 -w "未鉴权API:%{http_code}(应401)\n" "$GW/admin/api/accounts"
