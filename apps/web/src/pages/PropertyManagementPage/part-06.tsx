import { type ChangeEvent, type FormEvent } from "react";
import { confirmAction } from "../../components/ConfirmationProvider";
import type {
  EquipmentAttachment,
  EquipmentAttachmentKind,
  EquipmentLink,
} from "@climate-twin/contracts";
import { api } from "../../api";
import "../PropertyManagementPage.css";
import { MAX_EQUIPMENT_ATTACHMENT_BYTES, equipmentAttachmentMimeType, fileDataUrl } from "./support";
import { usePropertyManagementPagePart05 } from "./part-05";
export function usePropertyManagementPagePart06(context: ReturnType<typeof usePropertyManagementPagePart05>) {
  const { props, t, canManageAccess, setTab, property, readOnly, houses, houseReadOnly, setMapLoaded, areas, equipment, notes, setDrawing, pending, setPending, setFeedback, setTrackedEquipment, setTrackingEndpoints, setEquipmentAttachments, setEquipmentLinks, setEquipmentResourcesState, equipmentResourcesBusy, setEquipmentResourcesBusy, setEquipmentResourcesFeedback, equipmentLinkLabel, setEquipmentLinkLabel, equipmentLinkUrl, setEquipmentLinkUrl, setSelectedEndpointId, setNoteText, noteTarget, editingNoteId, setEditingNoteId, setPlacementEditing, setAssetPlacementEditing, trackingEnabled, selectedEquipment, selectedTracking } = context;
  const moveHouse = async (houseId: string, nextPropertyId: string) => {
      if (!property || readOnly || pending || nextPropertyId === property.id) return;
      const movingHouse = houses.find((house) => house.id === houseId);
      if (!movingHouse || houseReadOnly(movingHouse)) return;
      if (movingHouse && !await confirmAction(t("properties.moveHouseConfirm", { name: movingHouse.name }), t("confirmation.move"), false)) return;
      setPending(true);
      setFeedback(null);
      try {
        await props.onUpdateHouse(houseId, { propertyId: nextPropertyId });
        setFeedback({ kind: "success", text: t("properties.houseMoved") });
      } catch {
        setFeedback({ kind: "error", text: t("properties.houseMoveFailed") });
      } finally {
        setPending(false);
      }
    };
  const removeEquipment = async (id: string) => {
      const item = equipment.find((candidate) => candidate.id === id);
      if (readOnly || pending || !item || !await confirmAction(t("properties.deleteEquipmentConfirm", { name: item.name }), t("confirmation.delete"))) return;
      setPending(true);
      try { await props.onDeleteEquipment(id); setFeedback({ kind: "success", text: t("properties.equipmentDeleted") }); }
      catch { setFeedback({ kind: "error", text: t("properties.equipmentDeleteFailed") }); }
      finally { setPending(false); }
    };
  const uploadEquipmentAttachments = async (
      event: ChangeEvent<HTMLInputElement>,
      kind: EquipmentAttachmentKind,
    ) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (!selectedEquipment || readOnly || equipmentResourcesBusy || files.length === 0) return;
      const invalidSize = files.find((file) => file.size < 1 || file.size > MAX_EQUIPMENT_ATTACHMENT_BYTES);
      if (invalidSize) {
        setEquipmentResourcesFeedback({
          kind: "error",
          text: t("properties.inventoryAttachmentTooLarge", { name: invalidSize.name }),
        });
        return;
      }
      const typedFiles = files.map((file) => ({ file, mimeType: equipmentAttachmentMimeType(file, kind) }));
      const invalidType = typedFiles.find((item) => !item.mimeType);
      if (invalidType) {
        setEquipmentResourcesFeedback({
          kind: "error",
          text: t("properties.inventoryAttachmentUnsupported", { name: invalidType.file.name }),
        });
        return;
      }
      setEquipmentResourcesBusy(true);
      setEquipmentResourcesFeedback(null);
      try {
        for (const { file, mimeType } of typedFiles) {
          const attachment = await api.uploadEquipmentAttachment(selectedEquipment.id, {
            kind,
            name: file.name,
            mimeType: mimeType!,
            data: await fileDataUrl(file, mimeType!),
          });
          setEquipmentAttachments((current) => [attachment, ...current]);
        }
        setEquipmentResourcesState("ready");
        setEquipmentResourcesFeedback({
          kind: "success",
          text: t("properties.inventoryAttachmentsUploaded", { count: files.length }),
        });
      } catch {
        setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryAttachmentUploadFailed") });
      } finally {
        setEquipmentResourcesBusy(false);
      }
    };
  const removeEquipmentAttachment = async (attachment: EquipmentAttachment) => {
      if (!selectedEquipment || readOnly || equipmentResourcesBusy
        || !await confirmAction(t("properties.inventoryAttachmentDeleteConfirm", { name: attachment.name }), t("confirmation.delete"))) return;
      setEquipmentResourcesBusy(true);
      setEquipmentResourcesFeedback(null);
      try {
        await api.deleteEquipmentAttachment(selectedEquipment.id, attachment.id);
        setEquipmentAttachments((current) => current.filter((item) => item.id !== attachment.id));
        setEquipmentResourcesFeedback({ kind: "success", text: t("properties.inventoryAttachmentDeleted") });
      } catch {
        setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryAttachmentDeleteFailed") });
      } finally {
        setEquipmentResourcesBusy(false);
      }
    };
  const addEquipmentLink = async (event: FormEvent) => {
      event.preventDefault();
      if (!selectedEquipment || readOnly || equipmentResourcesBusy
        || !equipmentLinkLabel.trim() || !equipmentLinkUrl.trim()) return;
      setEquipmentResourcesBusy(true);
      setEquipmentResourcesFeedback(null);
      try {
        const link = await api.createEquipmentLink(selectedEquipment.id, {
          label: equipmentLinkLabel.trim(),
          url: equipmentLinkUrl.trim(),
        });
        setEquipmentLinks((current) => [...current, link].sort((left, right) => left.label.localeCompare(right.label)));
        setEquipmentLinkLabel("");
        setEquipmentLinkUrl("");
        setEquipmentResourcesFeedback({ kind: "success", text: t("properties.inventoryLinkAdded") });
      } catch {
        setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryLinkAddFailed") });
      } finally {
        setEquipmentResourcesBusy(false);
      }
    };
  const removeEquipmentLink = async (link: EquipmentLink) => {
      if (!selectedEquipment || readOnly || equipmentResourcesBusy
        || !await confirmAction(t("properties.inventoryLinkDeleteConfirm", { label: link.label }), t("confirmation.delete"))) return;
      setEquipmentResourcesBusy(true);
      setEquipmentResourcesFeedback(null);
      try {
        await api.deleteEquipmentLink(selectedEquipment.id, link.id);
        setEquipmentLinks((current) => current.filter((item) => item.id !== link.id));
        setEquipmentResourcesFeedback({ kind: "success", text: t("properties.inventoryLinkDeleted") });
      } catch {
        setEquipmentResourcesFeedback({ kind: "error", text: t("properties.inventoryLinkDeleteFailed") });
      } finally {
        setEquipmentResourcesBusy(false);
      }
    };
  const refreshInventoryTracking = async () => {
      if (!property || !trackingEnabled) return;
      const [equipmentStates, endpoints] = await Promise.all([
        api.trackedEquipment(property.id),
        canManageAccess ? api.trackingEndpoints(property.id) : Promise.resolve([]),
      ]);
      setTrackedEquipment(equipmentStates);
      if (canManageAccess) setTrackingEndpoints(endpoints);
    };
  const bindEndpoint = async (endpointId: string) => {
      if (!selectedEquipment || !canManageAccess || pending) return;
      setPending(true);
      setFeedback(null);
      try {
        await api.bindTrackingEndpoint(selectedEquipment.id, endpointId);
        await refreshInventoryTracking();
        setSelectedEndpointId("");
        setFeedback({ kind: "success", text: t("properties.trackingEndpointBound") });
      } catch {
        setFeedback({ kind: "error", text: t("properties.trackingEndpointBindFailed") });
      } finally {
        setPending(false);
      }
    };
  const unbindEndpoint = async () => {
      if (!selectedEquipment || !selectedTracking?.binding || !canManageAccess || pending) return;
      if (!await confirmAction(
        t("properties.trackingEndpointUnbindConfirm", {
          endpoint: selectedTracking.endpoint.displayName,
          equipment: selectedEquipment.name,
        }),
        t("properties.trackingEndpointUnbind"),
      )) return;
      setPending(true);
      setFeedback(null);
      try {
        await api.unbindTrackingEndpoint(selectedEquipment.id);
        await refreshInventoryTracking();
        setFeedback({ kind: "success", text: t("properties.trackingEndpointUnbound") });
      } catch {
        setFeedback({ kind: "error", text: t("properties.trackingEndpointUnbindFailed") });
      } finally {
        setPending(false);
      }
    };
  const showEquipmentOnMap = (equipmentId: string) => {
      context.changeMapAndInventoryEquipmentSelection(equipmentId);
      setPlacementEditing(false);
      setAssetPlacementEditing(false);
      setDrawing(false);
      setMapLoaded(true);
      setTab("map");
    };
  const removeNote = async (id: string) => {
      if (readOnly || pending || !await confirmAction(t("properties.deleteNoteConfirm"), t("confirmation.delete"))) return;
      setPending(true);
      setFeedback(null);
      try {
        await props.onDeleteNote(id);
        if (editingNoteId === id) {
          setEditingNoteId(null);
          setNoteText("");
        }
        setFeedback({ kind: "success", text: t("properties.noteDeleted") });
      } catch {
        setFeedback({ kind: "error", text: t("properties.noteDeleteFailed") });
      } finally {
        setPending(false);
      }
    };
  const noteTargetParts = () => {
      const separator = noteTarget.indexOf(":");
      if (separator < 0) return null;
      const target = { kind: noteTarget.slice(0, separator), id: noteTarget.slice(separator + 1) };
      if (target.kind === "property") return target.id ? null : target;
      if (target.kind === "house") {
        const retainedHouseId = notes.find((note) => note.id === editingNoteId)?.houseId;
        return houses.some((house) => house.id === target.id) || retainedHouseId === target.id ? target : null;
      }
      if (target.kind === "area") return areas.some((area) => area.id === target.id) ? target : null;
      if (target.kind === "equipment") return equipment.some((item) => item.id === target.id) ? target : null;
      return null;
    };
  return Object.assign(context, { moveHouse, removeEquipment, uploadEquipmentAttachments, removeEquipmentAttachment, addEquipmentLink, removeEquipmentLink, refreshInventoryTracking, bindEndpoint, unbindEndpoint, showEquipmentOnMap, removeNote, noteTargetParts });
}
