import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Activity, Bell, Bolt, Braces, ChartLine, ChevronDown, ChevronLeft, CloudSun, House, Languages, LayoutDashboard, ListChecks, LogOut, MapPinned, Menu, PanelLeftClose, PanelLeftOpen, RadioTower, RotateCcw, Settings2, ShieldCheck, Users, Wrench, X } from "lucide-react";
import type { AppPage } from "../domain";
import { useI18n, type Locale } from "../i18n";
import type { ConnectionState, House as Home, Property, UnitSystem } from "@climate-twin/contracts";
import { StugaMark } from "./StugaMark";
import { formatInTimeZone } from "../dateTime";
import type { DataMode } from "../useClimateData";
import { locationForRoute } from "../routing";
import { readLocalStorage, writeLocalStorage } from "../browserStorage";

interface AppShellProps {
  page: AppPage;
  onPage: (page: AppPage, scope?: { propertyId?: string | null; houseId?: string | null }) => void;
  connection: ConnectionState;
  units: UnitSystem;
  onUnits: (units: UnitSystem) => void;
  lastUpdated: string | null;
  freshnessLabel?: string | undefined;
  dataMode: DataMode;
  pollingFallback?: boolean;
  resourceErrors?: string[];
  canManagePeople?: boolean;
  openAlertCount?: number;
  readOnly?: boolean;
  principalEmail?: string | null;
  onLogout?: () => Promise<void> | void;
  properties?: Array<Pick<Property, "id" | "name">>;
  propertyId?: string;
  onProperty?: (propertyId: string) => void;
  houses?: Array<Pick<Home, "id" | "propertyId" | "name" | "timezone">>;
  houseId?: string;
  onHouse?: (houseId: string) => void;
  homeAvailable?: boolean;
  /** Whether the current principal can read the Property-owned electricity contract. */
  propertyElectricityAvailable?: boolean;
  onBack?: () => void;
  onBackLabel?: string;
  onRetryConnection?: () => void;
  sensorDiscoveryNotice?: {
    name: string;
    model: string;
    additionalCount: number;
  } | undefined;
  onAddDiscoveredSensor?: (() => void) | undefined;
  onDismissDiscoveredSensors?: (() => void) | undefined;
  children: ReactNode;
}

const pageIcons = {
  overview: LayoutDashboard,
  properties: MapPinned,
  people: Users,
  twin: House,
  activity: ListChecks,
  maintenance: Wrench,
  outdoor: CloudSun,
  energy: Bolt,
  sensors: RadioTower,
  analytics: ChartLine,
  alerts: Bell,
  integrations: Settings2,
  developer: Braces,
};

const navigationPreferenceKey = "climate-twin-navigation";

export function AppShell({
  page,
  onPage,
  connection,
  units,
  onUnits,
  lastUpdated,
  freshnessLabel,
  dataMode,
  pollingFallback = false,
  resourceErrors = [],
  canManagePeople = false,
  openAlertCount = 0,
  readOnly = false,
  principalEmail = null,
  onLogout,
  properties = [],
  propertyId = "",
  onProperty,
  houses = [],
  houseId = "",
  onHouse,
  homeAvailable = true,
  propertyElectricityAvailable = true,
  onBack,
  onBackLabel,
  onRetryConnection,
  sensorDiscoveryNotice,
  onAddDiscoveredSensor,
  onDismissDiscoveredSensors,
  children,
}: AppShellProps) {
  const { locale, setLocale, t } = useI18n();
  const activeProperty = properties.find((property) => property.id === propertyId);
  const propertyHouses = houses.filter((house) => house.propertyId === propertyId);
  const activeHome = propertyHouses.find((house) => house.id === houseId);
  const activeTimeZone = activeHome?.timezone;
  const [menuOpen, setMenuOpen] = useState(false);
  const [showConnectionException, setShowConnectionException] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(() => window.matchMedia?.("(max-width: 900px)").matches ?? false);
  const [desktopNavigationVisible, setDesktopNavigationVisible] = useState(() => readLocalStorage(navigationPreferenceKey) !== "hidden");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const desktopHideButtonRef = useRef<HTMLButtonElement>(null);
  const desktopShowButtonRef = useRef<HTMLButtonElement>(null);
  const wasMenuOpen = useRef(false);
  const wasDesktopNavigationVisible = useRef(desktopNavigationVisible);
  type NavigationItem = {
    id: AppPage;
    label: string;
    scope: "workspace" | "property" | "home";
  };
  const workspaceNavItems: NavigationItem[] = [
    { id: "overview", label: t("nav.overview"), scope: "workspace" },
    { id: "properties", label: t("nav.properties"), scope: "workspace" },
    ...(canManagePeople ? [{ id: "people" as const, label: t("nav.people"), scope: "workspace" as const }] : []),
    { id: "alerts", label: t("nav.alerts"), scope: "workspace" },
  ];
  const propertyNavItems: NavigationItem[] = activeProperty ? [
    { id: "properties", label: t("bootstrap.propertyForHome"), scope: "property" },
    { id: "maintenance", label: t("nav.maintenance"), scope: "property" },
    ...(propertyElectricityAvailable ? [
      { id: "energy" as const, label: t("nav.energy"), scope: "property" as const },
    ] : []),
  ] : [];
  const homeNavItems: NavigationItem[] = activeHome && homeAvailable ? [
    { id: "twin", label: t("nav.twin"), scope: "home" },
    { id: "activity", label: t("nav.activity"), scope: "home" },
    { id: "outdoor", label: t("nav.outdoor"), scope: "home" },
    ...(propertyElectricityAvailable ? [
      { id: "energy" as const, label: t("nav.energyUse"), scope: "home" as const },
    ] : []),
    { id: "sensors", label: t("nav.sensors"), scope: "home" },
    { id: "analytics", label: t("nav.analytics"), scope: "home" },
    ...(!readOnly ? [
      { id: "integrations" as const, label: t("nav.integrations"), scope: "home" as const },
    ] : []),
  ] : [];
  const advancedNavItems: NavigationItem[] = [
    { id: "developer", label: t("nav.developer"), scope: "workspace" },
  ];

  const closeMenu = () => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest("#primary-sidebar")) activeElement.blur();
    setMenuOpen(false);
  };

  const choosePage = (item: NavigationItem) => {
    onPage(item.id, item.scope === "workspace"
      ? { propertyId: null, houseId: null }
      : item.scope === "property"
        ? { propertyId, houseId: null }
        : { propertyId, houseId });
    closeMenu();
  };

  const setDesktopNavigation = (visible: boolean) => {
    writeLocalStorage(navigationPreferenceKey, visible ? "visible" : "hidden");
    setDesktopNavigationVisible(visible);
  };

  const logout = async () => {
    if (!onLogout || logoutPending) return;
    setLogoutPending(true);
    setLogoutFailed(false);
    try { await onLogout(); }
    catch { setLogoutFailed(true); }
    finally { setLogoutPending(false); }
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
    if (connection === "live") {
      setShowConnectionException(false);
      return;
    }
    setShowConnectionException(false);
    const timer = window.setTimeout(() => setShowConnectionException(true), connection === "reconnecting" ? 3000 : 1500);
    return () => window.clearTimeout(timer);
  }, [connection, dataMode]);

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
  const navigationItem = (item: NavigationItem) => {
    const Icon = pageIcons[item.id];
    const scope = item.scope === "workspace"
      ? { propertyId: null, houseId: null }
      : item.scope === "property"
        ? { propertyId, houseId: null }
        : { propertyId, houseId };
    const currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
    const href = locationForRoute(item.id, scope, currentPath);
    const active = page === item.id && currentPath === href;
    return (
      <a
        key={`${item.scope}:${item.id}`}
        href={href}
        className={active ? "nav-button active" : "nav-button"}
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          choosePage(item);
        }}
      >
        <Icon size={18} aria-hidden="true" /><span>{item.label}</span>
        {item.id === "alerts" && openAlertCount > 0 && (
          <span className="nav-alert-count" aria-label={t("alerts.navCount", { count: openAlertCount })}>
            {openAlertCount > 99 ? "99+" : openAlertCount}
          </span>
        )}
      </a>
    );
  };

  return (
    <div className={`app-shell ${desktopNavigationVisible ? "" : "navigation-hidden"} ${dataMode === "demo" ? "demo-mode" : dataMode === "real" ? "real-mode" : "neutral-mode"}`.trim()} data-environment={dataMode}>
      <nav
        id="primary-sidebar"
        className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}
        role={mainIsolated ? "dialog" : undefined}
        aria-label={t("nav.primary")}
        aria-modal={mainIsolated ? true : undefined}
        aria-hidden={navigationHidden ? true : undefined}
        {...(navigationHidden ? { inert: "" } : {})}
        onKeyDown={containMenuFocus}
        onTransitionEnd={(event) => {
          if (menuOpen && event.target === event.currentTarget && event.propertyName === "transform") closeButtonRef.current?.focus();
        }}
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
        <div className="sidebar-nav">
          <details className="sidebar-nav-group" aria-label={t("tenant.active")} open>
            <summary><span>{t("tenant.active")}</span><ChevronDown size={15} aria-hidden="true" /></summary>
            <div>{workspaceNavItems.map(navigationItem)}</div>
          </details>
          {propertyNavItems.length > 0 && <details className="sidebar-nav-group" aria-label={t("nav.propertyGroup", { name: activeProperty?.name ?? t("nav.properties") })} open>
            <summary><span>{t("nav.propertyGroup", { name: activeProperty?.name ?? t("nav.properties") })}</span><ChevronDown size={15} aria-hidden="true" /></summary>
            <div>{propertyNavItems.map(navigationItem)}</div>
          </details>}
          {homeNavItems.length > 0 && <details className="sidebar-nav-group" aria-label={t("nav.homeGroup", { name: activeHome?.name ?? t("nav.twin") })} open>
            <summary><span>{t("nav.homeGroup", { name: activeHome?.name ?? t("nav.twin") })}</span><ChevronDown size={15} aria-hidden="true" /></summary>
            <div>{homeNavItems.map(navigationItem)}</div>
          </details>}
          <details className="sidebar-nav-group" aria-label={t("nav.advanced")} open={advancedNavItems.some((item) => item.id === page) || undefined}>
            <summary><span>{t("nav.advanced")}</span><ChevronDown size={15} aria-hidden="true" /></summary>
            <div>{advancedNavItems.map(navigationItem)}</div>
          </details>
        </div>
        <div className="sidebar-foot">
          {readOnly && <div className="guest-session-badge"><ShieldCheck size={15} aria-hidden="true" /><span><strong>{t("properties.guestReadOnly")}</strong>{principalEmail && <small>{principalEmail}</small>}</span></div>}
          {principalEmail && onLogout && <>
            <button type="button" className="secondary-button sidebar-logout" disabled={logoutPending} onClick={() => void logout()}><LogOut size={15} aria-hidden="true" />{t(logoutPending ? "auth.loggingOut" : "auth.logout")}</button>
            {logoutFailed && <p className="sidebar-logout-error" role="alert">{t("auth.logoutFailed")}</p>}
          </>}
          <label className="compact-field">
            <span><Languages size={15} aria-hidden="true" />{t("common.language")}</span>
            <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
              <option value="en">{t("language.en")}</option>
              <option value="fi">{t("language.fi")}</option>
              <option value="sv">{t("language.sv")}</option>
            </select>
          </label>
          <label className="compact-field">
            <span><Activity size={15} aria-hidden="true" />{t("common.units")}</span>
            <select value={units} onChange={(event) => onUnits(event.target.value as UnitSystem)}>
              <option value="metric">{t("common.metricUnits")}</option>
              <option value="imperial">{t("common.imperialUnits")}</option>
            </select>
          </label>
          <div className="connection-row" role="group" aria-label={t("status.dataSource")}>
            <span className={`status-pulse ${connection}`} aria-hidden="true" />
            <span>{dataMode === "demo" ? t("demo.bannerTitle") : pollingFallback ? t("status.polling") : t(`status.${connection}`)}</span>
            {lastUpdated && <time dateTime={lastUpdated}>{freshnessLabel && <span>{freshnessLabel} · </span>}{t("status.updated", { time: formatInTimeZone(lastUpdated, locale, activeTimeZone, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })}</time>}
          </div>
        </div>
      </nav>
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
        className={`app-main-column${sensorDiscoveryNotice && !menuOpen ? " has-sensor-found-toast" : ""}`}
        aria-hidden={mainIsolated ? true : undefined}
        {...(mainIsolated ? { inert: "" } : {})}
      >
        <a className="skip-link" href="#main-content">{t("header.skipToContent")}</a>
        {dataMode !== "demo" && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{t("connectionBanner.announcement", { status: t(`status.${connection}`) })}</p>}
        {dataMode === "demo" && <div className="demo-banner" role="status" aria-atomic="true"><strong>{t("demo.bannerTitle")}</strong><span>{t("demo.bannerBody")}</span></div>}
        {pollingFallback && dataMode !== "demo" && <div className="connection-banner reconnecting" role="status">
          <span className="status-pulse reconnecting" aria-hidden="true" />
          <span><strong>{t("connectionBanner.pollingTitle")}</strong><small>{t("connectionBanner.pollingBody")}</small></span>
        </div>}
        {resourceErrors.length > 0 && <div className="connection-banner offline" role="alert">
          <span className="status-pulse offline" aria-hidden="true" />
          <span><strong>{t("resourceError.title")}</strong><small>{resourceErrors.join(" ")}</small></span>
        </div>}
        {showConnectionException && <div className={`connection-banner ${connection}`} role="region" aria-label={t("status.dataSource")}>
          <span className={`status-pulse ${connection}`} aria-hidden="true" />
          <span><strong>{t(connection === "reconnecting" ? "connectionBanner.reconnectingTitle" : "connectionBanner.offlineTitle")}</strong><small>{t(lastUpdated ? "connectionBanner.retainedBody" : "connectionBanner.noDataBody")}</small></span>
          {onRetryConnection && <button type="button" className="secondary-button" onClick={onRetryConnection}><RotateCcw size={15} aria-hidden="true" />{t("connectionBanner.retry")}</button>}
        </div>}
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
          {page === "overview" || page === "properties" || (page === "twin" && houses.length <= 1)
            ? <span className="mobile-header-spacer" aria-hidden="true" />
            : <button className="icon-button" type="button" onClick={() => onBack ? onBack() : choosePage({ id: "overview", label: t("nav.overview"), scope: "workspace" })} aria-label={onBackLabel ?? t("header.overview")}><ChevronLeft size={20} /></button>}
        </header>
        <main id="main-content" className={`main-content page-${page}`} tabIndex={-1}>
          {properties.length > 0 && onProperty && page !== "overview" && page !== "alerts" && page !== "developer"
            && !(page === "properties" && /^\/properties\/?$/.test(window.location.pathname)) && (
            <div className="page-home-switcher">
              <div className="page-home-switcher-group">
                <MapPinned size={16} aria-hidden="true" />
                <label>
                  <span>{t("properties.activeProperty")}</span>
                  <select value={propertyId} onChange={(event) => onProperty(event.target.value)}>
                    {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
                  </select>
                </label>
              </div>
              {onHouse && propertyHouses.length > 0 && (["twin", "activity", "outdoor", "sensors", "analytics", "integrations"].includes(page)
                || (page === "energy" && /\/homes\/[^/]+\/electricity\/?$/.test(window.location.pathname))) && (
                <div className="page-home-switcher-group">
                  <House size={16} aria-hidden="true" />
                  <label>
                    <span>{t("header.activeHome")}</span>
                    <select value={houseId} onChange={(event) => onHouse(event.target.value)}>
                      {propertyHouses.map((house) => <option key={house.id} value={house.id}>{house.name}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
          )}
          {children}
        </main>
        {sensorDiscoveryNotice && !menuOpen && <section className="sensor-found-toast" role="status" aria-live="polite" aria-atomic="true">
          <span className="sensor-found-toast-icon" aria-hidden="true"><RadioTower size={21} /></span>
          <span className="sensor-found-toast-copy">
            <strong>{t(sensorDiscoveryNotice.additionalCount > 0 ? "sensors.foundNoticeTitleMany" : "sensors.foundNoticeTitle", {
              count: sensorDiscoveryNotice.additionalCount + 1,
            })}</strong>
            <small>{t(sensorDiscoveryNotice.additionalCount > 0 ? "sensors.foundNoticeBodyMany" : "sensors.foundNoticeBody", {
              name: sensorDiscoveryNotice.name,
              model: sensorDiscoveryNotice.model,
              count: sensorDiscoveryNotice.additionalCount,
            })}</small>
          </span>
          {onAddDiscoveredSensor && <button type="button" className="primary-button" onClick={onAddDiscoveredSensor}><House size={16} aria-hidden="true" />{t("sensors.foundNoticeAdd")}</button>}
          {onDismissDiscoveredSensors && <button type="button" className="icon-button" onClick={onDismissDiscoveredSensors} aria-label={t("sensors.foundNoticeDismiss")}><X size={18} aria-hidden="true" /></button>}
        </section>}
      </div>
    </div>
  );
}
