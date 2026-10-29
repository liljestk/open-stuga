import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { diagnoseEvidence } from "../rpi-doctor.mjs";
import { validateApplicationReleaseTarget } from "../tooling/application-release-target.mjs";
import { cacheKey } from "../tooling/runtime.mjs";
import { healthyEvidence, hex } from "./rpi-doctor-test-support.mjs";

const FIRST_SUCCESS = "2026-08-09T09:59:58.120Z";
const LATER_SUCCESS = "2026-08-09T09:59:59.910Z";

function streamingEvidence(followUp, archive = {}) {
  const evidence = healthyEvidence();
  evidence.health.telemetryArchive = {
    ...evidence.health.telemetryArchive,
    phase: "syncing",
    caughtUp: false,
    queuedSamples: 2,
    dirtyRows: 0,
    lastSuccessAt: FIRST_SUCCESS,
    ...archive,
  };
  if (followUp) evidence.health.telemetryArchiveFollowUp = followUp;
  return evidence;
}

function read(elapsedMs, caughtUp, queuedSamples, lastSuccessAt = FIRST_SUCCESS) {
  return { elapsedMs, phase: caughtUp ? "ready" : "syncing", caughtUp, queuedSamples, lastSuccessAt };
}

function archiveCheck(diagnosis) {
  return diagnosis.checks.find((item) => item.id === "ARCHIVE_DATABASE");
}

function releaseReceipt(evidence) {
  const diagnosis = diagnoseEvidence(evidence);
  return {
    schema: "stugu-rpi-doctor/v1", ...diagnosis, mode: "default",
    collectedAt: evidence.collectedAt, durationMs: evidence.durationMs,
    target: { selectorSha256: hex("a"), sshHostKeyFingerprint: `SHA256:${"A".repeat(30)}` },
    identity: evidence.identity, evidenceSha256: cacheKey(evidence),
  };
}

test("a one- or two-sample in-flight queue that drains during the follow-up reads passes", () => {
  for (const followUp of [
    [read(760, false, 1), read(1_520, true, 0, LATER_SUCCESS)],
    [read(755, true, 0, LATER_SUCCESS)],
    // Production cadence: each read lands inside a fresh one-second flush
    // window, but lastSuccessAt shows the queue drained between reads.
    [read(760, false, 2, LATER_SUCCESS), read(1_515, false, 1, LATER_SUCCESS)],
  ]) {
    const diagnosis = diagnoseEvidence(streamingEvidence(followUp));
    assert.equal(archiveCheck(diagnosis).status, "pass");
    assert.match(archiveCheck(diagnosis).summary, /^Archive syncing, caught up within \d follow-up read\(s\) over \d\.\d s \(2 sample\(s\) in flight at first read\)/u);
    assert.equal(diagnosis.result, "healthy");
    assert.equal(diagnosis.summary.archive.followUpReads, followUp.length);
    assert.equal(diagnosis.summary.archive.sustainedLag, false);
    const receipt = releaseReceipt(streamingEvidence(followUp));
    assert.equal(validateApplicationReleaseTarget(receipt), receipt);
  }
});

test("a sustained or growing archive backlog still warns and blocks an application release", () => {
  for (const [followUp, queued] of [
    [[read(760, false, 5), read(1_520, false, 8), read(2_280, false, 10), read(3_040, false, 12)], "2 -> 12"],
    [[read(760, false, 2), read(1_520, false, 2), read(2_280, false, 2), read(3_040, false, 2)], "2 -> 2"],
  ]) {
    const evidence = streamingEvidence(followUp);
    const diagnosis = diagnoseEvidence(evidence);
    assert.equal(archiveCheck(diagnosis).status, "warning");
    assert.match(
      archiveCheck(diagnosis).summary,
      new RegExp(`^Archive syncing, not caught up across 4 follow-up read\\(s\\) over 3\\.0 s \\(queued ${queued}\\)`, "u"),
    );
    assert.equal(diagnosis.result, "attention");
    assert.equal(diagnosis.summary.archive.sustainedLag, true);
    assert.throws(() => validateApplicationReleaseTarget(releaseReceipt(evidence)), /idle host-feed warning/u);
  }
});

test("archive lag evidence is judged conservatively", () => {
  // An archive that has never drained cannot prove progress by a null timestamp.
  const neverDrained = streamingEvidence([read(760, false, 40, null), read(1_520, false, 90, null)], {
    lastSuccessAt: null,
  });
  assert.equal(archiveCheck(diagnoseEvidence(neverDrained)).status, "warning");
  // Only a boolean true or a later valid instant counts as having caught up.
  const malformed = streamingEvidence([
    { elapsedMs: 760, caughtUp: "true", queuedSamples: 2, lastSuccessAt: "later" },
    null,
    { elapsedMs: 1_520, caughtUp: 1, queuedSamples: -1, lastSuccessAt: "2026-08-09T09:59:50.000Z" },
  ]);
  const malformedCheck = archiveCheck(diagnoseEvidence(malformed));
  assert.equal(malformedCheck.status, "warning");
  assert.match(malformedCheck.summary, /not caught up across 2 follow-up read\(s\) over 1\.5 s \(queued 2 -> \?\)/u);
  // Evidence from a collector without follow-up reads keeps the single-read verdict.
  const singleRead = archiveCheck(diagnoseEvidence(streamingEvidence(null)));
  assert.equal(singleRead.status, "warning");
  assert.match(singleRead.summary, /^Archive syncing, caught up false;/u);
  // A required archive that is degraded still fails regardless of follow-up reads.
  const degraded = streamingEvidence([read(760, true, 0, LATER_SUCCESS)], { required: true, phase: "degraded" });
  assert.equal(archiveCheck(diagnoseEvidence(degraded)).status, "fail");
  // A caught-up first read needs no follow-up and keeps its original summary.
  const caughtUp = diagnoseEvidence(healthyEvidence());
  assert.match(archiveCheck(caughtUp).summary, /^Archive ready, caught up true;/u);
  assert.equal(caughtUp.summary.archive.followUpReads, 0);
});

test("Pi remote collector re-reads only a lagging archive, within the health budget", () => {
  const collector = new URL("../tooling/rpi-doctor-remote.py", import.meta.url);
  const program = String.raw`
import io
import json
import runpy
import sys
import urllib.error
from unittest.mock import patch
module = runpy.run_path(sys.argv[1])
health = module["health_snapshot"]
secret = "private-token-and-hostname"
clock = [1000.0]
def monotonic():
    return clock[0]
def sleep(seconds):
    clock[0] += seconds
def body(caught_up, queued, success="2026-08-09T09:59:58.120Z", **extra):
    archive = {"enabled": True, "required": False, "phase": "ready" if caught_up else "syncing", "caughtUp": caught_up, "queuedSamples": queued, "lastSuccessAt": success, "private": secret, **extra}
    return json.dumps({"status": "ok", "database": "ready", "telemetryArchive": archive}).encode()
def serve(*bodies, cost=0.01):
    remaining = list(bodies)
    calls = []
    def urlopen(request, timeout):
        calls.append(timeout)
        clock[0] += min(cost, timeout)
        item = remaining.pop(0)
        if isinstance(item, BaseException):
            raise item
        response = io.BytesIO(item)
        response.status = 200
        return response
    return urlopen, calls
def collect(*bodies, cost=0.01):
    clock[0] = 1000.0
    urlopen, calls = serve(*bodies, cost=cost)
    with patch("time.monotonic", monotonic), patch("time.sleep", sleep), patch("urllib.request.urlopen", urlopen):
        return health(), calls
# A caught-up first read takes no follow-up read.
result, calls = collect(body(True, 0))
assert "telemetryArchiveFollowUp" not in result and calls == [2.5]
# A disabled archive is never re-read.
result, calls = collect(json.dumps({"status": "ok", "telemetryArchive": {"enabled": False, "caughtUp": False}}).encode())
assert "telemetryArchiveFollowUp" not in result and calls == [2.5]
# A transient queue stops re-reading as soon as the archive catches up.
result, calls = collect(body(False, 2), body(False, 1), body(True, 0, "2026-08-09T09:59:59.910Z"))
reads = result["telemetryArchiveFollowUp"]
assert calls == [2.5, 1.0, 1.0]
assert [item["caughtUp"] for item in reads] == [False, True]
assert reads[-1] == {"elapsedMs": 1530, "phase": "ready", "caughtUp": True, "queuedSamples": 0, "lastSuccessAt": "2026-08-09T09:59:59.910Z"}
assert result["probe"]["durationMs"] == 10
assert secret not in json.dumps(result["telemetryArchiveFollowUp"])
# A sustained lag takes the bounded number of reads; values are type-checked.
result, calls = collect(body(False, 3), body(False, 5), body(False, True), body(False, 9, "yesterday", phase=["x"]), body(False, 12))
reads = result["telemetryArchiveFollowUp"]
assert len(reads) == 4 and len(calls) == 5
assert [item["queuedSamples"] for item in reads] == [5, None, 9, 12]
assert reads[2]["lastSuccessAt"] is None and reads[2]["phase"] is None
assert reads[-1]["elapsedMs"] <= 5000
# A slow first read leaves room only for follow-up reads that fit the budget.
result, calls = collect(body(False, 3), body(False, 3), body(False, 3), cost=2.4)
assert len(result["telemetryArchiveFollowUp"]) == 1
assert clock[0] - 1000.0 <= 5.0 + 1e-9
# A failing follow-up read keeps the first snapshot and the reads before it.
result, calls = collect(body(False, 3), body(False, 3), urllib.error.URLError(TimeoutError(secret)))
assert result["available"] is True and result["probe"]["outcome"] == "success"
assert len(result["telemetryArchiveFollowUp"]) == 1
assert secret not in json.dumps(result["telemetryArchiveFollowUp"])
assert secret not in json.dumps(result["probe"])
print("archive follow-up passed")
`;
  const result = spawnSync("python", ["-B", "-", fileURLToPath(collector)], {
    input: program, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /archive follow-up passed/u);
});
