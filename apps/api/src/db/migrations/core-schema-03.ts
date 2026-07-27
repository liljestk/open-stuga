export const CORE_SCHEMA_03 = `          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
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
      `;
