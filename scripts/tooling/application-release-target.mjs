import { validateDoctorReceipt } from "./receipt-contracts.mjs";

// Application releases replace containers, never signed host slots. Preserve
// the doctor's warning: this policy does not make the host feed healthy.
export function validateApplicationReleaseTarget(value, options = {}) {
  const receipt = validateDoctorReceipt(value, options);
  if (receipt.result === "healthy") return receipt;
  const nonPassing = receipt.checks.filter((check) => check.status !== "pass");
  const updater = receipt.summary.updater;
  if (receipt.result !== "attention"
    || nonPassing.length !== 1
    || nonPassing[0].id !== "UPDATER"
    || nonPassing[0].status !== "warning"
    || updater?.available !== true
    || updater.phase !== "failed"
    || !["TRUST_VERIFICATION_FAILED", "METADATA_FETCH_FAILED"].includes(updater.errorCode)
    || updater.journalPhase !== null
    || updater.recoveryPending !== false) {
    throw new Error("Application release requires a healthy target or only an idle host-feed warning");
  }
  return receipt;
}
