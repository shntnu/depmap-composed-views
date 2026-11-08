"""Private Vercel service for the catalog's verified dependency query."""

import logging
import sys
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

NOTEBOOK_DIR = Path(__file__).resolve().parent / "notebooks"
sys.path.insert(0, str(NOTEBOOK_DIR))
from nb06_verified_dependency_query import verified_dependency_query  # noqa: E402

app = FastAPI(title="DepMap verified query", docs_url=None, redoc_url=None, openapi_url=None)
logger = logging.getLogger(__name__)


class Query(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    gene: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9.-]*$")
    lineage: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z][A-Za-z /()-]*$")
    expected_release: str | None = Field(default=None, pattern=r"^[0-9]{2}Q[1-4]$")


@app.post("/query")
def query(inputs: Query):
    """Return complete evidence; upstream failure never becomes an empty result."""
    try:
        return verified_dependency_query(inputs.gene, inputs.lineage, expected_release=inputs.expected_release)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except requests.Timeout as error:
        raise HTTPException(status_code=504, detail="Breadbox timed out. Retry the live query.") from error
    except requests.RequestException as error:
        raise HTTPException(status_code=502, detail="Breadbox retrieval failed. Retry the live query.") from error
    except Exception as error:
        logger.exception("Verified dependency query failed")
        raise HTTPException(status_code=500, detail="The verified query failed before producing evidence.") from error
