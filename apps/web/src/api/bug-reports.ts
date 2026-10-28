import type {
  BugReportInput,
  BugReportReceipt,
  BugReportRelayInput,
  BugReportRelaySettings,
} from "@climate-twin/contracts";
import { request } from "./support/request";
import { bugReportReceiptShape, bugReportRelaySettingsShape } from "./support/entity-shapes";

export const bugReportApi = {
  reportBug: (input: BugReportInput): Promise<BugReportReceipt> => request("/bug-reports", bugReportReceiptShape, {
    method: "POST",
    body: JSON.stringify(input),
  }),
  bugReportRelay: (): Promise<BugReportRelaySettings> => request("/bug-reports/relay", bugReportRelaySettingsShape),
  configureBugReportRelay: (input: BugReportRelayInput): Promise<BugReportRelaySettings> => request("/bug-reports/relay", bugReportRelaySettingsShape, {
    method: "PUT",
    body: JSON.stringify(input),
  }),
  clearBugReportRelay: (): Promise<BugReportRelaySettings> => request("/bug-reports/relay", bugReportRelaySettingsShape, { method: "DELETE" }),
};
