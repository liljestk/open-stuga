import { type KeyboardEvent } from "react";
import type { SetupSection } from "./setupModel";
import { useIntegrationsPagePart05 } from "./part-05";
export function useIntegrationsPagePart06(context: ReturnType<typeof useIntegrationsPagePart05>) {
  const { t, discovering, sensorSourceConfigured, discoveredCount, nextStepIndex, primarySetupSections, scanIntegrations, activateSection, onOpenSensors } = context;
  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, section: SetupSection) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const sectionOrder = primarySetupSections.map((candidate) => candidate.id);
      const index = sectionOrder.indexOf(section);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? sectionOrder.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + sectionOrder.length) % sectionOrder.length;
      const next = sectionOrder[nextIndex]!;
      activateSection(next);
      window.requestAnimationFrame(() => document.getElementById(`setup-tab-${next}`)?.focus());
    };
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
  return Object.assign(context, { handleSectionKeyDown, runRecommendedAction, recommendedActionLabel });
}
