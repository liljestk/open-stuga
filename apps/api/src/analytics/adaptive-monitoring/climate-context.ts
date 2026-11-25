import { fixedPlanElementOpeningState, isAirflowPlanElement, type AdaptiveEvidenceEpoch, type House } from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../db.js";
import { MAX_OPENING_PROVIDER_STALE_MS } from "../../db/methods/opening-states.js";
import { HOUR_MS } from "../forecast/models.js";
import { MAX_HEAT_PUMP_STATE_GAP_MS } from "../heat-pump-evidence.js";
import { ADAPTIVE_CONTEXT_GUARD_HOURS, contextGuardWindow } from "./context-window.js";

export interface ClimateContextGuard {
  reason: "opening-state-change" | "heating-setting-change";
  sourceId: string;
  occurredAt: number;
  availableAt: number;
  until: number;
}

interface OpeningRow {
  id: string;
  floor_id: string;
  element_id: string;
  observed_at: string;
  adaptive_context_at: string;
  state: "open" | "closed" | "unknown";
  source: string;
  connection_id: string | null;
  external_id: string | null;
  valid_until: string | null;
}

interface HeatRow {
  connection_id: string;
  observed_at: string;
  adaptive_context_at: string;
}

interface GuardWindow { from: string; to: string; knownAt: string }

function openingStillValid(previous: OpeningRow, event: OpeningRow): boolean {
  if (previous.valid_until !== null && previous.valid_until <= event.observed_at) return false;
  const provider = event.source === "tapo" || event.source === "home-assistant";
  return !provider || Date.parse(event.observed_at) - Date.parse(previous.observed_at) < MAX_OPENING_PROVIDER_STALE_MS;
}

function openingSourceIsCurrent(house: House | null, event: OpeningRow): boolean {
  const element = house?.floors.find(({ id }) => id === event.floor_id)?.planElements?.find(({ id }) => id === event.element_id);
  if (!element || !isAirflowPlanElement(element) || fixedPlanElementOpeningState(element) !== null) return false;
  const binding = element.stateBinding;
  if (!binding) return event.source === "manual" || event.source === "api";
  return binding.provider === event.source && binding.externalId === event.external_id
    && (binding.connectionId === undefined || binding.connectionId === event.connection_id);
}

function guardFor(
  reason: ClimateContextGuard["reason"],
  sourceId: string,
  event: Pick<OpeningRow, "observed_at" | "adaptive_context_at">,
): ClimateContextGuard {
  const occurredAt = Date.parse(event.observed_at);
  return { reason, sourceId, occurredAt, availableAt: Date.parse(event.adaptive_context_at), until: contextGuardWindow(occurredAt).to };
}

export class AdaptiveClimateContext {
  constructor(private readonly database: ClimateDatabase) {}

  forHour(epoch: AdaptiveEvidenceEpoch, { hour, knownAt }: { hour: number; knownAt: number }): ClimateContextGuard | null {
    if (epoch.dataMode !== "live" || knownAt < hour) return null;
    const window = {
      from: new Date(hour - ADAPTIVE_CONTEXT_GUARD_HOURS * HOUR_MS).toISOString(),
      to: new Date(hour).toISOString(),
      knownAt: new Date(knownAt).toISOString(),
    };
    return this.#openingGuard(epoch.houseId, window) ?? this.#heatingGuard(epoch.houseId, window);
  }

  #openingGuard(houseId: string, window: GuardWindow): ClimateContextGuard | null {
    const events = this.database.db.prepare(`SELECT id, floor_id, element_id, observed_at, adaptive_context_at,
        state, source, external_id, connection_id, valid_until FROM opening_state_observations
      WHERE house_id = ? AND observed_at > ? AND observed_at <= ?
        AND adaptive_context_at >= observed_at AND adaptive_context_at <= ? AND state IN ('open', 'closed')
      ORDER BY observed_at DESC, id DESC LIMIT 256`)
      .all(houseId, window.from, window.to, window.knownAt) as unknown as OpeningRow[];
    if (!events.length) return null;
    const house = this.database.getHouse(houseId);
    const predecessor = this.database.db.prepare(`SELECT id, observed_at, adaptive_context_at, valid_until, state
      FROM opening_state_observations WHERE house_id = ? AND floor_id = ? AND element_id = ?
        AND source = ? AND external_id IS ? AND connection_id IS ?
        AND observed_at < ? AND created_at <= ? ORDER BY observed_at DESC, id DESC LIMIT 1`);
    for (const event of events) {
      if (!openingSourceIsCurrent(house, event)) continue;
      const previous = predecessor.get(houseId, event.floor_id, event.element_id, event.source,
        event.external_id, event.connection_id, event.observed_at, event.adaptive_context_at) as unknown as OpeningRow | undefined;
      if (previous?.adaptive_context_at && previous.adaptive_context_at >= previous.observed_at
        && previous.state !== "unknown" && previous.state !== event.state && openingStillValid(previous, event)) {
        return guardFor("opening-state-change", event.id, event);
      }
    }
    return null;
  }

  #heatingGuard(houseId: string, window: GuardWindow): ClimateContextGuard | null {
    const lookback = new Date(Date.parse(window.from) - MAX_HEAT_PUMP_STATE_GAP_MS).toISOString();
    const row = this.database.db.prepare(`WITH recent AS (
      SELECT connection_id, observed_at, adaptive_context_at,
        CASE
          WHEN json_extract(state_json, '$.available') IS NOT 1 THEN NULL
          WHEN json_extract(state_json, '$.power') = 0 THEN 0
          WHEN json_extract(state_json, '$.power') = 1 THEN
            CASE WHEN json_extract(state_json, '$.selectedMode') = 'heat' THEN 1
              WHEN json_extract(state_json, '$.selectedMode') IN ('cool', 'dry', 'fan') THEN 0 END
        END AS heating,
        json_extract(state_json, '$.targetTemperatureC') AS setpoint
      FROM heat_pump_state_history WHERE house_id = ? AND observed_at >= ? AND observed_at <= ?
        AND coalesce(adaptive_context_at, received_at) <= ?
      ORDER BY observed_at DESC, id DESC LIMIT 4096
    ), paired AS (
      SELECT recent.*, lag(observed_at) OVER lane AS prior_at, lag(adaptive_context_at) OVER lane AS prior_recorded,
        lag(heating) OVER lane AS prior_heating, lag(setpoint) OVER lane AS prior_setpoint
      FROM recent WINDOW lane AS (PARTITION BY connection_id ORDER BY observed_at)
    )
    SELECT connection_id, observed_at, adaptive_context_at FROM paired WHERE observed_at > ?
      AND adaptive_context_at >= observed_at AND prior_recorded BETWEEN prior_at AND adaptive_context_at
      AND unixepoch(observed_at, 'subsec') - unixepoch(prior_at, 'subsec') <= ?
      AND (heating <> prior_heating OR (heating = 1 AND prior_heating = 1 AND setpoint <> prior_setpoint))
    ORDER BY observed_at DESC, connection_id LIMIT 1`).get(
      houseId, lookback, window.to, window.knownAt, window.from, MAX_HEAT_PUMP_STATE_GAP_MS / 1_000,
    ) as unknown as HeatRow | undefined;
    return row ? guardFor("heating-setting-change", row.connection_id, row) : null;
  }
}
