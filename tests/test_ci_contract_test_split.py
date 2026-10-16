"""Guard the ownership boundary between always-on and optional contract tests."""

import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "tools" / "ci" / "run-contract-tests.py"
SPEC = importlib.util.spec_from_file_location("contract_test_runner", RUNNER_PATH)
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ContractTestSplitTests(unittest.TestCase):
    class CaseId:
        def __init__(self, test_id):
            self._test_id = test_id

        def id(self):
            return self._test_id

    def test_new_test_modules_default_to_core_unless_they_opt_into_openbb(self):
        core_case = self.CaseId("test_new_core_module.NewTests.test_added")
        openbb_case = self.CaseId("test_openbb_new.NewTests.test_added")
        self.assertEqual(runner.test_owner(core_case), "core")
        self.assertEqual(runner.test_owner(openbb_case), "openbb")
        self.assertEqual(runner.module_owners("test_new_core_module.py"), {"core"})
        self.assertEqual(runner.module_owners("test_openbb_future.py"), {"openbb"})
        self.assertEqual(runner.module_owners("test_upstream_provenance.py"), {"core", "openbb"})

    def test_native_modules_have_one_owner_and_are_not_imported_by_core(self):
        self.assertEqual(runner.test_owner(self.CaseId("test_native_boundary.Tests.test_no_escape")),
                         "native")
        self.assertEqual(runner.module_owners("test_native_boundary.py"), {"native"})
        with tempfile.TemporaryDirectory(prefix="eqoboard-native-test-split-") as temporary:
            test_root = pathlib.Path(temporary)
            (test_root / "test_native_broken.py").write_text(
                "raise RuntimeError('native-only import failure')\n", encoding="utf-8")
            self.assertEqual(runner.discover_test_cases("core", test_root), [])
            self.assertEqual(runner.discover_test_cases("openbb", test_root), [])
            cases = runner.discover_test_cases("native", test_root)
            self.assertTrue(any(runner.is_loader_failure(case) for case in cases))
            result = unittest.TestResult()
            runner.build_suite("native", cases=cases).run(result)
            self.assertFalse(result.wasSuccessful())

    def test_mixed_provenance_openbb_method_has_one_explicit_optional_owner(self):
        openbb_case = self.CaseId(runner.OPENBB_PROVENANCE_ID)
        unknown_openbb_method = self.CaseId("test_upstream_provenance.ProvenanceTests.test_openbb_new_contract")
        unknown_shared_method = self.CaseId("test_upstream_provenance.ProvenanceTests.test_new_shared_contract")
        self.assertEqual(runner.test_owner(openbb_case), "openbb")
        self.assertEqual(runner.test_owner(unknown_openbb_method), "openbb")
        self.assertEqual(runner.test_owner(unknown_shared_method), "core")
        unrelated_openbb_named_method = self.CaseId("test_core_contract.CoreTests.test_openbb_future_name")
        self.assertEqual(runner.test_owner(unrelated_openbb_named_method), "core")

    def test_discovered_cases_partition_without_dropping_or_double_owning(self):
        core_cases = runner.discover_test_cases("core")
        self.assertTrue(core_cases)
        self.assertTrue(all(runner.test_owner(case) == "core" for case in core_cases))
        self.assertNotIn(runner.OPENBB_PROVENANCE_ID, {case.id() for case in core_cases})

    def test_core_discovery_does_not_import_a_broken_openbb_module(self):
        with tempfile.TemporaryDirectory(prefix="eqoboard-test-split-") as temporary:
            test_root = pathlib.Path(temporary) / "tests"
            test_root.mkdir()
            marker = pathlib.Path(temporary) / "openbb-imported"
            (test_root / "test_core_fixture.py").write_text(
                "import unittest\nclass CoreFixture(unittest.TestCase):\n"
                "    def test_core(self):\n        self.assertTrue(True)\n",
                encoding="utf-8",
            )
            (test_root / "test_openbb_broken.py").write_text(
                "from pathlib import Path\n"
                f"Path({str(marker)!r}).touch()\n"
                "raise RuntimeError('optional OpenBB module import must stay isolated')\n",
                encoding="utf-8",
            )
            script = (
                "import importlib.util, pathlib, sys\n"
                "path, test_root = sys.argv[1:3]\n"
                "spec = importlib.util.spec_from_file_location('contract_runner', path)\n"
                "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\n"
                "cases = module.discover_test_cases('core', pathlib.Path(test_root))\n"
                "assert len(cases) == 1 and cases[0].id().endswith('.test_core')\n"
            )
            subprocess.run(
                [sys.executable, "-c", script, str(RUNNER_PATH), str(test_root)],
                check=True,
                cwd=ROOT,
            )
            self.assertFalse(marker.exists())

    def test_import_failure_in_selected_core_module_stays_in_core_suite(self):
        with tempfile.TemporaryDirectory(prefix="eqoboard-test-split-failure-") as temporary:
            test_root = pathlib.Path(temporary) / "tests"
            test_root.mkdir()
            (test_root / "test_core_broken.py").write_text(
                "raise RuntimeError('selected core module import failure')\n",
                encoding="utf-8",
            )
            core_cases = runner.discover_test_cases("core", test_root)
            optional_cases = runner.discover_test_cases("openbb", test_root)
            self.assertTrue(core_cases)
            self.assertTrue(any(case.__class__.__name__ == "_FailedTest" for case in core_cases))
            self.assertEqual(optional_cases, [])

    def test_import_failure_in_selected_openbb_module_fails_optional_suite(self):
        with tempfile.TemporaryDirectory(prefix="eqoboard-openbb-test-split-failure-") as temporary:
            test_root = pathlib.Path(temporary) / "tests"
            test_root.mkdir()
            (test_root / "test_upstream_provenance.py").write_text(
                "import unittest\n"
                "class ProvenanceTests(unittest.TestCase):\n"
                "    def test_openbb_read_only_versioned_contract(self):\n"
                "        self.assertTrue(True)\n",
                encoding="utf-8",
            )
            (test_root / "test_openbb_broken.py").write_text(
                "raise RuntimeError('selected OpenBB module import failure')\n",
                encoding="utf-8",
            )
            script = (
                "import importlib.util, pathlib, sys, unittest\n"
                "path, test_root = sys.argv[1:3]\n"
                "spec = importlib.util.spec_from_file_location('contract_runner', path)\n"
                "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\n"
                "suite = module.build_suite('openbb', tests_dir=pathlib.Path(test_root))\n"
                "cases = list(module.iter_test_cases(suite))\n"
                "assert any(case.__class__.__name__ == '_FailedTest' for case in cases)\n"
                "result = unittest.TestResult(); suite.run(result)\n"
                "assert result.errors or result.failures\n"
                "assert not result.wasSuccessful()\n"
            )
            subprocess.run(
                [sys.executable, "-c", script, str(RUNNER_PATH), str(test_root)],
                check=True,
                cwd=ROOT,
            )
