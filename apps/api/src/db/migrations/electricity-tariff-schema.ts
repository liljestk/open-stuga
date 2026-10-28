export const ELECTRICITY_TARIFF_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS property_electricity_tariffs (
        property_id TEXT PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
        versions_json TEXT NOT NULL CHECK (json_valid(versions_json) AND json_type(versions_json) = 'array'),
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS electricity_invoices (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL CHECK (period_end >= period_start),
        total_eur REAL NOT NULL,
        consumption_kwh REAL,
        energy_eur REAL,
        network_eur REAL,
        tax_eur REAL,
        fees_eur REAL,
        note TEXT CHECK (note IS NULL OR length(note) <= 500),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_electricity_invoices_property
        ON electricity_invoices(property_id, period_start DESC);
      `;
