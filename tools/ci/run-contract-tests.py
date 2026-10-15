#!/usr/bin/env python3
"""Run core, OpenBB or Native Python contract tests with explicit ownership."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[2]
OPENBB_PROVENANCE_ID = (
    "test_upstream_provenance.ProvenanceTests.test_openbb_read_only_versioned_contract"
)


def iter_test_cases(suite: unittest.TestSuite) -> Iterable[unittest.TestCase]:
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from iter_test_cases(item)
        else:
            yield item


def test_owner(test: unittest.TestCase) -> str:
    """OpenBB tests opt in by module prefix or within the mixed provenance module."""
    attributed_owner = getattr(test, "_contract_test_owner", None)
    if attributed_owner in {"core", "openbb", "native"}:
        return attributed_owner
    test_id = test.id()
    module = test_id.split(".", 1)[0]
    method = test_id.rsplit(".", 1)[-1]
    if module.startswith("test_native_"):
        return "native"
    if module.startswith("test_openbb_"):
        return "openbb"
    if module == "test_upstream_provenance" and method.startswith("test_openbb_"):
        return "openbb"
    return "core"


def is_loader_failure(test: unittest.TestCase) -> bool:
    return test.__class__.__name__ == "_FailedTest"


def module_owners(filename: str) -> set[str]:
    if filename.startswith("test_native_"):
        return {"native"}
    if filename.startswith("test_openbb_"):
        return {"openbb"}
    if filename == "test_upstream_provenance.py":
        return {"core", "openbb", "native"}
    return {"core"}


def discover_test_cases(owner: str, tests_dir: Path | None = None) -> list[unittest.TestCase]:
    if owner not in {"core", "openbb", "native"}:
        raise ValueError(f"unknown contract-test owner: {owner}")
    sys.path.insert(0, str(ROOT))
    test_root = tests_dir or ROOT / "tests"
    loader = unittest.TestLoader()
    cases: list[unittest.TestCase] = []
    for module_path in sorted(test_root.glob("test_*.py")):
        owners = module_owners(module_path.name)
        if owner not in owners:
            continue
        suite = loader.discover(str(test_root), pattern=module_path.name)
        for case in iter_test_cases(suite):
            # Import failures are represented by unittest.loader._FailedTest,
            # whose synthetic id may no longer identify the selected module.
            # Keep that failure in every lane that selected the module.
            if is_loader_failure(case):
                setattr(case, "_contract_test_owner", owner)
                setattr(case, "_contract_test_module", module_path.stem)
                cases.append(case)
            elif test_owner(case) == owner:
                cases.append(case)
    return cases


def build_suite(
    owner: str,
    cases: Iterable[unittest.TestCase] | None = None,
    tests_dir: Path | None = None,
) -> unittest.TestSuite:
    if owner not in {"core", "openbb", "native"}:
        raise ValueError(f"unknown contract-test owner: {owner}")
    candidate_cases = list(discover_test_cases(owner, tests_dir) if cases is None else cases)
    for case in candidate_cases:
        if is_loader_failure(case) and getattr(case, "_contract_test_owner", None) is None:
            setattr(case, "_contract_test_owner", owner)
    owned_cases = [case for case in candidate_cases if test_owner(case) == owner]

    # The mixed OpenTerminal provenance module must continue to contribute its
    # OpenBB compatibility test to the optional suite. If it is renamed or
    # accidentally omitted, fail rather than silently dropping that coverage.
    provenance_module_failed = any(
        is_loader_failure(case)
        and getattr(case, "_contract_test_module", None) == "test_upstream_provenance"
        for case in owned_cases
    )
    if owner == "openbb" and not provenance_module_failed and not any(
        case.id() == OPENBB_PROVENANCE_ID for case in owned_cases
    ):
        raise RuntimeError(f"required OpenBB-owned contract test is missing: {OPENBB_PROVENANCE_ID}")
    if not owned_cases:
        raise RuntimeError(f"no contract tests discovered for owner: {owner}")
    return unittest.TestSuite(owned_cases)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1 or args[0] not in {"core", "openbb", "native"}:
        print("usage: run-contract-tests.py core|openbb|native", file=sys.stderr)
        return 2

    owner = args[0]
    suite = build_suite(owner)
    count = suite.countTestCases()
    print(f"Running {count} {owner} contract tests")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
