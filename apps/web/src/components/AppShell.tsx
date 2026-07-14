import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Activity, Bell, Braces, ChevronLeft, House, Languages, Menu, Settings2, ThermometerSun, X } from "lucide-react";
import type { AppPage } from "../domain";
import { useI18n, type Locale } from "../i18n";
import type { ConnectionState, UnitSystem } from "@climate-twin/contracts";

interface AppShellProps {
  page: AppPage;
  onPage: (page: AppPage) => void;
  connection: ConnectionState;
  units: UnitSystem;
  onUnits: (units: UnitSystem) => void;
  lastUpdated: string | null;
  children: ReactNode;
}

const pageIcons = {
  twin: House,
  alerts: Bell,
  integrations: Settings2,
  developer: Braces,
};

export function AppShell({ page, onPage, connection, units, onUnits, lastUpdated, children }: AppShellProps) {
  const { locale, setLocale, t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasMenuOpen = useRef(false);
  const navItems: { id: AppPage; label: string }[] = [
    { id: "twin", label: t("nav.twin") },
    { id: "alerts", label: t("nav.alerts") },
    { id: "integrations", label: t("nav.integrations") },
    { id: "developer", label: t("nav.developer") },
  ];

  const choosePage = (next: AppPage) => {
    onPage(next);
    setMenuOpen(false);
  };

  useEffect(() => {
    const restoreOpener = wasMenuOpen.current;
    wasMenuOpen.current = menuOpen;
    // Wait until the responsive drawer's visibility change has reached layout;
    // browsers will otherwise refuse to focus its formerly hidden close button.
    const timer = window.setTimeout(() => {
      if (menuOpen) closeButtonRef.current?.focus();
      else if (restoreOpener) menuButtonRef.current?.focus();
    }, menuOpen ? 50 : 0);
    return () => window.clearTimeout(timer);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  const containMenuFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (!menuOpen || event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), a[href]")]
      .filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t("nav.twin")}</a>
      <aside
        id="primary-sidebar"
        className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}
        aria-label={t("nav.primary")}
        onKeyDown={containMenuFocus}
        onTransitionEnd={() => { if (menuOpen) closeButtonRef.current?.focus(); }}
      >
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><ThermometerSun size={22} /></span>
          <span>
            <strong>{t("app.name")}</strong>
            <small>{t("app.tagline")}</small>
          </span>
          <button ref={closeButtonRef} className="icon-button mobile-only" type="button" onClick={() => setMenuOpen(false)} aria-label={t("header.closeMenu")}>
            <X size={20} />
          </button>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const Icon = pageIcons[item.id];
            return (
              <button key={item.id} type="button" className={page === item.id ? "nav-button active" : "nav-button"} aria-current={page === item.id ? "page" : undefined} onClick={() => choosePage(item.id)}>
                <Icon size={18} aria-hidden="true" /><span>{item.label}</span>
                {item.id === "alerts" && <span className="nav-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <label className="compact-field">
            <span><Languages size={15} aria-hidden="true" />{t("common.language")}</span>
            <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
              <option value="en">English</option>
              <option value="fi">Suomi</option>
            </select>
          </label>
          <label className="compact-field">
            <span><Activity size={15} aria-hidden="true" />{t("common.units")}</span>
            <select value={units} onChange={(event) => onUnits(event.target.value as UnitSystem)}>
              <option value="metric">{t("common.metricUnits")}</option>
              <option value="imperial">{t("common.imperialUnits")}</option>
            </select>
          </label>
          <div className="connection-row" aria-label={t("status.dataSource")}>
            <span className={`status-pulse ${connection}`} aria-hidden="true" />
            <span>{t(`status.${connection}`)}</span>
            {lastUpdated && <time dateTime={lastUpdated}>{t("status.updated", { time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(lastUpdated)) })}</time>}
          </div>
        </div>
      </aside>
      {menuOpen && <button className="nav-scrim" type="button" onClick={() => setMenuOpen(false)} aria-label={t("header.closeMenu")} />}
      <div className="app-main-column">
        <header className="mobile-header">
          <button ref={menuButtonRef} className="icon-button" type="button" onClick={() => setMenuOpen(true)} aria-label={t("header.openMenu")} aria-expanded={menuOpen} aria-controls="primary-sidebar"><Menu size={20} /></button>
          <span className="mobile-brand"><span className="brand-mark small" aria-hidden="true"><ThermometerSun size={17} /></span>{t("app.name")}</span>
          <button className="icon-button" type="button" onClick={() => choosePage("twin")} aria-label={t("nav.twin")}><ChevronLeft size={20} /></button>
        </header>
        <main id="main-content" className="main-content">{children}</main>
      </div>
    </div>
  );
}
