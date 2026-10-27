import type { IntegrationsPageProps } from "./support";
import { useIntegrationsPagePart01 } from "./part-01";
import { useIntegrationsPagePart02 } from "./part-02";
import { useIntegrationsPagePart03 } from "./part-03";
import { useIntegrationsPagePart04 } from "./part-04";
import { useIntegrationsPagePart05 } from "./part-05";
import { useIntegrationsPagePart06 } from "./part-06";
import { renderIntegrationsPage } from "./render";

export function IntegrationsPage({ integration: aggregateIntegration, house: initialHouse, houses, connectionHouses = houses, streamConnection, tpLinkDevicesLoading = false, tpLinkDevicesError = null, canManageTuya = false, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout, onDiscoveryStarted }: IntegrationsPageProps) {
  const context0 = { aggregateIntegration, initialHouse, houses, connectionHouses, streamConnection, tpLinkDevicesLoading, tpLinkDevicesError, canManageTuya, onHouse, onHouseUpdate, onGeoreferenceChange, onIntegrationChange, onRefreshTpLinkDevices, onDisconnectHomeAssistant, onDisconnectTpLink, onMoveHomeAssistant, onMoveTpLink, onOpenSensors, onOpenLayout, onDiscoveryStarted };
  const context1 = useIntegrationsPagePart01(context0);
  const context2 = useIntegrationsPagePart02(context1);
  const context3 = useIntegrationsPagePart03(context2);
  const context4 = useIntegrationsPagePart04(context3);
  const context5 = useIntegrationsPagePart05(context4);
  const context6 = useIntegrationsPagePart06(context5);
  return renderIntegrationsPage(context6);
}
