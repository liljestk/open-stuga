import type {
  BugReportInput,
  BugReportReceipt,
  BugReportRelayInput,
  BugReportRelaySettings,
} from "@climate-twin/contracts";
import { request } from "./support/request";

export const bugReportApi = {
  reportBug: (input: BugReportInput): Promise<BugReportReceipt> => request("/bug-reports", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  bugReportRelay: (): Promise<BugReportRelaySettings> => request("/bug-reports/relay"),
  configureBugReportRelay: (input: BugReportRelayInput): Promise<BugReportRelaySettings> => request("/bug-reports/relay", {
    method: "PUT",
    body: JSON.stringify(input),
  }),
  clearBugReportRelay: (): Promise<BugReportRelaySettings> => request("/bug-reports/relay", { method: "DELETE" }),
};
