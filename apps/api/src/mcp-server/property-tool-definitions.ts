

export const propertyToolDefinitions = [
  {
        name: "list_properties",
        description: "List compact property summaries without exact map-centre coordinates or free-form descriptions.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
  {
        name: "get_property",
        description: "Get one explicitly selected Property with its description, location, and Stuguby authority/edit/sync metadata.",
        inputSchema: {
          type: "object",
          properties: { propertyId: { type: "string", minLength: 1, maxLength: 200 } },
          required: ["propertyId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_property_electricity",
        description: "Inspect one Property's redacted electricity configuration, current price, and bounded price history. Endpoint query parameters are omitted.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", minLength: 1, maxLength: 200 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
          },
          required: ["propertyId"],
          additionalProperties: false,
        },
      },
  {
        name: "get_property_energy_optimization",
        description: "Generate the advisory, read-only electricity-price and measured-load optimization report for one Property.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", minLength: 1, maxLength: 200 },
            windowHours: { type: "integer", minimum: 1, maximum: 12, default: 2 },
          },
          required: ["propertyId"],
          additionalProperties: false,
        },
      },
  {
        name: "list_property_areas",
        description: "List compact mapped-area and fixed-asset summaries, optionally for one property. Exact coordinates and free-form descriptions are omitted.",
        inputSchema: {
          type: "object",
          properties: { propertyId: { type: "string", minLength: 1, maxLength: 200 } },
          additionalProperties: false,
        },
      },
  {
        name: "list_area_equipment",
        description: "List compact area-equipment summaries, optionally filtered by property or area. Serial numbers and free-form notes are omitted.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", minLength: 1, maxLength: 200 },
            areaId: { type: "string", minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
  {
        name: "list_property_notes",
        description: "List Property, Home, area, and equipment notes, optionally filtered to one related resource.",
        inputSchema: {
          type: "object",
          properties: {
            propertyId: { type: "string", minLength: 1, maxLength: 200 },
            houseId: { type: "string", minLength: 1, maxLength: 200 },
            areaId: { type: "string", minLength: 1, maxLength: 200 },
            equipmentId: { type: "string", minLength: 1, maxLength: 200 },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
          },
          additionalProperties: false,
        },
      },
  {
        name: "list_houses",
        description: "List compact house and floor summaries. Coordinates, map placement, detailed geometry, and embedded floor-plan images are omitted; request get_house for one explicitly selected house when those details are needed.",
        inputSchema: { type: "object", properties: { propertyId: { type: "string" } }, additionalProperties: false },
      },
  {
        name: "get_house",
        description: "Get one house with its location, map placement, orientation, and floor layout.",
        inputSchema: { type: "object", properties: { houseId: { type: "string" } }, required: ["houseId"], additionalProperties: false },
      },
  {
        name: "get_daily_analytics_findings",
        description: "Get the latest stored daily analytics findings and worker status for one Home without triggering a new analysis.",
        inputSchema: {
          type: "object",
          properties: { houseId: { type: "string", minLength: 1, maxLength: 200 } },
          required: ["houseId"],
          additionalProperties: false,
        },
      },
  {
        name: "list_stugubys",
        description: "List compact Host/Client federation, adopted-Property, Home ownership, sharing, and sync summaries.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
  {
        name: "get_stuguby",
        description: "Inspect one Stuguby, including sanitized Host/Client membership, adopted Property state, local and shared Homes, read-only overview grants, and pending command counts. Secrets, invitation material, event payloads, and audit records are omitted.",
        inputSchema: {
          type: "object",
          properties: { stugubyId: { type: "string", minLength: 1, maxLength: 200 } },
          required: ["stugubyId"],
          additionalProperties: false,
        },
      },
] as const;
