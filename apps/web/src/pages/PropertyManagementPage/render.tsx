import { Suspense } from "react";
import {
  Building2,
  Battery,
  Boxes,
  Camera,
  Check,
  ChevronRight,
  ClipboardList,
  ExternalLink,
  FileText,
  HardHat,
  Link as LinkIcon,
  LoaderCircle,
  Map as MapIcon,
  MapPin,
  Move,
  NotebookPen,
  Plus,
  QrCode,
  Radio,
  Redo2,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Undo2,
  Upload,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import type {
  AreaEquipmentStatus,
  PropertyAreaKind,
  PropertyNote,
} from "@climate-twin/contracts";
import { api } from "../../api";
import { EquipmentQrLabel } from "./EquipmentQrLabel";
import { StugubyMark } from "../../components/StugubyMark";
import { formatInTimeZone } from "../../dateTime";
import { type PropertyTrafficLight } from "./propertyStatus";
import "../PropertyManagementPage.css";
import { AccessPanel, EQUIPMENT_DOCUMENT_ACCEPT, EQUIPMENT_DRAFT_MAP_ID, EQUIPMENT_PHOTO_ACCEPT, MAP_ITEM_BATCH_SIZE, NEW_FIXED_ASSET_ID, PropertyAreaMap, PropertyStatusLights, areaDraft, areaKinds, attachmentSize, isForeignSharedHouse, targetLabel } from "./support";
import type { EquipmentPlacement, InventoryLocationFilter, MapItemFilter } from "./support";
import { usePropertyManagementPagePart07 } from "./part-07";
import { PropertyCarousel } from "./PropertyCarousel";
import { PropertyWeatherSettings } from "./PropertyWeatherSettings";
export function renderPropertyManagementPage(context: ReturnType<typeof usePropertyManagementPagePart07>) {
  const { props, state, locale, t, propertySummary, workspaceReadOnly, canManageAccess, tab, setTab, properties, setPropertyId, property, readOnly, houses, houseReadOnly, mapLoaded, setMapLoaded, areas, fixedAssets, equipment, propertyTrafficLights, notes, selectedAreaId, selectedArea, selectedAreaTasks, isNewArea, isNewFixedAsset, drawing, setDrawing, areaForm, setAreaForm, redoVertices, setRedoVertices, coordinateInput, setCoordinateInput, coordinateError, setCoordinateError, newPropertyName, setNewPropertyName, newHouseName, setNewHouseName, areaDestinationPropertyId, setAreaDestinationPropertyId, equipmentDestination, setEquipmentDestination, editingProperty, setEditingProperty, propertyEditButtonRef, propertyNameInputRef, propertyName, setPropertyName, propertyDescription, setPropertyDescription, pending, feedback, setFeedback, editingEquipmentId, equipmentName, setEquipmentName, equipmentKind, setEquipmentKind, equipmentManufacturer, setEquipmentManufacturer, equipmentModel, setEquipmentModel, equipmentSerialNumber, setEquipmentSerialNumber, equipmentStatus, setEquipmentStatus, equipmentNotes, setEquipmentNotes, equipmentLatitude, setEquipmentLatitude, equipmentLongitude, setEquipmentLongitude, equipmentPinMapOpen, setEquipmentPinMapOpen, inventoryQuery, changeInventoryQuery, inventoryStatus, changeInventoryStatus, inventoryLocation, changeInventoryLocation, structureQuery, changeStructureQuery, mapItemQuery, changeMapItemQuery, mapItemFilter, changeMapItemFilter, setMapItemLimit, mapItemSelection, mapLayers, changeMapLayer, inventoryFormOpen, setInventoryFormOpen, trackedEquipment, trackingSnapshot, trackingConnection, selectedEquipmentId, changeSelectedEquipmentId, equipmentAttachments, equipmentLinks, equipmentResourcesState, equipmentResourcesBusy, setEquipmentResourcesRefresh, equipmentResourcesFeedback, equipmentLinkLabel, setEquipmentLinkLabel, equipmentLinkUrl, setEquipmentLinkUrl, equipmentPhotoInputRef, equipmentDocumentInputRef, selectedEndpointId, setSelectedEndpointId, noteText, setNoteText, noteKind, setNoteKind, noteTarget, setNoteTarget, editingNoteId, setEditingNoteId, noteFormOpen, setNoteFormOpen, maintenanceTitle, setMaintenanceTitle, maintenanceHouseId, setMaintenanceHouseId, maintenanceEquipmentId, setMaintenanceEquipmentId, placementLatitude, setPlacementLatitude, placementLongitude, setPlacementLongitude, placementWidth, setPlacementWidth, placementOrientation, setPlacementOrientation, placementEditing, setPlacementEditing, assetPlacementEditing, setAssetPlacementEditing, assetDraftLocation, setAssetDraftLocation, assetLatitudeInput, setAssetLatitudeInput, assetLongitudeInput, setAssetLongitudeInput, trackingStates, trackingByEquipmentId, trackingEnabled, selectedEquipment, selectedTracking, sharedMembers, availableTrackingEndpoints, equipmentPinEmpty, equipmentPinValid, equipmentPinMapItem, updateEquipmentPinFromMap, equipmentLocationLabel, sidebarHouses, sidebarAreas, matchingMapCatalogItems, visibleMapCatalogItems, remainingMapCatalogItems, inventoryLocationCount, visibleInventory, inventoryAttentionCount, placementAsset, editingFixedAsset, assetCoordinateInputsValid, updateFixedAssetCoordinate, mapAreas, placementHouse, visibleMapHouses, visibleAssetIds, visibleMapEquipment, visibleMapMembers, placementDraftIsValid, tabs, chooseTabFromKeyboard, vertexLabel, midpointLabel, startArea, startFixedAsset, appendVertex, moveVertex, insertVertex, undoVertex, redoVertex, applyCoordinates, saveArea, removeArea, createProperty, saveProperty, setDefaultHouse, createHouse, removeProperty, clearEquipmentDraft, beginEquipmentEdit, saveEquipment, moveHouse, removeEquipment, uploadEquipmentAttachments, removeEquipmentAttachment, addEquipmentLink, removeEquipmentLink, bindEndpoint, unbindEndpoint, showEquipmentOnMap, removeNote, saveNote, planMaintenance, selectMapArea, selectMapEquipment, selectPlacementHouse, updatePlacementFromMap, selectPlacementAsset, updateAssetPlacementFromMap, saveAssetPlacement, removeAssetPlacement, saveHousePlacement, removeHousePlacement, propertyShareLabel, houseShareLabel } = context;
  const statusPriority = { ok: 0, caution: 1, critical: 2 } as const;
  const primaryPropertyStatus = propertyTrafficLights.reduce<PropertyTrafficLight | null>((current, light) => (
    !current || statusPriority[light.level] > statusPriority[current.level] ? light : current
  ), null);
  const overviewHomeRows = houses.map((house) => {
    const shareLabel = houseShareLabel(house);
    const foreignShared = isForeignSharedHouse(house);
    return <article key={house.id} className={foreignShared ? "stuguby-shared" : ""}>{foreignShared ? <StugubyMark className="small" /> : <Building2 size={19} aria-hidden="true" />}<span><strong>{house.name}</strong>{property?.defaultHouseId === house.id && <small className="property-default-home"><Check size={12} aria-hidden="true" />{t("properties.defaultHome")}</small>}{shareLabel && <small className="property-stuguby-label">{shareLabel}</small>}{house.location?.label && <small>{house.location.label}</small>}</span>{props.onOpenHouse && <button type="button" className="primary-button" onClick={() => props.onOpenHouse?.(house.id)}>{t("overview.openHomeNamed", { name: house.name })}<ChevronRight size={15} aria-hidden="true" /></button>}</article>;
  });
  if (properties.length === 0) return <section className="property-empty-page"><MapPin size={28} /><h1>{workspaceReadOnly ? t("properties.noAccessTitle") : t("properties.emptyTitle")}</h1><p>{workspaceReadOnly ? t("properties.noAccessBody") : t("properties.emptyBody")}</p>{!workspaceReadOnly && <form onSubmit={(event) => void createProperty(event)}><label className="field"><span>{t("properties.propertyName")}</span><input autoFocus required value={newPropertyName} onChange={(event) => setNewPropertyName(event.target.value)} /></label><button type="submit" className="primary-button"><Plus size={15} />{t("properties.addProperty")}</button></form>}</section>;
  if (props.indexMode) return <div className="page-stack property-management-page property-index-page">
      <header className="page-heading property-heading"><div><span className="eyebrow"><MapPin size={14} />{t(properties.length === 1 ? "overview.propertyCountOne" : "overview.propertyCountMany", { count: properties.length })}</span><h1>{t("properties.title")}</h1><p>{t("properties.description")}</p></div>{workspaceReadOnly && <span className="read-only-badge"><ShieldCheck size={15} />{t("properties.guestReadOnly")}</span>}</header>
      <PropertyCarousel properties={properties} state={state} onOpenProperty={setPropertyId} propertyShareLabel={propertyShareLabel} />
      {!workspaceReadOnly && <details className="panel property-action-disclosure property-index-create"><summary><Plus size={17} aria-hidden="true" /><span><strong>{t("properties.addAnotherProperty")}</strong><small>{t("properties.description")}</small></span><ChevronRight size={17} aria-hidden="true" /></summary><form className="property-index-create-form" onSubmit={(event) => void createProperty(event)}><label className="field"><span>{t("properties.propertyName")}</span><input value={newPropertyName} onChange={(event) => setNewPropertyName(event.target.value)} /></label><button type="submit" className="primary-button" disabled={pending || !newPropertyName.trim()}><Plus size={14} />{t("properties.addProperty")}</button></form></details>}
      {feedback && <p className={`property-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
    </div>;
  if (!property) return null;
  return <div className="page-stack property-management-page">
      <header className="page-heading property-heading"><div><span className="eyebrow">{property.stuguby ? <StugubyMark className="small" /> : <MapPin size={14} />}{property.stuguby ? propertyShareLabel(property) : t("bootstrap.propertyForHome")}</span><h1>{property.name}</h1><p>{property.description || t("properties.description")}</p></div>{readOnly && <span className="read-only-badge"><ShieldCheck size={15} />{workspaceReadOnly ? t("properties.guestReadOnly") : t("properties.stuguby.readOnly")}</span>}</header>
      <div className="property-layout property-layout-simplified">
        <div className="property-workspace">
          {!props.onProperty && <label className="field property-inline-selector"><span>{t("properties.activeProperty")}</span><select value={property.id} onChange={(event) => setPropertyId(event.target.value)}>{properties.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          <div className="property-tabs" role="tablist" aria-label={t("properties.workspaceNavigation")}>{tabs.map(({ id, key, icon: Icon }, index) => <button key={id} id={`property-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`property-panel-${id}`} tabIndex={tab === id ? 0 : -1} onKeyDown={(event) => chooseTabFromKeyboard(event, index)} onClick={() => setTab(id)}><Icon size={16} />{t(key)}</button>)}</div>
          {tabs.filter(({ id }) => id !== tab).map(({ id }) => <div key={`inactive-${id}`} id={`property-panel-${id}`} role="tabpanel" aria-labelledby={`property-tab-${id}`} hidden />)}
          {houses.length === 0 && !readOnly && <section className="panel property-overview-first-home"><p className="property-empty-copy">{t("properties.noHouses")}</p><form onSubmit={(event) => void createHouse(event)}><label className="field"><span>{t("bootstrap.homeName")}</span><input value={newHouseName} onChange={(event) => setNewHouseName(event.target.value)} placeholder={t("bootstrap.homeNamePlaceholder")} /></label><button type="submit" className="primary-button" disabled={pending || !newHouseName.trim()}><Plus size={15} aria-hidden="true" />{t("properties.addHome")}</button></form></section>}

          {tab === "overview" && <section id="property-panel-overview" className="property-overview-workspace" role="tabpanel" aria-labelledby="property-tab-overview">
            <section className="panel property-overview-summary">
              <div className="panel-header"><div><span className="eyebrow">{propertySummary(houses.length, areas.length)}</span><h2>{t("properties.atAGlance")}</h2></div><Building2 size={20} aria-hidden="true" /></div>
              {houses.length > 0 ? <div className="property-overview-homes" aria-label={t("properties.houses")}>{overviewHomeRows[0]}{overviewHomeRows.length > 1 && <details className="property-overview-other-homes"><summary><span>{t("properties.otherHomes")}</span><small>{overviewHomeRows.length - 1}</small><ChevronRight size={15} aria-hidden="true" /></summary><div>{overviewHomeRows.slice(1)}</div></details>}</div> : readOnly ? <p className="property-empty-copy">{t("properties.noHouses")}</p> : null}
              <details className="property-overview-status" data-status={primaryPropertyStatus?.level ?? "unknown"}>
                <summary><span className={`property-status-signal${primaryPropertyStatus ? "" : " neutral"}`} aria-hidden="true" /><span><strong>{t("properties.status.title")}</strong><small>{primaryPropertyStatus ? `${t(`properties.status.level.${primaryPropertyStatus.level}`)} · ${t(`properties.status.reason.${primaryPropertyStatus.reason}`)}` : t("properties.status.none")}</small></span><ChevronRight size={16} aria-hidden="true" /></summary>
                <PropertyStatusLights lights={propertyTrafficLights} />
              </details>
            </section>
            <PropertyWeatherSettings property={property} houses={houses} readOnly={readOnly} onUpdateProperty={props.onUpdateProperty} />
          </section>}
          {!readOnly && <details className="panel property-manage-disclosure">
              <summary><Wrench size={17} aria-hidden="true" /><span><strong>{t("properties.manageProperty")}</strong><small>{t("properties.managePropertyHelp")}</small></span><ChevronRight size={17} aria-hidden="true" /></summary>
              <div className="property-manage-body">
                <section className="property-manage-section">
                  <h2>{t("properties.editProperty")}</h2>
                  {editingProperty ? <form className="property-edit-form" onSubmit={(event) => void saveProperty(event)}><label className="field"><span>{t("properties.propertyName")}</span><input ref={propertyNameInputRef} autoFocus required value={propertyName} onChange={(event) => setPropertyName(event.target.value)} /></label><label className="field"><span>{t("properties.propertyDescription")}</span><textarea rows={3} value={propertyDescription} onChange={(event) => setPropertyDescription(event.target.value)} /></label><div><button type="button" className="secondary-button" onClick={() => { setEditingProperty(false); window.requestAnimationFrame(() => propertyEditButtonRef.current?.focus()); }}>{t("common.cancel")}</button><button type="submit" className="primary-button"><Save size={14} aria-hidden="true" />{t("properties.saveProperty")}</button></div></form> : <button ref={propertyEditButtonRef} type="button" className="secondary-button" onClick={() => { setEditingProperty(true); window.requestAnimationFrame(() => propertyNameInputRef.current?.focus()); }}>{t("properties.editProperty")}</button>}
                </section>
                <section className="property-manage-section property-house-group">
                  <h2><Building2 size={15} aria-hidden="true" />{t("properties.houses")}</h2>
                  {houses.length + areas.length > 8 && <label className="field property-sidebar-search"><span>{t("properties.mapItemSearch")}</span><div><Search size={14} aria-hidden="true" /><input type="search" value={structureQuery} placeholder={t("properties.mapItemSearchHint")} onChange={(event) => changeStructureQuery(event.target.value)} /></div></label>}
                  {sidebarHouses.length ? <ul>{sidebarHouses.map((house) => {
                    const shareLabel = houseShareLabel(house);
                    const foreignShared = isForeignSharedHouse(house);
                    const locked = houseReadOnly(house);
                    const activeStugubyAssociation = Boolean(house.stuguby && house.stuguby.syncState !== "detached");
                    const moveTargets = properties.filter((candidate) => candidate.id === property.id || !candidate.stuguby || candidate.stuguby.syncState === "detached");
                    return <li key={house.id} className={foreignShared ? "stuguby-shared" : ""}>{foreignShared ? <StugubyMark className="small" /> : <Building2 size={13} aria-hidden="true" />}<span><strong>{house.name}</strong>{property.defaultHouseId === house.id ? <small className="property-default-home"><Check size={12} aria-hidden="true" />{t("properties.defaultHome")}</small> : <button type="button" className="text-button property-default-home-action" disabled={pending || readOnly} aria-label={t("properties.makeDefaultHomeNamed", { home: house.name })} onClick={() => void setDefaultHouse(house.id)}>{t("properties.makeDefaultHome")}</button>}{shareLabel && <small className="property-stuguby-label">{shareLabel}</small>}{!locked && !activeStugubyAssociation && moveTargets.length > 1 && <label><span>{t("properties.moveHouse")}</span><select value={property.id} disabled={pending} onChange={(event) => void moveHouse(house.id, event.target.value)}>{moveTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>}</span></li>;
                  })}</ul> : <p>{t(houses.length ? "properties.mapItemsNoMatches" : "properties.noHouses")}</p>}
                  {houses.length > 0 && <details className="property-action-disclosure"><summary><Plus size={15} aria-hidden="true" /><span><strong>{t("properties.addHome")}</strong><small>{t("properties.addHomeToProperty")}</small></span><ChevronRight size={15} aria-hidden="true" /></summary><form className="property-create-form compact" onSubmit={(event) => void createHouse(event)}><label className="field"><span>{t("properties.addHomeToProperty")}</span><input value={newHouseName} onChange={(event) => setNewHouseName(event.target.value)} placeholder={t("bootstrap.defaultHomeName")} /></label><button type="submit" className="secondary-button" disabled={pending || !newHouseName.trim()}><Plus size={14} aria-hidden="true" />{t("properties.addHome")}</button></form></details>}
                </section>
                <section className="property-manage-section property-area-list"><div><h2><MapIcon size={15} aria-hidden="true" />{t("properties.areas")}</h2><span>{areas.length}</span></div>{sidebarAreas.length ? <div>{sidebarAreas.map((area) => <button key={area.id} type="button" aria-pressed={selectedAreaId === area.id} className={selectedAreaId === area.id ? "active" : ""} onClick={() => selectMapArea(area.id)}><MapPin size={14} aria-hidden="true" /><span><strong>{area.name}</strong><small>{t(`properties.areaKind.${area.kind}`)}</small></span></button>)}</div> : <p>{t(areas.length ? "properties.mapItemsNoMatches" : "properties.noAreas")}</p>}<button type="button" className="structure-add-button" onClick={startArea}><Plus size={15} aria-hidden="true" />{t("properties.addArea")}</button></section>
                {!workspaceReadOnly && <section className="property-manage-section"><details className="property-action-disclosure"><summary><Plus size={15} aria-hidden="true" /><span><strong>{t("properties.addProperty")}</strong><small>{t("properties.addAnotherProperty")}</small></span><ChevronRight size={15} aria-hidden="true" /></summary><form className="property-create-form" onSubmit={(event) => void createProperty(event)}><label className="field"><span>{t("properties.propertyName")}</span><input value={newPropertyName} onChange={(event) => setNewPropertyName(event.target.value)} /></label><button type="submit" className="secondary-button" disabled={!newPropertyName.trim()}><Plus size={14} aria-hidden="true" />{t("common.add")}</button></form></details></section>}
                {(!property.stuguby || property.stuguby.syncState === "detached") && property.id !== "property-main" && properties.length > 1 && houses.length === 0 && areas.length === 0 && equipment.length === 0 && notes.length === 0 && !state.maintenanceTasks.some((task) => task.propertyId === property.id) && <button type="button" className="text-button danger-text property-manage-delete" disabled={pending} onClick={() => void removeProperty()}><Trash2 size={14} aria-hidden="true" />{t("properties.deleteEmptyProperty")}</button>}
              </div>
          </details>}

          {tab === "map" && <section id="property-panel-map" className="property-map-workspace" role="tabpanel" aria-labelledby="property-tab-map">
            <div className="panel property-map-panel">
              <div className="panel-header"><div><span className="eyebrow">{property.name}</span><h2>{t("properties.mapTitle")}</h2></div></div>
              {!mapLoaded ? <div className="setup-map-gate"><MapIcon size={28} /><div><strong>{t("properties.loadMapTitle")}</strong><p>{t("properties.loadMapBody")}</p></div><button type="button" className="primary-button" onClick={() => setMapLoaded(true)}><MapIcon size={15} />{t("properties.loadMap")}</button></div> : <Suspense fallback={<output className="property-loading"><LoaderCircle className="spin" />{t("common.loading")}</output>}>
                <div className={`property-map-shell ${drawing ? "drawing" : ""}${placementEditing || assetPlacementEditing ? " placing-house" : ""}`}>
                  <PropertyAreaMap
                    areas={mapAreas}
                    houses={visibleMapHouses}
                    propertyLocation={property.location}
                    propertyLabel={property.name}
                    selectedAreaId={selectedAreaId}
                    selectedHouseId={mapItemSelection?.kind === "home" ? placementHouse?.id ?? null : null}
                    editableHouseId={placementEditing && placementHouse && !houseReadOnly(placementHouse) ? placementHouse.id : null}
                    selectedAssetId={mapItemSelection?.kind === "asset" ? mapItemSelection.id : null}
                    editableAssetId={assetPlacementEditing && !readOnly ? (isNewArea && isNewFixedAsset ? NEW_FIXED_ASSET_ID : placementAsset?.id ?? null) : null}
                    visibleAssetIds={visibleAssetIds}
                    equipment={visibleMapEquipment}
                    trackedEquipment={trackingSnapshot?.equipment ?? trackedEquipment}
                    members={visibleMapMembers}
                    selectedEquipmentId={mapItemSelection?.kind === "equipment" ? mapItemSelection.id : null}
                    draftPolygon={!isNewFixedAsset && (isNewArea || selectedArea) ? areaForm.polygon : null}
                    drawing={drawing && !readOnly}
                    onSelectArea={selectMapArea}
                    onSelectHouse={selectPlacementHouse}
                    onMoveHouse={updatePlacementFromMap}
                    onSelectAsset={selectPlacementAsset}
                    onMoveAsset={updateAssetPlacementFromMap}
                    onSelectEquipment={selectMapEquipment}
                    onAppendVertex={appendVertex}
                    onMoveVertex={moveVertex}
                    onInsertVertex={insertVertex}
                    onFinishDrawing={() => setDrawing(false)}
                    vertexLabel={vertexLabel}
                    midpointLabel={midpointLabel}
                    ariaLabel={t("properties.mapAria", { property: property.name })}
                    viewportKey={property.id}
                    equipmentLabel={(item, tracking, source) => `${item.name}. ${t(`properties.mapEquipmentSource.${source}`)}${tracking?.position ? `. ${t(`properties.inventoryTracking.${tracking.position.freshness}`)}` : ""}`}
                    memberLabel={(member) => `${member.memberLabel}. ${t("properties.mapMemberAccuracy", { meters: Math.round(member.horizontalAccuracyMeters) })}. ${t("properties.mapMemberExpires", { time: formatInTimeZone(member.sharingUntil, locale, undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }) })}`}
                  />
                  {drawing && <span className="property-drawing-cue"><MapPin size={14} />{t("properties.drawHint")}</span>}
                  {placementEditing && placementHouse && <span className="property-drawing-cue"><Move size={14} />{t("placement.editingHint", { house: placementHouse.name })}</span>}
                  {assetPlacementEditing && <span className="property-drawing-cue"><Move size={14} />{t("properties.assetPlacementHint")}</span>}
                </div>
              </Suspense>}
            </div>
            {(houses.length > 0 || fixedAssets.length > 0 || equipment.length > 0 || sharedMembers.length > 0 || !readOnly) && <section className="panel property-home-placement">
              <div className="panel-header"><div><span className="eyebrow">{property.name}</span><h2>{t("properties.mapItems")}</h2></div>{!readOnly && <button type="button" className="text-button" onClick={startFixedAsset}><Plus size={14} aria-hidden="true" />{t("properties.addFixedAsset")}</button>}</div>
              <p className="property-help">{t("properties.mapItemsHelp")}</p>
              {areas.some((area) => area.polygon.length > 0) && <section className="property-area-list property-map-area-list"><div><h2><MapIcon size={15} aria-hidden="true" />{t("properties.areas")}</h2><span>{areas.filter((area) => area.polygon.length > 0).length}</span></div><div>{areas.filter((area) => area.polygon.length > 0).map((area) => <button key={area.id} type="button" aria-pressed={selectedAreaId === area.id} className={selectedAreaId === area.id ? "active" : ""} onClick={() => selectMapArea(area.id)}><MapPin size={14} aria-hidden="true" /><span><strong>{area.name}</strong><small>{t(`properties.areaKind.${area.kind}`)}</small></span></button>)}</div></section>}
              <div className="property-map-catalog-controls">
                <label className="field property-map-item-search"><span>{t("properties.mapItemSearch")}</span><div><Search size={14} aria-hidden="true" /><input type="search" value={mapItemQuery} placeholder={t("properties.mapItemSearchHint")} onChange={(event) => changeMapItemQuery(event.target.value)} /></div></label>
                <label className="field"><span>{t("properties.mapItemType")}</span><select value={mapItemFilter} onChange={(event) => changeMapItemFilter(event.target.value as MapItemFilter)}><option value="all">{t("properties.mapItemTypeAll")}</option><option value="home">{t("properties.houses")}</option><option value="asset">{t("properties.fixedAssets")}</option><option value="equipment">{t("properties.mapEquipment")}</option><option value="person">{t("properties.mapPeople")}</option></select></label>
              </div>
              <fieldset className="property-map-layer-controls">
                <legend>{t("properties.mapLayers")}</legend>
                <label><input type="checkbox" checked={mapLayers.home} onChange={(event) => changeMapLayer("home", event.target.checked)} /><Building2 size={13} aria-hidden="true" /><span>{t("properties.houses")}</span><small>{houses.length}</small></label>
                <label><input type="checkbox" checked={mapLayers.asset} onChange={(event) => changeMapLayer("asset", event.target.checked)} /><MapPin size={13} aria-hidden="true" /><span>{t("properties.fixedAssets")}</span><small>{fixedAssets.length}</small></label>
                <label><input type="checkbox" checked={mapLayers.equipment} onChange={(event) => changeMapLayer("equipment", event.target.checked)} /><Boxes size={13} aria-hidden="true" /><span>{t("properties.mapEquipment")}</span><small>{equipment.length}</small></label>
                <label><input type="checkbox" checked={mapLayers.person} onChange={(event) => changeMapLayer("person", event.target.checked)} /><UserRound size={13} aria-hidden="true" /><span>{t("properties.mapPeople")}</span><small>{sharedMembers.length}</small></label>
              </fieldset>
              <p className="property-map-result-count" aria-live="polite">{t("properties.inventoryShowing", { count: matchingMapCatalogItems.length })}</p>
              {visibleMapCatalogItems.length > 0 ? <ul className="property-placement-house-list property-map-item-list" aria-label={t("properties.mapItems")}>
                {visibleMapCatalogItems.map((entry) => {
                  const selected = mapItemSelection?.kind === entry.kind && mapItemSelection.id === entry.id;
                  const candidate = entry.kind === "home" ? houses.find((house) => house.id === entry.id) : null;
                  const asset = entry.kind === "asset" ? fixedAssets.find((item) => item.id === entry.id) : null;
                  const kindLabel = entry.kind === "home" ? t("common.house") : entry.kind === "asset" ? t("properties.fixedAssets") : entry.kind === "equipment" ? t("properties.equipment") : t("properties.mapPeople");
                  if (entry.kind === "person") return <li key={`${entry.kind}:${entry.id}`}><article className="property-map-person-row"><UserRound size={15} aria-hidden="true" /><span><strong>{entry.label}</strong><small>{kindLabel} · {entry.detail}</small></span></article></li>;
                  return <li key={`${entry.kind}:${entry.id}`}><button type="button" data-kind={entry.kind} draggable={entry.kind === "home" ? Boolean(candidate && !houseReadOnly(candidate)) : entry.kind === "asset" ? !readOnly : false} aria-pressed={selected} onClick={() => { if (entry.kind === "home") selectPlacementHouse(entry.id); else if (entry.kind === "asset") selectPlacementAsset(entry.id); else selectMapEquipment(entry.id); }} onDragStart={(event) => {
                    if (entry.kind === "home") {
                      if (!candidate || houseReadOnly(candidate)) { event.preventDefault(); return; }
                      selectPlacementHouse(entry.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-stugu-house-id", entry.id);
                    } else if (entry.kind === "asset" && asset && !readOnly) {
                      selectPlacementAsset(entry.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-stugu-property-asset-id", entry.id);
                    } else event.preventDefault();
                  }}>{entry.kind === "home" && candidate && isForeignSharedHouse(candidate) ? <StugubyMark className="small" /> : entry.kind === "home" ? <Building2 size={15} aria-hidden="true" /> : entry.kind === "asset" ? <MapPin size={15} aria-hidden="true" /> : <Boxes size={15} aria-hidden="true" />}<span><strong>{entry.label}</strong><small>{kindLabel} · {entry.detail}</small></span></button></li>;
                })}
              </ul> : <p className="property-map-empty">{t("properties.mapItemsNoMatches")}</p>}
              {remainingMapCatalogItems > 0 && <button type="button" className="secondary-button property-map-show-more" onClick={() => setMapItemLimit((current) => current + MAP_ITEM_BATCH_SIZE)}>{t("properties.mapItemsShowMore", { count: Math.min(MAP_ITEM_BATCH_SIZE, remainingMapCatalogItems) })}</button>}
              <details className="property-live-map">
                <summary><Radio size={15} aria-hidden="true" /><span><strong>{t("properties.liveAssetsPeople")}</strong><small>{t("properties.liveMapDetails")}</small></span><span className={`tracking-connection connection-${trackingConnection}`}>{trackingConnection === "live" ? t("properties.trackingConnectionLive") : trackingConnection === "reconnecting" ? t("properties.trackingConnectionReconnecting") : t("properties.trackingConnectionOff")}</span><ChevronRight size={15} aria-hidden="true" /></summary>
                <div><p className="property-help">{t("properties.liveMapConsentHelp")}</p>{sharedMembers.length === 0 && <p className="property-empty-copy">{t("properties.noSharedPeople")}</p>}</div>
              </details>
              {mapItemSelection?.kind === "home" && placementHouse && props.onSetHouseGeoreference && <section className="property-map-item-editor">
              <form className="property-placement-form" onSubmit={(event) => void saveHousePlacement(event)}>
                <details className="property-placement-advanced">
                  <summary><span>{t("setup.advancedPlacement")}</span><small>{t("setup.manualCoordinates")}</small></summary>
                  <div className="property-placement-fields">
                    <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" required disabled={houseReadOnly(placementHouse)} value={placementLatitude} onChange={(event) => { setPlacementLatitude(event.target.value); setPlacementEditing(true); }} /></label>
                    <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" required disabled={houseReadOnly(placementHouse)} value={placementLongitude} onChange={(event) => { setPlacementLongitude(event.target.value); setPlacementEditing(true); }} /></label>
                    <label className="field"><span>{t("placement.widthMeters")}</span><input type="number" min={1} max={500} step="0.1" required disabled={houseReadOnly(placementHouse)} value={placementWidth} onChange={(event) => { setPlacementWidth(event.target.value); setPlacementEditing(true); }} /></label>
                    <label className="field"><span>{t("orientation.degrees")}</span><input type="number" min={0} max={359} step={1} disabled={houseReadOnly(placementHouse)} value={placementOrientation} onChange={(event) => { setPlacementOrientation(event.target.value); setPlacementEditing(true); }} /></label>
                  </div>
                </details>
                <div className="property-placement-actions">
                  {houseReadOnly(placementHouse) ? <span className="property-stuguby-read-only"><ShieldCheck size={14} />{t("properties.stuguby.houseReadOnlyHelp")}</span> : <>
                    {!placementEditing && <button type="button" className="primary-button" onClick={() => { setMapLoaded(true); setDrawing(false); setPlacementEditing(true); setFeedback(null); }}><Move size={15} aria-hidden="true" />{placementHouse.mapPlacement ? t("placement.move") : t("placement.place")}</button>}
                    {placementEditing && <><button type="submit" className="primary-button" disabled={pending || !placementDraftIsValid}>{pending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}{pending ? t("common.saving") : t("placement.save")}</button><button type="button" className="secondary-button" disabled={pending} onClick={() => setPlacementEditing(false)}>{t("common.cancel")}</button></>}
                    {placementHouse.mapPlacement && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeHousePlacement()}><Trash2 size={15} aria-hidden="true" />{t("placement.remove")}</button>}
                  </>}
                </div>
              </form>
              </section>}
              {mapItemSelection?.kind === "asset" && placementAsset && <section className="property-map-item-editor">
                <div className="property-placement-actions">
                  {!assetPlacementEditing && <button type="button" className="primary-button" onClick={() => { setMapLoaded(true); setDrawing(false); setPlacementEditing(false); setAssetDraftLocation(placementAsset.location ? { ...placementAsset.location } : null); setAssetPlacementEditing(true); setFeedback(null); }}><MapPin size={15} aria-hidden="true" />{placementAsset.location ? t("properties.moveAsset") : t("properties.placeAsset")}</button>}
                  {assetPlacementEditing && <><button type="button" className="primary-button" disabled={pending || !assetDraftLocation || !assetCoordinateInputsValid} onClick={() => void saveAssetPlacement()}><Save size={15} aria-hidden="true" />{pending ? t("common.saving") : t("placement.save")}</button><button type="button" className="secondary-button" disabled={pending} onClick={() => { const location = placementAsset.location ? { ...placementAsset.location } : null; setAreaForm(areaDraft(placementAsset)); setAssetDraftLocation(location); setAssetLatitudeInput(location ? String(location.latitude) : ""); setAssetLongitudeInput(location ? String(location.longitude) : ""); setAssetPlacementEditing(false); }}>{t("common.cancel")}</button></>}
                  {placementAsset.location && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeAssetPlacement()}><Trash2 size={15} aria-hidden="true" />{t("placement.remove")}</button>}
                </div>
              </section>}
              {mapItemSelection?.kind === "equipment" && context.mapSelectedEquipment && <div className="property-map-item-editor property-map-equipment-selection"><span><Boxes size={15} aria-hidden="true" /><strong>{context.mapSelectedEquipment.name}</strong></span><button type="button" className="secondary-button" onClick={() => { changeSelectedEquipmentId(context.mapSelectedEquipment!.id); setTab("inventory"); }}>{t("properties.inventory")}</button></div>}
            </section>}
            {(selectedArea || isNewArea) && <section className="panel area-editor"><div className="panel-header"><div><span className="eyebrow">{isNewFixedAsset ? t("properties.newFixedAsset") : isNewArea ? t("properties.newArea") : t("properties.selectedArea")}</span><h2>{areaForm.name || (editingFixedAsset ? t("properties.unnamedFixedAsset") : t("properties.unnamedArea"))}</h2></div><MapPin size={20} /></div>
              <div className="area-form-grid">
                <label className="field"><span>{editingFixedAsset ? t("properties.assetName") : t("properties.areaName")}</span><input required value={areaForm.name} disabled={readOnly} onChange={(event) => setAreaForm((current) => ({ ...current, name: event.target.value }))} /></label>
                <label className="field"><span>{editingFixedAsset ? t("properties.assetKind") : t("properties.areaKind")}</span><select value={areaForm.kind} disabled={readOnly} onChange={(event) => setAreaForm((current) => ({ ...current, kind: event.target.value as PropertyAreaKind }))}>{areaKinds.map((kind) => <option key={kind} value={kind}>{t(`properties.areaKind.${kind}`)}</option>)}</select></label>
                {selectedArea && properties.length > 1 && <label className="field area-description"><span>{t("properties.moveAreaTo")}</span><select value={areaDestinationPropertyId} disabled={readOnly || pending} onChange={(event) => setAreaDestinationPropertyId(event.target.value)}>{properties.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select><small>{t("properties.moveAreaHelp")}</small></label>}
                <label className="field area-description"><span>{t("properties.areaDescription")}</span><textarea rows={2} value={areaForm.description} disabled={readOnly} onChange={(event) => setAreaForm((current) => ({ ...current, description: event.target.value }))} /></label>
              </div>
              {editingFixedAsset ? <><div className="property-placement-fields area-fixed-asset-coordinates">
                <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" required value={assetLatitudeInput} disabled={readOnly} onChange={(event) => updateFixedAssetCoordinate("latitude", event.target.value)} /></label>
                <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" required value={assetLongitudeInput} disabled={readOnly} onChange={(event) => updateFixedAssetCoordinate("longitude", event.target.value)} /></label>
              </div>{!assetCoordinateInputsValid && (assetLatitudeInput || assetLongitudeInput) && <p className="inline-error" role="alert">{t("weather.invalidLocation")}</p>}<p className={`property-asset-location-status ${assetCoordinateInputsValid ? "placed" : ""}`}><MapPin size={15} aria-hidden="true" />{assetCoordinateInputsValid ? t("properties.assetDraftPlaced") : t("properties.assetDraftHint")}</p></> : <>
                {!readOnly && <div className="area-drawing-actions"><button type="button" className={drawing ? "secondary-button active" : "secondary-button"} onClick={() => setDrawing((value) => !value)}><MapPin size={14} />{drawing ? t("properties.finishDrawing") : t("properties.editBoundary")}</button><button type="button" className="secondary-button" disabled={!areaForm.polygon.length} onClick={undoVertex}><Undo2 size={14} />{t("common.undo")}</button><button type="button" className="secondary-button" disabled={!redoVertices.length} onClick={redoVertex}><Redo2 size={14} />{t("common.redo")}</button><button type="button" className="secondary-button" disabled={!areaForm.polygon.length} onClick={() => { setAreaForm((current) => ({ ...current, polygon: [] })); setCoordinateInput(""); setRedoVertices([]); }}>{t("properties.clear")}</button></div>}
                <details className="area-coordinate-editor"><summary>{t("properties.manualCoordinates")}</summary><p>{t("properties.manualCoordinatesHelp")}</p><label className="field"><span>{t("properties.vertices")}</span><textarea rows={Math.max(4, areaForm.polygon.length)} value={coordinateInput} disabled={readOnly} onChange={(event) => { setCoordinateInput(event.target.value); setCoordinateError(false); }} /></label>{coordinateError && <p className="inline-error" role="alert">{t("properties.invalidCoordinates")}</p>}{!readOnly && <button type="button" className="secondary-button" onClick={applyCoordinates}><Check size={14} />{t("properties.applyCoordinates")}</button>}</details>
                <p className="property-help">{t("properties.vertexCount", { count: areaForm.polygon.length })}</p>
              </>}
              {!readOnly && <div className="area-editor-actions"><button type="button" className="primary-button" disabled={pending || !areaForm.name.trim() || (editingFixedAsset ? !areaForm.location || !assetCoordinateInputsValid : areaForm.polygon.length < 3)} onClick={() => void saveArea()}><Save size={15} />{pending ? t("common.saving") : editingFixedAsset ? t("properties.saveFixedAsset") : t("properties.saveArea")}</button>{selectedArea && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void removeArea()}><Trash2 size={14} />{t("common.delete")}</button>}</div>}
            </section>}
          </section>}

          {tab === "inventory" && <section id="property-panel-inventory" className="property-inventory-workspace" role="tabpanel" aria-labelledby="property-tab-inventory">
            <section className="panel inventory-overview">
              <div className="panel-header">
                <div><span className="eyebrow">{property.name}</span><h2>{t("properties.inventory")}</h2><p>{t("properties.inventoryHelp")}</p></div>
                {!readOnly && <button type="button" className="primary-button" onClick={() => {
                  clearEquipmentDraft("unassigned");
                  setInventoryFormOpen(true);
                }}><Plus size={15} aria-hidden="true" />{t("properties.addInventoryItem")}</button>}
              </div>
              <div className="inventory-summary" aria-label={t("properties.inventorySummary")}>
                <article><Boxes size={18} aria-hidden="true" /><span><strong>{equipment.length}</strong><small>{t("properties.inventoryTotal")}</small></span></article>
                <article data-attention={inventoryAttentionCount > 0}><Wrench size={18} aria-hidden="true" /><span><strong>{inventoryAttentionCount}</strong><small>{t("properties.inventoryAttention")}</small></span></article>
                <article><MapPin size={18} aria-hidden="true" /><span><strong>{inventoryLocationCount}</strong><small>{t("properties.inventoryLocations")}</small></span></article>
                <article><Radio size={18} aria-hidden="true" /><span><strong>{trackingStates.filter((item) => item.binding).length}</strong><small>{t("properties.inventoryTracked")}</small></span></article>
              </div>
            </section>

            <section className="panel inventory-catalog">
              <div className="inventory-controls">
                <label className="field inventory-search"><span>{t("properties.inventorySearch")}</span><div><Search size={15} aria-hidden="true" /><input type="search" value={inventoryQuery} onChange={(event) => changeInventoryQuery(event.target.value)} placeholder={t("properties.inventorySearchHint")} /></div></label>
                <label className="field"><span>{t("properties.inventoryStatusFilter")}</span><select value={inventoryStatus} onChange={(event) => changeInventoryStatus(event.target.value as "all" | AreaEquipmentStatus)}><option value="all">{t("properties.inventoryAllStatuses")}</option><option value="active">{t("properties.equipmentStatus.active")}</option><option value="out-of-service">{t("properties.equipmentStatus.out-of-service")}</option><option value="retired">{t("properties.equipmentStatus.retired")}</option></select></label>
                <label className="field"><span>{t("properties.inventoryLocationFilter")}</span><select value={inventoryLocation} onChange={(event) => changeInventoryLocation(event.target.value as InventoryLocationFilter)}><option value="all">{t("properties.inventoryAllLocations")}</option><option value="pinned">{t("properties.inventoryPinnedLocation")}</option><option value="unassigned">{t("properties.inventoryUnassigned")}</option>{houses.length > 0 && <optgroup label={t("properties.houses")}>{houses.map((house) => <option key={house.id} value={`house:${house.id}`}>{house.name}</option>)}</optgroup>}{areas.length > 0 && <optgroup label={t("properties.areas")}>{areas.map((area) => <option key={area.id} value={`area:${area.id}`}>{area.name}</option>)}</optgroup>}</select></label>
              </div>
              <p className="inventory-result-count" aria-live="polite">{t("properties.inventoryShowing", { count: visibleInventory.length })}</p>
              {visibleInventory.length > 0 ? <div className="inventory-list">
                {visibleInventory.map((item) => {
                  const tracked = trackingByEquipmentId.get(item.id);
                  const trackingState = tracked?.position?.freshness ?? (tracked ? "unknown" : null);
                  const batteryPercent = tracked?.endpoint.telemetry.batteryPercent;
                  return <article key={item.id} data-status={item.status} data-selected={selectedEquipmentId === item.id}>
                    <div className="inventory-item-icon" aria-hidden="true"><Boxes size={18} /></div>
                    <div className="inventory-item-copy">
                      <div><span className="inventory-item-kind">{item.kind}</span><h3>{item.name}</h3></div>
                      <p><MapPin size={13} aria-hidden="true" />{equipmentLocationLabel(item)}</p>
                      {(item.manufacturer || item.model || item.serialNumber) && <dl>
                        {item.manufacturer && <><dt>{t("properties.equipmentManufacturer")}</dt><dd>{item.manufacturer}</dd></>}
                        {item.model && <><dt>{t("properties.equipmentModel")}</dt><dd>{item.model}</dd></>}
                        {item.serialNumber && <><dt>{t("properties.equipmentSerialNumber")}</dt><dd>{item.serialNumber}</dd></>}
                      </dl>}
                      {item.notes && <p className="inventory-item-notes">{item.notes}</p>}
                    </div>
                    <div className="inventory-item-state">
                      <span className={`inventory-status status-${item.status}`}>{t(`properties.equipmentStatus.${item.status}`)}</span>
                      {trackingState && <span className={`inventory-tracking tracking-${trackingState}`}>{t(`properties.inventoryTracking.${trackingState}`)}{typeof batteryPercent === "number" ? ` · ${batteryPercent}%` : ""}</span>}
                    </div>
                    <div className="inventory-item-actions">
                      <button type="button" className="secondary-button" aria-label={`${t("properties.equipmentQrLabel")}: ${item.name}`} onClick={() => changeSelectedEquipmentId(item.id)}><QrCode size={14} aria-hidden="true" />{t("properties.equipmentQrLabel")}</button>
                      <button type="button" className="secondary-button" aria-label={`${t("properties.showOnMap")}: ${item.name}`} onClick={() => showEquipmentOnMap(item.id)}><MapPin size={14} aria-hidden="true" />{t("properties.showOnMap")}</button>
                      {!readOnly && <><button type="button" className="secondary-button" disabled={pending} aria-label={`${t("properties.editInventoryItem")}: ${item.name}`} onClick={() => beginEquipmentEdit(item)}><ClipboardList size={14} aria-hidden="true" />{t("properties.editInventoryItem")}</button>
                      <button type="button" className="icon-button small danger-icon" disabled={pending} aria-label={`${t("common.delete")}: ${item.name}`} onClick={() => void removeEquipment(item.id)}><Trash2 size={14} /></button></>}
                    </div>
                  </article>;
                })}
              </div> : <div className="inventory-empty"><Boxes size={24} aria-hidden="true" /><h3>{equipment.length ? t("properties.inventoryNoMatches") : t("properties.inventoryEmpty")}</h3><p>{equipment.length ? t("properties.inventoryNoMatchesHelp") : t("properties.inventoryEmptyHelp")}</p></div>}
            </section>

            {selectedEquipment && <section className="panel inventory-detail">
              <div className="panel-header">
                <div><span className="eyebrow">{selectedEquipment.kind}</span><h2>{selectedEquipment.name}</h2><p>{t("properties.inventoryDetailHelp")}</p></div>
                <button type="button" className="icon-button small" aria-label={t("common.close")} onClick={() => changeSelectedEquipmentId(null)}><X size={15} aria-hidden="true" /></button>
              </div>
              <EquipmentQrLabel
                equipment={selectedEquipment}
                propertyName={property.name}
                locationLabel={equipmentLocationLabel(selectedEquipment)}
              />
              <div className="inventory-location-comparison">
                <article>
                  <span className="eyebrow"><MapPin size={14} aria-hidden="true" />{t("properties.savedExpectedLocation")}</span>
                  <strong>{equipmentLocationLabel(selectedEquipment)}</strong>
                  {selectedEquipment.location && <small>{selectedEquipment.location.latitude.toFixed(6)}, {selectedEquipment.location.longitude.toFixed(6)}</small>}
                  <p>{t("properties.savedExpectedLocationHelp")}</p>
                </article>
                <article>
                  <span className="eyebrow"><Radio size={14} aria-hidden="true" />{t("properties.liveLocationEstimate")}</span>
                  {selectedTracking?.position ? <>
                    <strong>{t(`properties.inventoryTracking.${selectedTracking.position.freshness}`)}</strong>
                    <small>{(selectedTracking.position.kind === "zone" || selectedTracking.position.kind === "area") && selectedTracking.position.zoneId
                      ? areas.find((area) => area.id === selectedTracking.position!.zoneId)?.name ?? selectedTracking.position.zoneId
                      : selectedTracking.position.coordinate
                        ? `${selectedTracking.position.coordinate.latitude.toFixed(6)}, ${selectedTracking.position.coordinate.longitude.toFixed(6)}`
                        : t("properties.inventoryLocationUnknown")}</small>
                    <dl>
                      <div><dt>{t("properties.trackingConfidence")}</dt><dd>{Math.round(selectedTracking.position.confidence * 100)}% · {selectedTracking.position.source}</dd></div>
                      <div><dt>{t("properties.trackingAccuracy")}</dt><dd>{selectedTracking.position.uncertaintyRadiusMeters === null ? t("properties.inventoryLocationUnknown") : `±${Math.round(selectedTracking.position.uncertaintyRadiusMeters)} m`}</dd></div>
                      <div><dt>{t("properties.trackingObserved")}</dt><dd>{selectedTracking.position.lastObservedAt ? formatInTimeZone(selectedTracking.position.lastObservedAt, locale, undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : t("properties.inventoryLocationUnknown")}</dd></div>
                    </dl>
                  </> : <><strong>{t("properties.inventoryLocationUnknown")}</strong><p>{t("properties.liveLocationEstimateHelp")}</p></>}
                </article>
              </div>
              <section className="inventory-resources-panel" aria-labelledby="inventory-resources-title">
                <div className="property-placement-group-header">
                  <div><h3 id="inventory-resources-title"><FileText size={15} aria-hidden="true" />{t("properties.inventoryResources")}</h3><p>{t("properties.inventoryResourcesHelp")}</p></div>
                </div>
                {equipmentResourcesState === "loading" ? <output className="inventory-resources-loading"><LoaderCircle className="spin" size={16} aria-hidden="true" />{t("properties.inventoryResourcesLoading")}</output>
                  : equipmentResourcesState === "error" ? <div className="inventory-resources-error"><p>{t("properties.inventoryResourcesLoadFailed")}</p><button type="button" className="secondary-button" onClick={() => setEquipmentResourcesRefresh((current) => current + 1)}>{t("common.retry")}</button></div>
                    : <div className="inventory-resources-grid">
                      <article className="inventory-resource-group">
                        <div className="inventory-resource-heading"><span><Camera size={15} aria-hidden="true" /><strong>{t("properties.inventoryPhotos")}</strong></span>{!readOnly && <>
                          <input ref={equipmentPhotoInputRef} className="sr-only" type="file" multiple accept={EQUIPMENT_PHOTO_ACCEPT} aria-label={t("properties.inventoryAddPhotos")} onChange={(event) => void uploadEquipmentAttachments(event, "photo")} />
                          <button type="button" className="secondary-button" disabled={equipmentResourcesBusy} onClick={() => equipmentPhotoInputRef.current?.click()}><Upload size={14} aria-hidden="true" />{t("properties.inventoryAddPhotos")}</button>
                        </>}</div>
                        <p>{t("properties.inventoryPhotoUploadHelp")}</p>
                        {equipmentAttachments.some((attachment) => attachment.kind === "photo") ? <div className="inventory-photo-grid">{equipmentAttachments.filter((attachment) => attachment.kind === "photo").map((attachment) => <figure key={attachment.id}>
                          <a href={api.equipmentAttachmentUrl(selectedEquipment.id, attachment.id)} target="_blank" rel="noreferrer"><img src={api.equipmentAttachmentUrl(selectedEquipment.id, attachment.id)} alt={attachment.name} /></a>
                          <figcaption><span title={attachment.name}>{attachment.name}</span><small>{attachmentSize(attachment.size)}</small></figcaption>
                          {!readOnly && <button type="button" className="icon-button small danger-icon" disabled={equipmentResourcesBusy} aria-label={`${t("common.delete")}: ${attachment.name}`} onClick={() => void removeEquipmentAttachment(attachment)}><Trash2 size={13} aria-hidden="true" /></button>}
                        </figure>)}</div> : <p className="inventory-resource-empty">{t("properties.inventoryNoPhotos")}</p>}
                      </article>
                      <article className="inventory-resource-group">
                        <div className="inventory-resource-heading"><span><FileText size={15} aria-hidden="true" /><strong>{t("properties.inventoryDocuments")}</strong></span>{!readOnly && <>
                          <input ref={equipmentDocumentInputRef} className="sr-only" type="file" multiple accept={EQUIPMENT_DOCUMENT_ACCEPT} aria-label={t("properties.inventoryAddDocuments")} onChange={(event) => void uploadEquipmentAttachments(event, "document")} />
                          <button type="button" className="secondary-button" disabled={equipmentResourcesBusy} onClick={() => equipmentDocumentInputRef.current?.click()}><Upload size={14} aria-hidden="true" />{t("properties.inventoryAddDocuments")}</button>
                        </>}</div>
                        <p>{t("properties.inventoryDocumentUploadHelp")}</p>
                        {equipmentAttachments.some((attachment) => attachment.kind === "document") ? <ul className="inventory-document-list">{equipmentAttachments.filter((attachment) => attachment.kind === "document").map((attachment) => <li key={attachment.id}>
                          <a href={api.equipmentAttachmentUrl(selectedEquipment.id, attachment.id)}><FileText size={15} aria-hidden="true" /><span><strong>{attachment.name}</strong><small>{attachment.mimeType}{" \u00b7 "}{attachmentSize(attachment.size)}</small></span></a>
                          {!readOnly && <button type="button" className="icon-button small danger-icon" disabled={equipmentResourcesBusy} aria-label={`${t("common.delete")}: ${attachment.name}`} onClick={() => void removeEquipmentAttachment(attachment)}><Trash2 size={13} aria-hidden="true" /></button>}
                        </li>)}</ul> : <p className="inventory-resource-empty">{t("properties.inventoryNoDocuments")}</p>}
                      </article>
                      <article className="inventory-resource-group inventory-link-group">
                        <div className="inventory-resource-heading"><span><LinkIcon size={15} aria-hidden="true" /><strong>{t("properties.inventoryLinks")}</strong></span></div>
                        <p>{t("properties.inventoryLinksHelp")}</p>
                        {equipmentLinks.length ? <ul className="inventory-link-list">{equipmentLinks.map((link) => <li key={link.id}>
                          <a href={link.url} target="_blank" rel="noreferrer"><span><strong>{link.label}</strong><small>{link.url}</small></span><ExternalLink size={14} aria-hidden="true" /></a>
                          {!readOnly && <button type="button" className="icon-button small danger-icon" disabled={equipmentResourcesBusy} aria-label={`${t("common.delete")}: ${link.label}`} onClick={() => void removeEquipmentLink(link)}><Trash2 size={13} aria-hidden="true" /></button>}
                        </li>)}</ul> : <p className="inventory-resource-empty">{t("properties.inventoryNoLinks")}</p>}
                        {!readOnly && <form className="inventory-link-form" onSubmit={(event) => void addEquipmentLink(event)}>
                          <label className="field"><span>{t("properties.inventoryLinkLabel")}</span><input required maxLength={200} value={equipmentLinkLabel} onChange={(event) => setEquipmentLinkLabel(event.target.value)} /></label>
                          <label className="field"><span>{t("properties.inventoryLinkUrl")}</span><input required type="url" maxLength={2048} value={equipmentLinkUrl} onChange={(event) => setEquipmentLinkUrl(event.target.value)} /></label>
                          <button type="submit" className="secondary-button" disabled={equipmentResourcesBusy || !equipmentLinkLabel.trim() || !equipmentLinkUrl.trim()}><Plus size={14} aria-hidden="true" />{t("properties.inventoryAddLink")}</button>
                        </form>}
                      </article>
                    </div>}
                {equipmentResourcesFeedback && <p className={`inventory-resources-feedback ${equipmentResourcesFeedback.kind}`} role={equipmentResourcesFeedback.kind === "error" ? "alert" : "status"}>{equipmentResourcesFeedback.text}</p>}
              </section>
              <section className="inventory-endpoint-panel">
                <div className="property-placement-group-header"><h3><Radio size={15} aria-hidden="true" />{t("properties.trackingEndpoint")}</h3>{typeof selectedTracking?.endpoint.telemetry.batteryPercent === "number" && <span><Battery size={14} aria-hidden="true" />{selectedTracking.endpoint.telemetry.batteryPercent}%</span>}</div>
                {!trackingEnabled ? <p className="property-help">{t("properties.trackingDisabledHelp")}</p> : selectedTracking?.endpoint ? <div className="inventory-bound-endpoint">
                  <div><strong>{selectedTracking.endpoint.displayName}</strong><small>{selectedTracking.endpoint.model ?? selectedTracking.endpoint.profileId} · {selectedTracking.endpoint.claimStatus}</small></div>
                  {canManageAccess && <button type="button" className="secondary-button danger-text" disabled={pending} onClick={() => void unbindEndpoint()}>{t("properties.trackingEndpointUnbind")}</button>}
                </div> : canManageAccess ? <div className="inventory-endpoint-binding">
                  <label className="field"><span>{t("properties.trackingAvailableEndpoint")}</span><select value={selectedEndpointId} onChange={(event) => setSelectedEndpointId(event.target.value)}><option value="">{t("properties.trackingChooseEndpoint")}</option>{availableTrackingEndpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.displayName} · {endpoint.model ?? endpoint.profileId}</option>)}</select></label>
                  <button type="button" className="primary-button" disabled={pending || !selectedEndpointId} onClick={() => void bindEndpoint(selectedEndpointId)}>{t("properties.trackingEndpointBind")}</button>
                  <p className="property-help">{t("properties.trackingEndpointEnrollmentHelp")}</p>
                </div> : <p className="property-help">{t("properties.trackingNoEndpoint")}</p>}
              </section>
            </section>}

            {!readOnly && <details className="panel inventory-editor" open={inventoryFormOpen} onToggle={(event) => {
              setInventoryFormOpen(event.currentTarget.open);
            }}>
              <summary><Plus size={17} aria-hidden="true" /><span><strong>{editingEquipmentId ? t("properties.editInventoryItem") : t("properties.addInventoryItem")}</strong><small>{t("properties.inventoryFormHelp")}</small></span><ChevronRight size={17} aria-hidden="true" /></summary>
              <form className="inventory-form" onSubmit={(event) => void saveEquipment(event)}>
                <label className="field"><span>{t("properties.equipmentName")}</span><input required value={equipmentName} onChange={(event) => setEquipmentName(event.target.value)} /></label>
                <label className="field"><span>{t("properties.equipmentKind")}</span><input required value={equipmentKind} onChange={(event) => setEquipmentKind(event.target.value)} /></label>
                <label className="field"><span>{t("properties.savedExpectedLocation")}</span><select value={equipmentDestination} onChange={(event) => setEquipmentDestination(event.target.value as EquipmentPlacement)}><option value="unassigned">{t("properties.inventoryUnassigned")}</option>{editingEquipmentId && equipmentDestination.startsWith("house:") && !state.houses.some((house) => `house:${house.id}` === equipmentDestination) && <option value={equipmentDestination}>{t("properties.inventoryUnknownHome")}</option>}{houses.length > 0 && <optgroup label={t("properties.houses")}>{houses.map((house) => <option key={house.id} value={`house:${house.id}`}>{house.name}</option>)}</optgroup>}{areas.length > 0 && <optgroup label={t("properties.areas")}>{areas.map((area) => <option key={area.id} value={`area:${area.id}`}>{area.name}</option>)}</optgroup>}{editingEquipmentId && properties.filter((candidate) => candidate.id !== property.id).map((candidate) => {
                  const candidateHouses = state.houses.filter((house) => house.propertyId === candidate.id);
                  const candidateAreas = state.propertyAreas.filter((area) => area.propertyId === candidate.id);
                  if (!candidateHouses.length && !candidateAreas.length) return null;
                  return <optgroup key={candidate.id} label={candidate.name}>
                    {candidateHouses.map((house) => <option key={house.id} value={`house:${house.id}`}>{t("properties.houses")}: {house.name}</option>)}
                    {candidateAreas.map((area) => <option key={area.id} value={`area:${area.id}`}>{t("properties.areas")}: {area.name}</option>)}
                  </optgroup>;
                })}</select><small>{t("properties.savedExpectedLocationHelp")}</small></label>
                <label className="field"><span>{t("properties.equipmentStatusLabel")}</span><select value={equipmentStatus} onChange={(event) => setEquipmentStatus(event.target.value as AreaEquipmentStatus)}><option value="active">{t("properties.equipmentStatus.active")}</option><option value="out-of-service">{t("properties.equipmentStatus.out-of-service")}</option><option value="retired">{t("properties.equipmentStatus.retired")}</option></select></label>
                <label className="field"><span>{t("properties.equipmentManufacturer")}</span><input value={equipmentManufacturer} onChange={(event) => setEquipmentManufacturer(event.target.value)} /></label>
                <label className="field"><span>{t("properties.equipmentModel")}</span><input value={equipmentModel} onChange={(event) => setEquipmentModel(event.target.value)} /></label>
                <label className="field"><span>{t("properties.equipmentSerialNumber")}</span><input value={equipmentSerialNumber} onChange={(event) => setEquipmentSerialNumber(event.target.value)} /></label>
                <fieldset className="inventory-form-pin">
                  <legend>{t("properties.inventoryManualPin")}</legend>
                  <p>{t("properties.inventoryManualPinHelp")}</p>
                  <details
                    className="inventory-pin-map-picker"
                    open={equipmentPinMapOpen}
                    onToggle={(event) => setEquipmentPinMapOpen(event.currentTarget.open)}
                  >
                    <summary><MapIcon size={15} aria-hidden="true" />{t("properties.inventoryChooseOnMap")}</summary>
                    {equipmentPinMapOpen && <div className="inventory-pin-map-body">
                      <p>{t("properties.inventoryMapHint")}</p>
                      <div className="inventory-pin-map-shell">
                        <Suspense fallback={<output className="property-loading"><LoaderCircle className="spin" />{t("common.loading")}</output>}>
                          <PropertyAreaMap
                            areas={areas}
                            houses={houses}
                            propertyLocation={property.location}
                            propertyLabel={property.name}
                            selectedAreaId={null}
                            selectedEquipmentId={EQUIPMENT_DRAFT_MAP_ID}
                            editableEquipmentId={EQUIPMENT_DRAFT_MAP_ID}
                            equipment={equipmentPinMapItem ? [equipmentPinMapItem] : []}
                            onSelectArea={() => undefined}
                            onSelectHouse={() => undefined}
                            onSelectAsset={() => undefined}
                            onSelectEquipment={() => undefined}
                            onMoveEquipment={updateEquipmentPinFromMap}
                            onAppendVertex={() => undefined}
                            vertexLabel={() => ""}
                            midpointLabel={() => ""}
                            viewportKey={`inventory-pin:${property.id}`}
                            ariaLabel={t("properties.inventoryMapAria", {
                              name: equipmentName.trim() || t("properties.inventoryManualPin"),
                            })}
                          />
                        </Suspense>
                      </div>
                    </div>}
                  </details>
                  <label className="field"><span>{t("weather.latitude")}</span><input type="number" min={-90} max={90} step="any" inputMode="decimal" value={equipmentLatitude} onChange={(event) => setEquipmentLatitude(event.target.value)} /></label>
                  <label className="field"><span>{t("weather.longitude")}</span><input type="number" min={-180} max={180} step="any" inputMode="decimal" value={equipmentLongitude} onChange={(event) => setEquipmentLongitude(event.target.value)} /></label>
                  {!equipmentPinEmpty && <button type="button" className="text-button inventory-pin-clear" onClick={() => { setEquipmentLatitude(""); setEquipmentLongitude(""); }}>{t("properties.inventoryClearPin")}</button>}
                  {!equipmentPinValid && <p className="inline-error" role="alert">{t("weather.invalidLocation")}</p>}
                </fieldset>
                <label className="field inventory-form-notes"><span>{t("properties.equipmentNotes")}</span><textarea rows={3} value={equipmentNotes} onChange={(event) => setEquipmentNotes(event.target.value)} /></label>
                <div className="inventory-form-actions"><button type="submit" className="primary-button" disabled={pending || !equipmentName.trim() || !equipmentKind.trim() || !equipmentPinValid}><Save size={14} aria-hidden="true" />{pending ? t("common.saving") : editingEquipmentId ? t("properties.saveEquipment") : t("properties.addEquipment")}</button>{editingEquipmentId && <button type="button" className="secondary-button" onClick={() => { clearEquipmentDraft("unassigned"); setInventoryFormOpen(false); }}>{t("common.cancel")}</button>}</div>
              </form>
            </details>}
          </section>}

          {tab === "map" && selectedArea && <details className="panel property-secondary-tools">
            <summary><HardHat size={17} aria-hidden="true" /><span><strong>{t("properties.areaOperations")}</strong><small>{selectedArea.name}</small></span><ChevronRight size={17} aria-hidden="true" /></summary>
            <section className="property-assets-grid" aria-label={t("properties.assets")}>
            <section className="panel">
              <div className="panel-header"><div><span className="eyebrow">{selectedArea?.name ?? t("properties.selectArea")}</span><h2>{t("properties.equipment")}</h2></div><HardHat size={20} /></div>
              {!selectedArea ? <p className="property-empty-copy">{t("properties.selectAreaHelp")}</p> : <>
                {equipment.filter((item) => item.areaId === selectedArea.id).length ? <div className="equipment-list">{equipment.filter((item) => item.areaId === selectedArea.id).map((item) => <article key={item.id}><div><strong>{item.name}</strong><small>{item.kind} · {t(`properties.equipmentStatus.${item.status}`)}</small>{item.notes && <p>{item.notes}</p>}</div>{!readOnly && <div><button type="button" className="icon-button small" aria-label={`${t("properties.editInventoryItem")}: ${item.name}`} onClick={() => beginEquipmentEdit(item)}><ClipboardList size={14} /></button><button type="button" className="icon-button small danger-icon" aria-label={`${t("common.delete")}: ${item.name}`} onClick={() => void removeEquipment(item.id)}><Trash2 size={14} /></button></div>}</article>)}</div> : <p className="property-empty-copy">{t("properties.noEquipment")}</p>}
                {!readOnly && <button type="button" className="primary-button" onClick={() => { clearEquipmentDraft(`area:${selectedArea.id}`); setInventoryFormOpen(true); setTab("inventory"); }}><Plus size={14} />{t("properties.addEquipment")}</button>}
              </>}
            </section>
            <section className="panel">
              <div className="panel-header"><div><span className="eyebrow">{selectedArea?.name ?? t("properties.selectArea")}</span><h2>{t("properties.planMaintenance")}</h2></div><Wrench size={20} /></div>
              {!selectedArea ? <p className="property-empty-copy">{t("properties.selectAreaHelp")}</p> : <>
                {selectedAreaTasks.length > 0 ? <div className="area-maintenance-list">{selectedAreaTasks.map((task) => {
                  const taskEquipment = equipment.find((item) => item.id === task.equipmentId);
                  return <article key={task.id}><div><strong>{task.title}</strong><small>{t(`maintenance.status.${task.status}`)}{taskEquipment ? ` · ${taskEquipment.name}` : ""}</small>{task.description && <p>{task.description}</p>}</div>{(task.dueBy || task.plannedFor) && <time dateTime={task.dueBy ?? task.plannedFor ?? undefined}>{task.dueBy ? t("maintenance.dueDate", { date: task.dueBy }) : t("maintenance.plannedDate", { date: task.plannedFor ?? "" })}</time>}</article>;
                })}</div> : <p className="property-empty-copy">{t("properties.noAreaMaintenance")}</p>}
                {readOnly ? <p className="property-help">{t("properties.readOnlyMaintenance")}</p> : <form className="maintenance-area-form" onSubmit={(event) => void planMaintenance(event)}><label className="field"><span>{t("properties.workTitle")}</span><input required value={maintenanceTitle} onChange={(event) => setMaintenanceTitle(event.target.value)} /></label>{houses.length > 0 && <label className="field"><span>{t("common.house")} · {t("common.optional")}</span><select value={maintenanceHouseId} onChange={(event) => setMaintenanceHouseId(event.target.value)}><option value="">{t("properties.noSchedulingHouse")}</option>{houses.map((house) => <option key={house.id} value={house.id}>{house.name}</option>)}</select></label>}<label className="field"><span>{t("properties.equipmentOptional")}</span><select value={maintenanceEquipmentId} onChange={(event) => setMaintenanceEquipmentId(event.target.value)}><option value="">{t("properties.wholeArea")}</option>{equipment.filter((item) => item.areaId === selectedArea.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="submit" className="primary-button" disabled={pending || !maintenanceTitle.trim()}><Wrench size={14} />{t("properties.planWork")}</button></form>}
              </>}
            </section>
            </section>
          </details>}

          {tab === "notes" && <section id="property-panel-notes" className="property-notes-grid" role="tabpanel" aria-labelledby="property-tab-notes"><section className="panel"><div className="panel-header"><div><span className="eyebrow">{property.name}</span><h2>{t("properties.notes")}</h2></div><NotebookPen size={20} /></div>{notes.length ? <div className="property-note-list">{notes.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((note) => <article key={note.id}><div><span>{t(`properties.noteKind.${note.kind}`)}</span><strong>{targetLabel(note, state, t("properties.inventoryUnknownHome"))}</strong><p>{note.text}</p><time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleDateString()}</time></div>{!readOnly && <div><button type="button" className="icon-button small" disabled={pending} aria-label={`${t("common.edit")}: ${note.text}`} onClick={() => { setEditingNoteId(note.id); setNoteText(note.text); setNoteKind(note.kind); setNoteTarget(note.equipmentId ? `equipment:${note.equipmentId}` : note.areaId ? `area:${note.areaId}` : note.houseId ? `house:${note.houseId}` : "property:"); setNoteFormOpen(true); }}><ClipboardList size={14} /></button><button type="button" className="icon-button small danger-icon" disabled={pending} aria-label={`${t("common.delete")}: ${note.text}`} onClick={() => void removeNote(note.id)}><Trash2 size={14} /></button></div>}</article>)}</div> : <p className="property-empty-copy">{t("properties.noNotes")}</p>}</section>{!readOnly && <details className="panel property-note-editor" open={noteFormOpen} onToggle={(event) => setNoteFormOpen(event.currentTarget.open)}><summary><Plus size={17} aria-hidden="true" /><span><strong>{editingNoteId ? t("properties.editNote") : t("properties.newNote")}</strong><small>{t("properties.recordContext")}</small></span><ChevronRight size={17} aria-hidden="true" /></summary><form className="property-note-form" onSubmit={(event) => void saveNote(event)}><label className="field"><span>{t("properties.noteKind")}</span><select value={noteKind} onChange={(event) => setNoteKind(event.target.value as PropertyNote["kind"])}><option value="note">{t("properties.noteKind.note")}</option><option value="inspection">{t("properties.noteKind.inspection")}</option><option value="maintenance">{t("properties.noteKind.maintenance")}</option></select></label><label className="field"><span>{t("properties.assignTo")}</span><select value={noteTarget} onChange={(event) => setNoteTarget(event.target.value)}><option value="property:">{property.name}</option>{editingNoteId && noteTarget.startsWith("house:") && !state.houses.some((house) => `house:${house.id}` === noteTarget) && <option value={noteTarget}>{t("properties.inventoryUnknownHome")}</option>}<optgroup label={t("properties.houses")}>{houses.map((house) => <option key={house.id} value={`house:${house.id}`}>{house.name}</option>)}</optgroup><optgroup label={t("properties.areas")}>{areas.map((area) => <option key={area.id} value={`area:${area.id}`}>{area.name}</option>)}</optgroup><optgroup label={t("properties.equipment")}>{equipment.map((item) => <option key={item.id} value={`equipment:${item.id}`}>{item.name}</option>)}</optgroup></select></label><label className="field"><span>{t("properties.noteText")}</span><textarea required rows={5} value={noteText} onChange={(event) => setNoteText(event.target.value)} /></label><div className="property-note-actions"><button type="button" className="secondary-button" onClick={() => { setNoteFormOpen(false); setEditingNoteId(null); setNoteText(""); setNoteKind("note"); setNoteTarget("property:"); }}>{t("common.cancel")}</button><button type="submit" className="primary-button" disabled={pending || !noteText.trim()}><Save size={14} />{t("properties.saveNote")}</button></div></form></details>}</section>}

          {tab === "access" && canManageAccess && <section id="property-panel-access" role="tabpanel" aria-labelledby="property-tab-access"><AccessPanel
            state={state}
            properties={[property]}
            canRemoveGuests={false}
          /></section>}
          {feedback && <p className={`property-feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
        </div>
      </div>
    </div>;
}
