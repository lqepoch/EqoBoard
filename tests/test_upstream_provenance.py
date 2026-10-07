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
            self.assertEqual(widget["type"], "table")
            self.assertNotIn("wsEndpoint", widget)
            self.assertIn("HTTP polling", widget["description"])
            self.assertIn("not a Live Grid", widget["description"])

        fields = {
            name: {column["field"] for column in widget["data"]["table"]["columnsDefs"]}
            for name, widget in widgets.items()
        }
        self.assertTrue({"source_label", "feed", "market_as_of", "complete", "truncated"}
                        <= fields["eqo_sip_watchlist"])
        self.assertTrue({"source_label", "feed", "quote_at", "trade_at", "model_as_of",
                         "market_as_of", "pages_fetched", "has_more", "truncated"}
                        <= fields["eqo_opra_contracts"])
        self.assertTrue({"source_label", "feed", "market_as_of", "pages_fetched",
                         "has_more", "truncated", "complete"}
                        <= fields["eqo_sip_bars"])

        options = widgets["eqo_opra_contracts"]
        expiration = next(param for param in options["params"] if param["paramName"] == "expiration")
        self.assertEqual(expiration["value"], "$currentDate+1w")
        apps = json.loads((ROOT/"apps/gateway/openbb/apps.json").read_text())
        self.assertNotIn("expiration", json.dumps(apps))

if __name__=="__main__":
    unittest.main()
