import type { installAccessControl } from "./access-control.js";

/** Everything a route module may use: the composed services, the app and the access helpers. */
export type ApiRouteRegistrationContext = ReturnType<typeof installAccessControl>;
