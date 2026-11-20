type EvidenceChange = {
  trigger: string;
  event: string;
  house: string;
  overlaps: string;
  matches?: string;
};

function evidenceTrigger({ trigger, event, house, overlaps, matches = "1" }: EvidenceChange): string {
  return `
    CREATE TRIGGER IF NOT EXISTS ${trigger}
    AFTER ${event} BEGIN
      UPDATE daily_findings_evidence
      SET revision = revision + 1
      WHERE house_id = ${house}
        AND revision = observed_revision
        AND (${matches})
        AND EXISTS (
          SELECT 1 FROM json_each(daily_findings_evidence.windows_json) AS window
          WHERE ${overlaps}
        );
    END;`;
}

const windowStart = "json_extract(window.value, '$.start')";
const windowEnd = "json_extract(window.value, '$.end')";
const inWindow = (time: string) => `julianday(${time}) >= julianday(${windowStart})
  AND julianday(${time}) < julianday(${windowEnd})`;
const outdoorChange = {
  house: "NEW.house_id",
  overlaps: inWindow("NEW.timestamp"),
  matches: "location_key = NEW.location_key",
};

export const DAILY_FINDINGS_EVIDENCE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS daily_findings_evidence (
    house_id TEXT PRIMARY KEY REFERENCES houses(id) ON DELETE CASCADE,
    data_mode TEXT NOT NULL CHECK (data_mode IN ('live', 'demo')),
    location_key TEXT,
    windows_json TEXT NOT NULL CHECK (json_valid(windows_json)),
    revision INTEGER NOT NULL DEFAULT 1,
    observed_revision INTEGER NOT NULL DEFAULT 1,
    published_revision INTEGER
  );

  ${evidenceTrigger({
    trigger: "daily_findings_measurement_insert",
    event: "INSERT ON measurement_samples",
    house: "(SELECT house_id FROM sensors WHERE id = NEW.sensor_id AND enabled = 1)",
    overlaps: inWindow("NEW.timestamp"),
    matches: "NEW.quality IN ('good', 'estimated')",
  })}
  ${evidenceTrigger({
    ...outdoorChange,
    trigger: "daily_findings_outdoor_insert",
    event: "INSERT ON outdoor_temperature_samples",
  })}
  ${evidenceTrigger({
    ...outdoorChange,
    trigger: "daily_findings_outdoor_update",
    event: "UPDATE OF temperature_c, fetched_at ON outdoor_temperature_samples",
    matches: `${outdoorChange.matches} AND
      (OLD.temperature_c IS NOT NEW.temperature_c OR OLD.fetched_at IS NOT NEW.fetched_at)`,
  })}
  ${evidenceTrigger({
    trigger: "daily_findings_opening_insert",
    event: "INSERT ON opening_state_observations",
    house: "NEW.house_id",
    // Prior observations can supply the leading state at the start of a window.
    overlaps: `julianday(NEW.observed_at) < julianday(${windowEnd})
      AND (julianday(NEW.observed_at) >= julianday(${windowStart})
        OR NEW.valid_until IS NULL OR julianday(NEW.valid_until) > julianday(${windowStart}))`,
  })}
`;
