"""验证码求解。

主路径：Chromium param 提供器（param_provider.js，与 ZCode App 同款真实浏览器引擎，
无痕验证可静默通过）；兜底：jsdom 求解器（solver.js，阿里云风控升级后可能被 F001 拒绝）。

- 提供器以 Node 子进程常驻，本地 HTTP 提供 /param（每次现解新 param，对齐 App
  「发送前现解、用后即弃」语义）与 /health
- 求解失败自动重试；提供器不可用时回退 jsdom
- 配置（scene/region/prefix）来自上游 client/configs，60s 缓存（与 App 一致）
"""

from __future__ import annotations

import asyncio
import shutil
import time

import httpx

from . import logs, settings


class CaptchaProvider:
    """param_provider.js 子进程管理（启动 / 健康检查 / 崩溃重启）。"""

    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._restart_task: asyncio.Task | None = None
        self._stopping = False
        self.enabled = False
        self._scene = "11xygtvd"
        self._region = "sgp"
        self._prefix = "no8xfe"

    # ── 生命周期 ───────────────────────────────────────────────────────────
    async def start(self, scene: str, region: str, prefix: str) -> None:
        self._scene, self._region, self._prefix = scene, region, prefix
        if not settings.CAPTCHA_PROVIDER_ENABLED:
            logs.info("captcha", "param 提供器未启用（ZCODE_CAPTCHA_PROVIDER=0）")
            return
        chromium = shutil.which(settings.CHROMIUM_PATH) or (
            settings.CHROMIUM_PATH if "/" in settings.CHROMIUM_PATH else ""
        )
        if not chromium:
            logs.warn("captcha", f"未找到 Chromium（{settings.CHROMIUM_PATH}），回退 jsdom 求解器")
            return
        self._stopping = False
        await self._spawn(chromium)
        if await self._wait_ready():
            self.enabled = True
            logs.ok("captcha", f"param 提供器就绪（127.0.0.1:{settings.CAPTCHA_PROVIDER_PORT}）")
        else:
            logs.warn("captcha", "param 提供器启动超时，回退 jsdom 求解器")
        self._restart_task = asyncio.create_task(self._watchdog())

    async def stop(self) -> None:
        self._stopping = True
        self.enabled = False
        if self._restart_task:
            self._restart_task.cancel()
            self._restart_task = None
        if self._proc:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass
            self._proc = None

    async def _spawn(self, chromium: str) -> None:
        env_extra = {**settings.CHILD_ENV, "ZCODE_CHROMIUM_PATH": chromium}
        cmd = [settings.NODE_PATH, str(settings.CAPTCHA_SOLVER_DIR / "param_provider.js"),
               self._scene, self._region, self._prefix]
        # 阿里云风控识别 headless（F001），需有头模式；服务器无显示则套 Xvfb 虚拟屏
        xvfb = shutil.which("xvfb-run")
        if xvfb:
            env_extra["ZCODE_CAPTCHA_HEADFUL"] = "1"
            cmd = [xvfb, "-a", "-s", "-screen 0 1280x900x24", *cmd]
        else:
            env_extra.setdefault("ZCODE_CAPTCHA_HEADFUL", "0")
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(settings.CAPTCHA_SOLVER_DIR),
                env=env_extra,
                stdout=None,   # 继承容器日志，便于观察 mint 失败原因
                stderr=None,
            )
        except Exception as err:  # noqa: BLE001
            logs.err("captcha", f"param 提供器启动失败: {err}")
            self._proc = None

    async def _wait_ready(self, timeout: float = 30.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._proc and self._proc.returncode is not None:
                return False
            try:
                async with httpx.AsyncClient(timeout=2) as client:
                    res = await client.get(f"{settings.CAPTCHA_PROVIDER_URL}/health")
                if res.status_code == 200:
                    return True
            except httpx.HTTPError:
                pass
            await asyncio.sleep(1)
        return False

    async def _watchdog(self) -> None:
        """提供器崩溃时自动拉起。"""
        chromium = shutil.which(settings.CHROMIUM_PATH) or settings.CHROMIUM_PATH
        while not self._stopping:
            await asyncio.sleep(5)
            if self._proc and self._proc.returncode is None:
                continue
            if self._stopping:
                return
            logs.warn("captcha", "param 提供器退出，正在重启…")
            self.enabled = False
            await self._spawn(chromium)
            if await self._wait_ready():
                self.enabled = True
                logs.ok("captcha", "param 提供器已恢复")
            else:
                await asyncio.sleep(10)

    # ── 取参 ───────────────────────────────────────────────────────────────
    async def get_param(self, timeout: float = 35.0) -> str | None:
        """现解一发新 param；提供器未启用或失败返回 None。"""
        if not self.enabled:
            return None
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                res = await client.get(f"{settings.CAPTCHA_PROVIDER_URL}/param")
            if res.status_code == 200:
                return res.json().get("param")
            logs.warn("captcha", f"提供器取参失败 HTTP {res.status_code}")
        except Exception as err:  # noqa: BLE001
            logs.warn("captcha", f"提供器取参异常: {err}")
        return None


class CaptchaManager:
    def __init__(self) -> None:
        self._cached: str | None = None
        self._cached_at: float = 0.0
        self._lock = asyncio.Lock()
        self._config_cache: dict | None = None
        self._config_cache_at: float = 0.0
        self.provider = CaptchaProvider()

    # ── 配置（60s 缓存，与 App 一致）───────────────────────────────────────
    async def fetch_config(self) -> dict:
        now = time.time() * 1000
        if self._config_cache and now - self._config_cache_at < settings.CAPTCHA_CONFIG_CACHE_TTL:
            return self._config_cache
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                res = await client.get(
                    "https://zcode.z.ai/api/v1/client/configs",
                    params={
                        "app_version": settings.ZCODE_CLIENT_VERSION,
                        "platform": settings.PLATFORM,
                    },
                    headers={
                        "User-Agent": f"ZCode/{settings.ZCODE_CLIENT_VERSION}",
                        "HTTP-Referer": "https://zcode.z.ai",
                        "Accept": "application/json",
                    },
                )
            res.raise_for_status()
            captcha = ((res.json().get("data") or {}).get("configs") or {}).get("captcha")
            if captcha:
                self._config_cache = captcha
                self._config_cache_at = now
                return captcha
        except (httpx.HTTPError, ValueError) as err:
            logs.warn("captcha", f"获取配置失败，使用默认: {err}")
        return {"enabled": True, "prefix": "no8xfe", "region": "sgp", "sceneId": "11xygtvd"}

    # ── 求解 ─────────────────────────────────────────────────────────────────
    async def get_verify_param(self, port: int | None = None) -> str:
        """取一发 verifyParam：优先提供器现解（真实浏览器，单次有效），失败回退 jsdom。"""
        param = await self.provider.get_param()
        if param:
            return param
        async with self._lock:
            config = await self.fetch_config()
            return await self._solve(config)

    async def solve_fresh(self) -> tuple[str, dict]:
        """求解一个全新的 verifyParam，返回 (param, captcha配置)。供活动领取使用。"""
        config = await self.fetch_config()
        param = await self.provider.get_param()
        if param:
            return param, config
        async with self._lock:
            param = await self._solve(config)
            return param, config

    async def _solve(self, config: dict) -> str:
        scene = config.get("sceneId") or "11xygtvd"
        region = config.get("region") or "sgp"
        prefix = config.get("prefix") or "no8xfe"

        last_err: str | None = None
        for attempt in range(1, settings.CAPTCHA_SOLVE_RETRIES + 1):
            try:
                param = await self._run_solver(scene, region, prefix)
            except Exception as err:  # noqa: BLE001
                last_err = str(err)
                param = None
            if param:
                if attempt > 1:
                    logs.ok("captcha", f"求解成功（第 {attempt} 次尝试）")
                return param
            logs.warn("captcha", f"第 {attempt}/{settings.CAPTCHA_SOLVE_RETRIES} 次求解未果，重试…")

        raise RuntimeError(f"验证码求解失败: {last_err or '多次重试无结果'}")

    async def _run_solver(self, scene: str, region: str, prefix: str) -> str | None:
        if not settings.CAPTCHA_SOLVER_JS.exists():
            raise RuntimeError(
                f"未找到求解器 {settings.CAPTCHA_SOLVER_JS}，请先在 captcha_node 下执行 npm install"
            )
        proc = await asyncio.create_subprocess_exec(
            settings.NODE_PATH, str(settings.CAPTCHA_SOLVER_JS), scene, region, prefix,
            cwd=str(settings.CAPTCHA_SOLVER_DIR),
            env=settings.CHILD_ENV,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=settings.CAPTCHA_SOLVE_TIMEOUT)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return None
        except FileNotFoundError as err:
            raise RuntimeError(f"无法启动 Node（{settings.NODE_PATH}）: {err}") from err

        for line in stdout.decode("utf-8", "ignore").splitlines():
            if line.startswith("VERIFY_PARAM="):
                return line[len("VERIFY_PARAM="):].strip()
        return None

    def invalidate(self) -> None:
        self._cached = None
        self._cached_at = 0.0

    async def close(self) -> None:
        await self.provider.stop()


captcha_manager = CaptchaManager()
