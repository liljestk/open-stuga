# Encrypted Cloudflare R2 backups

Stugu can copy its newest verified scheduled recovery set to a private
Cloudflare R2 bucket. The copy is compressed and encrypted on the Stugu node
before it leaves the device. Only the age public recipient is installed on the
node; keep the corresponding identity offline.

The feature is opt-in through the `r2-backup` Compose profile. Its isolated
replicator has:

- read-only access to completed scheduled backups;
- no access to TimescaleDB or the live data volume;
- a dedicated outbound network;
- bucket-scoped R2 credentials; and
- no age decryption identity.

The replicator streams `tar -> zstd -> age -> R2`, without a second plaintext
or ciphertext copy on local disk. It first writes an unlocked staging object,
then promotes it to the retention-protected `sets/` prefix. A completed object
name includes the ciphertext SHA-256 so a download can be checked before
decryption.

## 1. Create the private bucket

Activate R2 in the Cloudflare account, then create a bucket with:

- **Storage class:** Standard. The R2 free tier applies only to Standard.
- **Jurisdiction:** European Union when EU residency is required.
- **Public access:** disabled. Do not enable an `r2.dev` URL or custom domain.

Create an R2 API token with **Object Read & Write**, scoped only to this bucket.
Record the Access Key ID and Secret Access Key when Cloudflare displays them.
The token does not need account-level bucket administration.

Cloudflare documentation:

- [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## 2. Create a recovery identity

Install [age](https://github.com/FiloSottile/age), then generate an identity on
a trusted operator machine:

```text
age-keygen -o age-identity.txt
age-keygen -y age-identity.txt > age-recipient
```

Store `age-identity.txt` in an offline password manager, encrypted removable
media, or another protected recovery store. Test that it can decrypt a sample.
Do not put it on the Stugu node, in R2, or in the repository.

Create the ignored directory configured by `STUGA_R2_SECRET_DIR`. Its files are:

```text
secrets/r2/
|-- access-key-id
|-- secret-access-key
`-- age-recipient
```

Each file contains exactly one value. `age-recipient` is public; the two R2
credential files are secrets. Restrict the directory and credential files to
the account that runs Compose. The container reads them as UID/GID 1000 by
default, so do not make them root-only unless the deployment uses a matching
`STUGA_HOST_BIND_USER`.

## 3. Configure retention protection

In the bucket's **Settings**, add these rules. Replace `stugu` when
`STUGU_R2_PREFIX` uses another value.

| Rule | Prefix | Action |
|---|---|---|
| Completed-set lock | `stugu/sets/` | Retain for 30 days |
| Completed-set expiry | `stugu/sets/` | Delete after 35 days |
| Staging cleanup | `stugu/staging/` | Delete after 1 day |

The lock prevents deletion or overwriting of completed sets for 30 days. The
five-day gap allows the later lifecycle expiry to clean them up. Do not lock the
staging prefix: a failed upload must remain removable. Cloudflare also expires
incomplete multipart uploads after seven days by default.

Keep these objects in Standard storage. For a small backup collection,
Infrequent Access loses the free tier and its rounded operation charges can be
more expensive.

See [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
and [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

## 4. Enable replication

Set the non-secret values in `.env` or the appliance `stugu.env`:

```dotenv
STUGU_R2_ENDPOINT=https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com
STUGU_R2_BUCKET=stugu-backups
STUGU_R2_PREFIX=stugu
STUGA_R2_SECRET_DIR=./secrets/r2
STUGU_R2_POLL_INTERVAL_SECONDS=60
STUGU_R2_RETRY_INTERVAL_MINUTES=15
```

For a bucket without an EU jurisdiction, omit `.eu` from the endpoint. Add
`r2-backup` to the comma-separated profiles:

```dotenv
COMPOSE_PROFILES=r2-backup
```

Preserve any existing profiles, for example:

```dotenv
COMPOSE_PROFILES=self-update,cloudflare,r2-backup
```

Build and start the replicator:

```powershell
docker compose build stugu-r2-backup
docker compose up -d stugu-r2-backup
docker compose logs --tail 100 stugu-r2-backup
```

Use `podman compose` on a Podman deployment. On its first healthy pass the
replicator uploads only the newest verified set. It then uploads each new
newest set, retries failures without creating extra local backups, and checks
R2 before writing so a restart does not duplicate a completed object.

Inspect its machine-readable status with:

```powershell
docker compose exec stugu-r2-backup node -e "console.log(require('fs').readFileSync('/app/runtime/r2-backup-operations/status.json','utf8'))"
```

The container becomes unhealthy when replication fails or status stops
advancing. Local scheduled backups and restore drills remain independent.

## Manual verification and recovery

Copy the completed object key from the status file or R2 dashboard. Verify the
remote ciphertext by downloading and hashing it without saving it:

```powershell
docker compose run --rm --no-deps --entrypoint node stugu-r2-backup `
  /app/scripts/stugu-r2-backup.mjs verify <completed-object-key>
```

For recovery, bind a protected host directory at `/restore` and download there:

```powershell
docker compose run --rm --no-deps --entrypoint node `
  --volume "${PWD}/backups:/restore" `
  stugu-r2-backup /app/scripts/stugu-r2-backup.mjs download `
  <completed-object-key> /restore/stugu-recovery.tar.zst.age
```

The command refuses to overwrite a file and verifies the ciphertext SHA-256
encoded in the object key. On a trusted recovery machine, decrypt and extract:

```text
age --decrypt --identity age-identity.txt stugu-recovery.tar.zst.age |
  tar --extract --zstd --file=-
```

Then run Stugu's normal manifest verification against the extracted directory:

```powershell
docker compose --profile maintenance run --rm --no-deps stugu-backup `
  --verify /app/backups/<extracted-backup-directory>
```

Complete an isolated TimescaleDB restore drill before treating R2 as a working
recovery path. Test the offline age identity and a full R2 download at least
quarterly; storage durability alone does not prove that credentials, encryption
keys, and the restore procedure still work.

## Rotation and incident response

- Rotate the bucket-scoped R2 token by replacing both credential files and
  restarting `stugu-r2-backup`.
- Add a new age recipient before retiring an old identity. Existing archives
  remain decryptable only by recipients used when they were created.
- If the Stugu node is compromised, revoke the R2 token. The completed-set
  bucket lock preserves already-promoted objects for its configured duration.
- Keep at least one recovery identity and one older recovery point outside both
  the Stugu device and the Cloudflare account.
