/** Triggers that refuse mock and replay telemetry once a database is in real mode or a Home is shared. */
export const DEMO_DATA_GUARD_SCHEMA_SQL = `      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_insert_in_real_mode
        BEFORE INSERT ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_update_in_real_mode
        BEFORE UPDATE OF source ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_insert_in_real_mode
        BEFORE INSERT ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_update_in_real_mode
        BEFORE UPDATE OF source ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_outdoor_insert_in_real_mode
        BEFORE INSERT ON outdoor_temperature_samples
        WHEN NEW.source = 'mock'
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_outdoor_update_in_real_mode
        BEFORE UPDATE OF source ON outdoor_temperature_samples
        WHEN NEW.source = 'mock'
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_insert_for_shared_home
        BEFORE INSERT ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (
            SELECT 1 FROM sensors sensor
            JOIN houses house ON house.id = sensor.house_id
            WHERE sensor.id = NEW.sensor_id
              AND json_extract(house.stugby_json, '$.ownership') = 'shared'
              AND json_extract(house.stugby_json, '$.syncState') <> 'detached'
          )
        BEGIN SELECT RAISE(ABORT, 'SHARED_HOME_DEMO_TELEMETRY_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_update_for_shared_home
        BEFORE UPDATE OF sensor_id, source ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (
            SELECT 1 FROM sensors sensor
            JOIN houses house ON house.id = sensor.house_id
            WHERE sensor.id = NEW.sensor_id
              AND json_extract(house.stugby_json, '$.ownership') = 'shared'
              AND json_extract(house.stugby_json, '$.syncState') <> 'detached'
          )
        BEGIN SELECT RAISE(ABORT, 'SHARED_HOME_DEMO_TELEMETRY_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_insert_for_shared_home
        BEFORE INSERT ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (
            SELECT 1 FROM sensors sensor
            JOIN houses house ON house.id = sensor.house_id
            WHERE sensor.id = NEW.sensor_id
              AND json_extract(house.stugby_json, '$.ownership') = 'shared'
              AND json_extract(house.stugby_json, '$.syncState') <> 'detached'
          )
        BEGIN SELECT RAISE(ABORT, 'SHARED_HOME_DEMO_TELEMETRY_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_update_for_shared_home
        BEFORE UPDATE OF sensor_id, source ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (
            SELECT 1 FROM sensors sensor
            JOIN houses house ON house.id = sensor.house_id
            WHERE sensor.id = NEW.sensor_id
              AND json_extract(house.stugby_json, '$.ownership') = 'shared'
              AND json_extract(house.stugby_json, '$.syncState') <> 'detached'
          )
        BEGIN SELECT RAISE(ABORT, 'SHARED_HOME_DEMO_TELEMETRY_DISABLED'); END;
      `;
