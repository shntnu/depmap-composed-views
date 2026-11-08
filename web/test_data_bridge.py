"""Offline bridge behavior and integrity checks for saved real query evidence."""

import hashlib
import io
import json
import math
import unittest
from collections import Counter
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import data_bridge


class DataBridgeTests(unittest.TestCase):
    def test_query_failure_emits_no_json(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(data_bridge, "verified_dependency_query", side_effect=ValueError("bad gene")):
            with redirect_stdout(output), redirect_stderr(errors):
                status = data_bridge.main(["--gene", "unknown"])
        self.assertEqual(status, 1)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("bad gene", errors.getvalue())

    def test_success_preserves_the_complete_evidence(self):
        evidence = {"rows": [{"dependency": None}], "provenance": {"example": "unchanged"}}
        output = io.StringIO()
        with patch.object(data_bridge, "verified_dependency_query", return_value=evidence) as query:
            with redirect_stdout(output):
                status = data_bridge.main(["--gene", "BRAF", "--lineage", "Skin", "--expected-release", "26Q3"])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue()), evidence)
        query.assert_called_once_with("BRAF", "Skin", expected_release="26Q3")

    def test_saved_evidence_has_complete_rows_and_matching_hash(self):
        paths = list((Path(__file__).parent / "data").glob("*.json"))
        self.assertTrue(paths, "At least one authentic snapshot must be bundled")
        for path in paths:
            with self.subTest(snapshot=path.name):
                evidence = json.loads(path.read_text())
                rows, counts = evidence["rows"], evidence["counts"]
                self.assertEqual(len(rows), counts["cohort"])
                self.assertEqual(len({row["depmap_id"] for row in rows}), len(rows))
                statuses = Counter(row["status"] for row in rows)
                for status in ("observed", "null_score", "absent_from_dataset"):
                    self.assertEqual(statuses[status], counts[status])
                self.assertEqual(counts["present_in_dataset"], counts["observed"] + counts["null_score"])
                for row in rows:
                    if row["status"] == "observed":
                        self.assertIn(type(row["dependency"]), (int, float))
                        self.assertTrue(math.isfinite(row["dependency"]))
                    else:
                        self.assertIsNone(row["dependency"])
                encoded = json.dumps(rows, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
                self.assertEqual(hashlib.sha256(encoded).hexdigest(), evidence["rows_sha256"])
                self.assertEqual(evidence["provenance"]["base_url"], "https://depmap.org/portal/breadbox")
                self.assertTrue(evidence["checks"]["context_matches_metadata"])
                self.assertTrue(evidence["provenance"]["completed_at_utc"])


if __name__ == "__main__":
    unittest.main()
