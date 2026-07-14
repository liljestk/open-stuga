import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Activity, Bell, Braces, ChevronLeft, CloudSun, House, Languages, LayoutDashboard, Menu, PanelLeftClose, PanelLeftOpen, RadioTower, Settings2, X } from "lucide-react";
import type { AppPage } from "../domain";
import { useI18n, type Locale } from "../i18n";
import type { ConnectionState, House as Home, UnitSystem } from "@climate-twin/contracts";
import { StugaMark } from "./StugaMark";
import { formatInTimeZone } from "../dateTime";

interface AppShellProps {
  page: AppPage;
  onPage: (page: AppPage) => void;
  connection: ConnectionState;
  units: UnitSystem;
  onUnits: (units: UnitSystem) => void;
  lastUpdated: string | null;
  openAlertCount?: number;
  houses?: Array<Pick<Home, "id" | "name" | "timezone">>;
  houseId?: string;
  onHouse?: (houseId: string) => void;
  onBack?: () => void;
  children: ReactNode;
}

const pageIcons = {
  overview: LayoutDashboard,
  twin: House,
  outdoor: CloudSun,
  sensors: RadioTower,
  alerts: Bell,
  integrations: Settings2,
  developer: Braces,
};

const navigationPreferenceKey = "climate-twin-navigation";

export function AppShell({ page, onPage, connection, units, onUnits, lastUpdated, openAlertCount = 0, houses = [], houseId = "", onHouse, onBack, children }: AppShellProps) {
  const { locale, setLocale, t } = useI18n();
  const activeTimeZone = houses.find((house) => house.id === houseId)?.timezone;
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(() => window.matchMedia?.("(max-width: 900px)").matches ?? false);
  const [desktopNavigationVisible, setDesktopNavigationVisible] = useState(() => localStorage.getItem(navigationPreferenceKey) !== "hidden");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const desktopHideButtonRef = useRef<HTMLButtonElement>(null);
  const desktopShowButtonRef = useRef<HTMLButtonElement>(null);
  const wasMenuOpen = useRef(false);
  const wasDesktopNavigationVisible = useRef(desktopNavigationVisible);
  const navItems: { id: AppPage; label: string }[] = [
    { id: "overview", label: t("nav.overview") },
    { id: "twin", label: t("nav.twin") },
    { id: "outdoor", label: t("nav.outdoor") },
    { id: "sensors", label: t("nav.sensors") },
    { id: "alerts", label: t("nav.alerts") },
    { id: "integrations", label: t("nav.integrations") },
    { id: "developer", label: t("nav.developer") },
  ];

  const closeMenu = () => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest("#primary-sidebar")) activeElement.blur();
    setMenuOpen(false);
  };

  const choosePage = (next: AppPage) => {
    onPage(next);
    closeMenu();
  };

  const setDesktopNavigation = (visible: boolean) => {
    localStorage.setItem(navigationPreferenceKey, visible ? "visible" : "hidden");
    setDesktopNavigationVisible(visible);
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
    const changed = wasDesktopNavigationVisible.current !== desktopNavigationVisible;
    wasDesktopNavigationVisible.current = desktopNavigationVisible;
    if (!changed) return;
    const timer = window.setTimeout(() => {
      if (desktopNavigationVisible) desktopHideButtonRef.current?.focus();
      else desktopShowButtonRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [desktopNavigationVisible]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  useEffect(() => {
    if (!mobileViewport || !menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [menuOpen, mobileViewport]);

  useEffect(() => {
    const mobileQuery = window.matchMedia?.("(max-width: 900px)");
    if (!mobileQuery) return;
    const updateViewport = (event: MediaQueryListEvent) => {
      setMobileViewport(event.matches);
      if (!event.matches) closeMenu();
    };
    mobileQuery.addEventListener("change", updateViewport);
    return () => mobileQuery.removeEventListener("change", updateViewport);
  }, []);

  const containMenuFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (!mobileViewport || !menuOpen || event.key !== "Tab") return;
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

  const navigationHidden = mobileViewport ? !menuOpen : !desktopNavigationVisible;
  const mainIsolated = mobileViewport && menuOpen;

  return (
    <div className={`app-shell ${desktopNavigationVisible ? "" : "navigation-hidden"}`.trim()}>
      <aside
        id="primary-sidebar"
        className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}
        role={mainIsolated ? "dialog" : undefined}
        aria-label={t("nav.primary")}
        aria-modal={mainIsolated ? true : undefined}
        aria-hidden={navigationHidden ? true : undefined}
        {...(navigationHidden ? { inert: "" } : {})}
        onKeyDown={containMenuFocus}
        onTransitionEnd={() => { if (menuOpen) closeButtonRef.current?.focus(); }}
      >
        <div className="brand">
          <StugaMark />
          <span className="brand-lockup">
            <strong>{t("app.name")}</strong>
            <small>{t("app.tagline")}</small>
          </span>
          <button
            ref={desktopHideButtonRef}
            className="icon-button desktop-navigation-hide"
            type="button"
            onClick={() => {
              desktopHideButtonRef.current?.blur();
              setDesktopNavigation(false);
            }}
            aria-label={t("header.hideNavigation")}
            aria-controls="primary-sidebar"
            aria-expanded="true"
            title={t("header.hideNavigation")}
          >
            <PanelLeftClose size={19} aria-hidden="true" />
          </button>
          <button ref={closeButtonRef} className="icon-button mobile-only" type="button" onClick={closeMenu} aria-label={t("header.closeMenu")}>
            <X size={20} />
          </button>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const Icon = pageIcons[item.id];
            return (
              <button key={item.id} type="button" className={page === item.id ? "nav-button active" : "nav-button"} aria-current={page === item.id ? "page" : undefined} onClick={() => choosePage(item.id)}>
                <Icon size={18} aria-hidden="true" /><span>{item.label}</span>
                {item.id === "alerts" && openAlertCount > 0 && (
                  <span className="nav-alert-count" aria-label={t("alerts.navCount", { count: openAlertCount })}>
                    {openAlertCount > 99 ? "99+" : openAlertCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        {houses.length > 0 && onHouse && (
          <label className="active-home-switcher">
            <span>{t("header.activeHome")}</span>
            <select value={houseId} onChange={(event) => onHouse(event.target.value)}>
              {houses.map((house) => <option key={house.id} value={house.id}>{house.name}</option>)}
            </select>
          </label>
        )}
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
          <div className="connection-row" role="status" aria-live="polite" aria-atomic="true" aria-label={t("status.dataSource")}>
            <span className={`status-pulse ${connection}`} aria-hidden="true" />
            <span>{t(`status.${connection}`)}</span>
            {lastUpdated && <time dateTime={lastUpdated}>{t("status.updated", { time: formatInTimeZone(lastUpdated, locale, activeTimeZone, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })}</time>}
          </div>
        </div>
      </aside>
      {menuOpen && <div className="nav-scrim" aria-hidden="true" onClick={closeMenu} />}
      {!desktopNavigationVisible && !mobileViewport && (
        <button
          ref={desktopShowButtonRef}
          className="icon-button desktop-navigation-show"
          type="button"
          onClick={() => setDesktopNavigation(true)}
          aria-label={t("header.showNavigation")}
          aria-controls="primary-sidebar"
          aria-expanded="false"
          title={t("header.showNavigation")}
        >
          <PanelLeftOpen size={19} aria-hidden="true" />
        </button>
      )}
      <div
        className="app-main-column"
        aria-hidden={mainIsolated ? true : undefined}
        {...(mainIsolated ? { inert: "" } : {})}
      >
        <a className="skip-link" href="#main-content">{t("header.skipToContent")}</a>
        <header className="mobile-header">
          <button
            ref={menuButtonRef}
            className="icon-button"
            type="button"
            onClick={() => {
              menuButtonRef.current?.blur();
              setMenuOpen(true);
            }}
            aria-label={t("header.openMenu")}
            aria-expanded={menuOpen}
            aria-controls="primary-sidebar"
          ><Menu size={20} /></button>
          <span className="mobile-brand"><StugaMark className="small" />{t("app.name")}</span>
          {page === "overview"
            ? <span className="mobile-header-spacer" aria-hidden="true" />
            : <button className="icon-button" type="button" onClick={() => onBack ? onBack() : choosePage("overview")} aria-label={t("header.back")}><ChevronLeft size={20} /></button>}
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
