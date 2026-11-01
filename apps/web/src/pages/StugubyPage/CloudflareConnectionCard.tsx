import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n";
import { CloudflareSetupPanel } from "../CloudflareSetupPanel";
import { loopbackOrigin } from "./stugubyModel";

interface CloudflareConnectionCardProps {
  publicOrigin: string | null | undefined;
  /** True when the deployment, not the UI, pins the public origin. */
  deploymentManaged: boolean;
  onComplete: () => Promise<void>;
}

/**
 * Reruns the Cloudflare setup on a coordinator whose HTTPS address the
 * deployment already pins, for example when an update adds an Access
 * application. Before that address exists, the create panel offers the setup.
 */
export function CloudflareConnectionCard({
  publicOrigin,
  deploymentManaged,
  onComplete,
}: Readonly<CloudflareConnectionCardProps>) {
  const { t } = useI18n();
  const [rerunning, setRerunning] = useState(false);
  if (!deploymentManaged || !publicOrigin || loopbackOrigin(publicOrigin)) return null;

  return <details className="stuguby-card stuguby-collapsible stuguby-cloudflare-connection">
    <summary>
      <ShieldCheck size={19} aria-hidden="true" />
      <span>
        <strong>{t("cloudflareSetup.connectionTitle")}</strong>
        <small>{t("cloudflareSetup.connectionSummary", { origin: publicOrigin })}</small>
      </span>
    </summary>
    <div className="stuguby-collapsible-body">
      {rerunning
        ? <>
          <CloudflareSetupPanel
            suggestedOrigin={publicOrigin}
            onComplete={async () => {
              await onComplete();
              setRerunning(false);
            }}
          />
          <button type="button" className="secondary-button" onClick={() => setRerunning(false)}>
            {t("common.cancel")}
          </button>
        </>
        : <>
          <p>{t("cloudflareSetup.rerunBody")}</p>
          <button type="button" className="secondary-button" onClick={() => setRerunning(true)}>
            {t("cloudflareSetup.rerun")}
          </button>
        </>}
    </div>
  </details>;
}
