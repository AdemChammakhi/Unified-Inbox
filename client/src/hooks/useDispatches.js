import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { customerIdOf } from "./useLeadInsights";

/**
 * useDispatches — the discussions an admin handed out, as the inbox sees
 * them.
 *
 * Two queries: `mine` (every role) is the signed-in user's open dispatches
 * on every platform, what gets pinned at the top of their list; `board`
 * (admin and manager) is every open dispatch, so an admin sees who holds
 * what and the picker can show each agent's load. Both are keyed by the
 * customer id (CLAUDE.md §6), resolved from a conversation the same way the
 * lead insights are.
 *
 * The Inbox invalidates ["dispatch"] on the `dispatch:changed` socket
 * event, so a dispatch made from the Leads page or the admin dashboard
 * reaches the agent's list without a reload.
 */

const EMPTY = [];

const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

export const useDispatches = ({ token, role }) => {
  const queryClient = useQueryClient();
  const isStaff = role === "admin" || role === "manager";

  const mine = useQuery({
    queryKey: ["dispatch", "mine"],
    queryFn: async ({ signal }) => {
      const res = await axios.get("/api/dispatch/mine", { ...auth(token), signal });
      return res.data?.items || EMPTY;
    },
    enabled: Boolean(token),
    staleTime: 20 * 1000,
    refetchInterval: 60 * 1000,
  });

  const board = useQuery({
    queryKey: ["dispatch", "board"],
    queryFn: async ({ signal }) => {
      const res = await axios.get("/api/dispatch", {
        ...auth(token),
        params: { status: "open" },
        signal,
      });
      return res.data?.items || EMPTY;
    },
    enabled: Boolean(token) && isStaff,
    staleTime: 20 * 1000,
    refetchInterval: 60 * 1000,
  });

  const mineItems = mine.data || EMPTY;
  const boardItems = board.data || EMPTY;

  const mineByCustomer = useMemo(() => {
    const map = new Map();
    for (const d of mineItems) map.set(`${d.platform}:${d.customerId}`, d);
    return map;
  }, [mineItems]);

  const boardByCustomer = useMemo(() => {
    const map = new Map();
    for (const d of boardItems) map.set(`${d.platform}:${d.customerId}`, d);
    return map;
  }, [boardItems]);

  /** Open dispatches per platform, for the tab badges. */
  const counts = useMemo(() => {
    const out = {};
    for (const d of mineItems) out[d.platform] = (out[d.platform] || 0) + 1;
    return out;
  }, [mineItems]);

  /** Open dispatches per agent id, for the picker. */
  const loadByAgent = useMemo(() => {
    const out = {};
    for (const d of boardItems) {
      if (d.agentId) out[d.agentId] = (out[d.agentId] || 0) + 1;
    }
    return out;
  }, [boardItems]);

  const keysOf = (conv, platform) => {
    const keys = [];
    const cid = customerIdOf(conv, platform);
    if (cid) keys.push(`${platform}:${cid}`);
    if (conv?.id !== undefined && conv?.id !== null) keys.push(`${platform}:${conv.id}`);
    return keys;
  };

  /** My open dispatch for this conversation, or null. */
  const getMine = useCallback(
    (conv, platform) => {
      for (const k of keysOf(conv, platform)) {
        const hit = mineByCustomer.get(k);
        if (hit) return hit;
      }
      return null;
    },
    [mineByCustomer],
  );

  /** Anyone's open dispatch for this conversation (staff only), or null. */
  const getOpen = useCallback(
    (conv, platform) => {
      for (const k of keysOf(conv, platform)) {
        const hit = boardByCustomer.get(k);
        if (hit) return hit;
      }
      return null;
    },
    [boardByCustomer],
  );

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["dispatch"] }),
    [queryClient],
  );

  const dispatch = useCallback(
    async ({ platform, customerId, agentId, note }) => {
      const res = await axios.post(
        "/api/dispatch",
        { platform, customerId, agentId, note: note || "" },
        auth(token),
      );
      await refresh();
      return res.data?.dispatch || null;
    },
    [token, refresh],
  );

  const markDone = useCallback(
    async (id) => {
      const res = await axios.put(`/api/dispatch/${encodeURIComponent(id)}/done`, {}, auth(token));
      await refresh();
      return res.data?.dispatch || null;
    },
    [token, refresh],
  );

  const reassign = useCallback(
    async (id, agentId, note) => {
      const res = await axios.put(
        `/api/dispatch/${encodeURIComponent(id)}/reassign`,
        note === undefined ? { agentId } : { agentId, note },
        auth(token),
      );
      await refresh();
      return res.data?.dispatch || null;
    },
    [token, refresh],
  );

  const cancel = useCallback(
    async (id) => {
      const res = await axios.delete(`/api/dispatch/${encodeURIComponent(id)}`, auth(token));
      await refresh();
      return res.data?.dispatch || null;
    },
    [token, refresh],
  );

  return {
    mine: mineItems,
    board: boardItems,
    counts,
    loadByAgent,
    getMine,
    getOpen,
    refresh,
    dispatch,
    markDone,
    reassign,
    cancel,
  };
};

export default useDispatches;
