"""Offline provenance and single-terminal architecture checks."""
import json
import pathlib
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]

class ProvenanceTests(unittest.TestCase):
    def test_pinned_upstreams_and_licenses(self):
        data=json.loads((ROOT/"third_party/upstreams.lock.json").read_text())
        sources={x["name"]:x for x in data["sources"]}
        self.assertEqual(len(sources["OpenTerminal"]["commit"]),40)
        self.assertEqual(sources["OpenTerminal"]["license"],"MIT")
        self.assertEqual(sources["AG Grid Community"]["version"],"36.2.0")
        self.assertEqual(sources["OpenBB Workspace"]["license"],"Apache-2.0")
        self.assertIn("MIT License",(ROOT/"apps/openterminal/LICENSE").read_text())

    def test_single_primary_terminal(self):
        self.assertTrue((ROOT/"apps/openterminal/web/components/Workspace.tsx").exists())
        self.assertFalse((ROOT/"apps/web").exists())
        option=(ROOT/"apps/openterminal/web/components/widgets/OptionsWidget.tsx").read_text()
        self.assertIn("AgGridReact",option)
        self.assertIn("applyTransactionAsync",option)

    def test_openbb_read_only_versioned_contract(self):
        gateway=(ROOT/"apps/gateway/src/main.rs").read_text()
        for path in ('"/openbb/v1/stocks"','"/openbb/v1/options"','"/openbb/v1/bars"'):
            self.assertIn(path,gateway)
        self.assertNotIn('"/openbb/v1/orders"',gateway)
        widgets=json.loads((ROOT/"apps/gateway/openbb/widgets.json").read_text())
        self.assertGreaterEqual(len(widgets),3)
        for widget in widgets.values():
            self.assertTrue(widget["endpoint"].startswith("openbb/v1/"))
            self.assertFalse(widget["exportable"])
            self.assertIsInstance(widget["source"], list)
            self.assertTrue(widget["source"])
            self.assertIn("dataKey", widget["data"])
            self.assertGreaterEqual(widget["refetchInterval"], 1000)
            self.assertGreaterEqual(widget["staleTime"], 1000)

if __name__=="__main__":
    unittest.main()
