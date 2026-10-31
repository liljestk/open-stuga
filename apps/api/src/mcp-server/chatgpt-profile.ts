/** Which tool set and presentation an MCP server offers: the full local inspection surface or the ChatGPT app. */
export type McpProfile = "local" | "chatgpt";

export const CHATGPT_MCP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_houses",
  "get_house",
  "get_daily_analytics_findings",
  "get_house_weather",
  "get_house_opening_states",
  "get_opening_activity",
  "get_home_performance",
  "get_home_monitoring",
  "compare_calendar_periods",
  "get_house_electricity_price",
  "get_house_energy_cost",
  "get_house_energy_summary",
  "get_house_energy_projection",
  "list_heat_pump_states",
  "query_outdoor_temperature_history",
  "get_home_moisture_response",
  "list_sensors",
  "list_measurement_definitions",
  "get_measurement_snapshot",
  "query_measurement_history",
  "summarize_home_measurements",
  "list_active_alerts",
]);

const chatgptToolPresentation: Record<string, { title: string; description: string }> = {
  list_houses: {
    title: "List Homes",
    description: "List the Homes available in Stugu, including IDs, names, timezones, floors, and rooms.",
  },
  get_house: {
    title: "Get Home details",
    description: "Get one selected Home's location, orientation, floors, rooms, and timezone.",
  },
  get_daily_analytics_findings: {
    title: "Get recent Home findings",
    description: "Get the latest stored daily findings for one Home without starting a new analysis.",
  },
  get_house_weather: {
    title: "Get current Home weather",
    description: "Get the latest locally stored outdoor conditions, wind, forecast, and weather warnings for one Home.",
  },
  get_house_opening_states: {
    title: "Check doors and windows",
    description: "Check whether doors, windows, and vents in one Home are open, closed, or unknown.",
  },
  get_opening_activity: {
    title: "Get door and window activity",
    description: "Get bounded door, window, and vent activity for one Home over a selected time range.",
  },
  get_home_performance: {
    title: "Get Home performance",
    description: "Get the authoritative 30-day climate and energy performance result for one Home.",
  },
  get_home_monitoring: {
    title: "Check Home monitoring",
    description: "Check freshness, coverage, integration state, and insights for one or all Homes.",
  },
  compare_calendar_periods: {
    title: "Compare Home periods",
    description: "Compare Home-local days, weeks, months, or years using server-owned timezone boundaries.",
  },
  get_house_electricity_price: {
    title: "Get electricity price",
    description: "Get the current effective electricity price and optional price history for one Home.",
  },
  get_house_energy_cost: {
    title: "Get electricity cost",
    description: "Get consumption, price coverage, and cost for one Home energy sensor over a selected period.",
  },
  get_house_energy_summary: {
    title: "Get Home electricity use",
    description: "Get total electricity consumption and coverage for all enabled energy sensors in one Home.",
  },
  get_house_energy_projection: {
    title: "Project electricity use",
    description: "Project one Home's electricity use and cost over the next 30 days from recent use, the weather forecast, and the tariff.",
  },
  list_heat_pump_states: {
    title: "Check heat pumps",
    description: "Check whether each heat pump or air conditioner is on, its mode, target and room temperature, and when it last reported.",
  },
  query_outdoor_temperature_history: {
    title: "Get outdoor temperature history",
    description: "Get observed outdoor temperature history for one Home over a selected time range.",
  },
  get_home_moisture_response: {
    title: "Compare indoor and outdoor moisture",
    description: "Compare temperature-corrected indoor and outdoor moisture; this shows association, not whether wind caused a change.",
  },
  list_sensors: {
    title: "List Home sensors",
    description: "List configured sensors and their room placement, optionally for one Home.",
  },
  list_measurement_definitions: {
    title: "List measured quantities",
    description: "List the temperature, humidity, energy, and other quantities that Stugu can measure.",
  },
  get_measurement_snapshot: {
    title: "Get current Home readings",
    description: "Get the latest independently timestamped reading for every sensor and measured quantity in one Home.",
  },
  query_measurement_history: {
    title: "Get room reading history",
    description: "Get bounded history for a sensor and measured quantity, such as temperature, humidity, or energy.",
  },
  summarize_home_measurements: {
    title: "Summarize Home readings",
    description: "Compute coverage-aware per-sensor and whole-Home averages for a measured quantity over an exact time range.",
  },
  list_active_alerts: {
    title: "List active Home alerts",
    description: "List unresolved Stugu alert events.",
  },
};

export function presentationForChatgptTool(
  name: string,
): { title: string; description: string } | undefined {
  return chatgptToolPresentation[name];
}

export const chatgptMcpServerInstructions = [
  "This is Stugu's focused, read-only Home conversation surface.",
  "Resolve Home and sensor names with list tools before requesting data; ask only when a name is ambiguous.",
  "For current readings, include the sample timestamp. Interpret relative dates in the Home's timezone and state the interval used.",
  "Prefer a short conclusion followed by the supporting value, coverage, or confidence so answers work well in voice conversations.",
  "Never infer that wind caused an indoor humidity change from correlation alone. Combine weather, opening state, and temperature-corrected moisture response, then describe only what the evidence supports.",
  "No tool can create, update, delete, control equipment, or expose credentials.",
].join(" ");
