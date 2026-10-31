import type { TelemetryEvent } from "@climate-twin/contracts";

export type MutationNotice = Extract<TelemetryEvent, { type: "mutation" }>["data"];

/** Workspace inventory lists the bootstrap loads once and a mutation can reload on their own. */
export type InventoryList =
  | "properties"
  | "houses"
  | "propertyAreas"
  | "areaEquipment"
  | "propertyNotes"
  | "maintenanceTasks"
  | "sensors";

/** Bootstrap-store data a mutation can make stale. */
export type StoreRefresh =
  | InventoryList
  /** The active Home's snapshot: readings, observations, maintenance and static parameters. */
  | "homeSnapshot"
  | "alerts"
  | "integrations"
  | "tpLinkDevices"
  | "measurementDefinitions";

/** Query-client families a mutation can make stale. */
export type QueryRefresh =
  | "monitoring"
  | "analytics"
  | "connectedDevices"
  | "heatPumps"
  | "electricity";

export interface MutationScope {
  /**
   * Only a new workspace bootstrap reflects the change: the Home list,
   * membership or sharing, or a resource this viewer may not name.
   */
  bootstrap: boolean;
  store: readonly StoreRefresh[];
  queries: readonly QueryRefresh[];
  /** The Home the resource path names, if it names one. */
  houseId: string | null;
  /** The property the resource path names, if it names one. */
  propertyId: string | null;
}

interface ScopeRule {
  pattern: RegExp;
  /** Methods the rule applies to; every method when absent. */
  methods?: readonly string[];
  bootstrap?: true;
  store?: readonly StoreRefresh[];
  queries?: readonly QueryRefresh[];
}

const SENSOR_QUERIES: readonly QueryRefresh[] = ["monitoring", "analytics"];
const SENSOR_LAYOUT: readonly StoreRefresh[] = ["sensors", "homeSnapshot"];

/**
 * Resource paths, as the mutation feed names them without the API prefix, and
 * what each makes stale. The first matching rule wins. Pages that load their
 * own data (tracking, Stuguby lists, system updates, backups, action
 * verification, spatial layers, scheduled exports) are not refreshed here.
 */
const RULES: readonly ScopeRule[] = [
  { pattern: /^\/houses$/, bootstrap: true },
  { pattern: /^\/houses\/[^/]+$/, methods: ["DELETE"], bootstrap: true },
  { pattern: /^\/properties$/, bootstrap: true },
  { pattern: /^\/properties\/[^/]+$/, methods: ["DELETE"], bootstrap: true },
  { pattern: /^\/(?:tenant|stugbys|stugby-protocol)(?:\/|$)/, bootstrap: true },
  { pattern: /^\/houses\/(?<houseId>[^/]+)\/sensor-mappings$/, store: SENSOR_LAYOUT, queries: SENSOR_QUERIES },
  { pattern: /^\/houses\/[^/]+\/(?:opening-states|layers|scheduled-data-exports)(?:\/|$)/ },
  {
    pattern: /^\/houses\/(?<houseId>[^/]+)(?:\/floors\/[^/]+(?:\/roomplan-import)?|\/layout)?$/,
    store: ["houses", "sensors"],
    queries: SENSOR_QUERIES,
  },
  { pattern: /^\/properties\/(?<propertyId>[^/]+)\/electricity(?:\/|$)/, queries: ["electricity"] },
  { pattern: /^\/properties\/[^/]+\/(?:tracking-settings|member-location|layers)(?:\/|$)/ },
  { pattern: /^\/properties\/(?<propertyId>[^/]+)$/, store: ["properties"] },
  { pattern: /^\/property-areas(?:\/|$)/, store: ["propertyAreas"] },
  { pattern: /^\/(?:area-equipment|equipment-loans)(?:\/|$)/, store: ["areaEquipment"] },
  { pattern: /^\/property-notes(?:\/|$)/, store: ["propertyNotes"] },
  { pattern: /^\/maintenance-tasks(?:\/|$)/, store: ["maintenanceTasks"] },
  // A deleted sensor also leaves readings, observations and parameters behind.
  { pattern: /^\/sensors\/[^/]+$/, methods: ["DELETE"], store: SENSOR_LAYOUT, queries: SENSOR_QUERIES },
  { pattern: /^\/sensors(?:\/[^/]+)?$/, store: ["sensors"], queries: SENSOR_QUERIES },
  { pattern: /^\/setup\/bulk-sensor-mappings$/, store: SENSOR_LAYOUT, queries: SENSOR_QUERIES },
  { pattern: /^\/(?:observations|static-parameters|parameters)(?:\/|$)/, store: ["homeSnapshot"], queries: ["analytics"] },
  { pattern: /^\/(?:alert-rules|alerts|alert-events)(?:\/|$)/, store: ["alerts"], queries: ["monitoring"] },
  { pattern: /^\/integrations\/apple-notes\/capture$/, store: ["maintenanceTasks"] },
  // Probes, discovery, export jobs and grants change no state the workspace shows.
  { pattern: /^\/integrations\/(?:discover|discovery-jobs)(?:\/|$)/ },
  { pattern: /^\/integrations\/[^/]+\/(?:cloud\/)?(?:test|test-draft|discover|history-export|grants)(?:\/|$)/ },
  // Notification channels own no sensors.
  { pattern: /^\/integrations\/(?:telegram|apple-notes)(?:\/|$)/, store: ["integrations"] },
  {
    pattern: /^\/integrations\/tp-link(?:\/|$)/,
    store: ["integrations", "tpLinkDevices", ...SENSOR_LAYOUT],
    queries: SENSOR_QUERIES,
  },
  {
    pattern: /^\/integrations(?:\/|$)/,
    store: ["integrations", ...SENSOR_LAYOUT],
    queries: [...SENSOR_QUERIES, "connectedDevices", "heatPumps"],
  },
  { pattern: /^\/measurement-definitions(?:\/|$)/, store: ["measurementDefinitions"], queries: SENSOR_QUERIES },
  { pattern: /^\/connected-devices(?:\/|$)/, queries: ["connectedDevices", "monitoring"] },
  { pattern: /^\/heat-pumps(?:\/|$)/, queries: ["heatPumps", "monitoring"] },
  {
    pattern: /^\/(?:action-runs|action-playbooks|notification-deliveries|tracking|system|backups|bug-reports|ios-notification-registrations|cloudflare|internal|assets)(?:\/|$)/,
  },
];

/**
 * A full bootstrap, for the rules above that need one and for every resource
 * no rule names. Guests receive mutations with the path removed, so they land
 * here too.
 */
const BOOTSTRAP_SCOPE: MutationScope = {
  bootstrap: true,
  store: [],
  queries: ["monitoring", "analytics", "connectedDevices"],
  houseId: null,
  propertyId: null,
};

function ruleApplies(rule: ScopeRule, notice: MutationNotice): RegExpExecArray | null {
  if (rule.methods && !rule.methods.includes(notice.method.toUpperCase())) return null;
  return rule.pattern.exec(notice.resource);
}

function pathSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** What a workspace mutation makes stale, from the method and resource path the mutation feed names. */
export function mutationScope(notice: MutationNotice): MutationScope {
  for (const rule of RULES) {
    const match = ruleApplies(rule, notice);
    if (!match) continue;
    if (rule.bootstrap) return BOOTSTRAP_SCOPE;
    return {
      bootstrap: false,
      store: rule.store ?? [],
      queries: rule.queries ?? [],
      houseId: pathSegment(match.groups?.houseId),
      propertyId: pathSegment(match.groups?.propertyId),
    };
  }
  return BOOTSTRAP_SCOPE;
}
