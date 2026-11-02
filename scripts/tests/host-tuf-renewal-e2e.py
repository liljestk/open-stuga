#!/usr/bin/env python3
"""End-to-end test of scripts/host-tuf-renewal.py against a throwaway feed.

Builds a feed shaped like the production one (root v1 with 2-of-3 root and
targets keys, an expired targets role, hash-pinned snapshot and timestamp) with
throwaway keys in a local bare Git repository, serves that repository over
HTTP the way media.githubusercontent.com serves the real feed, and drives the
renewer through check, dry run, publish, no-op, online backstop, and refusals.
Runs with python-tuf 5.1 (Debian Trixie, as on the appliance) and 7.0.
"""

from __future__ import annotations

import argparse
import datetime as dt
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

from cryptography.hazmat.primitives import serialization
from securesystemslib.signer import CryptoSigner
from tuf.api.metadata import (
    MetaFile,
    Metadata,
    Root,
    Snapshot,
    TargetFile,
    Targets,
    Timestamp,
)
from tuf.api.serialization.json import JSONSerializer


SCRIPTS = Path(__file__).resolve().parents[1]
UPDATER = SCRIPTS.parent / "deploy" / "rpi" / "host-updater"
TARGET_PATH = "channels/preview/stugu-rpi4-usb.raucb"
COMPACT = JSONSerializer(compact=True)


def load_renewer(path: Path):
    spec = importlib.util.spec_from_file_location("host_tuf_renewal", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def run_git(arguments: list[str], cwd: Path) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid"]
        + arguments,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def signed(metadata: Metadata, signers: list[CryptoSigner]) -> bytes:
    for signer in signers:
        metadata.sign(signer, append=True)
    # Compact, unlike the renewer: the snapshot pins must hold for bytes that
    # other tooling wrote.
    return metadata.to_bytes(COMPACT)


def key_directory(work: Path, keys: dict[str, list[CryptoSigner]], root: bytes) -> Path:
    directory = work / "keys"
    directory.mkdir()
    (directory / "root.json").write_bytes(root)
    for role, signers in keys.items():
        for position, signer in enumerate(signers, start=1):
            pem = signer._private_key.private_bytes(  # noqa: SLF001 - test keys
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
            (directory / f"tuf-{role}-{position}.pem").write_bytes(pem)
    return directory


def build_feed(
    work: Path, keys: dict[str, list[CryptoSigner]], now: dt.datetime
) -> tuple[Path, bytes]:
    """Create a bare feed repository mirroring the 2026-11 incident state."""
    root = Root(
        version=1, expires=now + dt.timedelta(days=1800), consistent_snapshot=True
    )
    for role, signers in keys.items():
        for signer in signers:
            root.add_key(signer.public_key, role)
    root.roles["root"].threshold = 2
    root.roles["targets"].threshold = 2
    root_bytes = signed(Metadata(root), keys["root"][:2])

    targets = Targets(version=14, expires=now - dt.timedelta(days=58))
    targets.targets[TARGET_PATH] = TargetFile(
        length=4096,
        hashes={"sha256": "ab" * 32},
        path=TARGET_PATH,
        unrecognized_fields={"custom": {"stugu": {"hostGeneration": 15}}},
    )
    targets_bytes = signed(Metadata(targets), keys["targets"][1:])
    snapshot = Snapshot(version=16, expires=now + dt.timedelta(days=28))
    snapshot.meta["targets.json"] = MetaFile(
        version=14,
        length=len(targets_bytes),
        hashes={"sha256": hashlib.sha256(targets_bytes).hexdigest()},
    )
    snapshot_bytes = signed(Metadata(snapshot), keys["snapshot"])
    timestamp = Timestamp(
        version=16,
        expires=now - dt.timedelta(days=32),
        snapshot_meta=MetaFile(
            version=16,
            length=len(snapshot_bytes),
            hashes={"sha256": hashlib.sha256(snapshot_bytes).hexdigest()},
        ),
    )
    timestamp_bytes = signed(Metadata(timestamp), keys["timestamp"])

    source = work / "feed-source"
    metadata = source / "host-updates" / "v1" / "metadata"
    metadata.mkdir(parents=True)
    for name, data in {
        "1.root.json": root_bytes,
        "14.targets.json": targets_bytes,
        "16.snapshot.json": snapshot_bytes,
        "timestamp.json": timestamp_bytes,
    }.items():
        (metadata / name).write_bytes(data)
    run_git(["init", "--quiet", "--initial-branch", "main"], source)
    run_git(["add", "."], source)
    run_git(["commit", "--quiet", "-m", "feed"], source)
    bare = work / "feed.git"
    run_git(["clone", "--quiet", "--bare", str(source), str(bare)], work)
    return bare, root_bytes


class FeedHandler(BaseHTTPRequestHandler):
    """Serve <path> from the bare repository's main branch, like the LFS host."""

    def __init__(self, *arguments, bare: Path, **keywords) -> None:
        self.bare = bare
        super().__init__(*arguments, **keywords)

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        shown = subprocess.run(
            ["git", f"--git-dir={self.bare}", "show", f"main:{self.path.lstrip('/')}"],
            capture_output=True,
            check=False,
        )
        if shown.returncode != 0:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(shown.stdout)))
        self.end_headers()
        self.wfile.write(shown.stdout)

    def log_message(self, *_arguments) -> None:
        return


def serve(bare: Path) -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(FeedHandler, bare=bare))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/host-updates/v1/"


def feed_names(bare: Path) -> set[str]:
    listing = run_git(
        [
            "--git-dir",
            str(bare),
            "ls-tree",
            "--name-only",
            "main",
            "host-updates/v1/metadata/",
        ],
        bare,
    )
    return {Path(line).name for line in listing.splitlines()}


def feed_file(bare: Path, name: str) -> bytes:
    return subprocess.run(
        ["git", f"--git-dir={bare}", "show", f"main:host-updates/v1/metadata/{name}"],
        capture_output=True,
        check=True,
    ).stdout


def expect_failure(renewer, options, message: str, now) -> None:
    report = renewer.attempt(options, now)
    assert report["ok"] is False, report
    assert message in report["error"], report


def test_renewal(renewer, work: Path) -> None:
    now = renewer.utcnow()
    keys = {
        "root": [CryptoSigner.generate_ed25519() for _ in range(3)],
        "targets": [CryptoSigner.generate_ed25519() for _ in range(3)],
        "snapshot": [CryptoSigner.generate_ed25519()],
        "timestamp": [CryptoSigner.generate_ed25519()],
    }
    bare, root_bytes = build_feed(work, keys, now)
    keys_dir = key_directory(work, keys, root_bytes)
    server, public = serve(bare)
    options = partial(
        renewer.Options,
        trusted_root=keys_dir / "root.json",
        key_directory=keys_dir,
        repository=str(bare),
        public_feed=public,
    )
    clock = lambda: now  # noqa: E731
    try:
        checked = renewer.attempt(options(command="check"), clock)
        assert checked["outcome"] == "renewal-due", checked
        assert checked["publicFeed"]["accepted"] is False, checked
        assert "ExpiredMetadataError" in checked["publicFeed"]["problem"], checked
        print("check: expired targets and timestamp reported, public feed rejected")

        before = feed_names(bare)
        dry = renewer.attempt(options(command="renew"), clock)
        assert dry["outcome"] == "dry-run", dry
        assert dry["proof"] == {
            "root": 1,
            "timestamp": 17,
            "snapshot": 17,
            "targets": 15,
        }
        assert feed_names(bare) == before
        print("dry run: proved targets v15/snapshot v17/timestamp v17, pushed nothing")

        published = renewer.attempt(options(command="renew", publish=True), clock)
        assert published["outcome"] == "renewed", published
        assert published["publicFeed"]["versions"]["targets"] == 15, published
        assert {"15.targets.json", "17.snapshot.json"} <= feed_names(bare)
        old = Metadata.from_bytes(feed_file(bare, "14.targets.json"))
        new = Metadata.from_bytes(feed_file(bare, "15.targets.json"))
        assert renewer.signed_content(old) == renewer.signed_content(new)
        assert renewer.expiry(new) == now + dt.timedelta(days=365)
        assert len(new.signatures) == 2
        print("publish: pushed, public feed verified from root v1, targets unchanged")

        settled = renewer.attempt(options(command="renew", publish=True), clock)
        assert settled["outcome"] == "current", settled
        assert settled["publicFeed"]["accepted"] is True, settled
        print("second run: nothing due, nothing pushed")

        later = lambda: now + dt.timedelta(days=25)  # noqa: E731
        backstop = renewer.attempt(options(command="renew", publish=True), later)
        assert backstop["outcome"] == "renewed", backstop
        assert backstop["written"] == ["18.snapshot.json", "timestamp.json"], backstop
        print("backstop: stale online roles refreshed without touching targets")

        rogue = keys_dir / "tuf-targets-0.pem"
        rogue.write_bytes(
            CryptoSigner.generate_ed25519()._private_key.private_bytes(  # noqa: SLF001
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        renew_now = options(command="renew", publish=True)
        far = lambda: now + dt.timedelta(days=300)  # noqa: E731
        expect_failure(
            renewer, renew_now, "is not a targets key of the trusted root", far
        )
        rogue.unlink()
        print("refusal: a key the root does not authorize stops the run")

        checkout = work / "tamper"
        run_git(["clone", "--quiet", str(bare), str(checkout)], work)
        snapshot = checkout / "host-updates" / "v1" / "metadata" / "18.snapshot.json"
        snapshot.write_bytes(snapshot.read_bytes() + b"\n")
        run_git(["commit", "--quiet", "-am", "tamper"], checkout)
        run_git(["push", "--quiet", "origin", "main"], checkout)
        before = feed_names(bare)
        expect_failure(
            renewer, renew_now, "does not match its pinned length and hash", far
        )
        assert feed_names(bare) == before
        print("refusal: a snapshot that breaks its pin stops the run, nothing pushed")

        state = work / "state"
        code = renewer.main(
            [
                "check",
                "--trusted-root",
                str(keys_dir / "root.json"),
                "--state-dir",
                str(state),
            ]
            + ["--repository", str(bare), "--public-feed", public],
        )
        recorded = json.loads((state / "last-run.json").read_text("utf-8"))
        assert code == 1 and recorded["ok"] is False, recorded
        assert (state / "history.jsonl").read_text("utf-8").count("\n") == 1
        print("cli: check records last-run.json and exits non-zero on a bad feed")
    finally:
        server.shutdown()


def test_client_parity(renewer) -> None:
    if not (UPDATER / "stugu_host_updater").is_dir():
        print("parity: skipped outside the source repository")
        return
    sys.path.insert(0, str(UPDATER))
    from stugu_host_updater.repository import CLIENT_LIMITS

    assert renewer.APPLIANCE_CLIENT == CLIENT_LIMITS
    print("parity: renewer proves with the appliance's python-tuf client limits")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--renewer", type=Path, default=SCRIPTS / "host-tuf-renewal.py")
    arguments = parser.parse_args()
    renewer = load_renewer(arguments.renewer)
    test_client_parity(renewer)
    work = Path(tempfile.mkdtemp(prefix="stugu-tuf-renewal-e2e-"))
    try:
        test_renewal(renewer, work)
    finally:
        renewer.remove_tree(work)
    print("HOST TUF RENEWAL E2E PASSED")


if __name__ == "__main__":
    main()
