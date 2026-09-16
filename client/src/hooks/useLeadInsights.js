import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";

/**
 * useLeadInsights — maturity, message counts and frein for a conversation list.
 *
 * One POST /api/lead-insights per platform covers the first 200 conversations
 * shown. Everything except the frein is computed by the server at read time.
 *
 * Conversations have no single stable id (CLAUDE.md §6), so insights are keyed
 * by the customer id, and getInsight() falls back to the server's
 * keyToCustomer map for thread-keyed (`t_…`) rows.
 */

const PLATFORMS = new Set(["instagram", "facebook", "whatsapp", "email"]);
const MAX_ITEMS = 200;
const EMPTY = { insights: {}, keyToCustomer: {} };

/** The customer behind a conversation, as the server keys insights. */
export const customerIdOf = (conv, platform) => {
  if (!conv) return "";
  const id =
    platform === "email"
      ? conv.email || conv.participants?.[0]?.email || conv.id
      : conv.participants?.[0]?.id || conv.id;
  return id === undefined || id === null ? "" : String(id);
};

/** FNV-1a, 32 bit — a short, stable fingerprint for the query key. */
const fingerprint = (text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

const noRetryOnClientError = (failureCount, error) => {
  const status = error?.response?.status;
  if (status && status < 500 && status !== 429) return false;
  return failureCount < 1;
};

export const useLeadInsights = ({ platform, conversations, token }) => {
  const queryClient = useQueryClient();
  const supported = PLATFORMS.has(platform);

  const items = useMemo(() => {
    if (!supported || !Array.isArray(conversations)) return [];
    const seen = new Set();
    const out = [];
    for (const conv of conversations) {
      if (out.length >= MAX_ITEMS) break;
      if (!conv || conv.id === undefined || conv.id === null) continue;
      const key = String(conv.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, customerId: customerIdOf(conv, platform) });
    }
    return out;
  }, [conversations, platform, supported]);

  // Order-insensitive: a new message reordering the list must not refetch.
  const signature = useMemo(() => {
    if (items.length === 0) return "0";
    const text = items
      .map((it) => `${it.key}>${it.customerId}`)
      .sort()
      .join("|");
    return `${items.length}:${fingerprint(text)}`;
  }, [items]);

  const query = useQuery({
    queryKey: ["leadInsights", platform, signature],
    queryFn: async ({ signal }) => {
      const res = await axios.post(
        "/api/lead-insights",
        { platform, items },
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 30000,
          signal,
        },
      );
      return {
        insights: res.data?.insights || {},
        keyToCustomer: res.data?.keyToCustomer || {},
      };
    },
    enabled: Boolean(token) && supported && items.length > 0,
    staleTime: 20 * 1000,
    refetchInterval: 60 * 1000,
    retry: noRetryOnClientError,
    // Keep the chips on screen while a changed list refetches, but never
    // borrow another platform's data.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey?.[1] === platform ? previousData : undefined,
  });

  const data = supported ? query.data || EMPTY : EMPTY;

  const getInsight = useCallback(
    (conv) => {
      if (!conv) return null;
      const direct = data.insights[customerIdOf(conv, platform)];
      if (direct) return direct;
      const mapped = data.keyToCustomer[String(conv.id)];
      return (mapped && data.insights[mapped]) || null;
    },
    [data, platform],
  );

  const saveFrein = useCallback(
    async (conv, code, note) => {
      if (!supported) throw new Error("Plateforme non prise en charge.");
      if (!conv) throw new Error("Conversation introuvable.");
      const conversationId = String(conv.id ?? "");
      const customerId = customerIdOf(conv, platform);
      const res = await axios.put(
        "/api/lead-insights/frein",
        { platform, customerId, conversationId, code, note },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 },
      );
      const frein = res.data?.frein || null;

      // Show the new frein at once; the refetch below brings the maturity.
      if (frein) {
        queryClient.setQueriesData(
          { queryKey: ["leadInsights", platform] },
          (old) => {
            if (!old?.insights) return old;
            const targets = new Set(
              [customerId, old.keyToCustomer?.[conversationId]].filter(
                (id) => id && old.insights[id],
              ),
            );
            if (targets.size === 0) return old;
            const insights = { ...old.insights };
            for (const id of targets) {
              insights[id] = {
                ...insights[id],
                frein,
                needsQualification: false,
              };
            }
            return { ...old, insights };
          },
        );
      }
      queryClient.invalidateQueries({ queryKey: ["leadInsights", platform] });
      return frein;
    },
    [platform, supported, token, queryClient],
  );

  return {
    getInsight,
    saveFrein,
    refetch: query.refetch,
    isLoading: supported && query.isLoading,
  };
};

export default useLeadInsights;
