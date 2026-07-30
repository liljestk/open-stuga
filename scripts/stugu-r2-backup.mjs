#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { r2BackupConfiguration } from "./stugu-r2-backup/configuration.mjs";
import {
  downloadEncryptedObject,
  uploadVerifiedBackup,
  verifyEncryptedObject,
} from "./stugu-r2-backup/transport.mjs";

export { r2BackupConfiguration } from "./stugu-r2-backup/configuration.mjs";
export {
  downloadEncryptedObject,
  findCompletedBackup,
  uploadVerifiedBackup,
  verifyEncryptedObject,
} from "./stugu-r2-backup/transport.mjs";

function help() {
  return `Encrypted Cloudflare R2 recovery copies

Usage:
  node scripts/stugu-r2-backup.mjs upload <verified-backup-directory>
  node scripts/stugu-r2-backup.mjs verify <completed-object-key>
  node scripts/stugu-r2-backup.mjs download <completed-object-key> <output.tar.zst.age>

Configuration:
  STUGU_R2_ENDPOINT                 Account endpoint, including .eu for an EU bucket
  STUGU_R2_BUCKET                   Private Standard-storage bucket
  STUGU_R2_PREFIX                   Object prefix (default: stugu)
  STUGU_R2_ACCESS_KEY_ID_FILE       Default: /run/secrets/r2/access-key-id
  STUGU_R2_SECRET_ACCESS_KEY_FILE   Default: /run/secrets/r2/secret-access-key
  STUGU_R2_AGE_RECIPIENT_FILE       Default: /run/secrets/r2/age-recipient

The upload is streamed as tar + zstd + age and never writes plaintext or
ciphertext staging files locally. Completed object names contain the ciphertext
SHA-256. Keep the matching age identity offline; it is not needed for uploads.
`;
}

export async function main(arguments_ = process.argv.slice(2), environment = process.env) {
  const [command, first, second, ...rest] = arguments_;
  if (command === "--help" || command === "-h" || !command) {
    console.log(help());
    return;
  }
  if (rest.length > 0) throw new Error("Too many arguments");
  if (command === "upload" && first && !second) {
    const result = await uploadVerifiedBackup(
      resolve(first),
      r2BackupConfiguration(environment),
      environment,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "verify" && first && !second) {
    const result = await verifyEncryptedObject(
      r2BackupConfiguration(environment, { recipientRequired: false }),
      first,
      environment,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "download" && first && second) {
    const result = await downloadEncryptedObject(
      r2BackupConfiguration(environment, { recipientRequired: false }),
      first,
      resolve(second),
      environment,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Invalid command or arguments\n\n${help()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`R2 backup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
