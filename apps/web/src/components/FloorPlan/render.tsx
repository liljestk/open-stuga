import { BoxSelect, Grid3X3, ImagePlus, MapPinPlus, MousePointer2, PenLine, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { isAirflowPlanElement, type PlanElementKind } from "@climate-twin/contracts";
import { type TranslationKey } from "../../i18n";
import { normalizeDegrees } from "../../outdoorContext";
import { PlanElementDimensionFields } from "../PlanElementDimensionFields";
import { PlanElementAirflowFields } from "../PlanElementAirflowFields";
import { PlanElementFixtureFields } from "../PlanElementFixtureFields";
import { OpeningInventory } from "../OpeningInventory";
import {
  defaultPlanElementWidth,
  effectivePlanElementHeight,
  isWallAttachedPlanElement,
} from "../../planElementGeometry";
import { PLAN_ELEMENT_KINDS, ROOM_KINDS } from "./support";
import type { FloorGridDensity } from "./support";
import { useFloorPlanPart05 } from "./part-05";
import { renderFloorPlanEditorSection } from "./render-section";
export function renderFloorPlan(context: ReturnType<typeof useFloorPlanPart05>) {
  const { floor, viewMode, editing, observationPlacement, allowBackgroundImageEditing, t, fileRef, roomNameInputRef, undoButtonRef, roomNameBeforeEdit, planElementRefs, mapHelpId, roomNameErrorId, wallLengthErrorId, selectedWallId, wallLengthDraft, setWallLengthDraft, wallLengthError, setWallLengthError, selectedPlanElementId, setSelectedPlanElementId, planElementKind, setPlanElementKind, roomNameError, setRoomNameError, deletedWallUndo, snapEnabled, setSnapEnabled, gridDensity, setGridDensity, addToolsOpen, setAddToolsOpen, editorOptionsOpen, setEditorOptionsOpen, placementAnnouncement, uploadError, metresPerPlanUnit, drawingWall, drawingRoom, placingElement, selectingLayout, selectedWall, selectedRoom, selectedPlanElement, selectedRoomSensorCount, roomName, chooseEditorTool, applyFloorChange, resetSelectedWallLengthDraft, commitSelectedWallLength, deleteWall, undoLastDeletion, updateRoom, commitRoomName, deleteRoom, updatePlanElement, updatePlanElementWidth, updatePlanElementHeight, deletePlanElement, uploadBackground, selectedElementWidthBounds, selectedElementHeightBounds, selectedElementRotation, selectedElementHasCardinalRotation, editorHint } = context;
  return (
      <div className="floor-plan-wrap">
        {editing && (
          <div className="editor-toolbar" role="toolbar" aria-label={t("twin.editTools")}>
            <div className="editor-mode-tools" role="group" aria-label={t("twin.editMode")}>
              <button type="button" className={selectingLayout ? "tool-button active" : "tool-button"} aria-pressed={selectingLayout} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("select")}>
                <MousePointer2 size={16} aria-hidden="true" />{t("twin.selectMove")}
              </button>
              <details open={addToolsOpen} className="editor-tool-disclosure editor-add-tools">
                <summary className="tool-button" onClick={(event) => { event.preventDefault(); setEditorOptionsOpen(false); setAddToolsOpen((value) => !value); }}><Plus size={16} aria-hidden="true" />{t("common.add")}</summary>
                <div hidden={!addToolsOpen} className="editor-disclosure-content" role="group" aria-label={t("common.add")}>
                  <button type="button" className={drawingWall ? "tool-button active" : "tool-button"} aria-pressed={drawingWall} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("wall")}>
                    <PenLine size={16} aria-hidden="true" />{t("twin.drawWall")}
                  </button>
                  <button type="button" className={drawingRoom ? "tool-button active" : "tool-button"} aria-pressed={drawingRoom} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("room")}>
                    <BoxSelect size={16} aria-hidden="true" />{t("twin.addRoom")}
                  </button>
                  <div className="element-palette" role="group" aria-label={t("twin.planElements")}>
                    <label className="grid-size-control">
                      <span>{t("twin.planElement")}</span>
                      <select value={planElementKind} disabled={viewMode !== "plan"} aria-label={t("twin.planElement")} onChange={(event) => setPlanElementKind(event.target.value as PlanElementKind)}>
                        {PLAN_ELEMENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(`planElement.${kind}` as TranslationKey)}</option>)}
                      </select>
                    </label>
                    <button type="button" className={placingElement ? "tool-button active" : "tool-button"} aria-pressed={placingElement} disabled={viewMode !== "plan"} onClick={() => chooseEditorTool("element")}>
                      <Plus size={16} aria-hidden="true" />{t("twin.placeElement")}
                    </button>
                  </div>
                </div>
              </details>
            </div>
            <OpeningInventory
              floors={[floor]}
              selected={selectedPlanElementId ? { floorId: floor.id, elementId: selectedPlanElementId } : null}
              onSelect={(_floorId, elementId) => { chooseEditorTool("select"); setSelectedPlanElementId(elementId); window.setTimeout(() => planElementRefs.current.get(elementId)?.focus(), 0); }}
            />
            {deletedWallUndo && <button ref={undoButtonRef} type="button" className="tool-button" aria-keyshortcuts="Control+Z Meta+Z" onClick={undoLastDeletion}>{t("common.undo")}</button>}
            {selectedWall && (
              <div className="editor-properties wall-properties" role="group" aria-label={t("twin.wallProperties")}>
                <strong>{t("twin.wallProperties")}</strong>
                <label>
                  <span>{t("twin.wallLength")}</span>
                  <span className="input-suffix"><input
                    type="number"
                    min="0.01"
                    max="10000"
                    step="0.01"
                    inputMode="decimal"
                    value={wallLengthDraft}
                    placeholder={t("twin.wallLengthPlaceholder")}
                    aria-label={t("twin.wallLength")}
                    aria-invalid={wallLengthError ? true : undefined}
                    aria-describedby={wallLengthError ? wallLengthErrorId : undefined}
                    onChange={(event) => { setWallLengthDraft(event.currentTarget.value); setWallLengthError(null); }}
                    onBlur={commitSelectedWallLength}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                      if (event.key === "Escape") { event.preventDefault(); resetSelectedWallLengthDraft(); }
                    }}
                  /><span>m</span></span>
                </label>
                <span className="editor-properties-note">{t(metresPerPlanUnit === null ? "twin.wallLengthCalibrationHelp" : "twin.wallLengthScaleHelp")}</span>
                {wallLengthError && <span id={wallLengthErrorId} className="editor-field-error" role="alert">{wallLengthError}</span>}
              </div>
            )}
            {selectedRoom && (
              <div className="editor-properties" role="group" aria-label={t("twin.roomProperties")}>
                <strong>{t("twin.roomProperties")}</strong>
                <label><span>{t("twin.roomName")}</span><input ref={roomNameInputRef} required value={selectedRoom.name} aria-invalid={roomNameError ? true : undefined} aria-describedby={roomNameError ? roomNameErrorId : undefined} onFocus={() => { roomNameBeforeEdit.current = selectedRoom.name; }} onChange={(event) => { setRoomNameError(null); updateRoom(selectedRoom.id, { name: event.target.value }); }} onBlur={(event) => commitRoomName(selectedRoom.id, event.currentTarget.value)} /></label>
                <label><span>{t("twin.roomType")}</span><select value={selectedRoom.kind ?? "other"} onChange={(event) => updateRoom(selectedRoom.id, { kind: event.target.value })}>{selectedRoom.kind && !ROOM_KINDS.some((kind) => kind === selectedRoom.kind) && <option value={selectedRoom.kind}>{selectedRoom.kind}</option>}{ROOM_KINDS.map((kind) => <option key={kind} value={kind}>{roomName(kind, kind)}</option>)}</select></label>
                {roomNameError && <span id={roomNameErrorId} className="editor-field-error" role="alert">{roomNameError}</span>}
                {selectedRoomSensorCount > 0 && <span className="editor-properties-note">{t("twin.roomAssignmentsManaged", { count: selectedRoomSensorCount })}</span>}
              </div>
            )}
            {selectedPlanElement && (
              <div className="editor-properties" role="group" aria-label={t("twin.elementProperties")}>
                <strong>{t(`planElement.${selectedPlanElement.kind}` as TranslationKey)}</strong>
                {selectedElementWidthBounds && selectedElementHeightBounds && <PlanElementDimensionFields
                  widthLabel={t("twin.elementWidth")}
                  heightLabel={t("twin.elementHeight")}
                  planUnitLabel={t("twin.planUnit")}
                  metreLabel="m"
                  width={selectedPlanElement.width ?? defaultPlanElementWidth(floor, selectedPlanElement.kind)}
                  height={effectivePlanElementHeight(floor, selectedPlanElement)}
                  widthBounds={selectedElementWidthBounds}
                  heightBounds={selectedElementHeightBounds}
                  onWidthChange={(value) => updatePlanElementWidth(selectedPlanElement.id, value)}
                  onHeightChange={(value) => updatePlanElementHeight(selectedPlanElement.id, value)}
                />}
                {isAirflowPlanElement(selectedPlanElement) && <PlanElementAirflowFields floor={floor} element={selectedPlanElement} onChange={(patch) => updatePlanElement(selectedPlanElement.id, patch)} />}
                {(selectedPlanElement.kind === "fireplace" || selectedPlanElement.kind === "fireEscape") && <PlanElementFixtureFields floor={floor} element={selectedPlanElement} planUnitLabel={t("twin.planUnit")} onChange={(patch) => updatePlanElement(selectedPlanElement.id, patch)} />}
                {!isWallAttachedPlanElement(selectedPlanElement) && <label><span>{t("twin.elementRotation")}</span><select value={selectedElementRotation} onChange={(event) => updatePlanElement(selectedPlanElement.id, { rotationDegrees: Number(event.currentTarget.value) })}>{!selectedElementHasCardinalRotation && <option value={selectedElementRotation}>{selectedElementRotation}°</option>}{[0, 90, 180, 270].map((degrees) => <option key={degrees} value={degrees}>{degrees}°</option>)}</select></label>}
                {isWallAttachedPlanElement(selectedPlanElement)
                  ? <button type="button" className="tool-button" onClick={() => updatePlanElement(selectedPlanElement.id, { rotationDegrees: normalizeDegrees(selectedPlanElement.rotationDegrees + 180) })}><RotateCw size={16} aria-hidden="true" />{t("twin.flipElement")}</button>
                  : <>
                    <button type="button" className="tool-button" aria-keyshortcuts="Shift+R" onClick={() => updatePlanElement(selectedPlanElement.id, { rotationDegrees: normalizeDegrees(selectedPlanElement.rotationDegrees - 90) })}><RotateCcw size={16} aria-hidden="true" />{t("twin.rotateElementLeft")}</button>
                    <button type="button" className="tool-button" aria-keyshortcuts="R" onClick={() => updatePlanElement(selectedPlanElement.id, { rotationDegrees: normalizeDegrees(selectedPlanElement.rotationDegrees + 90) })}><RotateCw size={16} aria-hidden="true" />{t("twin.rotateElementRight")}</button>
                  </>}
              </div>
            )}
            <details open={editorOptionsOpen} className="editor-tool-disclosure editor-options">
              <summary className="tool-button" onClick={(event) => { event.preventDefault(); setAddToolsOpen(false); setEditorOptionsOpen((value) => !value); }}><Grid3X3 size={16} aria-hidden="true" />{t("twin.editorOptions")}</summary>
              <div hidden={!editorOptionsOpen} className="editor-disclosure-content" role="group" aria-label={t("twin.editorOptions")}>
                <button type="button" className={snapEnabled ? "tool-button active" : "tool-button"} aria-pressed={snapEnabled} disabled={viewMode !== "plan"} title={t("twin.snapBypass")} onClick={() => setSnapEnabled((value) => !value)}>
                  <Grid3X3 size={16} aria-hidden="true" />{t("twin.snapToGrid")}
                </button>
                <label className="grid-size-control">
                  <span>{t("twin.gridSize")}</span>
                  <select value={gridDensity} disabled={viewMode !== "plan"} aria-label={t("twin.gridSize")} onChange={(event) => setGridDensity(event.target.value as FloorGridDensity)}>
                    <option value="fine">{t("twin.gridFine")}</option>
                    <option value="medium">{t("twin.gridMedium")}</option>
                    <option value="coarse">{t("twin.gridCoarse")}</option>
                  </select>
                </label>
                {allowBackgroundImageEditing && <><button type="button" className="tool-button" onClick={() => fileRef.current?.click()}><ImagePlus size={16} aria-hidden="true" />{t("twin.uploadPlan")}</button>
                <input ref={fileRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadBackground} aria-label={t("twin.uploadPlan")} />
                {floor.backgroundImage && <button type="button" className="tool-button danger-tool" onClick={() => { const { backgroundImage: _, ...rest } = floor; applyFloorChange(rest); }}><Trash2 size={16} aria-hidden="true" />{t("twin.removePlan")}</button>}</>}
                {selectedWallId && <button type="button" className="tool-button danger-tool" disabled={viewMode !== "plan"} onClick={() => deleteWall()}><Trash2 size={16} aria-hidden="true" />{t("twin.deleteWall")}</button>}
                {selectedRoom && <button type="button" className="tool-button danger-tool" onClick={() => deleteRoom()} disabled={selectedRoomSensorCount > 0}><Trash2 size={16} aria-hidden="true" />{t("twin.deleteRoom")}</button>}
                {selectedPlanElement && <button type="button" className="tool-button danger-tool" onClick={() => deletePlanElement()}><Trash2 size={16} aria-hidden="true" />{t("twin.deleteElement")}</button>}
              </div>
            </details>
            <span className="editor-hint">{editorHint}</span>
            {uploadError && <span className="editor-error" role="alert">{uploadError}</span>}
          </div>
        )}
        {observationPlacement && <div className="placement-banner"><MapPinPlus size={17} aria-hidden="true" /><span>{t("observations.locationHint")}<small>{t("twin.keyboardPlacement")}</small></span></div>}
        {(placementAnnouncement || editing || observationPlacement) && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{placementAnnouncement || (observationPlacement ? `${t("observations.locationHint")} ${t("twin.keyboardPlacement")}` : editorHint)}</p>}
        {renderFloorPlanEditorSection(context)}
        <span id={mapHelpId} className="sr-only">{t("twin.keyboardPlacement")}</span>
      </div>
    );
}