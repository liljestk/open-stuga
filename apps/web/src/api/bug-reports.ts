import type { BugReportInput, BugReportReceipt } from "@climate-twin/contracts";
import { request } from "./support";

export const bugReportApi = {
  reportBug: (input: BugReportInput): Promise<BugReportReceipt> => request("/bug-reports", {
    method: "POST",
    body: JSON.stringify(input),
  }),
};
