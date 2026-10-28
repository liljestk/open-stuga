import type { AlertEvent, IOSNotificationRegistration, IOSNotificationRegistrationInput, TenantMemberRole } from "@climate-twin/contracts";
import type { APNSDestination } from "../../apns.js";
import { MAX_ACTIVE_IOS_REGISTRATIONS_PER_USER } from "../support/domain-limits.js";
import { IOSNotificationRegistrationRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { iosNotificationRegistrationFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import { compareCodeUnits } from "../../text-order.js";

declare module "../core.js" {
  interface DatabaseInternals {
    saveIOSNotificationRegistration(userId: string, id: string, input: IOSNotificationRegistrationInput, now?: Date): IOSNotificationRegistration;
    getIOSNotificationRegistration(userId: string, id: string): IOSNotificationRegistration | null;
    deleteIOSNotificationRegistration(userId: string, id: string): boolean;
    disableIOSNotificationRegistration(id: string): boolean;
    getIOSPushDestination(id: string): APNSDestination | null;
    getIOSPushDestinationForAlert(id: string, eventId: string): APNSDestination | null;
    listIOSPushDestinations(houseId: string, severity: AlertEvent["severity"]): APNSDestination[];
  }

  interface ClimateDatabaseCore {
    saveIOSNotificationRegistration(userId: string, id: string, input: IOSNotificationRegistrationInput, now?: Date): IOSNotificationRegistration;
    getIOSNotificationRegistration(userId: string, id: string): IOSNotificationRegistration | null;
    deleteIOSNotificationRegistration(userId: string, id: string): boolean;
    disableIOSNotificationRegistration(id: string): boolean;
    getIOSPushDestination(id: string): APNSDestination | null;
    getIOSPushDestinationForAlert(id: string, eventId: string): APNSDestination | null;
    listIOSPushDestinations(houseId: string, severity: AlertEvent["severity"]): APNSDestination[];
  }
}

registerDatabaseMethods({
  saveIOSNotificationRegistration(
      userId: string,
      id: string,
      input: IOSNotificationRegistrationInput,
      now = new Date(),
    ): IOSNotificationRegistration {
      return this.immediateTransaction(() => {
        const existing = this.db.prepare(
          "SELECT user_id, enabled FROM ios_notification_registrations WHERE id = ?",
        ).get(id) as { user_id: string; enabled: number } | undefined;
        if (existing && existing.user_id !== userId) {
          throw new ClimateDataValidationError(409, "IOS_REGISTRATION_CONFLICT", "Notification registration is already owned by another account");
        }
        const normalizedToken = input.deviceToken.trim().toLowerCase();
        const tokenOwner = this.db.prepare(`SELECT id, user_id FROM ios_notification_registrations
          WHERE environment = ? AND device_token = ?`).get(input.environment, normalizedToken) as {
            id: string;
            user_id: string;
          } | undefined;
        if (tokenOwner && tokenOwner.id !== id) {
          // Possession of the current opaque APNs token lets the signed-in
          // installation retire a stale registration left by an expired session
          // or an account switch on the same device.
          this.db.prepare("DELETE FROM ios_notification_registrations WHERE id = ?").run(tokenOwner.id);
        }
        if ((!existing || existing.enabled !== 1)
          && Number((this.db.prepare(`SELECT COUNT(*) AS count
            FROM ios_notification_registrations WHERE user_id = ? AND enabled = 1`)
            .get(userId) as { count: number }).count) >= MAX_ACTIVE_IOS_REGISTRATIONS_PER_USER) {
          throw new ClimateDataValidationError(
            409,
            "IOS_REGISTRATION_LIMIT",
            `An account can enable at most ${MAX_ACTIVE_IOS_REGISTRATIONS_PER_USER} iOS notification registrations`,
          );
        }
        const timestamp = now.toISOString();
        this.db.prepare(`INSERT INTO ios_notification_registrations(
            id, user_id, device_token, environment, minimum_severity, include_details,
            enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            device_token = excluded.device_token,
            environment = excluded.environment,
            minimum_severity = excluded.minimum_severity,
            include_details = excluded.include_details,
            enabled = 1,
            updated_at = excluded.updated_at`)
          .run(
            id,
            userId,
            normalizedToken,
            input.environment,
            input.minimumSeverity,
            input.includeDetails ? 1 : 0,
            timestamp,
            timestamp,
          );
        this.db.prepare(`DELETE FROM ios_notification_subscriptions
          WHERE registration_id = ? AND EXISTS (
            SELECT 1 FROM houses AS house
            WHERE house.id = ios_notification_subscriptions.house_id AND house.deleted_at IS NULL
          )`).run(id);
        const subscribe = this.db.prepare(`INSERT INTO ios_notification_subscriptions(
          registration_id, house_id
        ) VALUES (?, ?)`);
        for (const houseId of [...new Set(input.homeIds)].sort(compareCodeUnits)) {
          subscribe.run(id, houseId);
        }
        return this.getIOSNotificationRegistration(userId, id)!;
      });
    },
  getIOSNotificationRegistration(
      userId: string,
      id: string,
    ): IOSNotificationRegistration | null {
      const row = this.db.prepare(`SELECT * FROM ios_notification_registrations
        WHERE id = ? AND user_id = ?`).get(id, userId) as unknown as IOSNotificationRegistrationRow | undefined;
      if (!row) return null;
      const homeIds = (this.db.prepare(`SELECT subscription.house_id FROM ios_notification_subscriptions AS subscription
        JOIN houses AS house ON house.id = subscription.house_id
        WHERE subscription.registration_id = ? AND house.deleted_at IS NULL
        ORDER BY subscription.house_id`).all(id) as Array<{ house_id: string }>)
        .map((item) => item.house_id);
      return iosNotificationRegistrationFromRow(row, homeIds);
    },
  deleteIOSNotificationRegistration(userId: string, id: string): boolean {
      return Number(this.db.prepare(`DELETE FROM ios_notification_registrations
        WHERE id = ? AND user_id = ?`).run(id, userId).changes) === 1;
    },
  disableIOSNotificationRegistration(id: string): boolean {
      return Number(this.db.prepare(`UPDATE ios_notification_registrations
        SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1`)
        .run(new Date().toISOString(), id).changes) === 1;
    },
  getIOSPushDestination(id: string): APNSDestination | null {
      const row = this.db.prepare(`SELECT registration.id, registration.device_token,
          registration.environment, registration.include_details, member.role
        FROM ios_notification_registrations registration
        JOIN local_workspace_members member ON member.user_id = registration.user_id
        WHERE registration.id = ? AND registration.enabled = 1`).get(id) as {
          id: string;
          device_token: string;
          environment: APNSDestination["environment"];
          include_details: number;
          role: TenantMemberRole;
        } | undefined;
      return row ? {
        registrationId: row.id,
        deviceToken: row.device_token,
        environment: row.environment,
        includeDetails: row.include_details === 1,
        canAcknowledge: row.role !== "guest",
      } : null;
    },
  getIOSPushDestinationForAlert(
      id: string,
      eventId: string,
    ): APNSDestination | null {
      const row = this.db.prepare(`SELECT registration.id, registration.device_token,
          registration.environment, registration.include_details, member.role
        FROM ios_notification_registrations registration
        JOIN local_workspace_members member ON member.user_id = registration.user_id
        JOIN alert_events event ON event.id = ?
        JOIN sensors sensor ON sensor.id = event.sensor_id
        JOIN houses house ON house.id = sensor.house_id
        JOIN ios_notification_subscriptions subscription
          ON subscription.registration_id = registration.id
          AND subscription.house_id = house.id
        WHERE registration.id = ? AND registration.enabled = 1
          AND house.deleted_at IS NULL
          AND event.acknowledged_at IS NULL AND event.resolved_at IS NULL
          AND CASE registration.minimum_severity
            WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
            <= CASE event.severity
              WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
          AND (
            member.role != 'guest'
            OR EXISTS (
              SELECT 1 FROM local_guest_access_grants grant_row
              WHERE grant_row.subject_type = 'member'
                AND grant_row.subject_key = registration.user_id
                AND (
                  (grant_row.scope_type = 'property' AND grant_row.scope_id = house.property_id)
                  OR (grant_row.scope_type = 'house' AND grant_row.scope_id = house.id)
                )
            )
          )
        LIMIT 1`).get(eventId, id) as {
          id: string;
          device_token: string;
          environment: APNSDestination["environment"];
          include_details: number;
          role: TenantMemberRole;
        } | undefined;
      return row ? {
        registrationId: row.id,
        deviceToken: row.device_token,
        environment: row.environment,
        includeDetails: row.include_details === 1,
        canAcknowledge: row.role !== "guest",
      } : null;
    },
  listIOSPushDestinations(
      houseId: string,
      severity: AlertEvent["severity"],
    ): APNSDestination[] {
      const rows = this.db.prepare(`SELECT registration.id, registration.device_token,
          registration.environment, registration.include_details, member.role
        FROM ios_notification_registrations registration
        JOIN ios_notification_subscriptions subscription
          ON subscription.registration_id = registration.id
        JOIN houses house ON house.id = subscription.house_id
        JOIN local_workspace_members member ON member.user_id = registration.user_id
        WHERE subscription.house_id = ? AND registration.enabled = 1 AND house.deleted_at IS NULL
          AND CASE registration.minimum_severity
            WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
            <= CASE ? WHEN 'info' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
          AND (
            member.role != 'guest'
            OR EXISTS (
              SELECT 1 FROM local_guest_access_grants grant_row
              WHERE grant_row.subject_type = 'member'
                AND grant_row.subject_key = registration.user_id
                AND (
                  (grant_row.scope_type = 'property' AND grant_row.scope_id = house.property_id)
                  OR (grant_row.scope_type = 'house' AND grant_row.scope_id = house.id)
                )
            )
          )
        ORDER BY registration.id`).all(houseId, severity) as Array<{
          id: string;
          device_token: string;
          environment: APNSDestination["environment"];
          include_details: number;
          role: TenantMemberRole;
        }>;
      return rows.map((row) => ({
        registrationId: row.id,
        deviceToken: row.device_token,
        environment: row.environment,
        includeDetails: row.include_details === 1,
        canAcknowledge: row.role !== "guest",
      }));
    },
});
