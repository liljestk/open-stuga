import { useIntegrationsPagePart05 } from "./part-05";
export function useIntegrationsPagePart06(context: ReturnType<typeof useIntegrationsPagePart05>) {
  const { t, discovering, sensorSourceConfigured, discoveredCount, nextStepIndex, scanIntegrations, activateSection, onOpenSensors } = context;
  const runRecommendedAction = () => {
      if (nextStepIndex === 1) {
        activateSection("connections");
        if (!sensorSourceConfigured && !discovering) void scanIntegrations();
        return;
      }
      if (nextStepIndex === 2) {
        if (onOpenSensors) onOpenSensors();
        else activateSection("connections");
      }
    };
  const recommendedActionLabel = discoveredCount > 0 && nextStepIndex === 1
      ? t("setup.reviewFound", { count: discoveredCount })
      : nextStepIndex === 1 && !sensorSourceConfigured
        ? t("setup.scan")
        : nextStepIndex === 2 ? t("sensors.add") : t("setup.workspaceConnections");
  return Object.assign(context, { runRecommendedAction, recommendedActionLabel });
}
