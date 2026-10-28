import "../PropertyManagementPage.css";
import type { PropertyManagementPageProps } from "./support";
import { usePropertyManagementPagePart01 } from "./part-01";
import { usePropertyManagementPagePart02 } from "./part-02";
import { usePropertyManagementPagePart03 } from "./part-03";
import { usePropertyManagementPagePart04 } from "./part-04";
import { usePropertyManagementPagePart05 } from "./part-05";
import { usePropertyManagementPagePart06 } from "./part-06";
import { usePropertyManagementPagePart07 } from "./part-07";
import { renderPropertyManagementPage } from "./render";
import { useHomeMonitoringCollectionQuery } from "../../data/analytics/homeMonitoringQuery";

function PropertyManagementPageView(props: Readonly<PropertyManagementPageProps>) {
  const context0 = { props };
  const context1 = usePropertyManagementPagePart01(context0);
  const context2 = usePropertyManagementPagePart02(context1);
  const context3 = usePropertyManagementPagePart03(context2);
  const context4 = usePropertyManagementPagePart04(context3);
  const context5 = usePropertyManagementPagePart05(context4);
  const context6 = usePropertyManagementPagePart06(context5);
  const context7 = usePropertyManagementPagePart07(context6);
  return renderPropertyManagementPage(context7);
}

function PropertyManagementPageQuery(props: Readonly<PropertyManagementPageProps>) {
  const mode = props.dataMode === "real" ? "live" as const : "demo" as const;
  const query = useHomeMonitoringCollectionQuery(
    mode,
    props.dataMode !== "unknown",
  );
  return <PropertyManagementPageView
    {...props}
    {...(query.data ? { monitoring: query.data } : {})}
  />;
}

export function PropertyManagementPage(props: Readonly<PropertyManagementPageProps>) {
  return props.monitoring || props.dataMode === undefined
    ? <PropertyManagementPageView {...props} />
    : <PropertyManagementPageQuery {...props} />;
}
