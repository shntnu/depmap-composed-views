# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = [
#     "altair==5.5.0",
#     "marimo",
#     "polars==1.40.1",
#     "requests==2.32.5",
# ]
# ///

import marimo

__generated_with = "0.23.16"
app = marimo.App(width="medium")

with app.setup:
    import hashlib
    import json
    import math
    import re
    import sys
    import tomllib
    from datetime import datetime, timezone
    from pathlib import Path

    import marimo as mo
    import polars as pl

    NOTEBOOK_DIR = Path(__file__).resolve().parent
    if str(NOTEBOOK_DIR) not in sys.path:
        sys.path.insert(0, str(NOTEBOOK_DIR))

    from nb02_dataset_discovery import BASE_URL, bb_get, bb_post, dataset_features, list_datasets
    from nb03_gene_dependency_profile import column_mapping_to_frame
    from nb04_context_comparison import lineage_context, resolve_context


@app.cell(hide_code=True)
def _():
    mo.md("""
    # Verified DepMap retrieval

    Resolve a gene and lineage, check the returned identifiers and missingness,
    and preserve a machine-readable evidence record alongside the values.
    """)
    return


@app.function(hide_code=True)
def exact_record(frame: pl.DataFrame, column: str, value: str) -> dict:
    """Resolve one exact match; substring search never establishes identity."""
    matches = frame.filter(pl.col(column) == value)
    if matches.height != 1:
        raise ValueError(
            f"Expected one exact {column}={value!r}; found {matches.height}. "
            "Inspect dataset or feature discovery results; do not pick the first hit."
        )
    return matches.row(0, named=True)


@app.function(hide_code=True)
def checked_dependency_rows(raw: dict, feature_id: str, cohort_ids: list[str], sample_ids: list[str]) -> list[dict]:
    """Check the entire requested slice; retain absent models and null scores."""
    for name, ids in [("cohort", cohort_ids), ("dataset sample", sample_ids)]:
        if any(not isinstance(item, str) or not item for item in ids) or len(ids) != len(set(ids)):
            raise ValueError(f"Invalid or duplicate {name} IDs.")
    expected = set(cohort_ids) & set(sample_ids)
    if not isinstance(raw, dict) or set(raw) != {feature_id} or not isinstance(raw[feature_id], dict):
        raise ValueError(f"Expected only feature ID {feature_id!r} in the matrix response.")
    values = raw[feature_id]
    if set(values) != expected:
        raise ValueError(
            f"Matrix membership mismatch: {len(expected - set(values))} missing and "
            f"{len(set(values) - expected)} unexpected model IDs. Retry discovery before interpretation."
        )
    rows = []
    for model_id in sorted(cohort_ids):
        value = values.get(model_id)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
            raise ValueError(f"Non-numeric or non-finite dependency for {model_id}.")
        status = "absent_from_dataset" if model_id not in expected else "null_score" if value is None else "observed"
        rows.append({"depmap_id": model_id, "dependency": value, "status": status})
    return rows


@app.function(hide_code=True)
def verified_dependency_query(gene: str = "KRAS", lineage: str = "Lung", expected_release: str | None = None) -> dict:
    """Retrieve a checked Chronos slice with JSON provenance, counts, and all cohort rows.

    Uses exact, case-sensitive gene symbols and Oncotree lineage names.
    expected_release is a guard on both source datasets, not a historical selector.
    Raises ValueError on identity, membership, numeric, or release mismatches.
    Network and HTTP failures propagate; a failed query is never an empty result.
    """
    if not isinstance(gene, str) or not gene.strip() or not isinstance(lineage, str) or not lineage.strip():
        raise ValueError("Supply a nonempty gene symbol and Oncotree lineage.")
    gene, lineage = gene.strip(), lineage.strip()
    if expected_release is not None and (
        not isinstance(expected_release, str) or not re.fullmatch(r"[0-9]{2}Q[1-4]", expected_release)
    ):
        raise ValueError("expected_release must be a release such as '26Q3', or None.")
    started_at = datetime.now(timezone.utc).isoformat()
    catalog_release = tomllib.loads((NOTEBOOK_DIR.parent / "catalog.toml").read_text())["data"]["version"]
    datasets = list_datasets()
    dependency = exact_record(datasets, "given_id", "Chronos_Combined")
    metadata = exact_record(datasets, "given_id", "depmap_model_metadata")
    if (dependency["feature_type_name"], dependency["sample_type_name"]) != ("gene", "depmap_model"):
        raise ValueError("Chronos_Combined no longer describes a gene by DepMap model matrix.")
    sources = []
    warnings = []
    for dataset in (dependency, metadata):
        download = (dataset.get("dataset_metadata") or {}).get("download_file_info") or {}
        release_text = download.get("release_name") or dataset["name"]
        match = re.search(r"\b([0-9]{2}Q[1-4])\b", release_text)
        release = match.group(1) if match else None
        if expected_release is not None and release != expected_release:
            raise ValueError(
                f"Release mismatch for {dataset['given_id']}: expected {expected_release}, observed {release!r}. "
                "Breadbox serves live data; this guard cannot request an old release."
            )
        if release != catalog_release:
            warnings.append(f"{dataset['given_id']}: observed release {release!r}; catalog baseline {catalog_release}.")
        sources.append(
            {
                "id": dataset["id"],
                "given_id": dataset["given_id"],
                "name": dataset["name"],
                "release": release,
                "release_evidence": release_text,
                "source_file": download.get("file_name"),
                "taiga_id": dataset.get("taiga_id"),
                "version": dataset.get("version"),
            }
        )
    feature = exact_record(dataset_features(dependency["id"]), "label", gene)
    metadata_body = {"columns": ["CellLineName", "OncotreeLineage"]}
    metadata_endpoint = f"datasets/tabular/{metadata['id']}"
    annotations = column_mapping_to_frame(bb_post(metadata_endpoint, metadata_body))
    cohort_ids = annotations.filter(pl.col("OncotreeLineage") == lineage)["depmap_id"].to_list()
    if not cohort_ids:
        raise ValueError(f"No models for exact OncotreeLineage={lineage!r}; inspect model metadata for valid names.")
    context = lineage_context(lineage)
    context["vars"]["lineage"]["dataset_id"] = metadata["id"]
    resolved = resolve_context(context)
    if not isinstance(resolved, dict) or not isinstance(resolved.get("ids"), list):
        raise ValueError("Malformed context response: expected an explicit ids list.")
    if len(resolved["ids"]) != len(cohort_ids) or set(resolved["ids"]) != set(cohort_ids):
        raise ValueError("Context membership disagrees with independently filtered metadata; retry discovery.")
    samples_endpoint = f"datasets/samples/{dependency['id']}"
    samples = bb_get(samples_endpoint)
    if not isinstance(samples, list) or any(not isinstance(row, dict) or "id" not in row for row in samples):
        raise ValueError("Malformed dataset sample enumeration.")
    sample_ids = [row["id"] for row in samples]
    if any(not isinstance(item, str) or not item for item in sample_ids) or len(sample_ids) != len(set(sample_ids)):
        raise ValueError("Invalid or duplicate dataset sample IDs.")
    requested_ids = sorted(set(cohort_ids) & set(sample_ids))
    matrix_endpoint = f"datasets/matrix/{dependency['id']}?strict=true"
    matrix_body = {
        "features": [feature["id"]],
        "feature_identifier": "id",
        "samples": requested_ids,
        "sample_identifier": "id",
    }
    # Empty filters can mean all rows upstream; never send an empty matrix request.
    raw = bb_post(matrix_endpoint, matrix_body) if requested_ids else {feature["id"]: {}}
    rows = checked_dependency_rows(raw, feature["id"], cohort_ids, sample_ids)
    names = dict(zip(annotations["depmap_id"], annotations["CellLineName"], strict=True))
    rows = [{**row, "cell_line_name": names[row["depmap_id"]]} for row in rows]
    counts = {
        status: sum(row["status"] == status for row in rows)
        for status in ("observed", "null_score", "absent_from_dataset")
    }
    counts = {"cohort": len(rows), "present_in_dataset": len(requested_ids), **counts}
    requests_made = [
        {"method": "GET", "endpoint": "datasets/"},
        {"method": "GET", "endpoint": f"datasets/features/{dependency['id']}"},
        {"method": "POST", "endpoint": metadata_endpoint, "body": metadata_body},
        {"method": "POST", "endpoint": "temp/context", "body": context},
        {"method": "GET", "endpoint": samples_endpoint},
    ]
    if requested_ids:
        requests_made.append({"method": "POST", "endpoint": matrix_endpoint, "body": matrix_body})
    return {
        "schema_version": 1,
        "query": {"gene": gene, "lineage": lineage, "expected_release": expected_release},
        "feature": feature,
        "provenance": {
            "base_url": BASE_URL,
            "started_at_utc": started_at,
            "completed_at_utc": datetime.now(timezone.utc).isoformat(),
            "catalog_release": catalog_release,
            "datasets": sources,
            "requests": requests_made,
        },
        "matrix_requested": bool(requested_ids),
        "units": dependency["units"],
        "interpretation": "More negative Chronos gene effect indicates stronger dependency; missing values are not zero.",
        "counts": counts,
        "checks": {"context_matches_metadata": True, "matrix_ids_match_request": True if requested_ids else None},
        "warnings": warnings,
        "limits": "Live calls are not an atomic or immutable snapshot. The hash identifies these rows, not a historical API version.",
        "rows_sha256": hashlib.sha256(
            json.dumps(rows, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        ).hexdigest(),
        "rows": rows,
    }


@app.cell(hide_code=True)
def query_controls():
    query_form = mo.ui.dictionary(
        {
            "gene": mo.ui.text(value="KRAS", label="Exact gene symbol"),
            "lineage": mo.ui.text(value="Lung", label="Exact Oncotree lineage"),
        }
    ).form(submit_button_label="Retrieve and verify", show_clear_button=False)
    query_form
    return (query_form,)


@app.cell(hide_code=True)
def retrieve(query_form):
    query_inputs = query_form.value or {"gene": "KRAS", "lineage": "Lung"}
    evidence = verified_dependency_query(**query_inputs)
    return (evidence,)


@app.cell(hide_code=True)
def coverage_output(evidence):
    counts_table = pl.DataFrame([evidence["counts"]])
    release_notes = "\n".join(evidence["warnings"]) or "Source releases match the catalog baseline."
    mo.vstack(
        [
            mo.md(f"## {evidence['query']['gene']} in {evidence['query']['lineage']}\n\n" + evidence["interpretation"]),
            mo.md("All cohort models are accounted for. Dataset absence and null scores stay explicit."),
            mo.ui.table(counts_table, selection=None),
            mo.callout(mo.md(release_notes), kind="warn" if evidence["warnings"] else "info"),
        ]
    )
    return


@app.cell(hide_code=True)
def model_output(evidence):
    dependency_rows = pl.DataFrame(evidence["rows"])
    mo.vstack(
        [
            mo.md(
                "### Model preview\n\nFirst 20 models by ID; the JSON download contains every cohort model. Missing scores are not evidence of no dependency."
            ),
            mo.ui.table(dependency_rows.head(20), selection=None),
        ]
    )
    return


@app.cell(hide_code=True)
def evidence_output(evidence):
    evidence_json = json.dumps(evidence, indent=2, allow_nan=False)
    mo.vstack(
        [
            mo.md(
                "### Evidence for reuse\n\nIncludes exact requests, dataset and feature IDs, source release evidence, all rows, checks, counts, timestamps, and a SHA-256 hash of the rows."
            ),
            mo.download(
                evidence_json.encode(),
                filename="depmap-evidence.json",
                mimetype="application/json",
                label="Download verified result",
            ),
            mo.md(
                "```json\n"
                + json.dumps({key: evidence[key] for key in ["feature", "counts", "checks", "rows_sha256"]}, indent=2)
                + "\n```"
            ),
            mo.md(evidence["limits"]),
        ]
    )
    return


@app.cell(hide_code=True)
def reuse_notes():
    mo.md("""
    ### Reuse this workflow

    From this repository checkout, import `verified_dependency_query` from this notebook to get a plain JSON-compatible dictionary.
    Use `expected_release="26Q3"` to require that release in both source datasets; a mismatch raises an error.
    The argument checks the live release and does not select historical data.
    Gene symbols and lineage names must match exactly; discovery candidates are never silently selected.

    The checks compare server context membership to independently filtered metadata and compare every returned matrix ID to the requested dataset intersection.
    They detect disagreement, missing rows, extra rows, wrong features, and non-finite values.
    They cannot establish atomic consistency across live requests or detect an upstream omission shared by both endpoints.
    See `docs/agent-readiness.md` in this repository for the broader task benchmark and upstream work.
    """)
    return


if __name__ == "__main__":
    app.run()
