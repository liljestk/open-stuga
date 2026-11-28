import { apiErrorStatus } from "../../api/support/request-error";
import { formatInTimeZone } from "../../dateTime";
import { useI18n } from "../../i18n";

export function useAdaptiveFormat(timeZone: string) {
  const { locale } = useI18n();
  const numbers = new Intl.NumberFormat(locale);
  const percentages = new Intl.NumberFormat(locale, { style: "percent" });
  return {
    date: (value: string) => formatInTimeZone(value, locale, timeZone, { dateStyle: "medium", timeStyle: "short" }),
    number: (value: number) => numbers.format(value),
    percent: (value: number) => percentages.format(value),
  };
}

export function AdaptiveRequestError({ error, onRetry }: Readonly<{ error: unknown; onRetry: () => void }>) {
  const { t } = useI18n();
  const status = apiErrorStatus(error);
  const inaccessible = status === 401 || status === 403 || status === 404;
  return <div className="adaptive-message">
    <p role="alert">{t(inaccessible ? "adaptive.inaccessible" : status === 409 ? "adaptive.conflict" : "adaptive.error")}</p>
    <button type="button" className="secondary-button" onClick={onRetry}>{t(status === 409 ? "adaptive.refresh" : "common.retry")}</button>
  </div>;
}
