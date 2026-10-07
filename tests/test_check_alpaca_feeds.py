"""Offline entitlement smoke regression tests."""
import importlib.util
import pathlib
import unittest

script = pathlib.Path(__file__).resolve().parents[1] / "tools" / "check_alpaca_feeds.py"
spec = importlib.util.spec_from_file_location("alpaca_smoke", script)
alpaca = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alpaca)


class EntitlementsTests(unittest.TestCase):
    def test_both_success(self):
        calls = []
        def request(path):
            calls.append(path)
            return {"snapshots": {}} if "options" in path else {"latestQuote": {"bp": 1.0}}
        self.assertEqual(alpaca.run_checks(request), 0)
        self.assertEqual(len(calls), 2)

    def test_403_does_not_skip_opra(self):
        calls = []
        def request(path):
            calls.append(path)
            if "snapshot?feed=sip" in path:
                raise alpaca.ProbeError(403, 40010001)
            if "/bars?" in path:
                return {"bars": []}
            return {"snapshots": {}}
        self.assertEqual(alpaca.run_checks(request), 1)
        self.assertEqual(len(calls), 3)
        self.assertTrue(any("feed=opra" in path for path in calls))

    def test_both_invalid_schema(self):
        self.assertEqual(alpaca.run_checks(lambda _: {}), 1)

    def test_rejects_untrusted_path(self):
        with self.assertRaises(ValueError):
            alpaca.probe("//example.com")
        with self.assertRaises(ValueError):
            alpaca.probe("/v2/stocks/QQQ?token@somehost")


if __name__ == "__main__":
    unittest.main()
