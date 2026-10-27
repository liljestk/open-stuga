import { ShieldCheck } from "lucide-react";
import { useAppPart02 } from "./part-02";
export function useAppPart03(context: ReturnType<typeof useAppPart02>) {
  const { t } = context;
  const renderNoAccessCard = () => (
      <section className="property-empty-page" aria-labelledby="workspace-no-access-title">
        <ShieldCheck size={28} aria-hidden="true" />
        <h1 id="workspace-no-access-title">{t("properties.noAccessTitle")}</h1>
        <p>{t("properties.noAccessBody")}</p>
      </section>
    );
  return Object.assign(context, { renderNoAccessCard });
}