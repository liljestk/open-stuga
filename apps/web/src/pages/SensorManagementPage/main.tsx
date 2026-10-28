import type { SensorManagementPageProps } from "./support";
import { useSensorManagementPagePart01 } from "./part-01";
import { useSensorManagementPagePart02 } from "./part-02";
import { useSensorManagementPagePart03 } from "./part-03";
import { useSensorManagementPagePart04 } from "./part-04";
import { renderSensorManagementPage } from "./render";

export function SensorManagementPage({
  state,
  house,
  houses,
  integration,
  tpLinkDevices,
  tpLinkDevicesLoading,
  tpLinkDevicesError,
  requestedDevice = null,
  requestedDeviceId = null,
  readOnly = false,
  localAuthority = true,
  canManageIntegrations = false,
  units = "metric",
  onRequestedDeviceHandled,
  onLoadSeries,
  onHouse,
  onUpdateHouse,
  onRefreshDevices,
  onCreateSensor,
  onUpdateSensor,
  onDeleteSensor,
  onImportHistoricalData,
}: SensorManagementPageProps) {
  const context0 = { state, house, houses, integration, tpLinkDevices, tpLinkDevicesLoading, tpLinkDevicesError, requestedDevice, requestedDeviceId, readOnly, localAuthority, canManageIntegrations, units, onRequestedDeviceHandled, onLoadSeries, onHouse, onUpdateHouse, onRefreshDevices, onCreateSensor, onUpdateSensor, onDeleteSensor, onImportHistoricalData };
  const context1 = useSensorManagementPagePart01(context0);
  const context2 = useSensorManagementPagePart02(context1);
  const context3 = useSensorManagementPagePart03(context2);
  const context4 = useSensorManagementPagePart04(context3);
  return renderSensorManagementPage(context4);
}
