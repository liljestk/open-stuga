#!/usr/bin/env python3
"""Native RAUC + TUF publication-verifier integration gate for Debian Trixie."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading

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


REPOSITORY = Path(__file__).resolve().parents[2]
UPDATER = REPOSITORY / "deploy" / "rpi" / "host-updater"
sys.path.insert(0, str(UPDATER))

from stugu_host_updater.contracts import ReleaseManifest  # noqa: E402


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.write_bytes(data)
    path.chmod(mode)


def run(*arguments: str, env: dict[str, str] | None = None) -> None:
    subprocess.run(
        arguments,
        check=True,
        stdin=subprocess.DEVNULL,
        env=env,
        timeout=300,
    )


def generate_certificates(work: Path) -> tuple[Path, Path, Path, Path]:
    ca = work / "rauc-ca.pem"
    ca_key = work / "rauc-ca.key"
    leaf = work / "rauc-leaf.pem"
    leaf_key = work / "rauc-leaf.key"
    run(
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(ca_key),
        "-out",
        str(ca),
        "-days",
        "2",
        "-subj",
        "/CN=Stugu RAUC test CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
    )
    csr = work / "rauc-leaf.csr"
    run(
        "openssl",
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(leaf_key),
        "-out",
        str(csr),
        "-subj",
        "/CN=Stugu RAUC test release",
    )
    extensions = work / "rauc-leaf.ext"
    extensions.write_text(
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature\n"
        "extendedKeyUsage=critical,codeSigning\n",
        encoding="ascii",
    )
    run(
        "openssl",
        "x509",
        "-req",
        "-in",
        str(csr),
        "-CA",
        str(ca),
        "-CAkey",
        str(ca_key),
        "-CAcreateserial",
        "-out",
        str(leaf),
        "-days",
        "2",
        "-extfile",
        str(extensions),
    )
    return ca, ca_key, leaf, leaf_key


def build_bundle(work: Path, ca: Path, leaf: Path, leaf_key: Path) -> tuple[Path, dict]:
    bundle_input = work / "bundle-input"
    bundle_input.mkdir(mode=0o700)
    files = {
        # Keep the fixture above RAUC's minimum squashfs size after compression.
        "boot.img": os.urandom(16 * 1024),
        "system.img": os.urandom(16 * 1024),
        "stugu-release-manifest-v1.json": b"{}\n",
        "stugu-host-sbom.spdx.json": b"{}\n",
        "stugu-host-provenance.intoto.jsonl": b"{}\n",
    }
    for name, data in files.items():
        write(bundle_input / name, data)
    manifest = {
        "schema": "stugu-host-release/v1",
        "product": "stugu-rpi4-usb",
        "hostGeneration": 42,
        "version": "1.2.3",
        "layout": "stugu-gpt-ab-v2",
        "hardware": {"models": ["raspberry-pi-4"], "minEeprom": "2026-01-01"},
        "updater": {"minContract": 4, "resultContract": 4},
        "bootShim": {"minGeneration": 1, "requiresRecoveryClassUpdate": False},
        "data": {
            "epoch": 1,
            "readableEpochs": [1],
            "writableEpoch": 1,
            "rollback": "automatic",
        },
        "runtimeState": {"dockerEpoch": 1, "tailscaleEpoch": 1},
        "containers": {
            "releaseSchema": 3,
            "manifestFile": "stugu-release-manifest-v1.json",
            "manifestSha256": digest(files["stugu-release-manifest-v1.json"]),
        },
        "rollback": {"minimumFallbackGeneration": 41},
        "artifacts": {
            "bootSha256": digest(files["boot.img"]),
            "bootSize": len(files["boot.img"]),
            "rootSha256": digest(files["system.img"]),
            "rootSize": len(files["system.img"]),
        },
        "supplyChain": {
            "sbomFile": "stugu-host-sbom.spdx.json",
            "sbomSha256": digest(files["stugu-host-sbom.spdx.json"]),
            "provenanceFile": "stugu-host-provenance.intoto.jsonl",
            "provenanceSha256": digest(files["stugu-host-provenance.intoto.jsonl"]),
            "sourceCommit": "f" * 40,
        },
        "migrations": [],
    }
    parsed = ReleaseManifest.parse(manifest)
    write(
        bundle_input / "stugu-host-manifest.json",
        (json.dumps(manifest, indent=2) + "\n").encode(),
    )
    write(
        bundle_input / "manifest.raucm",
        b"[update]\n"
        b"compatible=stugu-rpi4-usb:stugu-gpt-ab-v2:arm64\n"
        b"version=1.2.3\n\n[bundle]\nformat=verity\n\n"
        b"[image.rootfs]\nfilename=system.img\n\n"
        b"[image.boot]\nfilename=boot.img\n",
    )
    backend = work / "rauc-boot-backend"
    write(backend, b"#!/bin/sh\nprintf 'a\\n'\n", 0o700)
    config = work / "rauc-system.conf"
    config.write_text(
        "[system]\n"
        "compatible=stugu-rpi4-usb:stugu-gpt-ab-v2:arm64\n"
        "bootloader=custom\n\n"
        "[keyring]\n"
        f"path={ca}\n"
        "check-purpose=codesign\n\n"
        "[handlers]\n"
        f"bootloader-custom-backend={backend}\n",
        encoding="utf-8",
    )
    bundle = work / "stugu.raucb"
    run(
        "rauc",
        f"--conf={config}",
        f"--cert={leaf}",
        f"--key={leaf_key}",
        f"--signing-keyring={ca}",
        "bundle",
        str(bundle_input),
        str(bundle),
    )
    custom = {
        "stugu": {
            "schema": "stugu-host-target/v1",
            "channel": "stable",
            "manifestSha256": parsed.digest,
            "product": parsed.product,
            "layout": parsed.layout,
            "hostGeneration": parsed.host_generation,
            "version": parsed.version,
            "bootSha256": parsed.artifacts.boot_sha256,
            "rootSha256": parsed.artifacts.root_sha256,
        }
    }
    return bundle, custom


def signed(metadata: Metadata, signers: list[CryptoSigner]) -> bytes:
    for index, signer in enumerate(signers):
        metadata.sign(signer, append=index > 0)
    return metadata.to_bytes()


def build_tuf_repository(
    work: Path, bundle: Path, custom: dict
) -> tuple[Path, Path, Path]:
    repository = work / "repository"
    metadata_dir = repository / "metadata"
    targets_dir = repository / "targets"
    metadata_dir.mkdir(parents=True)
    targets_dir.mkdir()
    expiry = datetime.now(timezone.utc) + timedelta(days=2)
    signers = {
        "root": [CryptoSigner.generate_ed25519() for _ in range(3)],
        "targets": [CryptoSigner.generate_ed25519() for _ in range(3)],
        "snapshot": [CryptoSigner.generate_ed25519()],
        "timestamp": [CryptoSigner.generate_ed25519()],
    }
    root = Metadata(Root(version=1, expires=expiry, consistent_snapshot=True))
    for role, role_signers in signers.items():
        for signer in role_signers:
            root.signed.add_key(signer.public_key, role)
        root.signed.roles[role].threshold = 2 if role in {"root", "targets"} else 1
    root_bytes = signed(root, signers["root"][:2])
    immutable_root = work / "root.json"
    write(immutable_root, root_bytes)
    write(metadata_dir / "1.root.json", root_bytes)

    target_path = "channels/stable/stugu-rpi4-usb.raucb"
    target = TargetFile.from_file(target_path, str(bundle))
    target.unrecognized_fields["custom"] = custom
    targets = Metadata(
        Targets(version=1, expires=expiry, targets={target_path: target})
    )
    targets_bytes = signed(targets, signers["targets"][:2])
    write(metadata_dir / "1.targets.json", targets_bytes)

    targets_meta = MetaFile(
        version=1,
        length=len(targets_bytes),
        hashes={"sha256": digest(targets_bytes)},
    )
    snapshot = Metadata(
        Snapshot(version=1, expires=expiry, meta={"targets.json": targets_meta})
    )
    snapshot_bytes = signed(snapshot, signers["snapshot"])
    write(metadata_dir / "1.snapshot.json", snapshot_bytes)
    snapshot_meta = MetaFile(
        version=1,
        length=len(snapshot_bytes),
        hashes={"sha256": digest(snapshot_bytes)},
    )
    timestamp = Metadata(
        Timestamp(version=1, expires=expiry, snapshot_meta=snapshot_meta)
    )
    write(metadata_dir / "timestamp.json", signed(timestamp, signers["timestamp"]))

    prefixed_target = targets_dir / target.get_prefixed_paths()[0]
    prefixed_target.parent.mkdir(parents=True)
    shutil.copyfile(bundle, prefixed_target)
    request = {
        "schema": "stugu-tuf-target-request/v1",
        "targetPath": target_path,
        "length": target.length,
        "hashes": target.hashes,
        "custom": custom,
    }
    request_path = work / "request.json"
    write(request_path, (json.dumps(request, indent=2) + "\n").encode())
    return repository, immutable_root, request_path


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_: object) -> None:
        pass


def generate_server_certificate(work: Path) -> Path:
    certificate = work / "https.pem"
    key = work / "https.key"
    run(
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(key),
        "-out",
        str(certificate),
        "-days",
        "2",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,digitalSignature",
    )
    return certificate


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="stugu-publication-e2e-") as temporary:
        work = Path(temporary)
        ca, _, leaf, leaf_key = generate_certificates(work)
        bundle, custom = build_bundle(work, ca, leaf, leaf_key)
        repository, root, request = build_tuf_repository(work, bundle, custom)
        https_certificate = generate_server_certificate(work)
        handler = partial(QuietHandler, directory=str(repository))
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(https_certificate, work / "https.key")
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"https://127.0.0.1:{server.server_port}"
            receipt = work / "receipt.json"
            environment = os.environ.copy()
            environment["SSL_CERT_FILE"] = str(https_certificate)
            environment["REQUESTS_CA_BUNDLE"] = str(https_certificate)
            run(
                sys.executable,
                str(REPOSITORY / "scripts" / "verify-host-tuf-publication.py"),
                "--root",
                str(root),
                "--metadata-url",
                f"{base}/metadata/",
                "--targets-url",
                f"{base}/targets/",
                "--request",
                str(request),
                "--bundle",
                str(bundle),
                "--rauc-keyring",
                str(ca),
                "--receipt",
                str(receipt),
                "--initial-publication",
                env=environment,
            )
            value = json.loads(receipt.read_text(encoding="utf-8"))
            if value["raucManifestHash"] == value["manifestSha256"]:
                raise RuntimeError("RAUC and Stugu manifest hashes were conflated")
            if value["hostGeneration"] != 42 or value["metadataVersions"]["root"] != 1:
                raise RuntimeError("publication receipt lost verified identity")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    print("host publication native end-to-end gate passed")


if __name__ == "__main__":
    main()
