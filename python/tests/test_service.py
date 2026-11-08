"""Offline checks for the private Python query service."""

import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import requests
from fastapi.testclient import TestClient

REPOSITORY_DIR = Path(__file__).resolve().parents[2]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


adapter = load_module("depmap_vercel_adapter", REPOSITORY_DIR / "python" / "app.py")


class VercelAdapterTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(adapter.app)

    def test_complete_evidence_is_returned_without_changes(self):
        evidence = json.loads((REPOSITORY_DIR / "web" / "data" / "kras-lung.json").read_text())
        with patch.object(adapter, "verified_dependency_query", return_value=evidence) as query:
            response = self.client.post("/query", json={"gene": "KRAS", "lineage": "Lung"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), evidence)
        query.assert_called_once_with("KRAS", "Lung", expected_release=None)

    def test_invalid_or_extra_fields_never_reach_the_notebook(self):
        invalid_inputs = [
            {"gene": "", "lineage": "Lung"},
            {"gene": "A" * 65, "lineage": "Lung"},
            {"gene": "KRAS", "lineage": "A" * 81},
            {"gene": "KRAS", "lineage": "Lung", "endpoint": "other"},
            {"gene": "KRAS", "lineage": "Lung", "expected_release": "26Q5"},
        ]
        with patch.object(adapter, "verified_dependency_query") as query:
            for body in invalid_inputs:
                with self.subTest(body=body):
                    self.assertEqual(self.client.post("/query", json=body).status_code, 422)
            query.assert_not_called()

    def test_upstream_failures_are_explicit_http_errors(self):
        for error, status in ((ValueError("Unknown exact gene"), 422), (requests.Timeout(), 504), (requests.HTTPError(), 502)):
            with self.subTest(error=type(error).__name__):
                with patch.object(adapter, "verified_dependency_query", side_effect=error):
                    response = self.client.post("/query", json={"gene": "KRAS", "lineage": "Lung"})
                self.assertEqual(response.status_code, status)
                self.assertIn("detail", response.json())
                self.assertNotIn("rows", response.json())

    def test_unexpected_failure_does_not_expose_internal_details(self):
        with patch.object(adapter, "verified_dependency_query", side_effect=RuntimeError("internal detail")):
            with self.assertLogs(adapter.logger, level="ERROR"):
                response = self.client.post("/query", json={"gene": "KRAS", "lineage": "Lung"})
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("internal detail", response.text)


if __name__ == "__main__":
    unittest.main()
