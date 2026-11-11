import { useMutation, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AdaptiveSettingsPatch, AdaptiveReviewInput, AdaptiveKind, DataMode } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { useCancelInactiveQuery } from "../useCancelInactiveQuery";

export function useAdaptiveMonitoringQuery(input: { houseId: string; dataMode: DataMode; enabled: boolean; findingId: string | null; includeHistory: boolean; kind?: AdaptiveKind | undefined }) {
  const baseKey = ["house", input.houseId, "adaptive-monitoring", input.dataMode];
  const queryKey = [...baseKey, input.kind ?? "all"];
  const query = useInfiniteQuery({
    queryKey, enabled: input.enabled && Boolean(input.houseId), staleTime: 15_000, refetchInterval: input.enabled ? 60_000 : false,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api.adaptiveMonitoring(input.houseId, { dataMode: input.dataMode, signal, kind: input.kind,
      ...(pageParam ? { streamCursor: pageParam } : {}) }),
    getNextPageParam: page => page.streams.nextCursor,
  }, queryClient);
  const findingKey = [...queryKey, "findings", input.includeHistory];
  const findings = useInfiniteQuery({
    queryKey: findingKey, enabled: input.enabled && Boolean(input.houseId), staleTime: 15_000,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => api.adaptiveFindings(input.houseId, { dataMode: input.dataMode, signal, kind: input.kind, activeOnly: !input.includeHistory,
      ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: page => page.nextCursor,
  }, queryClient);
  const detailKey = [...queryKey, "finding", input.findingId];
  const detail = useQuery({ queryKey: detailKey, enabled: input.enabled && Boolean(input.findingId), staleTime: 15_000,
    queryFn: ({ signal }) => api.adaptiveFinding(input.houseId, { dataMode: input.dataMode, findingId: input.findingId!, signal }),
  }, queryClient);
  useCancelInactiveQuery(queryKey, input.enabled);
  useCancelInactiveQuery(findingKey, input.enabled);
  useCancelInactiveQuery(detailKey, input.enabled && Boolean(input.findingId));
  const settings = useMutation({
    mutationFn: (patch: AdaptiveSettingsPatch) => api.updateAdaptiveSettings(input.houseId, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: baseKey }),
  }, queryClient);
  const review = useMutation({
    mutationFn: (review: { findingId: string; body: AdaptiveReviewInput }) => api.reviewAdaptiveFinding(input.houseId, review.findingId, review.body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: baseKey }),
  }, queryClient);
  return { ...query, data: query.data?.pages[0],
    streams: query.data?.pages.flatMap(page => page.streams.items) ?? [], findings, detail, settings, review };
}
