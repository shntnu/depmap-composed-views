# DepMap composed views

This prototype explores two bets for working with a scientific agent: an executable notebook as the shared workspace, and a structured interface assembled over reusable analysis functions.
It makes the comparison concrete with one DepMap query for a gene within a lineage.

Scientists need to inspect an agent's work and keep exploring after its first answer.
[JX](https://github.com/broadinstitute/jx), a project for exploring JUMP Cell Painting data, makes one bet: the notebook itself can be the interface between the scientist and the agent.

In [JX's notebook approach](https://github.com/broadinstitute/jx/blob/main/PLAN.md#hypothesis), an agent draws on a catalog of reusable analyses, writes Python cells, and runs them in a marimo notebook.
Code, explanations, and outputs stay together in a document the scientist can inspect and rerun.
Follow-up questions can extend that notebook with more cells.
The notebook is both a working surface and a durable result.

This demo explores another bet: the agent can compose a structured interface over reusable analysis functions.
With json-render, the model describes a view using allowed charts, tables, and evidence components, and the app renders it.
Both approaches reuse scientific code and can offer interactive controls.
Here the model produces a description of the interface, while the existing functions perform the analysis.

We are trying that second approach with one DepMap query from [DMX](https://github.com/broadinstitute/dmx), JX's sibling notebook catalog.
[View the rendered notebook and its recorded results](https://molab.marimo.io/github/shntnu/depmap-composed-views/blob/main/python/notebooks/nb06_verified_dependency_query.py), then try the web interface.
The notebook, [Verified DepMap retrieval (nb06)](python/notebooks/nb06_verified_dependency_query.py), retrieves published dependency scores for one gene within one lineage, checks cell-line identifiers and missing scores, and records the data sources.
The rendered preview uses a saved session snapshot; fresh retrieval requires running the notebook or choosing Breadbox in the app.
In this prototype, the user chooses the query and the model chooses how to display its results.
It is a working interface experiment, not the full DepMap portal or a system that creates new analyses.
New scientific questions still need additional analysis code.

The interface uses [json-render](https://json-render.dev/) and was inspired by Vercel's [json-render and Chat SDK announcement](https://vercel.com/changelog/json-render-and-chat-sdk-agents).
The source repository is [shntnu/depmap-composed-views](https://github.com/shntnu/depmap-composed-views), a public personal repository.

[Open the public demo](https://depmap-composed-views.vercel.app/).
The production address does not require Vercel sign-in.
**Compose view** uses the demo operator's Anthropic account; visitors do not supply an API key.
Presets do not make model calls.

## Try it

Set **Gene symbol** to `BRAF`, **Lineage** to `Skin`, and **Data source** to **Retrieve from Breadbox**.
Then describe the display:

> Show a distribution, cohort coverage, and source evidence.
No table.

Or keep **Saved verified snapshot** and try KRAS/Lung, EGFR/Lung, or BRAF/Skin without waiting for upstream retrieval.
The fields determine the data; display instructions only choose the presentation.
Naming another gene or lineage in the text does not change the selected query.
Presets use the selected fields, ignore the display instructions, and work without a model connection.
The **UI specification** tab shows the validated component tree.
The **Chat card** tab previews the same selected components through `@json-render/chat`; it does not send messages to a chat service.
Download the evidence to inspect all cohort models, missingness, exact requests, dataset releases and the reported row hash.

## Run locally

Requires Node 22+, npm, and Python 3.12 or 3.13 with [uv](https://docs.astral.sh/uv/). Python is needed for fresh retrievals; the included snapshots work with Node alone.
From the repository root:

```bash
npm --prefix web ci
npm --prefix web run dev
```

Open <http://127.0.0.1:4317/>. To use Anthropic directly, set `AI_PROVIDER=anthropic` and supply `ANTHROPIC_API_KEY` through the process environment before starting the server.
Set `AI_MODEL=claude-sonnet-5-5` to match the hosted demo.
If `AI_MODEL` is omitted, the direct Anthropic default remains `claude-haiku-5-5`.
Keep credentials out of files and frontend variables.
Requests are capped at 1,500 output tokens, and model failures are shown explicitly.
Sonnet 5.5 uses medium effort without upfront thinking for this short composition task.

When `AI_PROVIDER` is omitted, the original defaults remain: local runs use `OPENROUTER_API_KEY`, and Vercel deployments use AI Gateway.
Those defaults use `anthropic/claude-haiku-4.5`, overridden by `AI_MODEL` or `OPENROUTER_MODEL`.
Explicit `AI_PROVIDER=anthropic` never falls back to another provider when its key is missing or a request fails.

For a local production build:

```bash
npm --prefix web run build
npm --prefix web start
```

To retrieve a complete evidence record directly:

```bash
uv run --no-project web/data_bridge.py --gene KRAS --lineage Lung --output /tmp/kras-lung-evidence.json
```

## Deploy from GitHub

This repository is connected to the existing `depmap-composed-views` Vercel project, with `main` as the production branch.
The project root is the repository root, and the checked-in `vercel.json` declares both services and their build settings.
Pushes to `main` automatically deploy the application at its existing address.

The `web` service builds and serves the React interface and Node API.
Its `DEPMAP_SERVICE_URL` binding reaches the private Python `depmap` service, which has no public route.
Vercel Services is currently Beta.
The web service explicitly serves built assets because the service rewrite routes asset requests through Express.

The production demo uses `AI_PROVIDER=anthropic`, `AI_MODEL=claude-sonnet-5-5`, and a server-only `ANTHROPIC_API_KEY` stored in the project's production environment.
Model calls go directly to Anthropic and use the selected Anthropic account's credits or billing.
They do not use Vercel AI Gateway credits or silently fall back to another billing account.
Vercel still hosts the application and its Python service.
Keep Node set to 22 or later.

For other installations, omitting `AI_PROVIDER` preserves Vercel AI Gateway with the deployment's automatically supplied identity.
That mode requires project OIDC and available Gateway credits; `AI_PROVIDER=gateway` also selects it explicitly.
`AI_PROVIDER=openrouter` explicitly selects the original OpenRouter connection.

The deployed project currently uses Vercel Standard Protection (`all_except_custom_domains`).
That setting protects generated deployment and preview addresses but leaves the main production address public, including its model endpoint.
Anyone who can reach that address can invoke model calls funded by the configured Anthropic account.
The API key remains server-only; the application does not implement visitor authentication or a per-user spending limit.
The server's busy flag limits one running instance, not total account spending.
Same-origin checks and schema validation are not user authentication.
To require sign-in on the production address, explicitly configure Vercel Authentication for All Deployments or add application-level authentication.
See [Vercel's deployment protection explanation](https://vercel.com/academy/optimize-your-vercel-account/deployment-protection).

## Repository layout

```text
web/                  React UI, Node API, data snapshots, local bridge and tests
python/app.py         Private FastAPI query service
python/notebooks/     Exact copies of the four imported DMX notebooks
                      and the recorded nb06 session for the marimo preview
python/catalog.toml   Original catalog metadata and release baseline
python/uv.lock        Locked Python service dependencies
vercel.json           Service builds, private binding and public routing
PROVENANCE.md         Source revision, working-tree status and copied-file hashes
LICENSE               Preserved upstream BSD 3-Clause license
```

The local bridge and hosted service both import `verified_dependency_query` from `python/notebooks/nb06_verified_dependency_query.py`.
All Breadbox requests retain the existing HTTP helpers, identifying User-Agent, retries, identifier checks and cohort accounting.
See [source provenance](PROVENANCE.md) for the exact notebook snapshot.
This repository runs independently of the original DMX checkout.

## Scientific scope

Queries cover one gene and one lineage: descriptive Chronos scores, coverage and evidence.
The model can select components, order, filters and display limits.
It cannot supply measurements, arbitrary scientific claims, code, mutable state or event handlers.
Every valid report includes coverage and evidence.
Complete model output is validated before the scientific view appears; invalid output remains an explicit error.
Schema validation alone cannot prove that a valid report answers an arbitrary question.

More negative Chronos gene effect indicates stronger dependency.
Absent models and null scores remain distinct, and neither becomes zero in a plot.
Within-lineage rankings do not establish lineage selectivity, drug response or patient benefit.
Live retrieval failures never silently substitute saved data.
Breadbox serves the current release, and separate requests are not an atomic historical snapshot.

The saved evidence was retrieved on November 8, 2026:

| Query | Cohort | Observed | Absent | Null |
| --- | ---: | ---: | ---: | ---: |
| KRAS / Lung | 269 | 126 | 143 | 0 |
| EGFR / Lung | 269 | 126 | 143 | 0 |
| BRAF / Skin | 152 | 75 | 77 | 0 |

Both source datasets reported 26Q3 against a 26Q1 catalog baseline.
The interface preserves this release warning.
The Node API rechecks query identity, numeric values, unique models and counts.
Python tests independently recompute snapshot row hashes; the browser displays the hash supplied by the notebook.

## Checks

From the repository root:

```bash
npm --prefix web test
npm --prefix web run build
uv run --project python --with httpx python -m unittest discover -s web -p test_data_bridge.py -v
uv run --project python --with httpx python -m unittest discover -s python/tests -p test_service.py -v
```

These checks cover schema restrictions, graph validity, missingness, evidence integrity, Chat SDK conversion and streaming, hosted asset delivery, same-origin checks, service calls, direct Anthropic selection without provider fallback, and explicit upstream errors.
Live AI composition and Breadbox retrieval were also verified in the deployed prototype.
Slack and Teams delivery are outside this demo.
