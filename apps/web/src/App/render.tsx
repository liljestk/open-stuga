import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { hasLocalHouseAuthority, type Floor, type Metric, type TpLinkDiscoveredDevice, type UnitSystem } from "@climate-twin/contracts";
import { AlertTriangle, HousePlus, LoaderCircle, RotateCcw, ShieldCheck, Wrench } from "lucide-react";
import { AppShell } from "../components/AppShell";
import { preferredHouseForProperty, type AppPage, type ViewMode } from "../domain";
import { useClimateData } from "../useClimateData";
import { countActionableAlertGroups } from "../alertGrouping";
import { useI18n } from "../i18n";
import { enabledDefinitions } from "../measurements";
import { api, type CreateHouseInput } from "../api";
import { locationForPropertySection, locationForRoute, routeFromLocation } from "../routing";
import { StuguMark } from "../components/StuguMark";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { readLocalStorage, writeLocalStorage } from "../browserStorage";
import {
  clearInvitationBootstrapStorage,
  clearInvitationFragment,
  invitationTokenFromBootstrapStorage,
  invitationTokenFromFragment,
  LocalAuthPage,
} from "../pages/LocalAuthPage";
import { integrationForHouse } from "../integrationScope";
import { isTpLinkContactDevice } from "../tpLinkDeviceClassification";
import { twinDashboardHomeViewLocation } from "../pages/TwinDashboard/queryState";
import { ActivityPage, AlertsPage, DataAnalyticsPage, DeveloperPage, EnergyPage, IntegrationsPage, MaintenancePage, OutdoorWeatherPage, PeopleAccessPage, PortfolioOverview, PropertyManagementPage, SensorManagementPage, StugubyPage, SystemUpdatesPage, TwinDashboard, dismissedTpLinkDevicesKey, firstFloor, freshTpLinkDiscoveryWindowMs, latestIso, pageTitleKeys, settleInBackground, storedDismissedTpLinkDevices, tpLinkDeviceKey } from "./support";
import type { TpLinkDeviceReference } from "./support";
import { useAppPart03 } from "./part-03";
import { hasBrowserCapability } from "../accessPolicy";
export function renderApp(context: ReturnType<typeof useAppPart03>) {
  const { t, climate, state, workspaceReadOnly, canManagePeople, loadSeriesInBackground, initialRoute, initialHouse, initialPropertyId, initialSelectedHouse, page, setPage, routeLoading, routeNotFound, setRouteNotFound, setRouteRevision, propertyId, setPropertyId, houseId, setHouseId, floorId, setFloorId, metric, setMetric, viewMode, setViewMode, selectedSensorId, setSelectedSensorId, units, setUnitsState, firstHomeName, setFirstHomeName, firstPropertyName, setFirstPropertyName, firstHomePropertyId, setFirstHomePropertyId, bootstrapAction, setBootstrapAction, maintenanceObservationId, setMaintenanceObservationId, requestedSensorDevice, setRequestedSensorDevice, dismissedTpLinkDeviceIds, setDismissedTpLinkDeviceIds, invitationToken, setInvitationToken, logoutUncertain, setLogoutUncertain, previousPage, logout, property, propertyReadOnly, propertyElectricityAvailable, propertyHouses, selectedPropertyHouse, house, activeSharedHouse, houseReadOnly, houseLocalAuthority, locationRoute, readOnly, routeHouse, routeScopeInvalid, effectiveRouteNotFound, floor, measurementDefinitions, availableMeasurements, lastUpdated, openAlertCount, scopedIntegration, availableTpLinkDevices, currentTpLinkDevices, undisclosedTpLinkDevices, discoveredSensorNotice, applyHouse, setUnits, dismissTpLinkDeviceNotices, navigate, chooseHouse, chooseProperty, createHouse, deleteHouse, createFirstHome, repairHome, renderFirstHomeCard, renderNoAccessCard } = context;
  const localAuthorityHouses = propertyHouses.filter(hasLocalHouseAuthority);
  const canUseDeveloperTools = hasBrowserCapability(state.session?.tenant.role ?? "guest", "developer-tools");
  if (climate.loading || climate.bootstrapStatus === "loading") {
      return <output className="loading-screen"><span className="loading-logo" aria-hidden="true" /><strong>{t("app.name")}</strong><span>{t("common.loading")}</span></output>;
    }
  if (climate.bootstrapStatus === "setup-required") {
      return <LocalAuthPage mode="setup" onAuthenticated={climate.retryBootstrap} onAuthStateChanged={climate.retryBootstrap} />;
    }
  if (climate.bootstrapStatus === "login-required") {
      return <LocalAuthPage
        mode={invitationToken ? "invitation" : "login"}
        invitationToken={invitationToken}
        noticeKey={logoutUncertain ? "auth.logoutUncertain" : null}
        onAuthStateChanged={climate.retryBootstrap}
        onAuthenticated={() => {
          setLogoutUncertain(false);
          setInvitationToken(null);
          climate.retryBootstrap();
        }}
        onCancelInvitation={() => setInvitationToken(null)}
      />;
    }
  if (climate.bootstrapStatus === "incompatible") {
      return <main className="bootstrap-screen"><section className="bootstrap-card" aria-labelledby="bootstrap-incompatible-title"><StuguMark /><span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span><div><span className="eyebrow">{t("bootstrap.incompatibleEyebrow")}</span><h1 id="bootstrap-incompatible-title">{t("bootstrap.incompatibleTitle")}</h1><p>{t("bootstrap.incompatibleBody")}</p></div><button type="button" className="primary-button" onClick={() => window.location.reload()}><RotateCcw size={16} aria-hidden="true" />{t("bootstrap.reload")}</button>{climate.bootstrapError && <details><summary>{t("bootstrap.technicalDetails")}</summary><code>{climate.bootstrapError}</code></details>}</section></main>;
    }
  if (climate.bootstrapStatus === "unavailable") {
      return <main className="bootstrap-screen"><section className="bootstrap-card" aria-labelledby="bootstrap-unavailable-title"><StuguMark /><span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span><div><span className="eyebrow">{t("bootstrap.connectionEyebrow")}</span><h1 id="bootstrap-unavailable-title">{t("bootstrap.unavailableTitle")}</h1><p>{t("bootstrap.unavailableBody")}</p></div><button type="button" className="primary-button" onClick={climate.retryBootstrap}><RotateCcw size={16} aria-hidden="true" />{t("bootstrap.retry")}</button>{climate.bootstrapError && <details><summary>{t("bootstrap.technicalDetails")}</summary><code>{climate.bootstrapError}</code></details>}</section></main>;
    }
  if (climate.bootstrapStatus === "empty") return <main className="bootstrap-screen">{renderFirstHomeCard()}</main>;
  if (effectiveRouteNotFound) {
      return <AppShell
        page={page}
        canManagePeople={canManagePeople}
        canUseDeveloperTools={canUseDeveloperTools}
        onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
        connection={climate.connection}
        units={units}
        onUnits={setUnits}
        lastUpdated={null}
        dataMode={climate.dataMode}
        pollingFallback={climate.pollingFallback}
        resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
        openAlertCount={openAlertCount}
        properties={state.properties}
        propertyId={propertyId}
        onProperty={chooseProperty}
        houses={state.houses}
        readOnly={readOnly}
        propertyElectricityAvailable={propertyElectricityAvailable}
        principalEmail={state.session?.principal.email ?? null}
        onLogout={logout}
        onRetryConnection={climate.retryBootstrap}
      >
        <section className="route-recovery" aria-labelledby="route-recovery-title">
          <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
          <div><span className="eyebrow">{t("route.notFoundEyebrow")}</span><h1 id="route-recovery-title">{t("route.notFoundTitle")}</h1><p>{t("route.notFoundBody")}</p></div>
          <button type="button" className="primary-button" onClick={() => navigate("overview", null, true, window.location.pathname, null)}>{t("route.openOverview")}</button>
        </section>
      </AppShell>;
    }
  if (page === "overview" || page === "people" || page === "stugubys" || page === "alerts" || page === "developer" || page === "updates") {
      return <AppShell
        page={page}
        onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
        connection={climate.connection}
        units={units}
        onUnits={setUnits}
        lastUpdated={null}
        dataMode={climate.dataMode}
        pollingFallback={climate.pollingFallback}
        resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
        openAlertCount={openAlertCount}
        canManagePeople={canManagePeople}
        canUseDeveloperTools={canUseDeveloperTools}
        properties={state.properties}
        propertyId={propertyId}
        onProperty={chooseProperty}
        houses={state.houses}
        readOnly={readOnly}
        propertyElectricityAvailable={propertyElectricityAvailable}
        principalEmail={state.session?.principal.email ?? null}
        onLogout={logout}
        onRetryConnection={climate.retryBootstrap}
      >
        {routeNotFound ? (
          <section className="route-recovery" aria-labelledby="route-recovery-title">
            <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
            <div><span className="eyebrow">{t("route.notFoundEyebrow")}</span><h1 id="route-recovery-title">{t("route.notFoundTitle")}</h1><p>{t("route.notFoundBody")}</p></div>
            <button type="button" className="primary-button" onClick={() => navigate("overview", null, true, window.location.pathname, null)}>{t("route.openOverview")}</button>
          </section>
        ) : <RouteErrorBoundary
          resetKey={`${page}:workspace`}
          onReload={() => window.location.reload()}
          renderFallback={(reload) => (
            <section className="route-recovery" aria-labelledby="route-load-failed-title">
              <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
              <div><span className="eyebrow">{t("route.loadFailedEyebrow")}</span><h1 id="route-load-failed-title">{t("route.loadFailedTitle")}</h1><p>{t("route.loadFailedBody")}</p></div>
              <button type="button" className="primary-button" onClick={reload}><RotateCcw size={16} aria-hidden="true" />{t("route.reload")}</button>
            </section>
          )}
        ><Suspense fallback={routeLoading}><>
          {page === "overview" && <PortfolioOverview
            properties={state.properties}
            propertyAreas={state.propertyAreas}
            houses={state.houses}
            sensors={state.sensors}
            latestMeasurements={state.latestMeasurements}
            measurementHistory={state.measurementHistory}
            measurementDefinitions={state.measurementDefinitions}
            alerts={state.alerts}
            alertRules={state.alertRules}
            integration={state.integration}
            units={units}
            dataMode={climate.dataMode}
            onOpenProperty={(id) => {
              const targetProperty = state.properties.find((candidate) => candidate.id === id);
              const defaultPropertyHouse = preferredHouseForProperty(targetProperty, state.houses);
              if (defaultPropertyHouse) applyHouse(defaultPropertyHouse.id);
              else {
                setPropertyId(id);
                setHouseId("");
              }
              navigate("properties", defaultPropertyHouse?.id ?? null, false, window.location.pathname, id);
            }}
            onOpenTwin={(id) => { applyHouse(id); navigate("twin", id); }}
            onOpenOutdoor={(id) => { applyHouse(id); navigate("outdoor", id); }}
            onOpenSetup={(id) => { applyHouse(id); navigate("integrations", id); }}
            onOpenAlerts={() => navigate("alerts", null, false, window.location.pathname, null)}
            readOnly={readOnly}
          />}
          {page === "alerts" && <AlertsPage
            state={state}
            units={units}
            dataMode={climate.dataMode}
            onCreateRule={climate.createRule}
            onUpdateRule={climate.updateRule}
            onAcknowledge={climate.acknowledgeAlert}
            onIntegrationChange={climate.applyIntegrationStatus}
            readOnly={readOnly}
            canManageSystem={canManagePeople}
            onOpenSystem={() => navigate("updates", null, false, window.location.pathname, null)}
            onInspectAlert={(alert) => {
              const sensor = state.sensors.find((candidate) => candidate.id === alert.sensorId);
              if (!sensor) return;
              applyHouse(sensor.houseId);
              setFloorId(sensor.floorId);
              setSelectedSensorId(sensor.id);
              navigate("twin", sensor.houseId);
            }}
          />}
          {page === "people" && <PeopleAccessPage state={state} />}
          {page === "stugubys" && (canManagePeople
            ? <StugubyPage houses={state.houses} properties={state.properties} onInventoryChange={climate.retryBootstrap} />
            : <section className="route-recovery" aria-labelledby="stuguby-access-title"><ShieldCheck size={24} aria-hidden="true" /><div><span className="eyebrow">{t("properties.guestReadOnly")}</span><h1 id="stuguby-access-title">{t("properties.adminOnlyTitle")}</h1><p>{t("properties.adminOnlyBody")}</p></div><button type="button" className="primary-button" onClick={() => navigate("overview", null, true, window.location.pathname, null)}>{t("route.openOverview")}</button></section>)}
          {page === "developer" && (canUseDeveloperTools
            ? <DeveloperPage canManageSystem={canManagePeople} />
            : <section className="route-recovery" aria-labelledby="developer-access-title"><ShieldCheck size={24} aria-hidden="true" /><div><span className="eyebrow">{t("properties.guestReadOnly")}</span><h1 id="developer-access-title">{t("developer.accessDeniedTitle")}</h1><p>{t("developer.accessDeniedBody")}</p></div><button type="button" className="primary-button" onClick={() => navigate("overview", null, true, window.location.pathname, null)}>{t("route.openOverview")}</button></section>)}
          {page === "updates" && (canManagePeople
            ? <SystemUpdatesPage />
            : <section className="route-recovery" aria-labelledby="updates-access-title"><ShieldCheck size={24} aria-hidden="true" /><div><span className="eyebrow">{t("properties.guestReadOnly")}</span><h1 id="updates-access-title">{t("properties.adminOnlyTitle")}</h1><p>{t("properties.adminOnlyBody")}</p></div><button type="button" className="primary-button" onClick={() => navigate("overview", null, true, window.location.pathname, null)}>{t("route.openOverview")}</button></section>)}
        </></Suspense></RouteErrorBoundary>}
      </AppShell>;
    }
  if (page === "maintenance" && property) {
      return <AppShell
        page="maintenance"
        canManagePeople={canManagePeople}
        canUseDeveloperTools={canUseDeveloperTools}
        onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
        connection={climate.connection}
        units={units}
        onUnits={setUnits}
        lastUpdated={null}
        dataMode={climate.dataMode}
        pollingFallback={climate.pollingFallback}
        resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
        openAlertCount={openAlertCount}
        properties={state.properties}
        propertyId={property.id}
        onProperty={chooseProperty}
        houses={state.houses}
        houseId={selectedPropertyHouse?.id ?? ""}
        onHouse={chooseHouse}
        onBack={() => navigate("properties", null, true, window.location.pathname, property.id)}
        onBackLabel={t("header.backToProperty")}
        readOnly={readOnly}
        propertyElectricityAvailable={propertyElectricityAvailable}
        principalEmail={state.session?.principal.email ?? null}
        onLogout={logout}
        onRetryConnection={climate.retryBootstrap}
      ><Suspense fallback={routeLoading}><MaintenancePage
        state={state}
        propertyId={property.id}
        {...(locationRoute.houseId && selectedPropertyHouse ? { house: selectedPropertyHouse } : {})}
        houses={propertyHouses}
        initialObservationId={maintenanceObservationId}
        onSeedConsumed={() => setMaintenanceObservationId(null)}
        onCreateTask={climate.createMaintenanceTask}
        onUpdateTask={climate.updateMaintenanceTask}
        onReloadTask={climate.reloadMaintenanceTask}
        onLoadTaskRevisions={climate.maintenanceTaskRevisions}
        areas={state.propertyAreas.filter((area) => area.propertyId === property.id)}
        equipment={state.areaEquipment.filter((item) => item.propertyId === property.id)}
        readOnly={readOnly}
      /></Suspense></AppShell>;
    }
  if (page === "energy" && property) {
      const contextualHouse = locationRoute.houseId ? house ?? null : null;
      const propertyEnergyDenied = !contextualHouse && !propertyElectricityAvailable;
      return <AppShell
        page="energy"
        canManagePeople={canManagePeople}
        canUseDeveloperTools={canUseDeveloperTools}
        onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
        connection={climate.connection}
        units={units}
        onUnits={setUnits}
        lastUpdated={contextualHouse ? lastUpdated : null}
        dataMode={climate.dataMode}
        pollingFallback={climate.pollingFallback}
        resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
        openAlertCount={openAlertCount}
        properties={state.properties}
        propertyId={property.id}
        onProperty={chooseProperty}
        houses={state.houses}
        houseId={selectedPropertyHouse?.id ?? ""}
        onHouse={chooseHouse}
        onBack={() => contextualHouse
          ? navigate("twin", contextualHouse.id, true)
          : navigate("properties", null, true, window.location.pathname, property.id)}
        onBackLabel={t(contextualHouse ? "header.backToHome" : "header.backToProperty")}
        readOnly={readOnly}
        propertyElectricityAvailable={propertyElectricityAvailable}
        principalEmail={state.session?.principal.email ?? null}
        onLogout={logout}
        onRetryConnection={climate.retryBootstrap}
      >{propertyEnergyDenied ? <section className="route-recovery" aria-labelledby="property-electricity-access-title">
        <ShieldCheck size={24} aria-hidden="true" />
        <div><span className="eyebrow">{t("properties.guestReadOnly")}</span><h1 id="property-electricity-access-title">{t("properties.adminOnlyTitle")}</h1><p>{t("properties.adminOnlyBody")}</p></div>
        <button type="button" className="primary-button" onClick={() => navigate("properties", null, true, window.location.pathname, property.id)}>{t("bootstrap.propertyForHome")}</button>
      </section> : <Suspense fallback={routeLoading}><EnergyPage
        state={state}
        house={contextualHouse}
        propertyId={property.id}
        units={units}
        onLoadSeries={loadSeriesInBackground}
        seriesStates={climate.seriesStates ?? {}}
        {...(contextualHouse && !readOnly && houseLocalAuthority ? { onOpenSensors: () => navigate("sensors", contextualHouse.id) } : {})}
        onOpenAlerts={() => navigate("alerts", null, false, window.location.pathname, null)}
        readOnly={readOnly}
        localAuthority={houseLocalAuthority}
      /></Suspense>}</AppShell>;
    }
  if (page === "properties" || (readOnly && (!house || !floor))) {
      const propertyIndex = page === "properties" && !locationRoute.propertyId;
      return <AppShell
        page="properties"
        canManagePeople={canManagePeople}
        canUseDeveloperTools={canUseDeveloperTools}
        onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
        connection={climate.connection}
        units={units}
        onUnits={setUnits}
        lastUpdated={null}
        dataMode={climate.dataMode}
        pollingFallback={climate.pollingFallback}
        resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
        properties={state.properties}
        propertyId={propertyIndex ? "" : propertyId}
        onProperty={chooseProperty}
        houses={state.houses}
        houseId={propertyIndex ? "" : selectedPropertyHouse?.id ?? ""}
        onHouse={chooseHouse}
        homeAvailable={!readOnly || Boolean(house && floor)}
        readOnly={readOnly}
        propertyElectricityAvailable={propertyElectricityAvailable}
        principalEmail={state.session?.principal.email ?? null}
        onLogout={logout}
        onRetryConnection={climate.retryBootstrap}
      ><Suspense fallback={routeLoading}><PropertyManagementPage
        state={state}
        dataMode={climate.dataMode}
        initialTab={locationRoute.propertySection ?? "overview"}
        onTab={(section) => {
          if (!propertyId) return;
          const url = locationForPropertySection(propertyId, section);
          if (`${window.location.pathname}${window.location.search}` === url) return;
          window.history.pushState({ page: "properties", propertyId, houseId: null, propertySection: section }, "", url);
          setRouteRevision((current) => current + 1);
        }}
        indexMode={propertyIndex}
        propertyId={propertyIndex ? undefined : propertyId}
        onProperty={chooseProperty}
        onCreateProperty={climate.createProperty}
        onUpdateProperty={climate.updateProperty}
        onDeleteProperty={climate.deleteProperty}
        onCreateHouse={climate.createHouse}
        onUpdateHouse={climate.updateHouse}
        onOpenHouse={(id) => { applyHouse(id); navigate("twin", id); }}
        onCreateArea={climate.createPropertyArea}
        onUpdateArea={climate.updatePropertyArea}
        onDeleteArea={climate.deletePropertyArea}
        onCreateEquipment={climate.createAreaEquipment}
        onUpdateEquipment={climate.updateAreaEquipment}
        onDeleteEquipment={climate.deleteAreaEquipment}
        onCreateNote={climate.createPropertyNote}
        onUpdateNote={climate.updatePropertyNote}
        onDeleteNote={climate.deletePropertyNote}
        onCreateMaintenanceTask={climate.createMaintenanceTask}
        onOpenMaintenance={() => navigate("maintenance", houseId || null, false, window.location.pathname, propertyId)}
        onSetHouseGeoreference={climate.setHouseGeoreference}
      /></Suspense></AppShell>;
    }
  if (!house && state.properties.length > 0 && page === "twin") {
      return <AppShell
        page="twin"
        canManagePeople={canManagePeople}
        canUseDeveloperTools={canUseDeveloperTools}
        onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
        connection={climate.connection}
        units={units}
        onUnits={setUnits}
        lastUpdated={null}
        dataMode={climate.dataMode}
        pollingFallback={climate.pollingFallback}
        resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
        properties={state.properties}
        propertyId={propertyId}
        onProperty={chooseProperty}
        houses={state.houses}
        readOnly={readOnly}
        propertyElectricityAvailable={propertyElectricityAvailable}
        principalEmail={state.session?.principal.email ?? null}
        onLogout={logout}
        onRetryConnection={climate.retryBootstrap}
      ><div className="home-empty-state">{readOnly ? renderNoAccessCard() : renderFirstHomeCard()}</div></AppShell>;
    }
  if (!house) {
      return <main className="bootstrap-screen">{readOnly ? renderNoAccessCard() : <section className="bootstrap-card"><AlertTriangle size={24} aria-hidden="true" /><h1>{t("bootstrap.inventoryUnavailable")}</h1><button type="button" className="primary-button" onClick={climate.retryBootstrap}><RotateCcw size={16} aria-hidden="true" />{t("bootstrap.retry")}</button></section>}</main>;
    }
  if (!floor) {
      return <main className="bootstrap-screen"><section className="bootstrap-card" aria-labelledby="bootstrap-floor-title"><StuguMark /><span className="bootstrap-icon exception" aria-hidden="true"><Wrench size={22} /></span><div><span className="eyebrow">{house.name}</span><h1 id="bootstrap-floor-title">{t("bootstrap.floorMissingTitle")}</h1><p>{t("bootstrap.floorMissingBody")}</p></div><button type="button" className="primary-button" disabled={bootstrapAction === "saving"} onClick={() => void repairHome()}>{bootstrapAction === "saving" ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Wrench size={16} aria-hidden="true" />}{t("bootstrap.addGroundFloor")}</button>{bootstrapAction === "error" && <p className="inline-error" role="alert">{t("bootstrap.repairFailed")}</p>}</section></main>;
    }
  const pageLastUpdated = page === "activity"
      ? latestIso([
        ...state.observations.filter((item) => item.houseId === house.id).map((item) => item.updatedAt),
        ...state.maintenanceTasks.filter((item) => item.houseId === house.id).map((item) => item.updatedAt),
        ...state.alerts.filter((item) => state.sensors.some((sensor) => sensor.houseId === house.id && sensor.id === item.sensorId)).flatMap((item) => [item.startedAt, item.acknowledgedAt, item.resolvedAt]),
      ])
      : page === "integrations"
        ? latestIso([state.integration.homeAssistant.lastEventAt, state.integration.tpLink.lastPollAt, state.integration.weather.lastSuccessAt])
        : page === "outdoor" ? null : lastUpdated;
  const freshnessLabel = page === "activity" ? t("nav.activity")
      : page === "integrations" ? t("nav.integrations")
        : page === "sensors" ? t("nav.sensors")
          : page === "analytics" ? t("nav.analytics")
          : page === "energy" ? t("nav.energyUse")
            : page === "twin" ? t("nav.twin") : undefined;
  Object.assign(context, { pageLastUpdated, freshnessLabel });
  return (
      <AppShell
        page={page}
        canManagePeople={canManagePeople}
        canUseDeveloperTools={canUseDeveloperTools}
        onPage={(next, scope) => navigate(next, scope?.houseId, false, window.location.pathname, scope?.propertyId)}
        connection={climate.connection}
        units={units}
        onUnits={setUnits}
        lastUpdated={pageLastUpdated}
        freshnessLabel={freshnessLabel}
        dataMode={climate.dataMode}
        pollingFallback={climate.pollingFallback}
        resourceErrors={[...new Set(Object.values(climate.resourceErrors ?? {}))]}
        openAlertCount={openAlertCount}
        readOnly={readOnly}
        propertyElectricityAvailable={propertyElectricityAvailable}
        principalEmail={state.session?.principal.email ?? null}
        onLogout={logout}
        properties={state.properties}
        propertyId={propertyId}
        onProperty={chooseProperty}
        houses={state.houses}
        houseId={selectedPropertyHouse?.id ?? house.id}
        onHouse={chooseHouse}
        onBack={() => page === "twin"
          ? navigate("properties", null, true, window.location.pathname, propertyId)
          : navigate("twin", house.id, true)}
        onBackLabel={t(page === "twin" ? "header.backToProperty" : "header.backToHome")}
        onRetryConnection={climate.retryBootstrap}
        integrationDiscoveryNotice={!readOnly ? context.discoveredIntegrationNotice : undefined}
        onReviewIntegrationDiscovery={context.discoveredIntegrationNotice ? () => {
          context.dismissIntegrationDiscoveryNotice(context.discoveredIntegrationNotice!.jobId);
          navigate("integrations", context.discoveredIntegrationNotice!.houseId, false, "/setup/connections");
        } : undefined}
        onDismissIntegrationDiscovery={context.discoveredIntegrationNotice
          ? () => context.dismissIntegrationDiscoveryNotice(context.discoveredIntegrationNotice!.jobId)
          : undefined}
        sensorDiscoveryNotice={!readOnly && discoveredSensorNotice ? {
          name: discoveredSensorNotice.alias?.trim() || t("sensors.unnamedDevice"),
          model: discoveredSensorNotice.model,
          kind: isTpLinkContactDevice(discoveredSensorNotice) ? "contact" : "sensor",
          additionalCount: undisclosedTpLinkDevices.filter((device) => (
            isTpLinkContactDevice(device) === isTpLinkContactDevice(discoveredSensorNotice)
          )).length - 1,
        } : undefined}
        onAddDiscoveredSensor={discoveredSensorNotice ? () => {
          dismissTpLinkDeviceNotices([discoveredSensorNotice]);
          setRequestedSensorDevice({
            deviceId: discoveredSensorNotice.deviceId,
            connectionId: discoveredSensorNotice.connectionId ?? null,
          });
          navigate("sensors", house.id);
        } : undefined}
        onDismissDiscoveredSensors={undisclosedTpLinkDevices.length > 0
          ? () => dismissTpLinkDeviceNotices(undisclosedTpLinkDevices)
          : undefined}
      >
        {routeNotFound ? (
          <section className="route-recovery" aria-labelledby="route-recovery-title">
            <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
            <div><span className="eyebrow">{t("route.notFoundEyebrow")}</span><h1 id="route-recovery-title">{t("route.notFoundTitle")}</h1><p>{t("route.notFoundBody")}</p></div>
            <button type="button" className="primary-button" onClick={() => navigate("overview", house.id, true)}>{t("route.openOverview")}</button>
          </section>
        ) : <RouteErrorBoundary
          resetKey={`${page}:${house.id}`}
          onReload={() => window.location.reload()}
          renderFallback={(reload) => (
            <section className="route-recovery" aria-labelledby="route-load-failed-title">
              <span className="bootstrap-icon exception" aria-hidden="true"><AlertTriangle size={22} /></span>
              <div><span className="eyebrow">{t("route.loadFailedEyebrow")}</span><h1 id="route-load-failed-title">{t("route.loadFailedTitle")}</h1><p>{t("route.loadFailedBody")}</p></div>
              <button type="button" className="primary-button" onClick={reload}><RotateCcw size={16} aria-hidden="true" />{t("route.reload")}</button>
            </section>
          )}
        ><Suspense fallback={routeLoading}><>
        {page === "twin" && (
          <TwinDashboard
            state={{ ...state, houses: propertyHouses }} house={house} floor={floor} houseId={house.id} floorId={floor.id} metric={metric} units={units} viewMode={viewMode}
            selectedSensorId={selectedSensorId} saveState={climate.saveState} scenario={climate.scenario} connection={climate.connection} dataMode={climate.dataMode}
            onHouse={chooseHouse} onFloor={setFloorId} onMetric={setMetric} onViewMode={setViewMode} onSensorSelect={setSelectedSensorId}
            onSensorMove={climate.moveSensor} onSensorUpdate={climate.updateSensor} onFloorChange={(next) => climate.updateFloor(house.id, next)}
            onHouseChange={(next) => climate.updateHouseDraft(next.id, { name: next.name, timezone: next.timezone, floors: next.floors })}
            onHouseCreate={createHouse} onHouseDelete={deleteHouse}
            onSaveLayout={(next) => climate.saveLayout(next.id, next)} onLoadSeries={loadSeriesInBackground} onLoadReplaySeries={climate.loadHistoricalSeries}
            onRunScenario={(next) => settleInBackground(climate.runScenario(next))} onCreateObservation={climate.createObservation}
            onUpdateObservation={climate.updateObservation}
            onReloadObservation={climate.reloadObservation}
            onLoadObservationRevisions={climate.observationRevisions}
            onCreateStaticParameter={climate.createStaticParameter}
            onOpenSensors={(id) => { applyHouse(id); navigate("sensors", id); }}
            onOpenConnections={(id) => { applyHouse(id); navigate("integrations", id, false, "/setup/connections"); }}
            onOpenActivity={() => navigate("activity", house.id)}
            onOpenMaintenance={() => navigate("maintenance", house.id)}
            onOpenEnergy={() => navigate("energy", house.id)}
            onOpenOutdoor={() => navigate("outdoor", house.id)}
            onAcknowledgeAlert={climate.acknowledgeAlert}
            onOpenAnalytics={() => navigate("analytics", house.id)}
            readOnly={readOnly}
            canManageConnectedDevices={canManagePeople}
            localAuthority={houseLocalAuthority}
          />
        )}
        {page === "activity" && <ActivityPage
          state={state}
          house={house}
          onCreateObservation={climate.createObservation}
          onUpdateObservation={climate.updateObservation}
          onReloadObservation={climate.reloadObservation}
          onLoadObservationRevisions={climate.observationRevisions}
          onOpenFloor={(targetFloorId) => { setFloorId(targetFloorId); setViewMode("plan"); navigate("twin", house.id); }}
          onPlanMaintenance={(observation) => { setMaintenanceObservationId(observation.id); navigate("maintenance", house.id); }}
          readOnly={readOnly}
        />}
        {page === "outdoor" && (
          <OutdoorWeatherPage
            house={house}
            units={units}
            {...(!readOnly && houseLocalAuthority
              ? { onConfigureLocation: () => navigate("integrations", house.id, false, "/setup/weather") }
              : {})}
          />
        )}
        {page === "sensors" && (
          <SensorManagementPage
            state={state}
            house={house}
            houses={houseLocalAuthority ? localAuthorityHouses : [house]}
            integration={state.integration}
            tpLinkDevices={climate.tpLinkDevices}
            tpLinkDevicesLoading={climate.tpLinkDevicesLoading}
            tpLinkDevicesError={climate.tpLinkDevicesError}
            requestedDevice={requestedSensorDevice}
            readOnly={readOnly}
            localAuthority={houseLocalAuthority}
            canManageIntegrations={canManagePeople}
            units={units}
            onLoadSeries={loadSeriesInBackground}
            onRequestedDeviceHandled={() => setRequestedSensorDevice(null)}
            onHouse={chooseHouse}
            onUpdateHouse={climate.updateHouse}
            onRefreshDevices={async () => { await climate.refreshTpLinkDevices(house.id); }}
            onCreateSensor={climate.createSensor}
            onUpdateSensor={climate.updateSensor}
            onDeleteSensor={climate.deleteSensor}
            onImportHistoricalData={(samples, onProgress) => climate.importHistoricalMeasurements(house.id, samples, onProgress)}
          />
        )}
        {page === "analytics" && (
          <DataAnalyticsPage
            key={house.id}
            state={state}
            house={house}
            units={units}
            dataMode={climate.dataMode}
            readOnly={readOnly}
            onLoadSeries={loadSeriesInBackground}
          />
        )}
        {page === "integrations" && !readOnly && houseLocalAuthority && (
          <IntegrationsPage
            integration={state.integration}
            house={house}
            houses={localAuthorityHouses}
            connectionHouses={localAuthorityHouses}
            units={units}
            streamConnection={climate.connection}
            tpLinkDevicesLoading={climate.tpLinkDevicesLoading}
            tpLinkDevicesError={climate.tpLinkDevicesError}
            canManageTuya={canManagePeople}
            onHouse={chooseHouse}
            onHouseUpdate={climate.updateHouse}
            onGeoreferenceChange={climate.setHouseGeoreference}
            onIntegrationChange={climate.applyIntegrationStatus}
            onRefreshTpLinkDevices={climate.refreshTpLinkDevices}
            onDisconnectHomeAssistant={climate.disconnectHomeAssistant}
            onDisconnectTpLink={climate.disconnectTpLink}
            onMoveHomeAssistant={climate.moveHomeAssistant}
            onMoveTpLink={climate.moveTpLink}
            onDiscoveryStarted={context.onIntegrationDiscoveryStarted}
            onOpenSensors={(device) => {
              if (device) setRequestedSensorDevice(device);
              navigate("sensors", house.id);
            }}
            onOpenLayout={() => {
              navigate("twin", house.id);
              window.history.replaceState(
                window.history.state,
                "",
                twinDashboardHomeViewLocation(window.location.href, "edit"),
              );
            }}
          />
        )}
        {page === "integrations" && (readOnly || !houseLocalAuthority) && <section className="route-recovery"><ShieldCheck size={24} aria-hidden="true" /><div><span className="eyebrow">{t(readOnly && workspaceReadOnly ? "properties.guestReadOnly" : "stuguby.eyebrow")}</span><h1>{t(readOnly && workspaceReadOnly ? "properties.adminOnlyTitle" : "stuguby.boundaryTitle")}</h1><p>{t(readOnly && workspaceReadOnly ? "properties.adminOnlyBody" : "stuguby.boundaryBody")}</p></div><button type="button" className="primary-button" onClick={() => navigate("properties", house.id, true)}>{t("nav.properties")}</button></section>}
        </></Suspense></RouteErrorBoundary>}
      </AppShell>
    );
}
