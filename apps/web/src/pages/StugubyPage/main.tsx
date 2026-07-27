import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { House, Property } from "@climate-twin/contracts";
import {
  STUGBY_DATASETS,
  type StugubyDataset,
  type StugubyDatasetGrant,
  type StugubyMember,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import { AlertTriangle, Check, Copy, Database, KeyRound, Link, LoaderCircle, Network, Pencil, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, Unplug, Users } from "lucide-react";
import {
  api,
  type StugubyDetailResponse,
  type StugubyInvitationCreated,
  type StugubyListResponse,
  type StugubyLocalMember,
  type StugubyLocalPublicationCatalog,
  type StugubyRemoteTelemetrySample,
} from "../../api";
import { StugubyMark } from "../../components/StugubyMark";
import { useI18n, type TranslationKey } from "../../i18n";
import { CloudflareSetupPanel } from "../CloudflareSetupPanel";
import "../StugubyPage.css";
import { MemberIdentity, activeGrant, datasetLabelKeys, editableHomeDatasets, errorMessage, formattedTime, grantHomeName, idlePublicationCatalog, initialDatasetDraft, localDateTimeInput, loopbackOrigin, memberStateLabelKeys, parseArray, roleLabelKeys, suggestedCoordinatorOrigin } from "./support";
import type { DatasetDraft, PublicationCatalogState, StugubyPageProps } from "./support";
import { useStugubyPagePart01 } from "./part-01";
import { useStugubyPagePart02 } from "./part-02";
import { useStugubyPagePart03 } from "./part-03";
import { renderStugubyPage } from "./render";

export function StugubyPage({ houses, properties = [], onInventoryChange }: Readonly<StugubyPageProps>) {
  const context0 = { houses, properties, onInventoryChange };
  const context1 = useStugubyPagePart01(context0);
  const context2 = useStugubyPagePart02(context1);
  const context3 = useStugubyPagePart03(context2);
  return renderStugubyPage(context3);
}
