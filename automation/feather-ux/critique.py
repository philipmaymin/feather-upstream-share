#!/usr/bin/env python3
"""Upload one synthetic Feather journey to Gemini and save a bounded UX critique."""
from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from google import genai
from google.genai import types


MODEL = os.environ.get("FEATHER_UX_GEMINI_MODEL", "gemini-3.6-flash")


def load_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    env_file = Path.home() / ".env.gemini"
    for line in env_file.read_text().splitlines():
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("GEMINI_API_KEY missing")


def critique_schema() -> dict:
    finding = {
        "type": "object",
        "properties": {
            "timestamp_start": {"type": "string"},
            "timestamp_end": {"type": "string"},
            "severity": {"type": "string", "enum": ["low", "medium", "high"]},
            "observable_contract": {"type": "string"},
            "observation": {"type": "string"},
            "local_reproduction": {"type": "string"},
            "causal_hypothesis": {"type": "string"},
            "smallest_change": {"type": "string"},
            "disconfirming_evidence": {"type": "string"},
        },
        "required": [
            "timestamp_start", "timestamp_end", "severity", "observable_contract",
            "observation", "local_reproduction", "causal_hypothesis",
            "smallest_change", "disconfirming_evidence",
        ],
    }
    return {
        "type": "object",
        "properties": {
            "verdict": {"type": "string", "enum": ["no_action", "candidate"]},
            "journey_summary": {"type": "string"},
            "findings": {"type": "array", "items": finding, "maxItems": 3},
            "highest_priority_index": {"type": ["integer", "null"]},
            "limits": {"type": "string"},
        },
        "required": ["verdict", "journey_summary", "findings", "highest_priority_index", "limits"],
    }


def validate(result: dict) -> None:
    findings = result.get("findings")
    if not isinstance(findings, list) or len(findings) > 3:
        raise RuntimeError("Gemini returned an invalid findings list")
    index = result.get("highest_priority_index")
    if result.get("verdict") == "candidate":
        if not findings or not isinstance(index, int) or index < 0 or index >= len(findings):
            raise RuntimeError("candidate verdict lacks one bounded highest-priority finding")
    elif result.get("verdict") == "no_action" and index is not None:
        raise RuntimeError("no_action verdict must not select a finding")
    for finding in findings:
        if not finding.get("timestamp_start") or not finding.get("observable_contract"):
            raise RuntimeError("finding lacks timestamp or observable contract")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    run_dir = args.run_dir.resolve()
    video = run_dir / "journey.webm"
    recording = json.loads((run_dir / "recording.json").read_text())
    if recording.get("synthetic") is not True:
        raise RuntimeError("refusing to upload a recording not marked synthetic")
    if not video.is_file():
        raise RuntimeError("synthetic journey video missing")

    prompt = f"""You are reviewing one complete synthetic 390x844 touch recording of Feather/Fledge.
Focus: {recording['focus']}.

This is model-only diagnostic evidence, not a human usability verdict. Watch the entire recording once from first frame to last. Do not infer intent or hidden state. A valid finding must:
1. cite the visible start and end timestamp,
2. name an observable violated contract,
3. describe a deterministic local reproduction in this same journey,
4. offer one causal hypothesis and the smallest cause-linked change,
5. name evidence that would disconfirm the hypothesis.

Prioritize whether a user can answer only two questions: what finished or needs me, then where to ask a follow-up. Reject unanchored aesthetic preference, generic redesign advice, desired features not exercised by the recording, and issues visible for less than a meaningful interaction beat. Return no_action when the journey has no reproducible material defect. Never recommend exposing more chats, implementation residents, logs, controls, or activity by default."""

    client = genai.Client(api_key=load_key())
    uploaded = None
    try:
        uploaded = client.files.upload(file=str(video))
        deadline = time.monotonic() + 600
        while uploaded.state and uploaded.state.name == "PROCESSING":
            if time.monotonic() >= deadline:
                raise TimeoutError("Gemini video processing exceeded 10 minutes")
            time.sleep(2)
            uploaded = client.files.get(name=uploaded.name)
        if not uploaded.state or uploaded.state.name != "ACTIVE":
            raise RuntimeError(f"Gemini video upload failed: {uploaded.state}")
        response = client.models.generate_content(
            model=MODEL,
            contents=[types.Part.from_uri(file_uri=uploaded.uri, mime_type=uploaded.mime_type), prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=critique_schema(),
                temperature=0.25,
            ),
        )
        result = json.loads(response.text)
        validate(result)
        receipt = {
            "schema": 1,
            "evidenceClass": "model-only diagnostic hypothesis; synthetic journey only",
            "model": MODEL,
            "focus": recording["focus"],
            "reviewedAt": datetime.now(timezone.utc).isoformat(),
            **result,
        }
        (run_dir / "critique.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"model": MODEL, "focus": recording["focus"], "verdict": result["verdict"], "findings": len(result["findings"])}))
    finally:
        if uploaded is not None:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass


if __name__ == "__main__":
    main()
