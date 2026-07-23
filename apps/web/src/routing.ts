import type { AppPage } from "./domain";

export interface RouteScope {
  propertyId: string | null;
  houseId: string | null;
}

export interface AppRoute extends RouteScope {
  page: AppPage;
  /** The URL parsed successfully, but should be replaced by its canonical scoped URL. */
  legacy?: boolean;
  notFound?: boolean;
}

function decoded(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const setupSectionPattern = "overview|homes|layout|connections|weather|automations|operations";

/**
 * Parse Stuga's explicit Workspace -> Property -> Home route hierarchy.
 *
 * Legacy Site URLs remain readable so an installed application can restore the
 * referenced Home and replace the address after it knows that Home's Property.
 */
export function routeFromLocation(location: Pick<Location, "pathname" | "search">): AppRoute {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const search = new URLSearchParams(location.search);
  const queryHouse = search.get("site") || search.get("home");

  const homeRoute = new RegExp(
    `^/properties/([^/]+)/homes/([^/]+)(?:/(activity|maintenance|outdoor|electricity|sensors|analytics|setup(?:/(?:${setupSectionPattern}))?))?$`,
  ).exec(path);
  if (homeRoute) {
    const propertyId = decoded(homeRoute[1]);
    const houseId = decoded(homeRoute[2]);
    if (!propertyId || !houseId) return { page: "overview", propertyId: null, houseId: null, notFound: true };
    const suffix = homeRoute[3] ?? "";
    if (suffix === "setup/homes") return { page: "properties", propertyId, houseId: null, legacy: true };
    const page: AppPage = suffix === "activity"
      ? "activity"
      : suffix === "maintenance"
        ? "maintenance"
      : suffix === "outdoor"
        ? "outdoor"
        : suffix === "electricity"
          ? "energy"
        : suffix === "sensors"
          ? "sensors"
          : suffix === "analytics"
            ? "analytics"
          : suffix.startsWith("setup")
            ? "integrations"
            : "twin";
    return { page, propertyId, houseId };
  }

  const propertyRoute = /^\/properties\/([^/]+)(?:\/(maintenance|electricity))?$/.exec(path);
  if (propertyRoute) {
    const propertyId = decoded(propertyRoute[1]);
    if (!propertyId) return { page: "overview", propertyId: null, houseId: null, notFound: true };
    const page: AppPage = propertyRoute[2] === "maintenance"
      ? "maintenance"
      : propertyRoute[2] === "electricity"
        ? "energy"
        : "properties";
    return { page, propertyId, houseId: null };
  }

  const legacySiteRoute = /^\/sites\/([^/]+)\/(twin|activity|maintenance|outdoor|energy)$/.exec(path);
  if (legacySiteRoute) {
    return {
      page: legacySiteRoute[2] as Extract<AppPage, "twin" | "activity" | "maintenance" | "outdoor" | "energy">,
      propertyId: null,
      houseId: decoded(legacySiteRoute[1]),
      legacy: true,
    };
  }

  if (path === "/overview") return { page: "overview", propertyId: null, houseId: null };
  if (path === "/properties") return { page: "properties", propertyId: null, houseId: null };
  if (path === "/people") return { page: "people", propertyId: null, houseId: null };
  if (path === "/stugbys") return { page: "stugbys", propertyId: null, houseId: null };
  if (path === "/alerts") return { page: "alerts", propertyId: null, houseId: null };
  if (path === "/developer") return { page: "developer", propertyId: null, houseId: null };

  if (path === "/") return { page: "twin", propertyId: null, houseId: queryHouse, legacy: true };
  if (["/twin", "/outdoor", "/energy", "/activity", "/maintenance", "/sensors", "/analytics"].includes(path)) {
    const page = path.slice(1) as Extract<AppPage, "twin" | "outdoor" | "energy" | "activity" | "maintenance" | "sensors" | "analytics">;
    return { page, propertyId: null, houseId: queryHouse, legacy: true };
  }
  if (path === "/setup" || new RegExp(`^/setup/(?:${setupSectionPattern})$`).test(path)) {
    return { page: "integrations", propertyId: null, houseId: queryHouse, legacy: true };
  }

  return { page: "overview", propertyId: null, houseId: null, notFound: true };
}

export function locationForRoute(
  page: AppPage,
  scope: Partial<RouteScope> = {},
  currentPathname?: string,
): string {
  const property = scope.propertyId ? encodeURIComponent(scope.propertyId) : "";
  const home = scope.houseId ? encodeURIComponent(scope.houseId) : "";
  const propertyBase = property ? `/properties/${property}` : "/properties";
  const homeBase = property && home ? `${propertyBase}/homes/${home}` : "";

  switch (page) {
    case "overview": return "/overview";
    case "properties": return propertyBase;
    case "people": return "/people";
    case "stugbys": return "/stugbys";
    case "twin": return homeBase || propertyBase;
    case "activity": return homeBase ? `${homeBase}/activity` : propertyBase;
    case "maintenance": return homeBase ? `${homeBase}/maintenance` : property ? `${propertyBase}/maintenance` : "/properties";
    case "outdoor": return homeBase ? `${homeBase}/outdoor` : propertyBase;
    case "energy": return homeBase ? `${homeBase}/electricity` : property ? `${propertyBase}/electricity` : "/properties";
    case "sensors": return homeBase ? `${homeBase}/sensors` : propertyBase;
    case "analytics": return homeBase ? `${homeBase}/analytics` : propertyBase;
    case "alerts": return "/alerts";
    case "integrations": {
      const normalizedCurrentPath = (currentPathname ?? "").replace(/\/+$/, "");
      const setupSection = new RegExp(`/(?:setup)/(?:${setupSectionPattern})$`).exec(normalizedCurrentPath)?.[0]
        .replace(/^\/setup\//, "")
        .replace(/^\/setup$/, "");
      const suffix = setupSection && setupSection !== "homes" ? `/setup/${setupSection}` : "/setup";
      return homeBase ? `${homeBase}${suffix}` : propertyBase;
    }
    case "developer": return "/developer";
  }
}
