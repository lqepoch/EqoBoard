"""Static checks for the independently built native web application.

These checks deliberately use only the native app, its container boundary,
and the frozen digest of the protected legacy Pro route. They do not load legacy
source or the migration reference tree, so the native build remains standalone.
"""

from __future__ import annotations

import hashlib
import json
import re
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
        )
        for helper in helpers:
            self.assertTrue(helper.is_file(), f"native workflow helper is required: {helper.name}")
            source = helper.read_text(encoding="utf-8")
            self.assertIn("NATIVE_CANDIDATE_SHA", source, f"candidate SHA must be explicit: {helper.name}")
            self.assertIn('git -C "$repo_root" rev-parse HEAD', source, f"helper must resolve checkout HEAD: {helper.name}")
            self.assertIn('"$checkout_sha" != "$NATIVE_CANDIDATE_SHA"', source)
            for forbidden in FORBIDDEN_PATHS:
                self.assertNotIn(forbidden, source, f"helper depends on a legacy tree: {helper.name}")
            for forbidden_secret in ("ALPACA_KEY", "ALPACA_SECRET", "EQO_ACCESS_TOKEN"):
                self.assertNotIn(forbidden_secret, source, f"helper names a real credential: {helper.name}")
            self.assertIn("GITHUB_ACTIONS", source, f"helper must reject local invocation: {helper.name}")
            self.assertNotIn("NATIVE_SERVER_ONLY_SECRET_SENTINEL_20261015_", source)

        compose_helper = helpers[0].read_text(encoding="utf-8")
        self.assertIn("env -i", compose_helper, "Compose must receive a sanitized environment")
        self.assertIn("--env-file /dev/null", compose_helper, "operator .env files must not enter Compose")
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
        self.assertIn('syft scan "docker:$NATIVE_WEB_IMAGE"', sbom_helper)
        self.assertEqual(sbom_helper.count('--source-version "$NATIVE_CANDIDATE_SHA"'), 2)
        self.assertNotIn('--source-version "$GITHUB_SHA"', sbom_helper)
        self.assertIn('printf \'Candidate: `%s`\\n\\n\' "$NATIVE_CANDIDATE_SHA"', sbom_helper)
        self.assertIn("SPDX-2.3", sbom_helper)
        self.assertIn("RUNNER_TEMP", sbom_helper)


if __name__ == "__main__":
    unittest.main()
