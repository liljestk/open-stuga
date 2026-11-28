import { DEMO_TELEMETRY_SOURCES } from "../db/support/domain-limits.js";

/** Install row guards without scanning or rewriting historical archive data. */
export function buildArchiveModeProtectionSql(relation: (name: string) => string): string[] {
  const sensorDemoSources = [...DEMO_TELEMETRY_SOURCES].map((source) => `'${source}'`).join(", ");
  const validator = relation("validate_archive_data_mode");
  return [
    `CREATE OR REPLACE FUNCTION ${validator}() RETURNS trigger LANGUAGE plpgsql AS $mode$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.data_mode IS NOT NULL AND (
          NEW.data_mode IS DISTINCT FROM OLD.data_mode OR NEW.source IS DISTINCT FROM OLD.source
        ) THEN
          RAISE EXCEPTION 'Verified archive telemetry mode and source are immutable' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF NEW.data_mode IS NOT NULL AND NEW.data_mode IS DISTINCT FROM
        (CASE WHEN NEW.source = ANY(TG_ARGV) THEN 'demo' ELSE 'live' END)
      THEN
        RAISE EXCEPTION 'Invalid archive data mode for telemetry source' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $mode$`,
    ...(["measurement_samples", "legacy_readings", "outdoor_temperature_samples"] as const).map((table) => {
      const target = relation(table);
      const demoSources = table === "outdoor_temperature_samples" ? "'mock'" : sensorDemoSources;
      return `DO $mode$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${target}'::REGCLASS
          AND tgname = 'archive_telemetry_data_mode_insert') THEN
          CREATE TRIGGER archive_telemetry_data_mode_insert BEFORE INSERT ON ${target}
          FOR EACH ROW WHEN (NEW.data_mode IS NOT NULL) EXECUTE FUNCTION ${validator}(${demoSources});
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${target}'::REGCLASS
          AND tgname = 'archive_telemetry_data_mode_update') THEN
          CREATE TRIGGER archive_telemetry_data_mode_update BEFORE UPDATE OF source, data_mode ON ${target}
          FOR EACH ROW WHEN (NEW.data_mode IS DISTINCT FROM OLD.data_mode OR NEW.source IS DISTINCT FROM OLD.source)
          EXECUTE FUNCTION ${validator}(${demoSources});
        END IF;
      END $mode$`;
    }),
  ];
}
