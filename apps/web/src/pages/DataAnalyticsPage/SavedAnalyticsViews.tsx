import { ApiRequestError } from "../../api";
import type { TranslationKey } from "../../i18n";
import { useAuthorizationRevision } from "../../data/useAuthorizationRevision";
import { useRef, useState } from "react";
import type { AnalyticsViewDefinition, DataMode } from "@climate-twin/contracts";
import { useI18n } from "../../i18n";
import { useSavedAnalyticsViews } from "../../data/analytics/savedViews";
import { confirmAction } from "../../components/ConfirmationProvider";

interface SavedViewsProps {
  houseId: string;
  dataMode: DataMode;
  readOnly: boolean;
  definition: AnalyticsViewDefinition;
  onApply: (definition: AnalyticsViewDefinition) => boolean;
}
export function SavedAnalyticsViews(props: SavedViewsProps) {
  const revision = useAuthorizationRevision();
  return <SavedAnalyticsViewEditor key={revision} {...props} />;
}
function SavedAnalyticsViewEditor(props: SavedViewsProps) {
  const { t } = useI18n();
  const { query, mutation } = useSavedAnalyticsViews(props.houseId, props.dataMode);
  const [selection, setSelection] = useState<{ id: string; baseRevision: number } | null>(null);
  const [name, setName] = useState("");
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);
  const current = query.data?.views.find((view) => view.id === selection?.id);
  const reload = () => { setSelection(null); setName(""); mutation.reset(); setFailed(false); setMessage(""); void query.refetch(); };
  const save = async (replace: boolean) => {
    setMessage(""); setFailed(false);
    try {
      const result = await mutation.mutateAsync(replace && selection
        ? { action: "update", ...selection, name, definition: props.definition }
        : { action: "create", name, definition: props.definition });
      if (result) { setSelection({ id: result.view.id, baseRevision: result.view.revision }); setName(result.view.name); setMessage(t("analyticsViews.saved")); }
    } catch { /* The mutation exposes its typed request failure below. */ }
  };
  const remove = async () => {
    if (!current || !selection || !await confirmAction(t("analyticsViews.deleteConfirm", { name: current.name }), t("analyticsViews.delete"))) return;
    try { await mutation.mutateAsync({ action: "delete", ...selection }); setSelection(null); setName(""); setMessage(t("analyticsViews.deleted")); selectRef.current?.focus(); }
    catch { /* Preserve the selection until the person reloads or retries. */ }
  };
  return <details className="analytics-view-controls">
    <summary>{t("analyticsViews.title")}</summary>
    <p>{t("analyticsViews.private")}</p>
    {query.isPending ? <p role="status">{t("analyticsViews.loading")}</p> : <>
      <label className="field"><span>{t("analyticsViews.choose")}</span><select ref={selectRef} value={selection?.id ?? ""} onChange={(event) => {
        const view = query.data?.views.find((item) => item.id === event.target.value);
        setSelection(view ? { id: view.id, baseRevision: view.revision } : null); setName(view?.name ?? ""); setMessage(""); setFailed(false);
      }}>
        <option value="">{t("analyticsViews.new")}</option>
        {(query.data?.views ?? []).map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </select></label>
      {current && <button type="button" className="secondary-button" onClick={() => {
        setFailed(!props.onApply(current.definition)); setMessage("");
      }}>{t("analyticsViews.load")}</button>}
      {!props.readOnly && <form onSubmit={(event) => { event.preventDefault(); void save(false); }}>
        <label className="field"><span>{t("analyticsViews.name")}</span><input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <div className="analytics-view-actions">
          <button type="submit" className="primary-button" disabled={mutation.isPending || !name.trim() || Boolean(query.error)}>{t("analyticsViews.saveNew")}</button>
          {current && <>
            <button type="button" className="secondary-button" disabled={mutation.isPending || !name.trim()} onClick={() => void save(true)}>{t("analyticsViews.replace")}</button>
            <button type="button" className="secondary-button" disabled={mutation.isPending} onClick={() => void remove()}>{t("analyticsViews.delete")}</button>
          </>}
        </div>
      </form>}
    </>}
    {(query.error || mutation.error || failed) && <p className="inline-error" role="alert">{t(savedViewErrorKey(query.error ?? mutation.error))}</p>}
    <button type="button" className="secondary-button" onClick={reload} disabled={query.isFetching || mutation.isPending}>{t("analyticsViews.reload")}</button>
    <p role="status">{mutation.isPending ? t("analyticsViews.updating") : message}</p>
  </details>;
}

function savedViewErrorKey(error: unknown): TranslationKey {
  if (!(error instanceof ApiRequestError)) return "analyticsViews.failed";
  if (error.status === 401 || error.status === 403) return "analyticsViews.accessDenied";
  if (error.status === 409) return "analyticsViews.conflict";
  return "analyticsViews.failed";
}
