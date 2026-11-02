#!/usr/bin/env python3
"""Keep the Stugu host-update feed's TUF metadata from expiring.

Runs on the operator machine that holds the feed's signing keys, normally from
the scheduled task that `npm run host-tuf-renewal -- install` registers. Each
run clones the public feed (metadata only) and verifies the published
timestamp -> snapshot -> targets chain against the pinned root v1, signatures
and hash pins included, so it only ever re-signs content the keys already
approved. Then:

- while targets has more than --renew-within-days left and the feed's weekly
  online workflow keeps snapshot and timestamp fresh, it changes nothing;
- otherwise it re-signs targets with identical target entries, a new version
  and a fresh lifetime (or, when only the online workflow has fallen behind,
  just snapshot and timestamp), followed by a matching snapshot and timestamp;
- it proves the result with the appliance's own python-tuf client settings
  before writing anything; with --publish it pushes to the feed and verifies
  the public URL from root v1 again.

It never adds, removes or edits a target, never touches root, and never prints
or copies key material. `check` is read-only and needs no keys.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import datetime as dt
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from typing import Callable, Iterator

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from securesystemslib.signer import CryptoSigner
from tuf.api.exceptions import DownloadHTTPError
from tuf.api.metadata import MetaFile, Metadata, Root
from tuf.api.serialization.json import JSONSerializer
from tuf.ngclient import Updater
from tuf.ngclient.config import UpdaterConfig
from tuf.ngclient.fetcher import FetcherInterface


FEED_REPOSITORY = "https://github.com/liljestk/stugu-releases.git"
PUBLIC_FEED = (
    "https://media.githubusercontent.com/media/liljestk/stugu-releases/main/"
    "host-updates/v1/"
)
METADATA_PATH = "host-updates/v1/metadata"
COMMITTER = ("stugu-tuf-renewer", "stugu-tuf-renewer@users.noreply.github.com")
SERIALIZER = JSONSerializer(compact=False)
# The client limits of deploy/rpi/host-updater/stugu_host_updater/repository.py
# (CLIENT_LIMITS); the end-to-end test asserts they are identical.
APPLIANCE_CLIENT = {
    "max_root_rotations": 0,
    "max_delegations": 16,
    "root_max_length": 512 * 1024,
    "timestamp_max_length": 64 * 1024,
    "snapshot_max_length": 2 * 1024 * 1024,
    "targets_max_length": 4 * 1024 * 1024,
    "prefix_targets_with_hash": True,
}
OFFLINE_FEED = "https://renewal-proof.invalid/"
PUBLIC_WAIT = dt.timedelta(minutes=10)
ROOT_WARNING = dt.timedelta(days=180)
HISTORY_LINES = 400
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class RenewalError(RuntimeError):
    """A refusal or failure that stops the run before anything is published."""


class PushRejected(RenewalError):
    """The feed moved while this run worked; start again from a fresh clone."""


@dataclass(frozen=True)
class Policy:
    renew_within: dt.timedelta = dt.timedelta(days=90)
    targets_lifetime: dt.timedelta = dt.timedelta(days=365)
    snapshot_lifetime: dt.timedelta = dt.timedelta(days=90)
    timestamp_lifetime: dt.timedelta = dt.timedelta(days=30)
    online_backstop: dt.timedelta = dt.timedelta(days=7)

    def validate(self) -> None:
        if self.targets_lifetime - self.renew_within < dt.timedelta(days=30):
            raise RenewalError(
                "targets lifetime must exceed the renewal window by 30 days"
            )
        if min(self.snapshot_lifetime, self.timestamp_lifetime) <= self.online_backstop:
            raise RenewalError("online lifetimes must exceed the online backstop")


@dataclass(frozen=True)
class Feed:
    files: dict[str, bytes]
    root: Root
    timestamp: Metadata
    snapshot: Metadata
    targets: Metadata
    snapshot_name: str
    targets_name: str


@dataclass(frozen=True)
class Plan:
    renew_targets: bool
    refresh_online: bool
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class Options:
    command: str
    trusted_root: Path
    key_directory: Path | None = None
    repository: str = FEED_REPOSITORY
    public_feed: str = PUBLIC_FEED
    publish: bool = False
    state_directory: Path | None = None
    policy: Policy = Policy()


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def expiry(metadata: Metadata) -> dt.datetime:
    return metadata.signed.expires.replace(tzinfo=dt.timezone.utc)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pin(data: bytes, version: int) -> MetaFile:
    return MetaFile(version=version, length=len(data), hashes={"sha256": sha256(data)})


def verified(root: Root, role: str, data: bytes | None) -> Metadata:
    """Parse published metadata and require its root signature threshold."""
    if data is None:
        raise RenewalError(f"the feed publishes no current {role} metadata")
    try:
        metadata = Metadata.from_bytes(data)
    except Exception as error:
        raise RenewalError(f"published {role} metadata is malformed") from error
    if metadata.signed.type != role:
        raise RenewalError(f"published {role} metadata has type {metadata.signed.type}")
    try:
        root.verify_delegate(role, metadata.signed_bytes, metadata.signatures)
    except Exception as error:
        raise RenewalError(
            f"published {role} metadata lacks its root signature threshold"
        ) from error
    return metadata


def pinned_file(files: dict[str, bytes], name: str, meta: MetaFile) -> bytes:
    data = files.get(name)
    if data is None:
        raise RenewalError(f"published metadata {name} is missing")
    try:
        meta.verify_length_and_hashes(data)
    except Exception as error:
        raise RenewalError(
            f"published {name} does not match its pinned length and hash"
        ) from error
    return data


def read_feed(metadata_dir: Path, trusted_root: bytes) -> Feed:
    """Load the current chain the way a client would, ignoring only expiry."""
    files = {path.name: path.read_bytes() for path in metadata_dir.glob("*.json")}
    rotations = sorted(
        name for name in files if name.endswith(".root.json") and name != "1.root.json"
    )
    if rotations:
        raise RenewalError(
            f"the feed publishes root rotation {rotations[0]}; this renewer trusts "
            "root v1 only and must be updated before it can sign again"
        )
    if files.get("1.root.json") != trusted_root:
        raise RenewalError(
            "the feed's 1.root.json differs from the pinned trusted root"
        )
    root = Metadata.from_bytes(trusted_root).signed
    if root.type != "root":
        raise RenewalError("the pinned trusted root is not root metadata")

    timestamp = verified(root, "timestamp", files.get("timestamp.json"))
    snapshot_meta = timestamp.signed.snapshot_meta
    snapshot_name = f"{snapshot_meta.version}.snapshot.json"
    snapshot = verified(
        root, "snapshot", pinned_file(files, snapshot_name, snapshot_meta)
    )
    targets_meta = snapshot.signed.meta.get("targets.json")
    if targets_meta is None:
        raise RenewalError(f"{snapshot_name} does not list targets.json")
    targets_name = f"{targets_meta.version}.targets.json"
    targets = verified(root, "targets", pinned_file(files, targets_name, targets_meta))
    for name, metadata, meta in (
        (snapshot_name, snapshot, snapshot_meta),
        (targets_name, targets, targets_meta),
    ):
        if metadata.signed.version != meta.version:
            raise RenewalError(f"{name} declares version {metadata.signed.version}")
    if targets.signed.delegations is not None:
        raise RenewalError(
            "targets delegates to other roles; this renewer renews top-level "
            "targets only"
        )
    return Feed(files, root, timestamp, snapshot, targets, snapshot_name, targets_name)


def plan_renewal(feed: Feed, now: dt.datetime, policy: Policy) -> Plan:
    reasons = []
    targets_left = expiry(feed.targets) - now
    renew_targets = targets_left < policy.renew_within
    if renew_targets:
        reasons.append(
            f"targets v{feed.targets.signed.version} expires "
            f"{iso(expiry(feed.targets))}, inside the "
            f"{policy.renew_within.days}-day renewal window"
        )
    online_expiry = min(expiry(feed.timestamp), expiry(feed.snapshot))
    online_behind = online_expiry - now < policy.online_backstop
    if online_behind:
        reasons.append(
            f"snapshot/timestamp expire {iso(online_expiry)}: the online refresh "
            f"is more than {policy.online_backstop.days} days behind"
        )
    return Plan(renew_targets, renew_targets or online_behind, tuple(reasons))


def private_key(path: Path) -> Ed25519PrivateKey:
    try:
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    except (OSError, ValueError, TypeError):
        raise RenewalError(
            f"{path.name} is not a readable unencrypted PEM private key"
        ) from None
    if not isinstance(key, Ed25519PrivateKey):
        raise RenewalError(f"{path.name} is not an ed25519 key")
    return key


def role_signers(key_directory: Path, root: Root, role: str) -> list[CryptoSigner]:
    """Load exactly the threshold of keys the trusted root lists for role."""
    definition = root.roles[role]
    authorized = {
        root.keys[keyid].keyval.get("public"): keyid for keyid in definition.keyids
    }
    signers: dict[str, CryptoSigner] = {}
    for path in sorted(key_directory.glob(f"tuf-{role}-*.pem")):
        key = private_key(path)
        public = key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        keyid = authorized.get(public.hex())
        if keyid is None:
            raise RenewalError(f"{path.name} is not a {role} key of the trusted root")
        signers.setdefault(keyid, CryptoSigner(key, root.keys[keyid]))
        if len(signers) == definition.threshold:
            return list(signers.values())
    raise RenewalError(
        f"{key_directory} holds {len(signers)} of the {definition.threshold} "
        f"distinct {role} keys the root requires"
    )


def load_signers(
    key_directory: Path, root: Root, plan: Plan
) -> dict[str, list[CryptoSigner]]:
    roles = ["snapshot", "timestamp"] + (["targets"] if plan.renew_targets else [])
    return {role: role_signers(key_directory, root, role) for role in roles}


def sign(metadata: Metadata, signers: list[CryptoSigner]) -> bytes:
    metadata.signatures.clear()
    for signer in signers:
        metadata.sign(signer, append=True)
    return metadata.to_bytes(SERIALIZER)


def signed_content(metadata: Metadata) -> dict:
    content = metadata.signed.to_dict()
    del content["version"], content["expires"]
    return content


def renew(
    feed: Feed,
    plan: Plan,
    signers: dict[str, list[CryptoSigner]],
    now: dt.datetime,
    policy: Policy,
) -> dict[str, bytes]:
    """Return the new metadata files, keyed by their published file name."""
    written: dict[str, bytes] = {}
    snapshot = Metadata.from_bytes(feed.files[feed.snapshot_name])
    if plan.renew_targets:
        targets = Metadata.from_bytes(feed.files[feed.targets_name])
        targets.signed.version += 1
        targets.signed.expires = now + policy.targets_lifetime
        if signed_content(targets) != signed_content(feed.targets):
            raise RenewalError("renewed targets would change signed target content")
        targets_bytes = sign(targets, signers["targets"])
        written[f"{targets.signed.version}.targets.json"] = targets_bytes
        snapshot.signed.meta["targets.json"] = pin(
            targets_bytes, targets.signed.version
        )

    snapshot.signed.version += 1
    snapshot.signed.expires = now + policy.snapshot_lifetime
    snapshot_bytes = sign(snapshot, signers["snapshot"])
    written[f"{snapshot.signed.version}.snapshot.json"] = snapshot_bytes

    timestamp = Metadata.from_bytes(feed.files["timestamp.json"])
    timestamp.signed.version += 1
    timestamp.signed.expires = now + policy.timestamp_lifetime
    timestamp.signed.snapshot_meta = pin(snapshot_bytes, snapshot.signed.version)
    written["timestamp.json"] = sign(timestamp, signers["timestamp"])
    return written


class MemoryFetcher(FetcherInterface):
    """Serve metadata to python-tuf from memory, as the feed's web host would."""

    def __init__(self, base_url: str, files: dict[str, bytes]) -> None:
        self._prefix = base_url + "metadata/"
        self._files = files

    def _fetch(self, url: str) -> Iterator[bytes]:
        name = url[len(self._prefix) :] if url.startswith(self._prefix) else ""
        if name not in self._files:
            raise DownloadHTTPError(f"{url} not found", 404)
        return iter([self._files[name]])


def appliance_accepts(
    trusted_root: bytes, base_url: str, fetcher: FetcherInterface | None = None
) -> dict[str, int]:
    """Refresh from root v1 with the appliance's settings; return trusted versions."""
    with tempfile.TemporaryDirectory(prefix="stugu-tuf-client-") as work:
        metadata_dir = Path(work, "metadata")
        target_dir = Path(work, "targets")
        metadata_dir.mkdir()
        target_dir.mkdir()
        # python-tuf 5.x (the appliance) bootstraps from metadata_dir/root.json;
        # 6.0+ requires the same root as an explicit keyword.
        (metadata_dir / "root.json").write_bytes(trusted_root)
        bootstrap = (
            {"bootstrap": trusted_root}
            if "bootstrap" in inspect.signature(Updater).parameters
            else {}
        )
        updater = Updater(
            metadata_dir=str(metadata_dir),
            metadata_base_url=base_url + "metadata/",
            target_dir=str(target_dir),
            target_base_url=base_url + "targets/",
            fetcher=fetcher,
            config=UpdaterConfig(
                **APPLIANCE_CLIENT, app_user_agent="stugu-tuf-renewal/1"
            ),
            **bootstrap,
        )
        updater.refresh()
        versions = {
            role: Metadata.from_bytes(
                (metadata_dir / f"{role}.json").read_bytes()
            ).signed.version
            for role in ("root", "timestamp", "snapshot", "targets")
        }
        targets = Metadata.from_bytes((metadata_dir / "targets.json").read_bytes())
        for path, target in targets.signed.targets.items():
            info = updater.get_targetinfo(path)
            if info is None or (info.length, info.hashes) != (
                target.length,
                target.hashes,
            ):
                raise RenewalError(f"the client cannot resolve target {path}")
        return versions


def public_status(trusted_root: bytes, public_feed: str) -> dict[str, object]:
    try:
        return {
            "accepted": True,
            "versions": appliance_accepts(trusted_root, public_feed),
        }
    except Exception as error:  # noqa: BLE001 - reported, never raised
        return {"accepted": False, "problem": f"{type(error).__name__}: {error}"}


def require_public(
    trusted_root: bytes,
    public_feed: str,
    expected_timestamp: int | None = None,
    wait: dt.timedelta = PUBLIC_WAIT,
) -> dict[str, object]:
    """Require the public feed to verify, waiting for its cache after a push."""
    deadline = time.monotonic() + wait.total_seconds()
    while True:
        status = public_status(trusted_root, public_feed)
        versions = status.get("versions")
        if status["accepted"] and (
            expected_timestamp is None or versions["timestamp"] >= expected_timestamp
        ):
            return status
        problem = status.get("problem") or (
            f"the public feed still serves timestamp v{versions['timestamp']}"
        )
        if expected_timestamp is None or time.monotonic() >= deadline:
            raise RenewalError(
                f"the appliance client rejects the public feed: {problem}"
            )
        time.sleep(20)


def last_line(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else "no output"


def git(
    arguments: list[str], cwd: Path, *, check: bool = True, env: dict | None = None
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        | (env or {}),
        capture_output=True,
        text=True,
        creationflags=NO_WINDOW,
        check=False,
    )
    if check and result.returncode != 0:
        raise RenewalError(f"git {arguments[0]} failed: {last_line(result.stderr)}")
    return result


def clone_feed(repository: str, destination: Path) -> Path:
    # Signed metadata is pinned byte for byte, so line endings must never be
    # converted, whatever the operator's global Git configuration says.
    git(
        ["clone", "--quiet", "--config", "core.autocrlf=false", "--depth", "1"]
        + ["--single-branch", "--branch", "main", repository, str(destination)],
        destination.parent,
        env={"GIT_LFS_SKIP_SMUDGE": "1"},
    )
    attributes = destination / ".gitattributes"
    if attributes.is_file() and "filter=lfs" in attributes.read_text(encoding="utf-8"):
        git(["lfs", "install", "--local"], destination)
        git(["lfs", "pull", "--include", f"{METADATA_PATH}/*"], destination)
    metadata_dir = destination / METADATA_PATH
    if not metadata_dir.is_dir():
        raise RenewalError(f"the feed has no {METADATA_PATH} directory")
    return metadata_dir


def write_metadata(metadata_dir: Path, files: dict[str, bytes]) -> None:
    for name, data in files.items():
        try:
            with open(
                metadata_dir / name, "wb" if name == "timestamp.json" else "xb"
            ) as handle:
                handle.write(data)
        except FileExistsError:
            raise RenewalError(
                f"{name} already exists in the feed; published versions are immutable"
            ) from None


def commit_message(feed: Feed, plan: Plan, files: dict[str, bytes]) -> str:
    versions = {
        name.split(".")[1]: int(name.split(".")[0])
        for name in files
        if name != "timestamp.json"
    }
    timestamp = Metadata.from_bytes(files["timestamp.json"]).signed.version
    if plan.renew_targets:
        title = f"Renew TUF targets v{feed.targets.signed.version} -> v{versions['targets']}"
    else:
        title = "Refresh TUF snapshot and timestamp metadata (backstop)"
    return (
        f"{title}\n\n"
        f"Snapshot v{versions['snapshot']}, timestamp v{timestamp}; target entries are "
        "unchanged.\n"
        + "".join(f"- {reason}\n" for reason in plan.reasons)
        + "\nAutomated by scripts/host-tuf-renewal.py on the key-holding operator "
        "machine.\n"
    )


def publish(feed_root: Path, message: str, names: list[str]) -> str:
    git(["add", "--", *(f"{METADATA_PATH}/{name}" for name in names)], feed_root)
    git(
        ["-c", f"user.name={COMMITTER[0]}", "-c", f"user.email={COMMITTER[1]}"]
        + ["commit", "--quiet", "-m", message],
        feed_root,
    )
    pushed = git(["push", "--quiet", "origin", "HEAD:main"], feed_root, check=False)
    if pushed.returncode != 0:
        if re.search(r"non-fast-forward|fetch first|\[rejected\]", pushed.stderr):
            raise PushRejected("the feed changed while this run was working")
        raise RenewalError(f"git push failed: {last_line(pushed.stderr)}")
    return git(["rev-parse", "HEAD"], feed_root).stdout.strip()


def describe(feed: Feed) -> dict[str, dict[str, object]]:
    roles = {
        "root": (feed.root.version, feed.root.expires.replace(tzinfo=dt.timezone.utc)),
        "targets": (feed.targets.signed.version, expiry(feed.targets)),
        "snapshot": (feed.snapshot.signed.version, expiry(feed.snapshot)),
        "timestamp": (feed.timestamp.signed.version, expiry(feed.timestamp)),
    }
    return {
        role: {"version": version, "expires": iso(expires)}
        for role, (version, expires) in roles.items()
    }


def remove_tree(path: Path) -> None:
    def clear_read_only(function, target, _info) -> None:
        os.chmod(target, stat.S_IWRITE)
        function(target)

    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=clear_read_only)
    else:
        shutil.rmtree(path, onerror=clear_read_only)


def renewal_run(
    options: Options, now: Callable[[], dt.datetime] = utcnow
) -> dict[str, object]:
    options.policy.validate()
    trusted_root = options.trusted_root.read_bytes()
    work = Path(tempfile.mkdtemp(prefix="stugu-tuf-renewal-"))
    try:
        metadata_dir = clone_feed(options.repository, work / "feed")
        feed = read_feed(metadata_dir, trusted_root)
        moment = now()
        plan = plan_renewal(feed, moment, options.policy)
        report: dict[str, object] = {
            "checkedAt": iso(moment),
            "published": describe(feed),
            "due": list(plan.reasons),
        }
        if feed.root.expires.replace(tzinfo=dt.timezone.utc) - moment < ROOT_WARNING:
            report["warning"] = (
                "root v1 expires within 180 days; the offline root ceremony is due"
            )
        if options.command == "check":
            report["outcome"] = "renewal-due" if plan.refresh_online else "current"
            report["publicFeed"] = public_status(trusted_root, options.public_feed)
            return report
        if not plan.refresh_online:
            report["outcome"] = "current"
            if options.publish:
                report["publicFeed"] = require_public(trusted_root, options.public_feed)
            return report

        files = renew(
            feed,
            plan,
            load_signers(options.key_directory, feed.root, plan),
            moment,
            options.policy,
        )
        report["proof"] = appliance_accepts(
            trusted_root, OFFLINE_FEED, MemoryFetcher(OFFLINE_FEED, feed.files | files)
        )
        write_metadata(metadata_dir, files)
        report["written"] = sorted(files)
        if not options.publish:
            report["outcome"] = "dry-run"
            return report
        report["commit"] = publish(
            work / "feed", commit_message(feed, plan, files), sorted(files)
        )
        report["outcome"] = "renewed"
        report["publicFeed"] = require_public(
            trusted_root, options.public_feed, report["proof"]["timestamp"]
        )
        return report
    finally:
        remove_tree(work)


def attempt(options: Options, now: Callable[[], dt.datetime]) -> dict[str, object]:
    """Run once, retrying a single time when the feed moved under the push."""
    for remaining in (1, 0):
        try:
            return {"ok": True} | renewal_run(options, now)
        except PushRejected as error:
            if remaining == 0:
                return {"ok": False, "outcome": "failed", "error": str(error)}
        except RenewalError as error:
            return {"ok": False, "outcome": "failed", "error": str(error)}
        except Exception as error:  # noqa: BLE001 - recorded for the operator
            return {
                "ok": False,
                "outcome": "failed",
                "error": f"{type(error).__name__}: {error}",
            }
    raise AssertionError("unreachable")


@contextmanager
def run_lock(state_directory: Path | None) -> Iterator[bool]:
    """Yield False when another run holds the lock, so overlapping runs skip."""
    if state_directory is None:
        yield True
        return
    state_directory.mkdir(parents=True, exist_ok=True)
    lock = state_directory / "renewal.lock"
    if lock.exists() and time.time() - lock.stat().st_mtime > 3600:
        lock.unlink(missing_ok=True)
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        yield False
        return
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        os.close(descriptor)
        yield True
    finally:
        lock.unlink(missing_ok=True)


def record(state_directory: Path | None, report: dict[str, object]) -> None:
    if state_directory is None:
        return
    state_directory.mkdir(parents=True, exist_ok=True)
    line = json.dumps(report, sort_keys=True)
    temporary = state_directory / "last-run.json.tmp"
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    os.replace(temporary, state_directory / "last-run.json")
    history = state_directory / "history.jsonl"
    lines = history.read_text("utf-8").splitlines() if history.exists() else []
    history.write_text("\n".join([*lines, line][-HISTORY_LINES:]) + "\n", "utf-8")


def emit(report: dict[str, object]) -> None:
    # pythonw (the scheduled task) has no stdout; the state file is the record.
    if sys.stdout is not None:
        print(json.dumps(report, indent=2, sort_keys=True))


def parse_arguments(argv: list[str] | None) -> Options:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("check", "read-only: verify the published chain and report what is due"),
        ("renew", "re-sign what is due; a dry run unless --publish is given"),
    ):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--key-directory", type=Path, required=name == "renew")
        command.add_argument(
            "--trusted-root",
            type=Path,
            help="pinned root v1 (default: <key-directory>/root.json)",
        )
        command.add_argument("--repository", default=FEED_REPOSITORY)
        command.add_argument("--public-feed", default=PUBLIC_FEED)
        command.add_argument("--state-dir", type=Path)
        command.add_argument("--renew-within-days", type=int, default=90)
        command.add_argument("--targets-lifetime-days", type=int, default=365)
        if name == "renew":
            command.add_argument("--publish", action="store_true")
    arguments = parser.parse_args(argv)
    trusted_root = arguments.trusted_root or (
        arguments.key_directory / "root.json" if arguments.key_directory else None
    )
    if trusted_root is None:
        parser.error("check needs --trusted-root or --key-directory")
    return Options(
        command=arguments.command,
        trusted_root=trusted_root,
        key_directory=arguments.key_directory,
        repository=arguments.repository,
        public_feed=arguments.public_feed,
        publish=getattr(arguments, "publish", False),
        state_directory=arguments.state_dir,
        policy=Policy(
            renew_within=dt.timedelta(days=arguments.renew_within_days),
            targets_lifetime=dt.timedelta(days=arguments.targets_lifetime_days),
        ),
    )


def main(argv: list[str] | None = None, now: Callable[[], dt.datetime] = utcnow) -> int:
    options = parse_arguments(argv)
    with run_lock(options.state_directory) as acquired:
        if not acquired:
            emit(
                {
                    "ok": True,
                    "outcome": "skipped",
                    "reason": "another run holds the lock",
                }
            )
            return 0
        report = attempt(options, now)
        report = {"command": options.command, "finishedAt": iso(utcnow())} | report
        record(options.state_directory, report)
    emit(report)
    if not report["ok"]:
        return 1
    if options.command == "check":
        return (
            0
            if report["outcome"] == "current" and report["publicFeed"]["accepted"]
            else 1
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
