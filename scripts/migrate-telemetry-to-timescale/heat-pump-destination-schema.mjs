export const HEAT_PUMP_DESTINATION_COLUMNS = Object.freeze([
  "connection_id", "house_id", "equipment_id", "device_id", "name", "brand", "model", "transport",
  "floor_id", "room_id", "x", "y", "z",
  "observed_at", "received_at", "available", "power", "selected_mode", "target_temperature_c",
  "current_temperature_c", "current_temperature_source", "fan_speed", "horizontal_swing",
  "vertical_swing", "quiet", "turbo", "xfan", "compressor_frequency_hz", "diagnostics",
  "activity", "activity_evidence", "ingested_at",
]);

export function heatPumpDestinationSql(schema, quote) {
  return `
      CREATE TABLE IF NOT EXISTS ${schema}.heat_pump_state_samples (
        connection_id text NOT NULL CHECK (length(connection_id) > 0),
        house_id text NOT NULL CHECK (length(house_id) > 0),
        equipment_id text,
        device_id text NOT NULL CHECK (length(device_id) > 0),
        name text,
        brand text,
        model text,
        transport text NOT NULL DEFAULT 'local' CHECK (transport IN ('local', 'ewpe-cloud')),
        floor_id text,
        room_id text,
        x double precision,
        y double precision,
        z double precision,
        observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
        received_at timestamptz NOT NULL CHECK (isfinite(received_at)),
        available boolean NOT NULL,
        power boolean,
        selected_mode text CHECK (
          selected_mode IS NULL OR selected_mode IN ('auto', 'cool', 'dry', 'fan', 'heat')
        ),
        target_temperature_c double precision CHECK (
          target_temperature_c IS NULL OR (
            target_temperature_c > '-Infinity'::double precision
            AND target_temperature_c < 'Infinity'::double precision
          )
        ),
        current_temperature_c double precision CHECK (
          current_temperature_c IS NULL OR (
            current_temperature_c > '-Infinity'::double precision
            AND current_temperature_c < 'Infinity'::double precision
          )
        ),
        current_temperature_source text NOT NULL CHECK (
          current_temperature_source IN ('reported', 'unavailable')
        ),
        fan_speed text,
        horizontal_swing text,
        vertical_swing text,
        quiet boolean,
        turbo boolean,
        xfan boolean,
        compressor_frequency_hz double precision CHECK (
          compressor_frequency_hz IS NULL OR (compressor_frequency_hz >= 0 AND compressor_frequency_hz <= 300)
        ),
        diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
        activity text NOT NULL CHECK (activity IN ('off', 'unknown')),
        activity_evidence text NOT NULL CHECK (activity_evidence IN ('protocol', 'unavailable')),
        ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (connection_id, observed_at)
      );
      CREATE INDEX IF NOT EXISTS ${quote("heat_pump_state_observed_at_brin")}
        ON ${schema}.heat_pump_state_samples USING BRIN (observed_at);
      CREATE INDEX IF NOT EXISTS ${quote("heat_pump_state_history_idx")}
        ON ${schema}.heat_pump_state_samples (house_id, connection_id, observed_at DESC)
        INCLUDE (available, power, selected_mode, target_temperature_c, current_temperature_c);
      ALTER TABLE ${schema}.heat_pump_state_samples
        ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'local'
        CHECK (transport IN ('local', 'ewpe-cloud'));
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS floor_id text;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS room_id text;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS x double precision;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS y double precision;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS z double precision;
      ALTER TABLE ${schema}.heat_pump_state_samples
        ADD COLUMN IF NOT EXISTS compressor_frequency_hz double precision
        CHECK (compressor_frequency_hz IS NULL OR (compressor_frequency_hz >= 0 AND compressor_frequency_hz <= 300));
      ALTER TABLE ${schema}.heat_pump_state_samples
        ADD COLUMN IF NOT EXISTS diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb;
  `;
}
