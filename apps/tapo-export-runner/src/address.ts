const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Prevents an API job from redirecting household exports to an unrelated
 * mailbox. The durable API chooses the tag; the runner only accepts tags on
 * its configured base mailbox.
 */
export function assertExpectedExportAddress(baseAddress: string, expectedAddress: string): string {
  if (!EMAIL_PATTERN.test(baseAddress.trim()) || !EMAIL_PATTERN.test(expectedAddress.trim())) {
    throw new Error("The export job recipient must be a valid email address");
  }
  const baseAt = baseAddress.lastIndexOf("@");
  const expectedAt = expectedAddress.lastIndexOf("@");
  const baseLocal = baseAddress.slice(0, baseAt).split("+", 1)[0]?.toLowerCase() ?? "";
  const expectedLocal = expectedAddress.slice(0, expectedAt).toLowerCase();
  const baseDomain = baseAddress.slice(baseAt + 1).toLowerCase();
  const expectedDomain = expectedAddress.slice(expectedAt + 1).toLowerCase();
  if (baseDomain !== expectedDomain || !expectedLocal.startsWith(`${baseLocal}+`) || expectedLocal.length <= baseLocal.length + 1) {
    throw new Error("The export job recipient is not a plus address on TAPO_EXPORT_EMAIL");
  }
  return expectedAddress.trim();
}
