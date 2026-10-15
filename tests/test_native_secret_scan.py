"""Static acceptance contract for the Actions-only native Gitleaks helper."""

from __future__ import annotations

import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "tools" / "native-web-secret-scan.sh"
GITLEAKS_CONFIG = REPO_ROOT / "tools" / "ci" / "native-gitleaks.toml"
PINNED_IMAGE = (
    "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:"
    "b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb"
)


class NativeSecretScanContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not HELPER.is_file():
            raise AssertionError("Actions-only native secret scan helper is required")
        cls.helper = HELPER.read_text(encoding="utf-8")
        cls.config = GITLEAKS_CONFIG.read_text(encoding="utf-8")

    def test_helper_requires_actions_and_exact_candidate_head(self) -> None:
        self.assertIn('GITHUB_ACTIONS:-', self.helper)
        self.assertIn("NATIVE_CANDIDATE_SHA", self.helper)
        self.assertIn(r"^[0-9a-f]{40}$", self.helper)
        self.assertIn('git -C "$repo_root" rev-parse HEAD', self.helper)
        self.assertIn('"$checkout_sha" != "$NATIVE_CANDIDATE_SHA"', self.helper)
        self.assertIn(PINNED_IMAGE, self.helper)

    def test_public_exception_control_and_generated_secret_control_are_paired(self) -> None:
        self.assertIn(
            'fixture_path="$fixture_root/apps/eqoboard-web/lib/server/research/macro.ts"',
            self.helper,
        )
        self.assertIn(
            'wrong_fixture_path="$wrong_fixture_root/apps/eqoboard-web/lib/server/research/macro-copy.ts"',
            self.helper,
        )
        self.assertIn(
            'series = ".".join(("B", "U2", "EUR", "4F", "G_N_A", "SV_C_YM", "SR_3M"))',
            self.helper,
        )
        self.assertIn('wrong_path_status != 1', self.helper)
        self.assertIn("grep -qi 'generic-api-key' \"$wrong_path_log\"", self.helper)
        self.assertIn('positive_status != 0', self.helper)
        self.assertIn('negative_status != 1', self.helper)
        self.assertIn("grep -qi 'generic-api-key'", self.helper)
        self.assertIn("secrets.choice(alphabet) for _ in range(48)", self.helper)
        self.assertNotIn("ghp_", self.helper)
        self.assertNotIn("AKIA", self.helper)

    def test_all_scans_are_redacted_networkless_read_only_and_runner_owned(self) -> None:
        docker_invocations = self.helper.count(
            "docker run --rm --network=none --read-only --cap-drop=ALL"
        )
        self.assertEqual(
            docker_invocations,
            5,
            "three scanner controls plus source and history scans are required",
        )
        self.assertEqual(self.helper.count('--user "$scan_uid:$scan_gid"'), 5)
        self.assertEqual(self.helper.count('--redact --verbose --no-banner'), 5)
        self.assertEqual(self.helper.count("--security-opt=no-new-privileges"), 5)
        self.assertIn('"$(uname -m)" != \'x86_64\'', self.helper)
        self.assertIn('--volume "$repo_root:/repo:ro"', self.helper)
        self.assertIn('--volume "$fixture_root:/probe:ro"', self.helper)
        self.assertIn('--volume "$wrong_fixture_root:/probe:ro"', self.helper)
        self.assertNotIn("safe.directory", self.helper)
        self.assertIn('positive_log="$work_root/positive.log"', self.helper)
        self.assertIn('wrong_path_log="$work_root/wrong-path.log"', self.helper)
        self.assertIn('negative_log="$work_root/negative.log"', self.helper)
        self.assertNotIn('cat "$wrong_path_log"', self.helper)
        self.assertNotIn('cat "$negative_log"', self.helper)
        self.assertIn('trap cleanup EXIT', self.helper)
        self.assertIn('rm -rf -- "$work_root"', self.helper)

    def test_native_source_and_candidate_history_scans_both_use_the_reviewed_config(self) -> None:
        self.assertIn(
            '"$GITLEAKS_IMAGE" dir --config "$GITLEAKS_CONFIG"', self.helper
        )
        self.assertIn(
            '"$GITLEAKS_IMAGE" git --config "$GITLEAKS_CONFIG"', self.helper
        )
        self.assertIn('/repo/apps/eqoboard-web', self.helper)
        self.assertIn('--log-opts="$scan_range" .', self.helper)
        self.assertIn('scan_range="$base_sha..$NATIVE_CANDIDATE_SHA"', self.helper)
        self.assertIn("scan_range='--all'", self.helper)
        self.assertIn('git -C "$repo_root" cat-file -e "$base_sha^{commit}"', self.helper)
        self.assertIn('GITLEAKS_CONFIG=\'/repo/tools/ci/native-gitleaks.toml\'', self.helper)

    def test_exception_is_and_scoped_to_the_four_public_series(self) -> None:
        self.assertIn('id = "generic-api-key"', self.config)
        self.assertIn('condition = "AND"', self.config)
        self.assertIn('regexTarget = "secret"', self.config)
        self.assertIn(r"apps/eqoboard-web/lib/server/research/macro\.ts$", self.config)
        self.assertIn(r"SR_(?:3M|5Y|10Y|30Y)", self.config)
        self.assertIn('useDefault = true', self.config)


if __name__ == "__main__":
    unittest.main()
