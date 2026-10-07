"""Local provenance safety tests for native OpenTerminal UI, AG Grid and OpenBB bridge."""
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
        self.assertEqual(sources["OpenTerminal"]["downstream_prefix"],"apps/openterminal")
        self.assertEqual(sources["OpenBB Workspace"]["license"],"Apache-2.0")
        self.assertIn("MIT License",(ROOT/"third_party/OpenTerminal-LICENSE.txt").read_text())

    def test_native_open_terminal_is_primary_workspace(self):
        package=json.loads((ROOT/"apps/openterminal/web/package.json").read_text())
        self.assertIn("next",package["dependencies"])
        workspace=(ROOT/"apps/openterminal/web/components/Workspace.tsx").read_text()
        store=(ROOT/"apps/openterminal/web/store/terminal.ts").read_text()
        self.assertIn("react-grid-layout",workspace)
        self.assertIn("OptionsWidget",workspace)
        self.assertIn("VerticalSpreadWidget",workspace)
        self.assertIn("toggleLinked",store)
        self.assertIn("eqoboard-open-terminal-v1",store)
        self.assertFalse((ROOT/"apps/web").exists())

    def test_ag_grid_is_native_option_chain(self):
        code=(ROOT/"apps/openterminal/web/components/widgets/OptionsWidget.tsx").read_text()
        self.assertIn("AgGridReact",code)
        self.assertIn("applyTransactionAsync",code)
        self.assertIn("ALPACA OPRA",code)

    def test_core_market_routes_are_rust_backed(self):
        adapter=(ROOT/"apps/openterminal/web/lib/eqo-market.ts").read_text()
        self.assertIn("/api/v1/stocks/snapshots",adapter)
        self.assertIn("/api/v1/stocks/bars",adapter)
        self.assertIn("/api/v1/options/chain",adapter)
        self.assertIn("No silent fallback",adapter)

    def test_openbb_bridge_has_no_order_endpoint(self):
        gateway=(ROOT/"apps/gateway/src/main.rs").read_text()
        self.assertIn('"/widgets.json"',gateway)
        self.assertIn('"/apps.json"',gateway)
        self.assertIn('"/openbb/v1/options"',gateway)
        self.assertNotIn('"/openbb/v1/orders"',gateway)

if __name__=="__main__":
    unittest.main()
