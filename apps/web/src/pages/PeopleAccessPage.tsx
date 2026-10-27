import { hasBrowserCapability } from "../accessPolicy";
import { ShieldCheck, Users } from "lucide-react";
import type { ClimateState } from "../domain";
import { useI18n } from "../i18n";
import { AccessPanel } from "./PropertyManagementPage";

export function PeopleAccessPage({ state }: Readonly<{ state: ClimateState }>) {
  const { t } = useI18n();
  const canManage = hasBrowserCapability(state.session.tenant.role, "workspace-administration");

  if (!canManage) return <section className="route-recovery" aria-labelledby="people-access-denied">
    <ShieldCheck size={24} aria-hidden="true" />
    <div><span className="eyebrow">{t("tenant.active")}</span><h1 id="people-access-denied">{t("properties.adminOnlyTitle")}</h1><p>{t("properties.adminOnlyBody")}</p></div>
  </section>;

  return <div className="property-page people-access-page">
    <header className="property-page-header">
      <div><span className="eyebrow">{t("tenant.active")}</span><h1>{t("nav.people")}</h1><p>{t("people.description")}</p></div>
      <Users size={28} aria-hidden="true" />
    </header>
    <AccessPanel state={state} properties={state.properties} canRemoveGuests workspaceMode />
  </div>;
}
