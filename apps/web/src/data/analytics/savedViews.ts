import { useAuthorizationRevision } from "../useAuthorizationRevision";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AnalyticsViewDefinition, DataMode } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";

type ViewMutation = { action: "create"; name: string; definition: AnalyticsViewDefinition }
  | { action: "update"; id: string; baseRevision: number; name: string; definition: AnalyticsViewDefinition }
  | { action: "delete"; id: string; baseRevision: number };
export function useSavedAnalyticsViews(houseId: string, dataMode: DataMode) {
  const revision = useAuthorizationRevision();
  const queryKey = ["saved-analytics-views", revision, houseId, dataMode];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api.savedAnalyticsViews(houseId, dataMode, signal), retry: false }, queryClient);
  const mutation = useMutation({
    mutationFn: async (input: ViewMutation) => {
      if (input.action === "delete") { await api.deleteAnalyticsView({ id: input.id, baseRevision: input.baseRevision, houseId, dataMode }); return null; }
      const body = { name: input.name, definition: input.definition, houseId, dataMode };
      return input.action === "create" ? api.saveAnalyticsView(body)
        : api.updateAnalyticsView({ ...body, id: input.id, baseRevision: input.baseRevision });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  }, queryClient);
  return { query, mutation };
}
