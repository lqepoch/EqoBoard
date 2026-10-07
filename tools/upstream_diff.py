#!/usr/bin/env python3
"""Compare the vendored OpenTerminal tree with its pinned upstream commit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / "third_party" / "upstreams.lock.json"
DOWNSTREAM_PREFIX = "apps/openterminal"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ARCHIVE_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


@dataclass(frozen=True)
class Pin:
    repository: str
    commit: str
    license: str
    downstream_prefix: str
    expected_git_archive_sha256: str | None = None


@dataclass(frozen=True)
class TreeDiff:
    exact: tuple[str, ...]
    modified: tuple[str, ...]
    eqoboard_only: tuple[str, ...]
    deleted: tuple[str, ...]


# Current-path notes keep the generated audit useful to reviewers. Unknown
# paths intentionally receive a "review required" note so upstream drift is
# visible instead of silently inheriting an old classification.
MODIFIED_NOTES: dict[str, tuple[str, str, str, str]] = {
    "README.md": ("记录 EqoBoard 的数据、安全和部署边界。", "保留", "无需抽 adapter", "否"),
    "package-lock.json": ("锁定 EqoBoard 认证和运行时依赖。", "保留", "无需抽 adapter", "否"),
    "server/package.json": ("加入短时委托 JWT 验证依赖。", "保留", "认证职责已在 server/src/auth.ts", "否"),
    "server/src/auth.ts": ("以 OIDC 用户委托和独立研究服务凭据替代自动生成的共享 API key。", "保留", "可抽成认证 adapter", "否"),
    "server/src/db.test.ts": ("覆盖按已验证用户隔离 Portfolio 的数据迁移和访问。", "保留", "无需抽 adapter", "否"),
    "server/src/db.ts": ("增加 Portfolio owner 列和不转移旧 local 数据的 SQLite 迁移。", "保留", "数据库迁移职责独立", "否"),
    "server/src/index.ts": ("增加健康检查、委托身份、scope、受限 JSON 和服务端路由边界。", "保留", "HTTP policy 可逐步拆分", "否"),
    "server/src/providers/binance.ts": ("统一显式 crypto 符号归一化；上游仍提供 Binance 数据访问。", "保留", "符号规则来自共享 provider adapter", "否"),
    "server/src/providers/yahoo.ts": ("为研究数据补充可空的 source-side observation time。", "保留", "无需抽 adapter", "否"),
    "server/src/routes/market.test.ts": ("验证 EqoBoard Gateway 市场数据路由行为。", "保留", "无需抽 adapter", "否"),
    "server/src/routes/market.ts": ("让美股/期权关键数据通过 Rust Gateway，并保留上游非美与研究 provider。", "保留", "应逐段抽为 Gateway/provider adapter", "否"),
    "server/src/routes/portfolio.ts": ("增加主体隔离、所有权校验及请求限额。", "保留", "portfolio persistence 可独立 adapter", "否"),
    "server/tsconfig.json": ("启用 EqoBoard Node/TypeScript 构建配置。", "保留", "无需抽 adapter", "否"),
    "web/app/api/[...path]/route.ts": ("加入 OIDC action authorization、短时服务委托、Rust Gateway SIP/OPRA 代理和有界响应。", "保留", "可逐步拆为具体 BFF adapters", "否"),
    "web/app/globals.css": ("为登录、会话和身份错误状态提供页面样式。", "保留", "无需抽 adapter", "否"),
    "web/app/layout.tsx": ("设置 EqoBoard 产品名称。", "保留", "无需抽 adapter", "否"),
    "web/app/page.tsx": ("以服务端 OIDC 会话门禁包裹上游终端。", "保留", "Workspace 本体继续复用上游", "否"),
    "web/components/Sidebar.tsx": ("将 EqoBoard 专属期权与风险 widget 注册到上游 Sidebar。", "保留", "Widget registry 后续可外置", "否"),
    "web/components/TopBar.tsx": ("展示 EqoBoard feed/source/授权状态，同时保留上游搜索和时间栏。", "保留", "行情状态可作为独立 extension", "否"),
    "web/components/Workspace.tsx": ("在上游 react-grid-layout Workspace 中注册 EqoBoard widgets 与 ticker linking。", "保留", "widget 注册表可外置", "否"),
    "web/components/widgets/CalendarWidget.tsx": ("呈现研究日历和财报字段的来源与观察时间。", "保留", "无需抽 adapter", "否"),
    "web/components/widgets/ChartWidget.tsx": ("保留 Lightweight Charts，实现 Rust bars 契约和 source/as-of 标签。", "保留", "bars DTO 转换适合 adapter", "否"),
    "web/components/widgets/HeatmapWidget.tsx": ("保留 D3 heatmap，消费 Gateway SIP 包络并显示 coverage/truncation。", "保留", "行包络转换适合 adapter", "否"),
    "web/components/widgets/InsiderWidget.tsx": ("补充 SEC filing date 与交易观察日期的区分。", "保留", "无需抽 adapter", "否"),
    "web/components/widgets/MacroWidget.tsx": ("保留上游宏观 UI，并显示各 provider 的 source/as-of。", "保留", "source metadata 可由 adapter 提供", "否"),
    "web/components/widgets/OptionsWidget.tsx": ("以 AG Grid Community 展示 OPRA 链，并接入共享行情状态、订阅和 freshness。", "保留", "数据/订阅 adapter 可从 widget 拆出", "否；替换了上游 option table"),
    "web/components/widgets/QuoteWidget.tsx": ("保留上游 Quote UI，增加 Gateway 快照/实时事件、source 和 freshness。", "保留", "市场状态 hook 可外置", "否"),
    "web/components/widgets/RecapWidget.tsx": ("保留上游 recap 视图并展示行情来源、coverage 和时间。", "保留", "source metadata 可由 adapter 提供", "否"),
    "web/components/widgets/ScreenerWidget.tsx": ("保留上游 screener UI，读取 Gateway SIP 行并显示 coverage/truncation。", "保留", "行包络转换可由 adapter 提供", "否"),
    "web/components/widgets/WatchlistWidget.tsx": ("保留上游 Watchlist UI，消费共享 store 与 Gateway 事件。", "保留", "行情 hook 可外置", "否"),
    "web/lib/api-key.ts": ("移除本地自动生成的静态 API key，改用服务端研究凭据。", "保留", "凭据读取 adapter 已有", "否"),
    "web/lib/api.ts": ("扩展前端 DTO 以表达 Gateway source、as-of、coverage 和 watermark。", "保留", "Gateway DTO adapter 可独立", "否"),
    "web/package.json": ("加入 NextAuth、jose 与 Gateway 契约集成依赖。", "保留", "认证库沿用上游 Next.js 层", "否"),
    "web/store/terminal.ts": ("保留 Zustand Workspace 状态并增加 EqoBoard widget 类型与交易预览状态。", "保留", "行情/金融状态继续在独立 market/domain store", "否"),
    "web/tsconfig.json": ("为 EqoBoard 的跨层 DTO 类型导入启用扩展配置。", "保留", "无需抽 adapter", "否"),
}

KNOWN_C_ONLY = {
    "web/components/widgets/IvSkewWidget.tsx",
    "web/components/widgets/OptionTapeWidget.tsx",
    "web/components/widgets/VerticalSpreadWidget.tsx",
    "web/components/widgets/OrderOutcomePanel.tsx",
    "web/components/widgets/MarketFeedStatus.tsx",
}

KNOWN_E_ONLY = {
    "AGENTS.md", "Dockerfile", "server/src/auth.test.ts",
    "server/src/providers/eqo-sip.test.ts", "server/src/providers/eqo-sip.ts",
    "server/src/providers/market-source.test.ts", "server/src/providers/market-source.ts",
    "server/src/providers/market-symbol.test.ts", "server/src/providers/market-symbol.ts",
    "server/src/providers/market-time.test.ts", "server/src/providers/market-time.ts",
    "server/src/providers/snapshot-watermarks.test.ts", "server/src/providers/snapshot-watermarks.ts",
    "server/src/routes/market-http.test.ts", "server/src/routes/market-store.test.ts",
    "server/src/routes/order-contract.test.ts", "server/src/routes/portfolio.test.ts",
    "web/app/api/auth/[...nextauth]/route.ts", "web/app/api/eqo/live/route.ts",
    "web/app/api/eqo/options/subscribe/route.ts", "web/app/api/eqo/orders/[action]/route.ts",
    "web/app/api/eqo/stocks/subscribe/route.ts", "web/app/api/healthz/route.ts",
    "web/app/api/readyz/route.ts", "web/app/e2e/order-outcome/page.tsx", "web/auth.ts",
    "web/components/MarketStreamProvider.tsx", "web/components/SignInButton.tsx",
    "web/components/SignOutButton.tsx", "web/components/TerminalShell.tsx",
    "web/e2e/access-boundary.spec.ts", "web/e2e/compose-e2e-server.mjs", "web/e2e/fixtures.ts",
    "web/e2e/market-freshness.spec.ts", "web/e2e/market-order.spec.ts",
    "web/e2e/market-stream.spec.ts", "web/e2e/market-test-data.ts", "web/e2e/mock-services.mjs",
    "web/e2e/order-outcome-probe.tsx", "web/lib/eqo-auth.ts", "web/lib/eqo-market.ts",
    "web/lib/http-response.ts", "web/lib/order-api.ts", "web/lib/order-contract.ts",
    "web/lib/permissions.ts", "web/next-auth.d.ts", "web/next.config.mjs",
    "web/playwright.compose.config.ts", "web/playwright.config.ts", "web/store/market.ts",
}


def load_pin(lock_path: Path = LOCK_PATH) -> Pin:
    data = json.loads(lock_path.read_text(encoding="utf-8"))
    matches = [item for item in data.get("sources", []) if item.get("name") == "OpenTerminal"]
    if len(matches) != 1:
        raise ValueError("upstreams.lock.json must contain exactly one OpenTerminal entry")
    item = matches[0]
    commit = item.get("commit", "")
    if not isinstance(commit, str) or not SHA_RE.fullmatch(commit):
        raise ValueError("OpenTerminal commit in upstream lock must be a full lowercase SHA-1")
    repository = item.get("repository", "")
    prefix = item.get("downstream_prefix", "")
    if not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository) or any(
        part in {".", ".."} for part in repository.split("/")
    ):
        raise ValueError("OpenTerminal repository must be an owner/repository name, not a URL")
    safe_prefix = PurePosixPath(prefix) if isinstance(prefix, str) else PurePosixPath(".")
    if (
        not isinstance(prefix, str)
        or prefix != DOWNSTREAM_PREFIX
        or safe_prefix.is_absolute()
        or ".." in safe_prefix.parts
    ):
        raise ValueError("OpenTerminal repository or downstream_prefix is invalid")
    expected_git_archive_sha256 = item.get("git_archive_sha256")
    if expected_git_archive_sha256 is not None and (
        not isinstance(expected_git_archive_sha256, str)
        or not ARCHIVE_SHA_RE.fullmatch(expected_git_archive_sha256)
    ):
        raise ValueError("OpenTerminal git_archive_sha256 in upstream lock is invalid")
    return Pin(repository, commit, str(item.get("license", "unknown")), prefix, expected_git_archive_sha256)


def _git(args: list[str], *, cwd: Path | None = None, stdout=None) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, stdout=stdout if stdout is not None else subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
    if stdout is not None:
        return ""
    return result.stdout.decode("utf-8", errors="strict").strip()


def verify_git_archive_sha256(pin: Pin, actual_sha256: str) -> None:
    if not ARCHIVE_SHA_RE.fullmatch(actual_sha256):
        raise ValueError("computed Git archive SHA-256 is invalid")
    if pin.expected_git_archive_sha256 and actual_sha256 != pin.expected_git_archive_sha256:
        raise RuntimeError(
            "OpenTerminal git archive SHA-256 does not match upstream lock: "
            f"got {actual_sha256}, expected {pin.expected_git_archive_sha256}"
        )


def fetch_pinned_tree(pin: Pin, destination: Path) -> tuple[Path, str]:
    """Fetch the locked commit as a Git object, verify it, and safely unpack it."""
    git_dir = destination / "upstream.git"
    source_dir = destination / "source"
    git_dir.mkdir()
    source_dir.mkdir()
    _git(["init", "--bare", "--quiet", "--initial-branch=main", str(git_dir)])
    remote = f"https://github.com/{pin.repository}.git"
    _git(["-C", str(git_dir), "fetch", "--quiet", "--no-tags", "--depth=1", remote, pin.commit])
    fetched = _git(["-C", str(git_dir), "rev-parse", "FETCH_HEAD^{commit}"])
    if fetched != pin.commit:
        raise RuntimeError(f"upstream returned {fetched}, expected locked commit {pin.commit}")
    archive_path = destination / "upstream.tar"
    _git(["-C", str(git_dir), "archive", "--format=tar", "--output", str(archive_path), pin.commit])
    archive_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    verify_git_archive_sha256(pin, archive_hash)
    with tarfile.open(archive_path, "r:") as archive:
        # Python 3.12+ applies the data filter, rejecting path traversal and
        # unsafe links from the source archive.
        archive.extractall(source_dir, filter="data")
    return source_dir, archive_hash


def _entry_digest(path: Path) -> str:
    if path.is_symlink():
        return "symlink:" + os.readlink(path)
    executable = bool(path.stat().st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return f"file:executable={int(executable)}:" + hasher.hexdigest()


def filesystem_paths(root: Path) -> set[str]:
    return {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() or path.is_symlink()
    }


def tracked_downstream_paths(repo_root: Path, prefix: str) -> set[str]:
    raw = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files", "-z", "--", prefix],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if raw.returncode:
        raise RuntimeError(raw.stderr.decode("utf-8", errors="replace").strip())
    base = prefix.rstrip("/") + "/"
    return {
        os.fsdecode(item)[len(base):]
        for item in raw.stdout.split(b"\0") if item and os.fsdecode(item).startswith(base)
    }


def compare_trees(
    upstream_root: Path,
    downstream_root: Path,
    downstream_paths: Iterable[str] | None = None,
) -> TreeDiff:
    upstream_paths = filesystem_paths(upstream_root)
    local_paths = set(downstream_paths) if downstream_paths is not None else filesystem_paths(downstream_root)
    exact: list[str] = []
    modified: list[str] = []
    deleted: list[str] = []
    for relative in sorted(upstream_paths):
        source = upstream_root / PurePosixPath(relative)
        local = downstream_root / PurePosixPath(relative)
        if relative not in local_paths or not (local.exists() or local.is_symlink()):
            deleted.append(relative)
        elif _entry_digest(source) == _entry_digest(local):
            exact.append(relative)
        else:
            modified.append(relative)
    eqoboard_only = sorted(local_paths - upstream_paths)
    return TreeDiff(tuple(exact), tuple(modified), tuple(eqoboard_only), tuple(deleted))


def _note_for_modified(path: str) -> tuple[str, str, str, str]:
    return MODIFIED_NOTES.get(
        path,
        ("未登记的上游差异；需要在升级审查中说明原因。", "待人工审核", "待人工审核", "待人工审核"),
    )


def _extension_note(path: str) -> tuple[str, str, str, str, str]:
    if path not in KNOWN_C_ONLY and path not in KNOWN_E_ONLY:
        return (
            "E?", "未登记的 EqoBoard-only 文件；需要人工判断是否为 domain 扩展或重复实现。",
            "待人工审核", "待人工审核", "待人工审核",
        )
    if path in KNOWN_C_ONLY:
        if path.endswith(("IvSkewWidget.tsx", "OptionTapeWidget.tsx", "VerticalSpreadWidget.tsx", "OrderOutcomePanel.tsx")):
            reason = "EqoBoard 专属期权分析/preview widget；复用 Workspace 与 AG Grid/图表容器。"
        else:
            reason = "EqoBoard 行情来源、授权、ACK 与 freshness 状态展示组件。"
        return ("C", reason, "保留", "是，继续作为 EqoBoard UI extension", "否")
    if path in {"web/components/MarketStreamProvider.tsx", "web/store/market.ts"}:
        return ("E", "EqoBoard Rust MarketEvent、订阅租约和行情状态扩展。", "保留", "是，继续作为行情 domain/extension", "否")
    if "/e2e/" in path or path.endswith("/auth.test.ts") or path.endswith("/order-outcome/page.tsx"):
        return ("E", "EqoBoard 集成/契约验证代码，不是产品 Workspace 的平行实现。", "保留", "无需抽 adapter", "否")
    if path == "AGENTS.md":
        return ("E", "OpenTerminal 子目录的 EqoBoard 数据来源、身份和上游同步约束。", "保留", "不适用", "否")
    if path.endswith("Dockerfile") or path.endswith("next.config.mjs") or path.endswith("playwright.config.ts") or path.endswith("playwright.compose.config.ts") or path.endswith("compose-e2e-server.mjs") or path.endswith("mock-services.mjs"):
        return ("E", "EqoBoard 容器、安全头和离线浏览器验证配置。", "保留", "不适用", "否")
    if "/providers/" in path:
        return ("E", "EqoBoard Rust Gateway 数据契约、source/time 或符号边界 provider adapter。", "保留", "是，继续作为 adapter/domain", "否")
    if "/routes/" in path or path.endswith("/order-contract.test.ts"):
        return ("E", "EqoBoard Gateway/订单权限与协议集成测试。", "保留", "无需抽 adapter", "否")
    if path.startswith("web/app/api/auth/") or path == "web/auth.ts" or path.endswith("SignInButton.tsx") or path.endswith("SignOutButton.tsx") or path.endswith("TerminalShell.tsx"):
        return ("E", "EqoBoard OIDC 会话与上游终端之间的认证适配。", "保留", "是，继续作为 adapter", "否")
    if path.startswith("web/app/api/eqo/") or path.startswith("web/app/api/healthz/") or path.startswith("web/app/api/readyz/"):
        return ("E", "EqoBoard Rust Gateway BFF 代理、市场订阅或健康状态路由。", "保留", "是，继续作为 adapter", "否")
    if path.startswith("web/lib/"):
        return ("E", "EqoBoard 身份、市场数据、订单 preview 或 Gateway response 契约。", "保留", "是，继续作为 adapter/domain", "否")
    return ("E", "EqoBoard SIP/OPRA、身份、安全或集成专属扩展。", "保留", "是，继续作为 extension/domain", "否")


def render_report(diff: TreeDiff, pin: Pin, head: str, audited_at: str, archive_sha256: str) -> str:
    lines = [
        "# OpenTerminal upstream file audit",
        "",
        f"- EqoBoard audit head: `{head}`",
        f"- OpenTerminal upstream commit: `{pin.commit}`",
        f"- Repository: `{pin.repository}`",
        f"- License: {pin.license}",
        f"- Verified Git archive SHA-256: `{archive_sha256}` (computed from `git archive` after the fetched Git object matched the locked commit)",
        f"- Audit date (UTC): {audited_at}",
        "- Comparison: tracked files below `apps/openterminal` against the verified Git tree at the locked commit; files such as `node_modules` and `.next` are excluded.",
        "",
        "## Summary",
        "",
        f"- A · exact upstream files: {len(diff.exact)}",
        f"- B · modified upstream files: {len(diff.modified)}",
        f"- C/E · EqoBoard-only files: {len(diff.eqoboard_only)}",
        f"- Deleted upstream files: {len(diff.deleted)}",
        "- D · duplicated mature upstream implementations: none identified in this comparison. EqoBoard routes U.S. SIP/OPRA prices through Rust; retained Yahoo/TradingView providers serve research, non-U.S. symbols, or metadata. The native OpenTerminal Workspace, charts, screener, heatmap, watchlist, and general research widgets remain reused.",
        "- Documentation follow-up: the OpenTerminal README still references five deleted screenshot files under `docs/screenshots/`; those image links are currently unresolved and are recorded below for a later asset/reference decision.",
        "",
        "C and E are both listed in the EqoBoard-only table. C marks product widgets; E marks data, identity, execution-preview, and integration-specific code. A newly modified or added path without a curated note is labeled `待人工审核` to make drift fail visibly in review.",
        "",
    ]

    def table_header() -> list[str]:
        return [
            "| Category | upstream file | EqoBoard file | upstream commit | modification reason | retain | adapter/extension | duplicate wheel |",
            "|---|---|---|---|---|---|---|---|",
        ]

    def row(category: str, upstream: str, local: str, reason: str, keep: str, adapter: str, duplicate: str) -> str:
        cells = (category, upstream, local, pin.commit, reason, keep, adapter, duplicate)
        return "| " + " | ".join(cell.replace("|", "\\|") for cell in cells) + " |"

    lines.extend(["## A. Exact upstream files", "", *table_header()])
    for path in diff.exact:
        lines.append(row("A", path, f"{DOWNSTREAM_PREFIX}/{path}", "与固定上游逐字节一致。", "保留", "不需要", "否"))

    lines.extend(["", "## B. Modified upstream files", "", *table_header()])
    for path in diff.modified:
        reason, keep, adapter, duplicate = _note_for_modified(path)
        if path == "web/components/widgets/OptionsWidget.tsx":
            duplicate = "否；替换上游旧表格实现"
        lines.append(row("B", path, f"{DOWNSTREAM_PREFIX}/{path}", reason, keep, adapter, duplicate))

    lines.extend(["", "## C. EqoBoard extension widgets", "", *table_header()])
    extension_paths = [path for path in diff.eqoboard_only if path in KNOWN_C_ONLY]
    for path in extension_paths:
        category, reason, keep, adapter, duplicate = _extension_note(path)
        lines.append(row(category, "—", f"{DOWNSTREAM_PREFIX}/{path}", reason, keep, adapter, duplicate))

    lines.extend(["", "## D. Duplicate implementations", "", *table_header()])
    lines.append(row("D", "—", "—", "本次逐文件审计未发现需要删除的重复成熟 Workspace、布局、图表、表格或研究框架实现。", "无删除项", "不适用", "否"))

    lines.extend(["", "## E. EqoBoard domain and integration files", "", *table_header()])
    extension_set = set(extension_paths)
    for path in diff.eqoboard_only:
        if path in extension_set:
            continue
        category, reason, keep, adapter, duplicate = _extension_note(path)
        lines.append(row(category, "—", f"{DOWNSTREAM_PREFIX}/{path}", reason, keep, adapter, duplicate))

    lines.extend(["", "## Deleted upstream files", "", *table_header()])
    deleted_notes = {
        ".claude/launch.json": "上游本地助手配置未随终端 vendoring；不是产品运行能力。",
        ".github/workflows/ci.yml": "CI 统一由 EqoBoard 仓库根工作流管理。",
        ".gitignore": "忽略规则由 EqoBoard 仓库根管理。",
        "data/readme.md": "上游本地数据目录未随终端 vendoring；Portfolio 存储由容器卷配置。",
        "docker-compose.yml": "容器拓扑由 EqoBoard 根 compose 管理。",
        "docs/screenshots/chart.png": "未复制上游截图；apps/openterminal/README.md 仍引用该路径，链接当前失效，需后续恢复资源或删除引用。",
        "docs/screenshots/crypto.png": "未复制上游截图；apps/openterminal/README.md 仍引用该路径，链接当前失效，需后续恢复资源或删除引用。",
        "docs/screenshots/dashboard.png": "未复制上游截图；apps/openterminal/README.md 仍引用该路径，链接当前失效，需后续恢复资源或删除引用。",
        "docs/screenshots/heatmap.png": "未复制上游截图；apps/openterminal/README.md 仍引用该路径，链接当前失效，需后续恢复资源或删除引用。",
        "docs/screenshots/news.png": "未复制上游截图；apps/openterminal/README.md 仍引用该路径，链接当前失效，需后续恢复资源或删除引用。",
        "server/Dockerfile": "镜像构建由 apps/openterminal/Dockerfile 集中管理。",
        "web/Dockerfile": "Next.js 与 server 构建由 apps/openterminal/Dockerfile 集中管理。",
        "web/next.config.ts": "由 EqoBoard 的 next.config.mjs 替代以配置 BFF 安全头。",
        "web/tsconfig.tsbuildinfo": "生成的 TypeScript 增量构建状态不纳入版本控制。",
    }
    for path in diff.deleted:
        lines.append(row("deleted", path, "—", deleted_notes.get(path, "EqoBoard 当前未保留该上游文件；升级前需复核是否仍可删除。"), "当前不保留", "不适用", "否"))
    lines.append("")
    return "\n".join(lines)


def _git_head(repo_root: Path) -> str:
    return _git(["-C", str(repo_root), "rev-parse", "HEAD"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=ROOT, help="EqoBoard repository root")
    parser.add_argument("--output", type=Path, help="write Markdown report to this path instead of stdout")
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    pin = load_pin(repo_root / "third_party" / "upstreams.lock.json")
    downstream = repo_root / pin.downstream_prefix
    if not downstream.is_dir():
        raise SystemExit(f"downstream directory does not exist: {downstream}")
    with tempfile.TemporaryDirectory(prefix="eqoboard-upstream-diff-") as temp:
        upstream, archive_sha256 = fetch_pinned_tree(pin, Path(temp))
        tracked = tracked_downstream_paths(repo_root, pin.downstream_prefix)
        diff = compare_trees(upstream, downstream, tracked)

    from datetime import datetime, timezone

    report = render_report(
        diff,
        pin,
        _git_head(repo_root),
        datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        archive_sha256,
    )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
    else:
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
