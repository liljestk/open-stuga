import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import type {
  GuestAccessGrant,
  TenantMemberRole,
  TenantMemberSummary,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "./db.js";

const PASSWORD_N = 32_768;
const PASSWORD_R = 8;
const PASSWORD_P = 1;
const PASSWORD_BYTES = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SESSIONS_PER_USER = 10;
const MAX_GRANTS = 100;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type AccountRole = Exclude<TenantMemberRole, "service">;
type InviteRole = Exclude<AccountRole, "owner">;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  password_n: number;
  password_r: number;
  password_p: number;
  role: AccountRole;
  joined_at: string;
}

interface SessionRow extends UserRow {
  csrf_token: string;
  expires_at: string;
  last_seen_at: string;
}

interface InvitationRow {
  email: string;
  role: InviteRole;
  invited_at: string;
  expires_at: string;
  token_hash: string;
}

export interface LocalAuthIdentity {
  userId: string;
  email: string;
  role: AccountRole;
  joinedAt: string;
  grants: GuestAccessGrant[];
}

export interface LocalAuthSession extends LocalAuthIdentity {
  csrfToken: string;
  expiresAt: string;
}

export interface IssuedLocalSession {
  token: string;
  session: LocalAuthSession;
}

export class LocalAuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function passwordBytes(password: string): Buffer {
  const characters = Array.from(password).length;
  const bytes = Buffer.from(password, "utf8");
  if (characters < 12 || characters > 1_024 || bytes.length > 4_096) {
    throw new LocalAuthError(400, "INVALID_PASSWORD", "Password must contain between 12 and 1024 characters");
  }
  return bytes;
}

export function normalizedAccountEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new LocalAuthError(400, "INVALID_EMAIL", "email must be a valid email address");
  }
  const email = value.trim().toLowerCase();
  // Local Stuga installations may deliberately use a private DNS name (for
  // example, owner@stuga) rather than a public, dotted email domain.
  if (email.length < 3 || email.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new LocalAuthError(400, "INVALID_EMAIL", "email must be a valid email address");
  }
  return email;
}

export function validatedAccountPassword(value: unknown): string {
  if (typeof value !== "string") {
    throw new LocalAuthError(400, "INVALID_PASSWORD", "password must be a string");
  }
  passwordBytes(value);
  return value;
}

function derivePassword(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(passwordBytes(password), salt, PASSWORD_BYTES, { N: n, r, p, maxmem: SCRYPT_MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

async function passwordRecord(password: string): Promise<{
  hash: string;
  salt: string;
  n: number;
  r: number;
  p: number;
}> {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt, PASSWORD_N, PASSWORD_R, PASSWORD_P);
  return {
    hash: key.toString("base64url"),
    salt: salt.toString("base64url"),
    n: PASSWORD_N,
    r: PASSWORD_R,
    p: PASSWORD_P,
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeGrants(grants: readonly GuestAccessGrant[]): GuestAccessGrant[] {
  if (!Array.isArray(grants) || grants.length > MAX_GRANTS) {
    throw new LocalAuthError(400, "INVALID_GRANTS", `grants must be an array of at most ${MAX_GRANTS} entries`);
  }
  const unique = new Map<string, GuestAccessGrant>();
  for (const grant of grants) {
    if (!grant || !["property", "house", "area"].includes(grant.scopeType)
      || typeof grant.scopeId !== "string" || !grant.scopeId.trim() || grant.scopeId.length > 200) {
      throw new LocalAuthError(400, "INVALID_GRANTS", "Every grant must contain a valid scopeType and scopeId");
    }
    const normalized = { scopeType: grant.scopeType, scopeId: grant.scopeId.trim() };
    unique.set(`${normalized.scopeType}:${normalized.scopeId}`, normalized);
  }
  return [...unique.values()].sort((a, b) => (
    a.scopeType.localeCompare(b.scopeType) || a.scopeId.localeCompare(b.scopeId)
  ));
}

export class LocalAuthStore {
  constructor(private readonly database: ClimateDatabase) {}

  isInitialized(): boolean {
    return Boolean(this.database.db.prepare(
      "SELECT 1 FROM metadata WHERE key = 'local_auth_initialized' AND value = '1'",
    ).get());
  }

  async createFirstOwner(emailValue: unknown, passwordValue: unknown): Promise<LocalAuthIdentity> {
    const email = normalizedAccountEmail(emailValue);
    const password = validatedAccountPassword(passwordValue);
    const passwordData = await passwordRecord(password);
    const userId = randomUUID();
    const now = new Date().toISOString();
    this.immediateTransaction(() => {
      if (this.isInitialized()
        || this.database.db.prepare("SELECT 1 FROM local_auth_users LIMIT 1").get()
        || this.database.db.prepare("SELECT 1 FROM local_workspace_members LIMIT 1").get()) {
        throw new LocalAuthError(409, "AUTH_ALREADY_INITIALIZED", "Local authentication has already been initialized");
      }
      this.database.db.prepare(`INSERT INTO local_auth_users
        (id, email, password_hash, password_salt, password_n, password_r, password_p, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, email, passwordData.hash, passwordData.salt, passwordData.n, passwordData.r, passwordData.p, now, now);
      this.database.db.prepare(
        "INSERT INTO local_workspace_members(user_id, role, joined_at) VALUES (?, 'owner', ?)",
      ).run(userId, now);
      this.database.db.prepare(
        "INSERT INTO metadata(key, value) VALUES ('local_auth_initialized', '1')",
      ).run();
    });
    return { userId, email, role: "owner", joinedAt: now, grants: [] };
  }

  async registerInvitation(tokenValue: unknown, passwordValue: unknown, emailValue?: unknown): Promise<LocalAuthIdentity> {
    if (typeof tokenValue !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(tokenValue)) {
      throw new LocalAuthError(400, "INVALID_INVITATION_TOKEN", "A valid invitation token is required");
    }
    const confirmationEmail = emailValue === undefined ? null : normalizedAccountEmail(emailValue);
    const password = validatedAccountPassword(passwordValue);
    const invitationTokenHash = tokenHash(tokenValue);
    const candidate = this.database.db.prepare(
      "SELECT email, role, invited_at, expires_at, token_hash FROM local_workspace_invitations WHERE token_hash = ?",
    ).get(invitationTokenHash) as unknown as InvitationRow | undefined;
    if (!candidate || Date.parse(candidate.expires_at) <= Date.now()) {
      if (candidate) {
        this.immediateTransaction(() => {
          this.database.db.prepare("DELETE FROM local_guest_access_grants WHERE subject_type = 'invitation' AND subject_key = ?")
            .run(candidate.email);
          this.database.db.prepare("DELETE FROM local_workspace_invitations WHERE email = ? AND token_hash = ?")
            .run(candidate.email, invitationTokenHash);
        });
      }
      throw new LocalAuthError(404, "INVITATION_NOT_FOUND", "Invitation token is invalid or expired");
    }
    if (confirmationEmail && confirmationEmail !== candidate.email) {
      throw new LocalAuthError(400, "INVITATION_EMAIL_MISMATCH", "The confirmation email does not match this invitation");
    }
    const passwordData = await passwordRecord(password);
    const userId = randomUUID();
    const now = new Date().toISOString();
    let identity: LocalAuthIdentity | null = null;
    this.immediateTransaction(() => {
      if (!this.isInitialized()) {
        throw new LocalAuthError(409, "SETUP_REQUIRED", "Create the first owner before accepting invitations");
      }
      const invitation = this.database.db.prepare(
        "SELECT email, role, invited_at, expires_at, token_hash FROM local_workspace_invitations WHERE token_hash = ? AND expires_at > ?",
      ).get(invitationTokenHash, now) as unknown as InvitationRow | undefined;
      if (!invitation) {
        throw new LocalAuthError(404, "INVITATION_NOT_FOUND", "Invitation token is invalid or expired");
      }
      const email = invitation.email;
      if (this.database.db.prepare("SELECT 1 FROM local_auth_users WHERE email = ?").get(email)) {
        throw new LocalAuthError(409, "ACCOUNT_EXISTS", "An account already exists for this email");
      }
      this.database.db.prepare(`INSERT INTO local_auth_users
        (id, email, password_hash, password_salt, password_n, password_r, password_p, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, email, passwordData.hash, passwordData.salt, passwordData.n, passwordData.r, passwordData.p, now, now);
      this.database.db.prepare(
        "INSERT INTO local_workspace_members(user_id, role, joined_at) VALUES (?, ?, ?)",
      ).run(userId, invitation.role, now);
      this.database.db.prepare(
        "DELETE FROM local_workspace_invitations WHERE email = ?",
      ).run(email);
      this.database.db.prepare(`UPDATE local_guest_access_grants
        SET subject_type = 'member' WHERE subject_type = 'invitation' AND subject_key = ?`).run(email);
      identity = {
        userId,
        email,
        role: invitation.role,
        joinedAt: now,
        grants: invitation.role === "guest" ? this.grantsFor("member", email) : [],
      };
    });
    return identity!;
  }

  async verifyCredentials(emailValue: unknown, passwordValue: unknown): Promise<LocalAuthIdentity | null> {
    const email = normalizedAccountEmail(emailValue);
    const password = validatedAccountPassword(passwordValue);
    const row = this.database.db.prepare(`SELECT user.id, user.email, user.password_hash, user.password_salt,
      user.password_n, user.password_r, user.password_p, member.role, member.joined_at
      FROM local_auth_users user JOIN local_workspace_members member ON member.user_id = user.id
      WHERE user.email = ?`).get(email) as unknown as UserRow | undefined;
    const salt = row ? Buffer.from(row.password_salt, "base64url") : Buffer.alloc(16);
    const expected = row ? Buffer.from(row.password_hash, "base64url") : Buffer.alloc(PASSWORD_BYTES);
    const actual = await derivePassword(
      password,
      salt,
      row?.password_n ?? PASSWORD_N,
      row?.password_r ?? PASSWORD_R,
      row?.password_p ?? PASSWORD_P,
    );
    if (!row || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return this.identityFromRow(row);
  }

  issueSession(identity: LocalAuthIdentity): IssuedLocalSession {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    this.immediateTransaction(() => {
      this.database.db.prepare("DELETE FROM local_auth_sessions WHERE expires_at <= ?").run(now.toISOString());
      const membership = this.database.db.prepare(
        "SELECT 1 FROM local_workspace_members WHERE user_id = ?",
      ).get(identity.userId);
      if (!membership) throw new LocalAuthError(401, "UNAUTHORIZED", "Account is no longer a workspace member");
      this.database.db.prepare(`INSERT INTO local_auth_sessions
        (token_hash, user_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(tokenHash(token), identity.userId, csrfToken, now.toISOString(), expiresAt, now.toISOString());
      this.database.db.prepare(`DELETE FROM local_auth_sessions
        WHERE user_id = ? AND token_hash NOT IN (
          SELECT token_hash FROM local_auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
        )`).run(identity.userId, identity.userId, MAX_SESSIONS_PER_USER);
    });
    return { token, session: { ...identity, csrfToken, expiresAt } };
  }

  sessionForToken(token: string | null): LocalAuthSession | null {
    if (!token || token.length > 256) return null;
    const row = this.database.db.prepare(`SELECT user.id, user.email, user.password_hash, user.password_salt,
      user.password_n, user.password_r, user.password_p, member.role, member.joined_at,
      session.csrf_token, session.expires_at, session.last_seen_at
      FROM local_auth_sessions session
      JOIN local_auth_users user ON user.id = session.user_id
      JOIN local_workspace_members member ON member.user_id = user.id
      WHERE session.token_hash = ?`).get(tokenHash(token)) as unknown as SessionRow | undefined;
    if (!row) return null;
    const now = new Date();
    if (Date.parse(row.expires_at) <= now.getTime()) {
      this.database.db.prepare("DELETE FROM local_auth_sessions WHERE token_hash = ?").run(tokenHash(token));
      return null;
    }
    if (now.getTime() - Date.parse(row.last_seen_at) > 24 * 60 * 60 * 1_000) {
      this.database.db.prepare("UPDATE local_auth_sessions SET last_seen_at = ? WHERE token_hash = ?")
        .run(now.toISOString(), tokenHash(token));
    }
    return { ...this.identityFromRow(row), csrfToken: row.csrf_token, expiresAt: row.expires_at };
  }

  csrfMatches(session: LocalAuthSession, provided: string | undefined): boolean {
    return Boolean(provided && provided.length <= 256 && secretsEqual(session.csrfToken, provided));
  }

  revokeSession(token: string | null): void {
    if (token && token.length <= 256) {
      this.database.db.prepare("DELETE FROM local_auth_sessions WHERE token_hash = ?").run(tokenHash(token));
    }
  }

  listWorkspaceMembers(): { members: TenantMemberSummary[]; invitations: TenantMemberSummary[] } {
    const now = new Date().toISOString();
    this.immediateTransaction(() => {
      this.database.db.prepare(`DELETE FROM local_guest_access_grants
        WHERE subject_type = 'invitation' AND subject_key IN (
          SELECT email FROM local_workspace_invitations WHERE expires_at <= ?
        )`).run(now);
      this.database.db.prepare("DELETE FROM local_workspace_invitations WHERE expires_at <= ?").run(now);
    });
    const rows = this.database.db.prepare(`SELECT user.email, member.role, member.joined_at
      FROM local_workspace_members member JOIN local_auth_users user ON user.id = member.user_id
      ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, user.email`)
      .all() as unknown as Array<{ email: string; role: AccountRole; joined_at: string }>;
    const invitations = this.database.db.prepare(
      "SELECT email, role, invited_at, expires_at, token_hash FROM local_workspace_invitations WHERE expires_at > ? ORDER BY invited_at, email",
    ).all(now) as unknown as InvitationRow[];
    return {
      members: rows.map((row) => ({
        email: row.email,
        role: row.role,
        joinedAt: row.joined_at,
        grants: row.role === "guest" ? this.grantsFor("member", row.email) : [],
      })),
      invitations: invitations.map((row) => ({
        email: row.email,
        role: row.role,
        invitedAt: row.invited_at,
        expiresAt: row.expires_at,
        grants: row.role === "guest" ? this.grantsFor("invitation", row.email) : [],
      })),
    };
  }

  inviteMember(
    actor: Pick<LocalAuthIdentity, "userId" | "role">,
    emailValue: unknown,
    role: InviteRole,
    grantsValue: readonly GuestAccessGrant[],
  ): { invitation: TenantMemberSummary; registrationToken: string; expiresAt: string } {
    const email = normalizedAccountEmail(emailValue);
    if (!["admin", "member", "guest"].includes(role)) {
      throw new LocalAuthError(400, "INVALID_ROLE", "role must be admin, member, or guest");
    }
    const existingInvitation = this.database.db.prepare(
      "SELECT role FROM local_workspace_invitations WHERE email = ? AND expires_at > ?",
    ).get(email, new Date().toISOString()) as { role: InviteRole } | undefined;
    if (actor.role === "admin" && (role !== "guest" || (existingInvitation && existingInvitation.role !== "guest"))) {
      throw new LocalAuthError(403, "FORBIDDEN", "Admins can invite and manage Guest accounts only");
    }
    const grants = role === "guest" ? this.validateGrants(grantsValue) : this.rejectUnexpectedGrants(grantsValue);
    if (this.database.db.prepare("SELECT 1 FROM local_auth_users WHERE email = ?").get(email)) {
      throw new LocalAuthError(409, "MEMBER_EXISTS", "This email is already a workspace member");
    }
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.parse(now) + INVITATION_TTL_MS).toISOString();
    const registrationToken = randomBytes(32).toString("base64url");
    this.immediateTransaction(() => {
      this.database.db.prepare(`INSERT INTO local_workspace_invitations
        (email, role, invited_at, expires_at, token_hash, invited_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET role = excluded.role, invited_at = excluded.invited_at,
          expires_at = excluded.expires_at, token_hash = excluded.token_hash,
          invited_by_user_id = excluded.invited_by_user_id`)
        .run(email, role, now, expiresAt, tokenHash(registrationToken), actor.userId);
      this.replaceGrants("invitation", email, grants, now);
    });
    return {
      invitation: { email, role, invitedAt: now, expiresAt, grants },
      registrationToken,
      expiresAt,
    };
  }

  updateMemberAccess(emailValue: unknown, grantsValue: readonly GuestAccessGrant[]): TenantMemberSummary {
    const email = normalizedAccountEmail(emailValue);
    const member = this.database.db.prepare(`SELECT user.email, member.role, member.joined_at
      FROM local_workspace_members member JOIN local_auth_users user ON user.id = member.user_id
      WHERE user.email = ?`).get(email) as unknown as { email: string; role: AccountRole; joined_at: string } | undefined;
    const invitation = member ? undefined : this.database.db.prepare(
      "SELECT email, role, invited_at, expires_at, token_hash FROM local_workspace_invitations WHERE email = ? AND expires_at > ?",
    ).get(email, new Date().toISOString()) as unknown as InvitationRow | undefined;
    const subject = member ?? invitation;
    if (!subject) throw new LocalAuthError(404, "MEMBER_NOT_FOUND", "Member or invitation not found");
    if (subject.role !== "guest") {
      throw new LocalAuthError(409, "NOT_A_GUEST", "Access grants can only be assigned to Guest accounts");
    }
    const grants = this.validateGrants(grantsValue);
    this.immediateTransaction(() => this.replaceGrants(member ? "member" : "invitation", email, grants));
    return {
      email,
      role: "guest",
      ...(member ? { joinedAt: member.joined_at } : { invitedAt: invitation!.invited_at, expiresAt: invitation!.expires_at }),
      grants,
    };
  }

  removeMember(
    emailValue: unknown,
    actor: Pick<LocalAuthIdentity, "email" | "role">,
  ): boolean {
    const email = normalizedAccountEmail(emailValue);
    if (email === actor.email.toLowerCase()) {
      throw new LocalAuthError(409, "CANNOT_REMOVE_SELF", "You cannot remove your own account");
    }
    const member = this.database.db.prepare(`SELECT user.id, member.role FROM local_auth_users user
      JOIN local_workspace_members member ON member.user_id = user.id WHERE user.email = ?`)
      .get(email) as unknown as { id: string; role: AccountRole } | undefined;
    if (member?.role === "owner") {
      throw new LocalAuthError(409, "OWNER_REQUIRED", "The workspace owner cannot be removed");
    }
    const invitation = this.database.db.prepare(
      "SELECT role FROM local_workspace_invitations WHERE email = ?",
    ).get(email) as { role: InviteRole } | undefined;
    if (!member && !invitation) return false;
    const targetRole = member?.role ?? invitation!.role;
    if (actor.role === "admin" && targetRole !== "guest") {
      throw new LocalAuthError(403, "FORBIDDEN", "Admins can remove Guest accounts and invitations only");
    }
    this.immediateTransaction(() => {
      this.database.db.prepare("DELETE FROM local_guest_access_grants WHERE subject_key = ?").run(email);
      this.database.db.prepare("DELETE FROM local_workspace_invitations WHERE email = ?").run(email);
      if (member) this.database.db.prepare("DELETE FROM local_auth_users WHERE id = ?").run(member.id);
    });
    return true;
  }

  private identityFromRow(row: UserRow): LocalAuthIdentity {
    return {
      userId: row.id,
      email: row.email,
      role: row.role,
      joinedAt: row.joined_at,
      grants: row.role === "guest" ? this.grantsFor("member", row.email) : [],
    };
  }

  private grantsFor(subjectType: "member" | "invitation", subjectKey: string): GuestAccessGrant[] {
    return this.database.db.prepare(`SELECT scope_type AS scopeType, scope_id AS scopeId
      FROM local_guest_access_grants WHERE subject_type = ? AND subject_key = ?
      ORDER BY scope_type, scope_id`).all(subjectType, subjectKey) as unknown as GuestAccessGrant[];
  }

  private validateGrants(value: readonly GuestAccessGrant[]): GuestAccessGrant[] {
    const grants = normalizeGrants(value);
    for (const grant of grants) {
      const exists = grant.scopeType === "property"
        ? this.database.getProperty(grant.scopeId)
        : grant.scopeType === "house"
          ? this.database.getHouse(grant.scopeId)
          : this.database.getPropertyArea(grant.scopeId);
      if (!exists) {
        throw new LocalAuthError(422, "INVALID_GRANT_SCOPE", `${grant.scopeType} ${grant.scopeId} does not exist`);
      }
    }
    return grants;
  }

  private rejectUnexpectedGrants(value: readonly GuestAccessGrant[]): [] {
    const grants = normalizeGrants(value);
    if (grants.length > 0) {
      throw new LocalAuthError(400, "GRANTS_REQUIRE_GUEST", "Only Guest accounts may receive scoped grants");
    }
    return [];
  }

  private replaceGrants(
    subjectType: "member" | "invitation",
    subjectKey: string,
    grants: readonly GuestAccessGrant[],
    createdAt = new Date().toISOString(),
  ): void {
    this.database.db.prepare(
      "DELETE FROM local_guest_access_grants WHERE subject_type = ? AND subject_key = ?",
    ).run(subjectType, subjectKey);
    const insert = this.database.db.prepare(`INSERT INTO local_guest_access_grants
      (subject_type, subject_key, scope_type, scope_id, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const grant of grants) insert.run(subjectType, subjectKey, grant.scopeType, grant.scopeId, createdAt);
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }
}
