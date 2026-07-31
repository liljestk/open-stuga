import { apiPart01 } from "./api/part-01";
import { apiPart02 } from "./api/part-02";
import { apiPart03 } from "./api/part-03";
import { apiPart04 } from "./api/part-04";
import { nexus433Api } from "./api/nexus433";

export * from "./api/support";
export const api = {
  ...apiPart01,
  ...apiPart02,
  ...apiPart03,
  ...apiPart04,
  ...nexus433Api,
};
