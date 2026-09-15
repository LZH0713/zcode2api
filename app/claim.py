"""ZCode 活动额度领取（协议链路借鉴 zcode-claim）。

流程：GET /billing/preview 查可领套餐 → 复用无浏览器求解器求阿里云无痕验证码
→ POST /billing/claim 领取 → 刷新额度让新领取的额度立刻可见。

领取接口除 Authorization 外还要求 X-Aliyun-Captcha-Verify-Param / -Region、
X-Platform 等来源头（billing 缺它们会报 3001 parameter error）。
每次领取使用独立求解的新 verifyParam，避免跨账号复用同一验证结果。
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid

import httpx

from . import logs, settings
from .captcha import captcha_manager
from .models import Account, Status
from .quota import _device_mid, fetch_quota
from .store import store

CLAIM_APP_VERSION = "3.11.2"

# 上游 claim 错误码 → 可读文案
CLAIM_ERR = {
    1001: "活动不存在",
    1002: "活动当前不可领取",
    1003: "该账号已领取过",
    1004: "账号不符合领取条件（如非新用户）",
    1005: "活动名额已发完",
    3001: "参数错误",
    3007: "人机验证校验失败",
    401: "登录态已失效",
}


def _platform() -> str:
    try:
        return f"{sys.platform}-{os.uname().machine}"
    except (AttributeError, OSError):  # 非 POSIX 平台兜底
        return sys.platform or "unknown"


def _os_category() -> str:
    if sys.platform == "darwin":
        return "macos"
    return {"win32": "windows"}.get(sys.platform, sys.platform or "unknown")


def _source_headers(account: Account, extra: dict | None = None) -> dict:
    """ZCode App 对 zcode.z.ai 的全局来源头（withZCodeSourceHeaders）。"""
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": f"ZCode/{CLAIM_APP_VERSION}",
        "HTTP-Referer": "https://zcode.z.ai",
        "X-Title": "Z Code@electron",
        "X-ZCode-App-Version": CLAIM_APP_VERSION,
        "X-Platform": _platform(),
        "X-Client-Language": "zh-CN",
        "X-Client-Timezone": "Asia/Shanghai",
        "X-Os-Category": _os_category(),
        "X-Os-Version": "10.15.7",
        "X-Device-Mid": _device_mid(),
        "x-request-id": str(uuid.uuid4()),
    }
    if account.mode == "jwt" and account.jwt_token:
        headers["Authorization"] = f"Bearer {account.jwt_token}"
    if extra:
        headers.update(extra)
    return headers


def _result(ok: bool, state: str, message: str) -> dict:
    return {"ok": ok, "state": state, "message": message}


def _mark_invalid(account: Account, message: str) -> None:
    account.status = Status.INVALID
    account.last_error = message
    store.update_account(account)


async def preview_plans(account: Account) -> list[dict]:
    """查询账号当前可领取的活动套餐（无可领时返回空列表）。"""
    if account.mode != "jwt" or not account.jwt_token:
        raise RuntimeError("仅 Coding Plan (JWT) 账号支持领取活动")

    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get(
            f"{settings.ZCODE_BILLING_BASE}/billing/preview",
            params={"app_version": CLAIM_APP_VERSION, "platform": _platform()},
            headers=_source_headers(account),
        )

    if res.status_code in (401, 403):
        _mark_invalid(account, "登录态已失效")
        raise RuntimeError("登录态已失效，请重新导入账号")
    try:
        data = res.json()
    except ValueError:
        raise RuntimeError(f"查询可领活动失败（HTTP {res.status_code}）")
    if res.status_code != 200 or data.get("code") not in (0, None):
        msg = data.get("msg") or f"HTTP {res.status_code}"
        raise RuntimeError(f"查询可领活动失败: {msg} (code={data.get('code')})")

    plans = []
    for p in (data.get("data") or {}).get("plans") or []:
        plans.append({
            "plan_id": p.get("plan_id"),
            "name": p.get("name"),
            "description": p.get("description"),
            "entitlements": [
                {
                    "show_name": e.get("show_name"),
                    "grant_units": e.get("grant_units"),
                    "unit_type": e.get("unit_type"),
                    "period": e.get("period"),
                }
                for e in (p.get("entitlements") or [])
            ],
        })
    return plans


async def claim_account(account: Account, plan_id: str | None = None) -> dict:
    """对单个账号执行 预览 → 验证码 → 领取，并刷新额度。

    返回 {ok, state, message}；state ∈ claimed / none / failed。
    """
    if account.mode != "jwt" or not account.jwt_token:
        return _result(False, "failed", "仅 Coding Plan (JWT) 账号支持领取活动")

    try:
        plans = await preview_plans(account)
    except RuntimeError as err:
        return _result(False, "failed", str(err))

    if not plans:
        return _result(False, "none", "没有可领取的活动（可能已领取过或不符合条件）")

    plan = next((p for p in plans if p["plan_id"] == plan_id), None) if plan_id else plans[0]
    if plan is None:
        return _result(False, "failed", f"plan_id {plan_id} 不在可领列表中")
    if not plan.get("plan_id"):
        return _result(False, "failed", "活动缺少 plan_id，无法领取")

    # 领取：验证码被上游拒绝(3007)时换一张新的重试一次
    max_attempts = 2
    for attempt in range(1, max_attempts + 1):
        try:
            param, cfg = await captcha_manager.solve_fresh()
        except Exception as err:  # noqa: BLE001 - 求解失败直接返回
            logs.err("claim", f"验证码求解失败: {err}")
            return _result(False, "failed", f"人机验证求解失败: {err}")

        headers = _source_headers(account, {
            "X-Aliyun-Captcha-Verify-Param": param,
            "X-Aliyun-Captcha-Verify-Region": cfg.get("region") or "sgp",
        })
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                res = await client.post(
                    f"{settings.ZCODE_BILLING_BASE}/billing/claim",
                    headers=headers,
                    json={"plan_id": plan["plan_id"]},
                )
        except httpx.HTTPError as err:
            return _result(False, "failed", f"领取请求失败: {err}")

        try:
            data = res.json()
        except ValueError:
            return _result(False, "failed", f"领取失败（HTTP {res.status_code}）")
        code = data.get("code")
        if code == 401 or res.status_code in (401, 403):
            _mark_invalid(account, "登录态已失效")
            return _result(False, "failed", "登录态已失效，请重新导入账号")
        if code == 3007 and attempt < max_attempts:
            logs.warn("claim", "验证码被上游拒绝，换新验证码重试…")
            continue
        break

    if code != 0:
        return _result(False, "failed",
                       f"{CLAIM_ERR.get(code, data.get('msg') or '领取失败')} (code={code})")

    # 领取成功：立刻刷新额度，让新入账的额度在 UI 可见
    try:
        await fetch_quota(account)
    except Exception as err:  # noqa: BLE001 - 刷新失败不影响领取结果
        logs.warn("claim", f"领取后刷新额度失败: {err}")
    name = plan.get("name") or plan["plan_id"]
    return _result(True, "claimed", f"领取成功：{name}")


async def claim_accounts(accounts: list[Account]) -> dict:
    """并发领取一批账号，返回按状态汇总。"""
    if not accounts:
        return {"claimed": 0, "none": 0, "failed": 0, "results": []}
    sem = asyncio.Semaphore(4)

    async def _one(acc: Account) -> dict:
        async with sem:
            res = await claim_account(acc)
            logs.info("claim", f"{acc.name}: {res['message']}")
            return {"id": acc.id, "name": acc.name, **res}

    results = await asyncio.gather(*[_one(a) for a in accounts])
    summary = {"claimed": 0, "none": 0, "failed": 0,
               "results": results, "ts": time.time()}
    for r in results:
        summary[r["state"]] += 1
    return summary
