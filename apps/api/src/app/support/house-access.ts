import type { House } from "@climate-twin/contracts";
import { HttpError } from "./http-error.js";

/** What a route needs to resolve a Home for the caller. */
export interface VisibleHouseContext<TResponse> {
  database: { getHouse(id: string): House | null };
  visibility(response: TResponse): { house(id: string): boolean };
}

/** The Home with this id when the caller may see it; otherwise a 404, so a hidden Home looks absent. */
export function requireVisibleHouse<TResponse>(
  context: VisibleHouseContext<TResponse>,
  response: TResponse,
  houseId: string,
): House {
  const house = context.database.getHouse(houseId);
  if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
  return house;
}
