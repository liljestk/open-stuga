import type { AppPage } from "./domain";

export interface AppRoute {
  page: AppPage;
  houseId: string | null;
}

function decoded(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Parse the small, intentionally explicit route surface used by Stuga.
 *
 * The app still works when served from `/`, while operational views get
 * durable URLs that can be refreshed, bookmarked, and restored with Back.
 */
export function routeFromLocation(location: Pick<Location, "pathname" | "search">): AppRoute {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const search = new URLSearchParams(location.search);
  const queryHouse = search.get("site") || search.get("home");
  const siteRoute = /^\/sites\/([^/]+)\/(twin|outdoor)$/.exec(path);
  if (siteRoute) {
    return {
      page: siteRoute[2] as Extract<AppPage, "twin" | "outdoor">,
      houseId: decoded(siteRoute[1]),
    };
  }

  if (path === "/overview") return { page: "overview", houseId: queryHouse };
  if (path === "/outdoor") return { page: "outdoor", houseId: queryHouse };
  if (path === "/sensors") return { page: "sensors", houseId: queryHouse };
  if (path === "/alerts") return { page: "alerts", houseId: queryHouse };
  if (path === "/setup" || path.startsWith("/setup/")) return { page: "integrations", houseId: queryHouse };
  if (path === "/developer") return { page: "developer", houseId: queryHouse };
  if (path === "/twin") return { page: "twin", houseId: queryHouse };
  return { page: "twin", houseId: queryHouse };
}

export function locationForRoute(
  page: AppPage,
  houseId: string | null | undefined,
  currentPathname?: string,
): string {
  const site = houseId ? encodeURIComponent(houseId) : "";
  switch (page) {
    case "overview": return "/overview";
    case "twin": return site ? `/sites/${site}/twin` : "/twin";
    case "outdoor": return site ? `/sites/${site}/outdoor` : "/outdoor";
    case "sensors": return site ? `/sensors?site=${site}` : "/sensors";
    case "alerts": return site ? `/alerts?site=${site}` : "/alerts";
    case "integrations": {
      const setupSection = /^\/setup\/(overview|homes|connections|weather)\/?$/.exec(currentPathname ?? "")?.[1];
      const path = setupSection ? `/setup/${setupSection}` : "/setup";
      return site ? `${path}?site=${site}` : path;
    }
    case "developer": return "/developer";
  }
}
