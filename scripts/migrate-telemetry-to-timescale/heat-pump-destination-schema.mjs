export const HEAT_PUMP_DESTINATION_COLUMNS = Object.freeze([
  "connection_id", "house_id", "equipment_id", "device_id", "name", "brand", "model", "transport",
  "floor_id", "room_id", "x", "y", "z",
  "observed_at", "received_at", "available", "power", "selected_mode", "target_temperature_c",
  "current_temperature_c", "current_temperature_source", "current_humidity_percent", "target_humidity_percent",
  "fan_speed", "horizontal_swing", "vertical_swing", "fresh_air", "anion", "sleep", "light",
  "quiet", "turbo", "xfan", "steady_heat", "power_save", "clean_filter", "water_full",
  "dehumidifier_mode", "compressor_frequency_hz", "diagnostics",
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
        current_humidity_percent double precision CHECK (
          current_humidity_percent IS NULL OR (current_humidity_percent >= 0 AND current_humidity_percent <= 100)
        ),
        target_humidity_percent double precision CHECK (
          target_humidity_percent IS NULL OR (target_humidity_percent >= 0 AND target_humidity_percent <= 100)
        ),
        fan_speed text,
        horizontal_swing text,
        vertical_swing text,
        fresh_air boolean,
        anion boolean,
        sleep boolean,
        light boolean,
        quiet boolean,
        turbo boolean,
        xfan boolean,
        steady_heat boolean,
        power_save boolean,
        clean_filter boolean,
        water_full boolean,
        dehumidifier_mode text,
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
      ALTER TABLE ${schema}.heat_pump_state_samples
        ADD COLUMN IF NOT EXISTS current_humidity_percent double precision
        CHECK (current_humidity_percent IS NULL OR (current_humidity_percent >= 0 AND current_humidity_percent <= 100));
      ALTER TABLE ${schema}.heat_pump_state_samples
        ADD COLUMN IF NOT EXISTS target_humidity_percent double precision
        CHECK (target_humidity_percent IS NULL OR (target_humidity_percent >= 0 AND target_humidity_percent <= 100));
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS fresh_air boolean;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS anion boolean;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS sleep boolean;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS light boolean;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS steady_heat boolean;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS power_save boolean;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS clean_filter boolean;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS water_full boolean;
      ALTER TABLE ${schema}.heat_pump_state_samples ADD COLUMN IF NOT EXISTS dehumidifier_mode text;
  `;
}
