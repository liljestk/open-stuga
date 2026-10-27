import type { ReactNode } from "react";
import { useI18n } from "../../i18n";

interface CredentialControlsProps {
  /** True for an Owner or Admin, the only roles the API lets change integration credentials. */
  allowed: boolean | undefined;
  children: ReactNode;
  /** Say why the controls are missing instead of leaving a silent gap. */
  explain?: boolean;
}

/** Credential forms for an Owner or Admin; everyone else sees why they are not offered. */
export function CredentialControls({ allowed, children, explain = true }: Readonly<CredentialControlsProps>) {
  const { t } = useI18n();
  if (allowed) return <>{children}</>;
  return explain ? <p className="setup-help">{t("setup.integrationCredentialsAdminOnly")}</p> : null;
}
