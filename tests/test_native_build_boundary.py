"""Static checks for the independently built native web application.

These checks deliberately use only the native app, its container boundary,
and the frozen digest of the protected legacy Pro route. They do not load legacy
source or the migration reference tree, so the native build remains standalone.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = REPO_ROOT / "apps" / "eqoboard-web"
NATIVE_COMPOSE = REPO_ROOT / "compose.native.yaml"
DEFAULT_COMPOSE = REPO_ROOT / "compose.yaml"
LEGACY_PRO_ROUTE_SHA256 = "0a73087e0f1a137e1af1bd97bc66f451e4ceada0d544a5f797583a6f218c4d1a"

PRODUCTION_CODE_SUFFIXES = {
    ".cjs",
    ".js",
    ".jsx",
    ".mjs",
    ".ts",
    ".tsx",
}
GENERATED_DIRS = {".next", "coverage", "node_modules", "playwright-report", "test-results"}
TEST_DIRS = {"__tests__", "e2e", "test", "tests"}
IMPORT_PATTERN = re.compile(
    r"(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*)['\"]([^'\"]+)['\"]"
)
RUNTIME_PATH_CALL_PATTERN = re.compile(
    r"\b(?:fetch|new\s+(?:URL|Request|Worker|SharedWorker)|"
    r"axios\.(?:request|get|post|put|patch|delete)|"
    r"(?:[A-Za-z_$][\w$]*\.)*(?:readFile|readFileSync|createReadStream)|importScripts)\s*\("
)
FORBIDDEN_PATHS = (
    "apps/openterminal",
    "references/legacy",
)


def native_files() -> list[Path]:
    files: list[Path] = []
    for path in APP_ROOT.rglob("*"):
        if any(part in GENERATED_DIRS for part in path.parts):
            continue
        if path.is_file() or path.is_symlink():
            files.append(path)
    return files


def compose_service_block(compose_text: str, service_name: str) -> str:
    lines = compose_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line == f"  {service_name}:":
            start = index + 1
            break
    if start is None:
        raise AssertionError(f"Compose service {service_name!r} is missing")

    end = len(lines)
    for index in range(start, len(lines)):
        if re.match(r"^  [A-Za-z0-9_.-]+:\s*(?:#.*)?$", lines[index]):
            end = index
            break
    return "\n".join(lines[start:end])


def native_compose_environment_validator() -> str:
    helper_path = REPO_ROOT / "tools" / "native-web-compose-e2e.sh"
    source = helper_path.read_text(encoding="utf-8")
    prefix = "dc config --format json | python3 -c '\n"
    suffix = "\n' \"$expected_web_origin\""
    start = source.index(prefix) + len(prefix)
    end = source.index(suffix, start)
    return source[start:end]


def native_compose_security_fixture() -> dict[str, object]:
    web_origin = "http://127.0.0.1:3440"
    research_origin = "http://localhost:3441"
    terminal_session = "terminal-session-secret"
    research_session = "research-session-secret"
    terminal_gateway = "terminal-gateway-signer-secret"
    research_mdp = "research-mdp-signer-secret"
    return {
        "services": {
            "native-web": {
                "image": "eqoboard-native-web:candidate",
                "read_only": True,
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
                "tmpfs": ["/tmp:rw,noexec,nosuid,size=64m"],
                "environment": {
                    "NEXTAUTH_URL": web_origin,
                    "EQO_PUBLIC_ORIGIN": web_origin,
                    "NEXTAUTH_SECRET": terminal_session,
                    "EQO_GATEWAY_JWT_SECRET": terminal_gateway,
                },
            },
            "native-research": {
                "image": "eqoboard-native-web:candidate",
                "read_only": True,
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
                "tmpfs": ["/tmp:rw,noexec,nosuid,size=64m"],
                "environment": {
                    "NEXTAUTH_URL": research_origin,
                    "EQO_PUBLIC_ORIGIN": research_origin,
                    "NEXTAUTH_SECRET": research_session,
                    "EQO_MDP_URL": "http://market-data-platform:4452",
                    "MDP_RESEARCH_JWT_SECRET": research_mdp,
                },
            },
            "native-mock-oidc": {
                "environment": {
                    "EQO_PUBLIC_ORIGINS": f"{web_origin},{research_origin}",
                },
            },
            "native-mock-gateway": {
                "environment": {"EQO_GATEWAY_JWT_SECRET": terminal_gateway},
            },
            "market-data-platform": {
                "environment": {"MDP_RESEARCH_JWT_SECRET": research_mdp},
            },
        },
    }


def credential_value_accesses(source: str) -> list[str]:
    source = re.sub(r"(?m)^#![^\n]*$", "", source)
    names = r"(?:ALPACA_KEY|ALPACA_SECRET|EQO_ACCESS_TOKEN)"
    patterns = (
        (
            "shell variable expansion",
            re.compile(r"\$\{" + names + r"(?:[^}]*)\}|\$" + names + r"(?![A-Za-z0-9_])"),
        ),
        (
            "shell command reads or forwards a credential",
            re.compile(r"\b(?:printenv|export|env)\b[^\n;]*\b" + names + r"\b"),
        ),
        ("credential environment assignment", re.compile(r"\b" + names + r"\s*[:=]")),
        (
            "Python or Node environment read",
            re.compile(
                r"\bos\.environ\b|\bos\.getenv\s*\(|\bgetenv\s*\(|"
                r"\bprocess\.env(?:\.|\[)"
            ),
        ),
        (
            "ambient environment read or forwarding",
            re.compile(
                r"(?m)^[ \t]*(?:command[ \t]+)?(?:printenv\b|env\b(?![ \t]+-i(?:[ \t]|$)))|"
                r"\$\([ \t]*(?:command[ \t]+)?(?:printenv|env)\b(?![ \t]+-i)"
            ),
        ),
    )
    return [
        f"{label}: {match.group(0)}"
        for label, pattern in patterns
        if (match := pattern.search(source)) is not None
    ]


def is_test_source(path: Path, app_root: Path) -> bool:
    relative = path.relative_to(app_root)
    if any(part.lower() in TEST_DIRS for part in relative.parts[:-1]):
        return True
    return ".test." in path.name or ".spec." in path.name


def strip_javascript_comments(source: str) -> str:
    """Remove comments while preserving quoted strings and source offsets."""
    characters = list(source)
    index = 0
    quote: str | None = None
    while index < len(source):
        char = source[index]
        if quote is not None:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in ("'", '"', "`"):
            quote = char
            index += 1
            continue
        if source.startswith("//", index):
            while index < len(source) and source[index] not in "\r\n":
                characters[index] = " "
                index += 1
            continue
        if source.startswith("/*", index):
            characters[index] = characters[index + 1] = " "
            index += 2
            while index < len(source) and not source.startswith("*/", index):
                if source[index] not in "\r\n":
                    characters[index] = " "
                index += 1
            if index < len(source):
                characters[index] = characters[index + 1] = " "
                index += 2
            continue
        index += 1
    return "".join(characters)


def first_call_argument(source: str, call_start: int) -> str:
    opening = source.find("(", call_start)
    if opening < 0:
        return ""
    depth = 0
    quote: str | None = None
    index = opening + 1
    while index < len(source):
        char = source[index]
        if quote is not None:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in ("'", '"', "`"):
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            if depth == 0:
                return source[opening + 1:index]
            depth -= 1
        elif char == "," and depth == 0:
            return source[opening + 1:index]
        index += 1
    return source[opening + 1:]


def contains_forbidden_source_path(value: str) -> str | None:
    normalized = value.replace("\\", "/")
    return next((forbidden for forbidden in FORBIDDEN_PATHS if forbidden in normalized), None)


def production_source_violations(app_root: Path) -> list[str]:
    """Find production module/path dependencies without rejecting provenance text."""
    resolved_root = app_root.resolve()
    violations: list[str] = []
    for path in app_root.rglob("*"):
        if any(part in GENERATED_DIRS for part in path.parts):
            continue
        if not (path.is_file() or path.is_symlink()):
            continue
        if path.is_symlink():
            if not path.resolve().is_relative_to(resolved_root):
                violations.append(f"symlink escapes native source tree: {path}")
            continue
        if path.suffix.lower() not in PRODUCTION_CODE_SUFFIXES or is_test_source(path, app_root):
            continue

        source = path.read_text(encoding="utf-8", errors="replace")
        code = strip_javascript_comments(source)
        for specifier in IMPORT_PATTERN.findall(code):
            forbidden = contains_forbidden_source_path(specifier)
            if forbidden:
                violations.append(f"production import references {forbidden}: {path} -> {specifier}")
                continue
            if specifier.startswith(("./", "../")):
                imported = (path.parent / specifier).resolve()
                if not imported.is_relative_to(resolved_root):
                    violations.append(f"relative import escapes native app: {path} -> {specifier}")

        for call in RUNTIME_PATH_CALL_PATTERN.finditer(code):
            argument = first_call_argument(code, call.start())
            forbidden = contains_forbidden_source_path(argument)
            if forbidden:
                violations.append(f"runtime URL or file call references {forbidden}: {path}")
    return violations


class NativeBuildBoundaryTests(unittest.TestCase):
    def test_native_package_is_standalone_and_has_no_legacy_local_dependency(self) -> None:
        package_path = APP_ROOT / "package.json"
        lock_path = APP_ROOT / "package-lock.json"
        self.assertTrue(package_path.is_file(), "native app package.json is required")
        self.assertTrue(lock_path.is_file(), "native app package-lock.json is required")

        package = json.loads(package_path.read_text(encoding="utf-8"))
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        self.assertNotIn("workspaces", package, "native app must install as an independent package")
        scripts = package.get("scripts", {})
        for script in (
            "lint",
            "typecheck",
            "test:unit",
            "test:component",
            "test:api",
            "test:e2e",
            "build",
        ):
            self.assertTrue(scripts.get(script), f"native package script {script!r} is required")

        dependency_maps = (
            package.get("dependencies", {}),
            package.get("devDependencies", {}),
            package.get("optionalDependencies", {}),
            package.get("peerDependencies", {}),
        )
        for dependencies in dependency_maps:
            for name, specifier in dependencies.items():
                value = str(specifier)
                self.assertFalse(
                    value.startswith(("file:", "workspace:")),
                    f"{name} must not escape the native standalone install via {value!r}",
                )
                for forbidden in FORBIDDEN_PATHS:
                    self.assertNotIn(forbidden, f"{name} {value}")

        lock_packages = lock.get("packages", {})
        self.assertIn("", lock_packages, "npm lock must describe the standalone root package")
        market_contract = "@lqepoch/trading-core-contracts"
        root_dependencies = lock_packages[""].get("dependencies", {})
        self.assertIn(market_contract, root_dependencies, "financial contracts must come from pinned trading-core")
        contract_specifier = str(root_dependencies[market_contract])
        contract_metadata = lock_packages.get(f"node_modules/{market_contract}", {})
        locked_resolution = str(contract_metadata.get("resolved", ""))
        immutable_git_pin = re.search(r"#[0-9a-f]{40}$", contract_specifier) or re.search(
            r"#[0-9a-f]{40}$", locked_resolution
        )
        exact_registry_pin = re.fullmatch(r"\d+\.\d+\.\d+", contract_specifier)
        self.assertTrue(
            immutable_git_pin or exact_registry_pin,
            "trading-core contract must resolve to an immutable commit or exact package version",
        )
        if exact_registry_pin:
            self.assertEqual(contract_metadata.get("version"), contract_specifier)
            self.assertTrue(contract_metadata.get("integrity"), "registry contract lock must include integrity")
        for package_path, metadata in lock_packages.items():
            if not package_path:
                continue
            self.assertFalse(
                metadata.get("link", False),
                f"native lock contains a linked workspace package: {package_path}",
            )
            resolved = str(metadata.get("resolved", ""))
            self.assertFalse(resolved.startswith("file:"), f"local lock resolution: {resolved}")
            for forbidden in FORBIDDEN_PATHS:
                self.assertNotIn(forbidden, f"{package_path} {resolved}")

    def test_native_source_has_no_legacy_imports_or_paths_outside_the_app(self) -> None:
        self.assertTrue(APP_ROOT.is_dir(), "native app directory is required")
        violations = production_source_violations(APP_ROOT)
        self.assertEqual(violations, [], "\n".join(violations))

    def test_production_source_allows_legacy_provenance_metadata_and_comments(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            app_root = Path(temporary_directory) / "eqoboard-web"
            source_path = app_root / "lib" / "provider.ts"
            source_path.parent.mkdir(parents=True)
            source_path.write_text(
                """/** Adapted provider; source: apps/openterminal/server/src/providers/secedgar.ts. */
export const provenance = Object.freeze({
  sourcePath: "apps/openterminal/server/src/providers/secedgar.ts",
});
""",
                encoding="utf-8",
            )
            self.assertEqual(production_source_violations(app_root), [])

    def test_production_source_rejects_legacy_imports_runtime_urls_and_relative_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            app_root = Path(temporary_directory) / "eqoboard-web"
            source_dir = app_root / "lib"
            source_dir.mkdir(parents=True)
            (source_dir / "legacy-import.ts").write_text(
                'import { readProvider } from "apps/openterminal/server/src/providers/secedgar";\n'
                'const legacyPath = require.resolve("references/legacy/provider.ts");\n',
                encoding="utf-8",
            )
            (source_dir / "legacy-url.ts").write_text(
                'export const load = () => fetch(new URL("../../apps/openterminal/provider.json", import.meta.url));\n',
                encoding="utf-8",
            )
            (source_dir / "relative-escape.ts").write_text(
                'import "../../../../outside.mjs";\n',
                encoding="utf-8",
            )

            violations = production_source_violations(app_root)
            self.assertTrue(any("production import references apps/openterminal" in item for item in violations))
            self.assertTrue(any("production import references references/legacy" in item for item in violations))
            self.assertTrue(any("runtime URL or file call references apps/openterminal" in item for item in violations))
            self.assertTrue(any("relative import escapes native app" in item for item in violations))

    def test_protected_legacy_pro_route_is_not_copied_into_native_source(self) -> None:
        exact_route = APP_ROOT / "app" / "api" / "futu" / "[...action]" / "route.ts"
        self.assertFalse(exact_route.exists(), "native app must not contain the legacy Pro route path")

        matching_files = [
            str(path.relative_to(APP_ROOT))
            for path in native_files()
            if path.is_file()
            and hashlib.sha256(path.read_bytes()).hexdigest() == LEGACY_PRO_ROUTE_SHA256
        ]
        self.assertEqual(
            matching_files,
            [],
            "native source contains a byte-identical copy of the protected Pro route",
        )

    def test_compose_e2e_validates_the_frozen_research_signer_boundary(self) -> None:
        validator = native_compose_environment_validator()
        web_origin = "http://127.0.0.1:3440"
        research_origin = "http://localhost:3441"
        oidc_origins = f"{web_origin},{research_origin}"

        def run_validator(config: dict[str, object]) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [sys.executable, "-c", validator, web_origin, research_origin, oidc_origins],
                input=json.dumps(config),
                capture_output=True,
                text=True,
                check=False,
            )

        valid = native_compose_security_fixture()
        accepted = run_validator(valid)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)

        reordered_options = json.loads(json.dumps(valid))
        for service_name in ("native-web", "native-research"):
            reordered_options["services"][service_name]["tmpfs"] = [
                "/tmp:size=64m,nosuid,noexec,rw"
            ]
        accepted_reordered = run_validator(reordered_options)
        self.assertEqual(accepted_reordered.returncode, 0, accepted_reordered.stderr)

        invalid_cases: list[tuple[str, dict[str, object], str]] = []
        for name in (
            "EQO_RUST_URL",
            "EQO_GATEWAY_JWT_SECRET",
            "EQO_RESEARCH_JWT_SECRET",
            "MDP_TERMINAL_JWT_SECRET",
            "ENGINE_RESEARCH_JWT_SECRET",
            "EQO_ENGINE_URL",
            "QUANT_RESEARCH_JWT_SECRET",
            "ALPACA_SECRET",
        ):
            candidate = json.loads(json.dumps(valid))
            candidate["services"]["native-research"]["environment"][name] = "unexpected-secret"
            invalid_cases.append(
                (
                    f"research rejects {name}",
                    candidate,
                    f"native-research must not receive {name}",
                )
            )

        candidate = json.loads(json.dumps(valid))
        candidate["services"]["native-web"]["environment"]["EQO_GATEWAY_JWT_SECRET"] = (
            candidate["services"]["native-web"]["environment"]["NEXTAUTH_SECRET"]
        )
        invalid_cases.append(
            (
                "terminal Gateway signer cannot reuse a session key",
                candidate,
                "terminal Gateway signer must be distinct from both app session secrets",
            )
        )

        candidate = json.loads(json.dumps(valid))
        candidate["services"]["native-mock-gateway"]["environment"]["EQO_GATEWAY_JWT_SECRET"] = (
            "different-gateway-fixture-secret"
        )
        invalid_cases.append(
            (
                "Gateway fixture verifies the terminal signer",
                candidate,
                "Gateway fixture must verify the terminal Gateway signer",
            )
        )

        for reused_name in ("terminal session", "research session", "terminal Gateway signer"):
            candidate = json.loads(json.dumps(valid))
            if reused_name == "terminal session":
                reused = candidate["services"]["native-web"]["environment"]["NEXTAUTH_SECRET"]
            elif reused_name == "research session":
                reused = candidate["services"]["native-research"]["environment"]["NEXTAUTH_SECRET"]
            else:
                reused = candidate["services"]["native-web"]["environment"]["EQO_GATEWAY_JWT_SECRET"]
            candidate["services"]["native-research"]["environment"]["MDP_RESEARCH_JWT_SECRET"] = reused
            candidate["services"]["market-data-platform"]["environment"]["MDP_RESEARCH_JWT_SECRET"] = reused
            invalid_cases.append(
                (
                    f"MDP signer differs from {reused_name}",
                    candidate,
                    "MDP delegation secret must differ from both sessions and terminal Gateway signer",
                )
            )

        candidate = json.loads(json.dumps(valid))
        candidate["services"]["market-data-platform"]["environment"]["MDP_RESEARCH_JWT_SECRET"] = (
            "different-mdp-fixture-secret"
        )
        invalid_cases.append(
            (
                "MDP fixture verifies the Research signer",
                candidate,
                "research app and MDP fixture must share only the MDP delegation secret",
            )
        )

        candidate = json.loads(json.dumps(valid))
        candidate["services"]["native-web"]["tmpfs"].append("/var/tmp:rw")
        invalid_cases.append(
            (
                "terminal rejects multiple tmpfs mounts",
                candidate,
                "native-web must have exactly one /tmp tmpfs mount",
            )
        )

        candidate = json.loads(json.dumps(valid))
        candidate["services"]["native-research"]["tmpfs"].append("/var/tmp:rw")
        invalid_cases.append(
            (
                "research rejects multiple tmpfs mounts",
                candidate,
                "native-research must have exactly one /tmp tmpfs mount",
            )
        )

        candidate = json.loads(json.dumps(valid))
        candidate["services"]["native-research"]["tmpfs"] = [
            "/tmp:rw,nosuid,size=64m"
        ]
        invalid_cases.append(
            (
                "research tmpfs requires noexec",
                candidate,
                "native-research /tmp tmpfs must use rw,noexec,nosuid,size=64m",
            )
        )

        candidate = json.loads(json.dumps(valid))
        candidate["services"]["native-web"]["security_opt"] = []
        invalid_cases.append(
            (
                "terminal requires no-new-privileges",
                candidate,
                "native-web must enable no-new-privileges",
            )
        )

        for label, candidate, expected_error in invalid_cases:
            with self.subTest(label=label):
                rejected = run_validator(candidate)
                self.assertNotEqual(rejected.returncode, 0, f"accepted invalid fixture: {label}")
                self.assertIn(expected_error, rejected.stderr)

    def test_credential_guard_allows_denylist_names_but_rejects_value_access(self) -> None:
        harmless_denylist = '''
research_forbidden_secrets = ("ALPACA_KEY", "ALPACA_SECRET", "EQO_ACCESS_TOKEN")
for name in research_forbidden_secrets:
    if research.get(name):
        reject(name)
'''
        self.assertEqual(credential_value_accesses(harmless_denylist), [])
        isolated_allowlist = 'env -i PATH="$PATH" NATIVE_WEB_IMAGE="$NATIVE_WEB_IMAGE"'
        self.assertEqual(credential_value_accesses(isolated_allowlist), [])

        actual_reads = (
            'value = "$ALPACA_KEY"',
            'value = "${ALPACA_SECRET}"',
            'value = os.environ.get("ALPACA_KEY")',
            "for key, value in os.environ.items(): pass",
            'value = os.getenv("ALPACA_SECRET")',
            'value = process.env.EQO_ACCESS_TOKEN',
            'env EQO_ACCESS_TOKEN="$EQO_ACCESS_TOKEN"',
            "env",
            "printenv",
            'export ALPACA_SECRET="$ALPACA_SECRET"',
        )
        for source in actual_reads:
            with self.subTest(source=source):
                self.assertTrue(credential_value_accesses(source), source)

    def test_container_context_is_the_native_app_only(self) -> None:
        dockerfile = APP_ROOT / "Dockerfile"
        dockerignore = APP_ROOT / ".dockerignore"
        self.assertTrue(dockerfile.is_file(), "native app Dockerfile is required")
        self.assertTrue(dockerignore.is_file(), "native app .dockerignore is required")

        dockerfile_text = dockerfile.read_text(encoding="utf-8")
        self.assertNotRegex(dockerfile_text, r"(?i)(?:^|[\s/])(?:apps/openterminal|references/legacy)(?:[\s/]|$)")
        for line in dockerfile_text.splitlines():
            if not re.match(r"\s*(?:COPY|ADD)\s", line, flags=re.IGNORECASE):
                continue
            if re.search(r"--from(?:=|\s)", line, flags=re.IGNORECASE):
                continue
            self.assertNotRegex(line, r"(?:^|/)\.\.(?:/|$)", f"Docker source escapes app context: {line}")
            self.assertNotRegex(line, r"(?i)\bADD\s+https?://", f"remote Docker ADD is not allowed: {line}")
            for forbidden in FORBIDDEN_PATHS:
                self.assertNotIn(forbidden, line)

        ignored = {
            line.strip().lstrip("/")
            for line in dockerignore.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#") and not line.lstrip().startswith("!")
        }
        for required in (".git", ".next", ".env*", "node_modules", "playwright-report", "test-results"):
            self.assertTrue(
                any(required in pattern for pattern in ignored),
                f"native Docker context must exclude {required}",
            )

        self.assertTrue(NATIVE_COMPOSE.is_file(), "opt-in native Compose file is required")
        native_compose = NATIVE_COMPOSE.read_text(encoding="utf-8")
        self.assertNotIn("apps/openterminal", native_compose)
        self.assertNotIn("references/legacy", native_compose)
        web_service = compose_service_block(native_compose, "native-web")
        self.assertRegex(web_service, r"(?m)^\s*context:\s*['\"]?\./apps/eqoboard-web['\"]?\s*(?:#.*)?$")
        self.assertRegex(web_service, r"(?m)^\s*profiles:\s*(?:\n\s*-\s*native\s*|[^\n]*\bnative\b)")
        self.assertRegex(web_service, r"(?m)^\s*image:\s*.*\$\{NATIVE_WEB_IMAGE")
        self.assertRegex(web_service, r"127\.0\.0\.1:\$\{NATIVE_WEB_HOST_PORT:-3440\}")
        self.assertNotRegex(native_compose, r"(?m)^  market-data-platform:\s*$", "base Compose must not start the MDP fixture")
        for forbidden in ("native-mock-oidc", "native-mock-gateway", "4450", "4451"):
            self.assertNotIn(forbidden, native_compose, "base Compose must contain no E2E fixtures")
        for forbidden_secret in ("ALPACA_KEY", "ALPACA_SECRET", "EQO_ACCESS_TOKEN"):
            interpolation = rf"\$(?:\{{{forbidden_secret}(?:[:?][^}}]*)?\}}|{forbidden_secret}(?![A-Za-z0-9_]))"
            self.assertNotRegex(native_compose, interpolation)

        e2e_overlay_path = REPO_ROOT / "compose.native.e2e.yaml"
        self.assertTrue(e2e_overlay_path.is_file(), "isolated mock Compose overlay is required")
        e2e_overlay = e2e_overlay_path.read_text(encoding="utf-8")
        self.assertNotIn("apps/openterminal", e2e_overlay)
        self.assertNotIn("references/legacy", e2e_overlay)
        research_service = compose_service_block(native_compose + "\n" + e2e_overlay, "native-research")
        self.assertRegex(research_service, r"(?m)^\s*profiles:\s*(?:\n\s*-\s*native\s*|[^\n]*\bnative\b)")
        self.assertRegex(research_service, r"(?m)^\s*image:\s*.*\$\{NATIVE_WEB_IMAGE")
        self.assertRegex(research_service, r"127\.0\.0\.1:3441:3000")
        self.assertIn("http://localhost:3441", research_service)
        oidc_service = compose_service_block(e2e_overlay, "native-mock-oidc")
        gateway_service = compose_service_block(e2e_overlay, "native-mock-gateway")
        mdp_service = compose_service_block(e2e_overlay, "market-data-platform")
        self.assertIn("4450", oidc_service)
        self.assertIn("4451", gateway_service)
        self.assertIn("4452", mdp_service)
        self.assertIn("127.0.0.1", oidc_service)
        self.assertIn("127.0.0.1", gateway_service)
        self.assertIn("127.0.0.1", mdp_service)
        self.assertIn("EQO_PUBLIC_ORIGINS", oidc_service)
        self.assertIn("localhost:3441", oidc_service)
        self.assertIn("mdp-fixture.mjs", mdp_service)
        for service in (oidc_service, gateway_service, mdp_service):
            self.assertRegex(service, r"(?m)^\s*profiles:\s*(?:\n\s*-\s*native\s*|[^\n]*\bnative\b)")
        self.assertNotRegex(e2e_overlay, r"\$\{(?:ALPACA_KEY|ALPACA_SECRET|EQO_ACCESS_TOKEN)(?:[:?][^}]*)?\}")
        sentinel_values = set(
            re.findall(
                r"NATIVE_SERVER_ONLY_SECRET_SENTINEL_20261015_[A-Z0-9_]+",
                native_compose + e2e_overlay,
            )
        )
        self.assertGreaterEqual(len(sentinel_values), 5, "terminal, research, OIDC, Gateway and MDP fixtures need isolated fake keys")

        default_compose = DEFAULT_COMPOSE.read_text(encoding="utf-8")
        self.assertNotIn("./apps/eqoboard-web", default_compose)

    def test_native_helpers_are_actions_only_and_use_scoped_inputs(self) -> None:
        helpers = (
            REPO_ROOT / "tools" / "native-web-compose-e2e.sh",
            REPO_ROOT / "tools" / "native-web-sbom.sh",
            REPO_ROOT / "tools" / "native-web-format-proposal.sh",
            REPO_ROOT / "tools" / "native-web-secret-scan.sh",
        )
        for helper in helpers:
            self.assertTrue(helper.is_file(), f"native workflow helper is required: {helper.name}")
            source = helper.read_text(encoding="utf-8")
            self.assertIn("NATIVE_CANDIDATE_SHA", source, f"candidate SHA must be explicit: {helper.name}")
            self.assertIn('git -C "$repo_root" rev-parse HEAD', source, f"helper must resolve checkout HEAD: {helper.name}")
            self.assertIn('"$checkout_sha" != "$NATIVE_CANDIDATE_SHA"', source)
            for forbidden in FORBIDDEN_PATHS:
                self.assertNotIn(forbidden, source, f"helper depends on a legacy tree: {helper.name}")
            self.assertEqual(
                credential_value_accesses(source),
                [],
                f"helper must not read or propagate real credential values: {helper.name}",
            )
            self.assertIn("GITHUB_ACTIONS", source, f"helper must reject local invocation: {helper.name}")
            self.assertNotIn("NATIVE_SERVER_ONLY_SECRET_SENTINEL_20261015_", source)

        compose_helper = helpers[0].read_text(encoding="utf-8")
        self.assertIn("env -i", compose_helper, "Compose must receive a sanitized environment")
        self.assertIn("--env-file /dev/null", compose_helper, "operator .env files must not enter Compose")
        self.assertIn('COMPOSE_PROJECT_NAME="$compose_project"', compose_helper)
        self.assertIn('NATIVE_WEB_IMAGE="$NATIVE_WEB_IMAGE"', compose_helper)
        self.assertIn('NATIVE_WEB_HOST_PORT="$native_web_host_port"', compose_helper)
        self.assertIn("NATIVE_WEB_HOST_PORT", compose_helper)
        self.assertIn("compose.native.e2e.yaml", compose_helper)
        self.assertIn("NEXTAUTH_URL", compose_helper)
        self.assertIn("EQO_PUBLIC_ORIGIN", compose_helper)
        self.assertIn("E2E_WEB_ORIGIN=", compose_helper)
        self.assertIn("E2E_RESEARCH_WEB_ORIGIN=", compose_helper)
        self.assertIn("E2E_FIXTURE_CONTROL_ORIGIN=", compose_helper)
        self.assertIn("E2E_MDP_FIXTURE_CONTROL_ORIGIN=", compose_helper)
        self.assertIn('E2E_CANDIDATE_SHA="$NATIVE_CANDIDATE_SHA"', compose_helper)
        self.assertIn("native-research", compose_helper)
        self.assertIn("market-data-platform", compose_helper)
        self.assertIn("EQO_PUBLIC_ORIGINS", compose_helper)
        self.assertIn('"$origin/healthz"', compose_helper)
        self.assertIn("npm run test:e2e", compose_helper)
        self.assertIn("down --volumes --remove-orphans", compose_helper)

        sbom_helper = helpers[1].read_text(encoding="utf-8")
        self.assertIn('syft scan "dir:$app_dir"', sbom_helper)
        self.assertIn('syft scan "docker:$NATIVE_IMAGE_CONFIG_DIGEST"', sbom_helper)
        self.assertNotIn('syft scan "docker:$NATIVE_WEB_IMAGE"', sbom_helper)
        self.assertEqual(sbom_helper.count('--source-version "$NATIVE_CANDIDATE_SHA"'), 2)
        self.assertNotIn('--source-version "$GITHUB_SHA"', sbom_helper)
        self.assertIn('printf \'Candidate: `%s`\\n\\n\' "$NATIVE_CANDIDATE_SHA"', sbom_helper)
        self.assertIn("SPDX-2.3", sbom_helper)
        self.assertIn("RUNNER_TEMP", sbom_helper)
        self.assertIn(
            'NATIVE_IMAGE_CONFIG_DIGEST:?NATIVE_IMAGE_CONFIG_DIGEST must identify the built image config',
            sbom_helper,
        )
        self.assertIn(
            'NATIVE_IMAGE_BUILD_DIGEST:?NATIVE_IMAGE_BUILD_DIGEST must identify the build output manifest',
            sbom_helper,
        )
        self.assertIn('^sha256:[0-9a-f]{64}$', sbom_helper)
        self.assertIn('docker image inspect "$NATIVE_WEB_IMAGE" --format', sbom_helper)
        self.assertIn(
            'actual_image_config_digest" != "$NATIVE_IMAGE_CONFIG_DIGEST"',
            sbom_helper,
        )
        self.assertIn('actual_image_revision" != "$NATIVE_CANDIDATE_SHA"', sbom_helper)
        self.assertIn('org.opencontainers.image.revision', sbom_helper)
        self.assertIn('"configDigest": config_digest', sbom_helper)
        self.assertIn('"buildDigest": build_digest', sbom_helper)
        self.assertIn('"tree": candidate_tree', sbom_helper)
        self.assertIn('"packageLockSha256": lock_sha256', sbom_helper)
        self.assertIn('artifact(source_path, "source-and-lock-inventory")', sbom_helper)
        self.assertIn('artifact(image_path, "production-runtime-image-inventory")', sbom_helper)
        self.assertIn('--network=none --read-only', sbom_helper)
        self.assertIn('--cap-drop=ALL --security-opt=no-new-privileges:true', sbom_helper)
        self.assertIn('"$NATIVE_IMAGE_CONFIG_DIGEST" --input-type=module -', sbom_helper)
        self.assertIn('tools/ci/native-binary-inventory.mjs', sbom_helper)
        self.assertIn('binary_inventory.get("candidateSha") != candidate_sha', sbom_helper)
        self.assertIn('binary_inventory.get("imageConfigDigest") != config_digest', sbom_helper)
        self.assertIn('runtime-native-file-identity-not-license-clearance', sbom_helper)
        self.assertIn('"releaseAcceptance": "NOT_RELEASE"', sbom_helper)
        self.assertIn('"licenseClosure": "NOT_CLAIMED"', sbom_helper)
        self.assertIn('"$(basename "$identity_receipt")" > SHA256SUMS', sbom_helper)
        diagnostic_start = sbom_helper.index("# BEGIN bounded candidate source drift diagnostic.")
        diagnostic_end = sbom_helper.index("# END bounded candidate source drift diagnostic.", diagnostic_start)
        drift_diagnostic = sbom_helper[diagnostic_start:diagnostic_end]
        self.assertIn("MAX_DIAGNOSTIC_PATHS = 32", drift_diagnostic)
        self.assertIn("if listed_path_count < MAX_DIAGNOSTIC_PATHS:", drift_diagnostic)
        self.assertIn('"--name-status"', drift_diagnostic)
        self.assertIn('"--no-renames"', drift_diagnostic)
        self.assertIn('"ls-files", "--others", "--exclude-standard", "-z"', drift_diagnostic)
        self.assertIn('"native-web-source-drift.json"', drift_diagnostic)
        self.assertIn('"$RUNNER_TEMP" <<\'PY\'', sbom_helper[diagnostic_start:])
        self.assertIn('"trackedChangeCount": counts["tracked"]', drift_diagnostic)
        self.assertIn('"untrackedPathCount": counts["untracked"]', drift_diagnostic)
        self.assertIn('"trackedChanges": listed["tracked"]', drift_diagnostic)
        self.assertIn('"untrackedPaths": listed["untracked"]', drift_diagnostic)
        self.assertIn('os.O_WRONLY | os.O_CREAT | os.O_EXCL', drift_diagnostic)
        self.assertIn("ensure_ascii=True", drift_diagnostic)
        self.assertIn("json.dumps(entry['path'], ensure_ascii=True)", drift_diagnostic)
        self.assertNotRegex(drift_diagnostic, r"--(?:patch|binary|word-diff)\b")
        self.assertNotIn("os.environ", drift_diagnostic)
        self.assertNotIn("git show", drift_diagnostic)

        format_helper = helpers[2].read_text(encoding="utf-8")
        self.assertIn('git -C "$repo_root" archive --format=tar "$NATIVE_CANDIDATE_SHA" -- apps/eqoboard-web', format_helper)
        self.assertIn('biome_bin="$app_dir/node_modules/.bin/biome"', format_helper)
        self.assertIn('"$biome_bin" format --write .', format_helper)
        self.assertIn('cd "$archive_app_dir"', format_helper)
        self.assertIn('git -C "$source_root" diff --cached --binary', format_helper)
        self.assertIn('proposal_dir="$runner_temp_real/native-format-proposal"', format_helper)
        self.assertIn('"acceptance": "NOT_ACCEPTANCE"', format_helper)
        self.assertIn("8388608", format_helper)
        self.assertIn("patch_sha256", format_helper)
        self.assertIn("archive_sha256", format_helper)
        self.assertNotIn("--unsafe", format_helper)
        self.assertNotIn("lint --write", format_helper)


class NativeLocalLauncherTests(unittest.TestCase):
    """Static security contracts for the Actions-driven Windows launcher."""

    START = REPO_ROOT / "tools" / "start-native-local.ps1"
    STOP = REPO_ROOT / "tools" / "stop-native-local.ps1"

    def test_startup_validates_the_immutable_package_and_candidate(self) -> None:
        source = self.START.read_text(encoding="utf-8")
        for required in (
            "runtime.json",
            "SHA256SUMS",
            "Get-FileHash",
            "candidateSha",
            "ExpectedSha",
            "LOCAL_EVALUATION_ONLY",
            "22.23.3",
            "win32",
            "x64",
            "execution -cne 'disabled'",
            "FileAttributes]::ReparsePoint",
        ):
            self.assertIn(required, source)
        self.assertIn("$listed.Count -ne $actualFiles.Count", source)
        self.assertIn("$EnvPath = Join-Path $repo '.env'", source)
        self.assertNotIn("Invoke-Expression", source)

    def test_services_receive_separate_scrubbed_environment_allowlists(self) -> None:
        source = self.START.read_text(encoding="utf-8")
        self.assertIn("GetEnvironmentVariables([EnvironmentVariableTarget]::Machine).Keys", source)
        self.assertIn("GetEnvironmentVariables([EnvironmentVariableTarget]::Process).Keys", source)
        self.assertIn("$environment[[string]$name] = $null", source)
        self.assertIn("-WindowStyle Hidden", source)
        self.assertIn("-Environment $Environment", source)
        self.assertNotIn("-UseNewEnvironment", source)
        gateway = source.split("$gatewayEnvironment = New-ServiceEnvironment", 1)[1].split(
            "$webEnvironment = New-ServiceEnvironment", 1
        )[0]
        web = source.split("$webEnvironment = New-ServiceEnvironment", 1)[1].split(
            "$gatewayExe = Join-Path", 1
        )[0]
        self.assertIn("EQO_RESEARCH_JWT_SECRET", gateway)
        self.assertIn("FUTU_OPEND_WEBSOCKET_KEY", gateway)
        self.assertIn("EQO_GATEWAY_JWT_SECRET", gateway)
        self.assertIn("EQO_AUDIT_PATH = (Join-Path $auditDir 'order-events.jsonl')", gateway)
        self.assertIn("EQO_WEB_DIST = (Join-Path $gatewayDirectory 'empty')", gateway)
        self.assertIn("EQO_GATEWAY_JWT_SECRET", web)
        self.assertIn("NEXTAUTH_SECRET", web)
        self.assertNotIn("EQO_RESEARCH_JWT_SECRET", web)
        self.assertNotIn("FUTU_OPEND_", web)
        self.assertNotRegex(web, r"\bALPACA_[A-Z0-9_]+\b")
        self.assertNotRegex(gateway, r"\bALPACA_[A-Z0-9_]+\b")
        # The launcher may compare private credentials to reject signer reuse;
        # neither service allowlist may receive these unused Futu-mode secrets.
        self.assertIn("Provider credentials must not be reused as service signing secrets", source)
        self.assertIn("EQO_EXECUTION_MODE = 'disabled'", gateway)
        self.assertIn("EQO_EXECUTION_MODE = 'disabled'", web)

    def test_local_bind_and_private_windows_state_are_enforced(self) -> None:
        start = self.START.read_text(encoding="utf-8")
        stop = self.STOP.read_text(encoding="utf-8")
        for fixed in (
            "http://127.0.0.1:3000",
            "127.0.0.1:8080",
            "EQO_LOCAL_BIND",
            "Assert-PortAvailable",
            "Assert-OwnedListener",
        ):
            self.assertIn(fixed, start)
        self.assertIn("SetAccessRuleProtection($true, $false)", start)
        self.assertIn("LocalSystemSid", start)
        self.assertIn("AreAccessRulesProtected", start)
        self.assertIn("Assert-PrivateAcl -Path $envFile", start)
        self.assertIn("startTimeUtcTicks", start)
        self.assertIn("repoRoot = $script:RepositoryRoot", start)
        self.assertIn("$script:RepositoryRoot = $repo", start)
        self.assertIn("Write-RunState -Root $dataRoot", start)
        self.assertRegex(start, r"\$\w+\.Kill\(\$true\)")
        self.assertIn("$actualStart -cne $Record.startTimeUtcTicks", stop)
        self.assertIn("$process.MainModule.FileName", stop)
        self.assertIn("$process.Kill($true)", stop)
        self.assertIn("State files are retained for recovery", stop)


if __name__ == "__main__":
    unittest.main()
