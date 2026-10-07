"""Local provenance safety tests for imported OpenTerminal UI and OpenBB bridge."""
import json
import pathlib
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]

class UpstreamTests(unittest.TestCase):
    def test_source_pins_and_licenses(self):
        data=json.loads((ROOT/"third_party/upstreams.lock.json").read_text())
        sources={s["name"]:s for s in data["sources"]}
        self.assertEqual(len(sources["OpenTerminal"]["commit"]),40)
        self.assertEqual(sources["OpenTerminal"]["license"],"MIT")
        self.assertEqual(sources["OpenBB Workspace"]["license"],"Apache-2.0")
        self.assertIn("MIT License",(ROOT/"third_party/OpenTerminal-LICENSE.txt").read_text())

    def test_open_terminal_code_actually_imported(self):
        app=(ROOT/"apps/web/src/App.tsx").read_text()
        self.assertIn("OpenTerminalWorkspace",app)
        self.assertIn("render={(widget,scopeSymbol)",app)
        upstream=(ROOT/"apps/web/src/upstream/openterminal/store.ts").read_text()
        self.assertIn("ErTasselli/OpenTerminal",upstream)
        self.assertIn("eqoboard:openterminal-workspace-v1",upstream)
        self.assertIn("toggleLinked",upstream)

    def test_ag_grid_has_one_options_chain(self):
        code=(ROOT/"apps/web/src/components/OptionChain.tsx").read_text()
        self.assertIn("AgGridReact",code)
        self.assertIn("applyTransactionAsync",code)

    def test_openbb_bridge_has_no_order_endpoint(self):
        gateway=(ROOT/"apps/gateway/src/main.rs").read_text()
        self.assertIn('"/widgets.json"',gateway)
        self.assertIn('"/apps.json"',gateway)
        self.assertIn('"/openbb/v1/options"',gateway)
        self.assertNotIn('"/openbb/v1/orders"',gateway)

if __name__=="__main__":
    unittest.main()
