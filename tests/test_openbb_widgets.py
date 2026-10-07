"""Offline contract tests for OpenBB Workspace custom backend manifests."""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FOLDER = ROOT / "integrations" / "openbb"

class OpenBBManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.widgets = json.loads((FOLDER/"widgets.json").read_text(encoding="utf-8"))
        cls.apps = json.loads((FOLDER/"apps.json").read_text(encoding="utf-8"))

    def test_widgets_are_read_only_authenticated_data(self):
        self.assertGreaterEqual(len(self.widgets), 3)
        for ident, widget in self.widgets.items():
            self.assertTrue(ident.startswith("eqo_"))
            self.assertEqual(widget["type"], "table")
            self.assertTrue(widget["endpoint"].startswith("openbb/v1/"))
            self.assertNotIn("orders", widget["endpoint"])
            self.assertIn("dataKey", widget["data"])
            self.assertFalse(widget["exportable"])
            self.assertTrue(widget["params"])

    def test_application_layout_references_defined_widgets(self):
        for app in self.apps:
            for tab in app["tabs"].values():
                for item in tab["layout"]:
                    self.assertIn(item["i"], self.widgets)
                    self.assertIn("params", item["state"])

    def test_no_api_credentials_in_manifests(self):
        contents = (FOLDER/"widgets.json").read_text(encoding="utf-8")
        for forbidden in ("ALPACA_SECRET", "ALPACA_KEY", "Bearer ", "EQO_ACCESS_TOKEN"):
            self.assertNotIn(forbidden, contents)

if __name__ == "__main__":
    unittest.main()
