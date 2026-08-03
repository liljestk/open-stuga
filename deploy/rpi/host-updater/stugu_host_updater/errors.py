"""Stable, sanitized updater errors exposed through the local protocol."""

from __future__ import annotations


class UpdaterError(Exception):
    """An expected failure with a stable external error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ContractError(UpdaterError):
    def __init__(self, message: str) -> None:
        super().__init__("CONTRACT_INVALID", message)


class PreflightError(UpdaterError):
    pass


class TrustError(UpdaterError):
    def __init__(self, message: str) -> None:
        super().__init__("TRUST_VERIFICATION_FAILED", message)


class ActivationBlocked(UpdaterError):
    def __init__(self, message: str) -> None:
        super().__init__("ACTIVATION_NOT_QUALIFIED", message)
