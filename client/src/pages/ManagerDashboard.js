import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import axios from "axios";
import { io } from "socket.io-client";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";
import {
  Search,
  RefreshCw,
  MessageSquare,
  BarChart3,
  Users,
  TrendingUp,
  Clock,
  CheckCircle2,
  Activity,
  Unlock,
} from "lucide-react";
import PlatformIcon from "../components/PlatformIcon";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

/* ── Constants ── */
const CLASSIFICATION_LABELS = {
  non_classifie: "Non Classifié",
  cible: "Cible",
  hors_cible: "Hors Cible",
  suivi: "Suivi",
  priorite: "Priorité",
};

const CLASSIFICATION_COLORS = {
  non_classifie: "#6B6780",
  cible: "#6ECC8B",
  hors_cible: "#E06C6C",
  suivi: "#7BA3CC",
  priorite: "#D4A24C",
};

const CHART_COLORS = ["#C8956A", "#6ECC8B", "#7BA3CC", "#E06C6C", "#D4A24C"];

const TABS = [
  { key: "chats", label: "Chats", icon: MessageSquare },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "agents", label: "Agent Activity", icon: Users },
];

const PLATFORMS = [
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "email", label: "Email" },
];

/* ════════════════════════════════════════════════════════════════════════
   MANAGER DASHBOARD
   ════════════════════════════════════════════════════════════════════════ */
const ManagerDashboard = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /* ── Top-level tab ── */
  const [activeMainTab, setActiveMainTab] = useState("chats");

  /* ════════════════════════════════════════
     CHAT STATE
     ════════════════════════════════════════ */
  const [selectedConv, setSelectedConv] = useState(null);
  const [activeTab, setActiveTab] = useState("instagram");
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [classifications, setClassifications] = useState({});
  const [classFilter, setClassFilter] = useState("all");
  const [locks, setLocks] = useState({});
  const [unreadCounts, setUnreadCounts] = useState({
    instagram: 0,
    facebook: 0,
    whatsapp: 0,
    email: 0,
  });
  const [unreadConvIds, setUnreadConvIds] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const audioCtxRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const selectedConvRef = useRef(selectedConv);
  const conversationsRef = useRef([]);

  /* ════════════════════════════════════════
     ANALYTICS STATE
     ════════════════════════════════════════ */
  const [analyticsRange, setAnalyticsRange] = useState(7);
  const [analytics, setAnalytics] = useState(null);
  const [agentStats, setAgentStats] = useState([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);

  /* ════════════════════════════════════════
     AGENT ACTIVITY STATE
     ════════════════════════════════════════ */
  const [agentLocks, setAgentLocks] = useState([]);
  const [agentLocksLoading, setAgentLocksLoading] = useState(true);

  /* ════════════════════════════════════════════════════════════════════
     CHAT LOGIC (adapted from Inbox.js)
     ════════════════════════════════════════════════════════════════════ */

  // React Query — fetch conversations
  const {
    data: conversations = [],
    isLoading: convLoading,
    error: convError,
  } = useQuery({
    queryKey: ["conversations", activeTab],
    queryFn: async ({ queryKey }) => {
      const [, tab] = queryKey;
      const token = user?.token;
      if (!token) return [];
      const opts = {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60000,
      };
      let newConvs = [];
      if (tab === "instagram") {
        const res = await axios.get(
          "/api/instagram/conversations?slim=1",
          opts,
        );
        newConvs = res.data.conversations || [];
      } else if (tab === "facebook") {
        const res = await axios.get("/api/facebook/conversations?slim=1", opts);
        newConvs = res.data.conversations || [];
      } else if (tab === "whatsapp") {
        const res = await axios.get("/api/whatsapp/conversations?slim=1", opts);
        newConvs = res.data.conversations || [];
      } else if (tab === "email") {
        const res = await axios.get("/api/email/conversations", opts);
        newConvs = res.data.conversations || [];
      }
      const cached = queryClient.getQueryData(["conversations", tab]) || [];
      const socketOnly = cached.filter(
        (c) =>
          c._fromSocket &&
          !newConvs.some(
            (n) =>
              n.id === c.id ||
              n.participants?.some((p) =>
                c.participants?.some((cp) => cp.id === p.id),
              ),
          ),
      );
      const mergedConvs = newConvs.map((newConv) => {
        const cachedConv = cached.find((c) => c.id === newConv.id);
        if (!cachedConv) return newConv;
        const mergedMessages =
          cachedConv.messages?.length > 0
            ? cachedConv.messages
            : newConv.messages;
        const serverTime = new Date(newConv.lastMessage?.time || 0).getTime();
        const cachedTime = new Date(
          cachedConv.lastMessage?.time || 0,
        ).getTime();
        const mergedLastMessage =
          cachedTime > serverTime
            ? cachedConv.lastMessage
            : newConv.lastMessage;
        return {
          ...newConv,
          messages: mergedMessages,
          lastMessage: mergedLastMessage,
          _messagesLoaded:
            cachedConv._messagesLoaded || newConv._messagesLoaded,
        };
      });
      return [...socketOnly, ...mergedConvs];
    },
    enabled: !!user?.token && activeMainTab === "chats",
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) =>
      error?.response?.status === 401 ? false : failureCount < 1,
  });

  const fetchError =
    convError?.response?.data?.message || convError?.message || null;

  // Handle auth errors
  useEffect(() => {
    if (convError?.response?.status === 401) {
      logout();
      navigate("/login");
    }
  }, [convError, logout, navigate]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Keep refs in sync
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  useEffect(() => {
    selectedConvRef.current = selectedConv;
  }, [selectedConv]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Socket.IO connection
  useEffect(() => {
    if (!user?.token) return;

    const socketUrl =
      process.env.NODE_ENV === "development"
        ? "http://localhost:5000"
        : window.location.origin;

    const socket = io(socketUrl, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
      auth: { token: user?.token },
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnectionStatus("connected");
      if (user?._id) socket.emit("join", user._id);
    });
    socket.on("disconnect", () => setConnectionStatus("disconnected"));
    socket.on("connect_error", () => {});
    socket.on("reconnect", () => setConnectionStatus("connected"));

    // New message handler
    socket.on("newMessage", (data) => {
      const { platform, message } = data;
      const currentTab = activeTabRef.current;
      const currentConv = selectedConvRef.current;

      const incomingConvId = data.conversationId || data.senderId;
      const isCurrentlyOpen =
        currentConv &&
        (currentConv.id === incomingConvId ||
          currentConv.participants?.some((p) => p.id === data.senderId));
      if (!isCurrentlyOpen) {
        setUnreadConvIds((prev) => new Set([...prev, incomingConvId]));
      }

      if (platform === currentTab) {
        const convs = conversationsRef.current;
        const isKnown = convs.some(
          (c) =>
            c.id === data.conversationId ||
            c.participants?.some((p) => p.id === data.senderId),
        );

        if (!isKnown) {
          const tempConv = {
            id: data.conversationId || data.senderId,
            participants: [
              {
                id: data.senderId,
                name: data.senderName || message.from || "New User",
              },
            ],
            lastMessage: {
              text: message.text,
              from: data.senderName || message.from || "New User",
              time: message.time,
            },
            messages: [
              {
                id: message.id,
                text: message.text,
                from: data.senderName || message.from || "New User",
                fromId: message.fromId || data.senderId,
                time: message.time,
              },
            ],
            _fromSocket: true,
          };
          queryClient.setQueryData(
            ["conversations", currentTab],
            (prev = []) => [tempConv, ...(prev || [])],
          );
        }

        if (!isKnown) {
          setTimeout(
            () =>
              queryClient.invalidateQueries({
                queryKey: ["conversations", currentTab],
              }),
            5000,
          );
          setTimeout(
            () =>
              queryClient.invalidateQueries({
                queryKey: ["conversations", currentTab],
              }),
            15000,
          );
        }

        if (currentConv) {
          const matchesSelected =
            currentConv.id === data.conversationId ||
            currentConv.participants?.some((p) => p.id === data.senderId);
          if (matchesSelected) {
            setSelectedConv((prev) => {
              if (!prev) return prev;
              const newMsg = {
                id: message.id,
                text: message.text,
                from: message.from,
                fromId: message.fromId,
                time: message.time,
              };
              const existingIdx = (prev.messages || []).findIndex(
                (m) => m.id === message.id,
              );
              if (existingIdx !== -1) {
                const updated = [...prev.messages];
                updated[existingIdx] = {
                  ...updated[existingIdx],
                  from: message.from,
                };
                return { ...prev, messages: updated };
              }
              return {
                ...prev,
                messages: [...(prev.messages || []), newMsg],
                lastMessage: {
                  text: message.text,
                  from: message.from,
                  time: message.time,
                },
              };
            });
          }
        }

        if (isKnown) {
          queryClient.setQueryData(
            ["conversations", currentTab],
            (prev = []) =>
              (prev || []).map((c) => {
                const matches =
                  c.id === data.conversationId ||
                  c.participants?.some((p) => p.id === data.senderId);
                if (!matches) return c;
                const existingIdx = (c.messages || []).findIndex(
                  (m) => m.id === message.id,
                );
                if (existingIdx !== -1) {
                  const msgs = [...c.messages];
                  msgs[existingIdx] = {
                    ...msgs[existingIdx],
                    from: message.from,
                  };
                  return {
                    ...c,
                    lastMessage: {
                      text: message.text,
                      from: message.from,
                      time: message.time,
                    },
                    messages: msgs,
                  };
                }
                return {
                  ...c,
                  lastMessage: {
                    text: message.text,
                    from: message.from,
                    time: message.time,
                  },
                  messages: [
                    ...(c.messages || []),
                    {
                      id: message.id,
                      text: message.text,
                      from: message.from,
                      fromId: message.fromId,
                      time: message.time,
                    },
                  ],
                };
              }),
          );
        }
      } else {
        setUnreadCounts((prev) => ({
          ...prev,
          [platform]: (prev[platform] || 0) + 1,
        }));
      }

      // Notification sound
      try {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new (
            window.AudioContext || window.webkitAudioContext
          )();
        }
        const ctx = audioCtxRef.current;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.35);
      } catch {}
    });

    // Sent message confirmation
    socket.on("messageSent", (data) => {
      const { platform, message } = data;
      const currentTab = activeTabRef.current;
      const currentConv = selectedConvRef.current;

      if (platform === currentTab) {
        if (currentConv) {
          const matchesSelected =
            currentConv.id === data.conversationId ||
            currentConv.participants?.some((p) => p.id === data.recipientId);
          if (matchesSelected) {
            setSelectedConv((prev) => {
              if (!prev) return prev;
              const filtered = (prev.messages || []).filter(
                (m) =>
                  !(
                    m.id &&
                    m.id.startsWith("temp_") &&
                    m.text === message.text
                  ),
              );
              const exists = filtered.some((m) => m.id === message.id);
              if (exists) return { ...prev, messages: filtered };
              return {
                ...prev,
                messages: [...filtered, message],
                lastMessage: {
                  text: message.text,
                  from: message.from,
                  time: message.time,
                },
              };
            });
          }
        }

        queryClient.setQueryData(
          ["conversations", currentTab],
          (prev = []) =>
            (prev || []).map((c) => {
              const matches =
                c.id === data.conversationId ||
                c.participants?.some((p) => p.id === data.recipientId);
              if (!matches) return c;
              const filteredMsgs = (c.messages || []).filter(
                (m) =>
                  !(
                    m.id &&
                    m.id.startsWith("temp_") &&
                    m.text === message.text
                  ),
              );
              const exists = filteredMsgs.some((m) => m.id === message.id);
              const updatedMsgs = exists
                ? filteredMsgs
                : [...filteredMsgs, message];
              return {
                ...c,
                lastMessage: {
                  text: message.text,
                  from: message.from,
                  time: message.time,
                },
                messages: updatedMsgs,
              };
            }),
        );
      }
    });

    socket.on("messageStatus", () => {});
    socket.on("messageReaction", () => {});

    return () => socket.disconnect();
  }, [user?.token, user?._id]); // eslint-disable-line

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selectedConv?.messages?.length]);

  const fetchConversations = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["conversations", activeTab] });
  }, [activeTab, queryClient]);

  // Classifications
  const fetchClassifications = useCallback(async () => {
    const token = user?.token;
    if (!token) return;
    try {
      const res = await axios.get("/api/classifications", {
        params: { platform: activeTab },
        headers: { Authorization: `Bearer ${token}` },
      });
      setClassifications(res.data.classifications || {});
    } catch (error) {
      if (error.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
    }
  }, [activeTab, user?.token, logout, navigate]);

  // Locks (for chat sidebar)
  const fetchChatLocks = useCallback(async () => {
    const token = user?.token;
    if (!token) return;
    try {
      const res = await axios.get("/api/locks", {
        params: { platform: activeTab },
        headers: { Authorization: `Bearer ${token}` },
      });
      setLocks(res.data.locks || {});
    } catch (error) {
      if (error.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
    }
  }, [activeTab, user?.token, logout, navigate]);

  const updateClassification = async (conversationId, classification) => {
    try {
      const token = user?.token;
      await axios.put(
        "/api/classifications",
        { conversationId, platform: activeTab, classification },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setClassifications((prev) => ({
        ...prev,
        [conversationId]: classification,
      }));
    } catch (error) {
      alert("Failed to update classification");
    }
  };

  // Sorted + filtered conversations
  const sortedConversations = useMemo(() => {
    let filtered = conversations;
    if (classFilter !== "all") {
      filtered = conversations.filter((conv) => {
        const cls = classifications[conv.id] || "non_classifie";
        return cls === classFilter;
      });
    }
    if (searchDebounced.trim()) {
      const q = searchDebounced.toLowerCase();
      filtered = filtered.filter((conv) => {
        const name =
          conv.participants
            ?.map((p) => p.name)
            .join(" ")
            .toLowerCase() || "";
        const email = (conv.email || "").toLowerCase();
        const id = (conv.id || "").toLowerCase();
        const lastMsg = (conv.lastMessage?.text || "").toLowerCase();
        return (
          name.includes(q) ||
          email.includes(q) ||
          id.includes(q) ||
          lastMsg.includes(q)
        );
      });
    }
    return [...filtered].sort((a, b) => {
      const tA = new Date(a.lastMessage?.time || 0).getTime();
      const tB = new Date(b.lastMessage?.time || 0).getTime();
      return tB - tA;
    });
  }, [conversations, classifications, classFilter, searchDebounced]);

  // Keep selectedConv in sync
  useEffect(() => {
    if (!selectedConv || !conversations.length) return;
    const updated = conversations.find((c) => c.id === selectedConv.id);
    if (!updated) return;
    setSelectedConv((prev) =>
      prev ? { ...updated, messages: prev.messages } : prev,
    );
  }, [conversations]); // eslint-disable-line

  // Tab change effects
  useEffect(() => {
    if (activeMainTab === "chats") {
      fetchClassifications();
      fetchChatLocks();
      setUnreadCounts((prev) => ({ ...prev, [activeTab]: 0 }));
    }
  }, [activeTab, activeMainTab, fetchClassifications, fetchChatLocks]);

  // Lazy-load messages
  const handleSelectConv = useCallback(
    async (conv) => {
      setSelectedConv(conv);
      setUnreadConvIds((prev) => {
        if (!prev.has(conv.id)) return prev;
        const next = new Set(prev);
        next.delete(conv.id);
        return next;
      });

      if (!conv._messagesLoaded) {
        const platform = activeTabRef.current;
        let endpoint;
        if (platform === "facebook")
          endpoint = "/api/facebook/messages-paged";
        else if (platform === "instagram")
          endpoint = "/api/instagram/messages-paged";
        else if (platform === "whatsapp")
          endpoint = "/api/whatsapp/messages-paged";
        else return;

        try {
          const participantId = conv.participants?.[0]?.id;
          const res = await axios.get(endpoint, {
            params: { conversationId: conv.id, participantId, limit: 30 },
            headers: { Authorization: `Bearer ${user?.token}` },
          });

          const loadedMessages = res.data.messages || [];
          const cachedConvs =
            queryClient.getQueryData(["conversations", platform]) || [];
          const currentCached = cachedConvs.find((c) => c.id === conv.id);
          const existingMessages =
            currentCached?.messages ||
            selectedConvRef.current?.messages ||
            [];

          const merged = [...loadedMessages];
          existingMessages.forEach((em) => {
            if (!merged.some((m) => m.id === em.id)) merged.push(em);
          });
          merged.sort((a, b) => new Date(a.time) - new Date(b.time));

          setSelectedConv((prev) => {
            if (!prev || prev.id !== conv.id) return prev;
            return {
              ...prev,
              messages: merged,
              _hasMoreMessages: res.data.hasMore,
              _messagesLoaded: true,
            };
          });

          queryClient.setQueryData(
            ["conversations", platform],
            (prevConvs = []) =>
              prevConvs.map((c) =>
                c.id === conv.id
                  ? { ...c, _messagesLoaded: true, messages: merged }
                  : c,
              ),
          );
        } catch (err) {
          console.error("Failed to fetch messages:", err.message);
        }
      }
    },
    [user?.token, queryClient],
  );

  // Send reply
  const sendReply = async () => {
    if (!replyText.trim() || !selectedConv) return;
    const messageText = replyText.trim();
    setReplyText("");
    const tempId = "temp_" + Date.now();
    let sendRes;

    try {
      setSending(true);
      const token = user?.token;
      const recipient = selectedConv.participants?.[0];

      const optimisticMsg = {
        id: tempId,
        text: messageText,
        from: "You",
        fromId: "page",
        time: new Date().toISOString(),
        sending: true,
      };

      setSelectedConv((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: [...(prev.messages || []), optimisticMsg],
          lastMessage: {
            text: messageText,
            from: "You",
            time: optimisticMsg.time,
          },
        };
      });

      queryClient.setQueryData(["conversations", activeTab], (prev = []) =>
        (prev || []).map((c) => {
          if (c.id === selectedConv.id) {
            return {
              ...c,
              lastMessage: {
                text: messageText,
                from: "You",
                time: optimisticMsg.time,
              },
            };
          }
          return c;
        }),
      );

      if (activeTab === "instagram") {
        sendRes = await axios.post(
          "/api/instagram/send",
          {
            recipientId: recipient?.id || selectedConv.id,
            conversationId: selectedConv.id,
            message: messageText,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      } else if (activeTab === "facebook") {
        sendRes = await axios.post(
          "/api/facebook/send",
          {
            recipientId: recipient?.id || selectedConv.id,
            conversationId: selectedConv.id,
            message: messageText,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      } else if (activeTab === "whatsapp") {
        sendRes = await axios.post(
          "/api/whatsapp/send",
          {
            recipientId: recipient?.id || selectedConv.id,
            conversationId: selectedConv.id,
            message: messageText,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      } else if (activeTab === "email") {
        sendRes = await axios.post(
          "/api/email/send",
          {
            to: recipient?.email || selectedConv.email,
            conversationId: selectedConv.id,
            subject: selectedConv.subject || "Re: Conversation",
            text: messageText,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      }

      fetchChatLocks();

      const confirmedId = sendRes?.data?.messageId || tempId;
      setSelectedConv((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: (prev.messages || []).map((m) =>
            m.id === tempId ? { ...m, id: confirmedId, sending: false } : m,
          ),
        };
      });

      setTimeout(() => {
        queryClient.invalidateQueries({
          queryKey: ["conversations", activeTab],
        });
      }, 8000);
    } catch (error) {
      alert(
        "Failed to send message: " +
          (error.response?.data?.error ||
            error.response?.data?.message ||
            error.message),
      );
      setSelectedConv((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: (prev.messages || []).filter((m) => m.id !== tempId),
        };
      });
    } finally {
      setSending(false);
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     ANALYTICS LOGIC
     ════════════════════════════════════════════════════════════════════ */

  const fetchAnalytics = useCallback(
    async (range) => {
      const token = user?.token;
      if (!token) return;
      setAnalyticsLoading(true);
      try {
        const [summaryRes, agentsRes] = await Promise.all([
          axios.get(`/api/analytics/summary?range=${range}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          axios.get("/api/analytics/agents", {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        setAnalytics(summaryRes.data);
        setAgentStats(agentsRes.data?.agents || []);
      } catch (err) {
        console.error("Analytics fetch failed:", err.message);
      } finally {
        setAnalyticsLoading(false);
      }
    },
    [user?.token],
  );

  useEffect(() => {
    if (activeMainTab === "analytics") {
      fetchAnalytics(analyticsRange);
    }
  }, [activeMainTab, analyticsRange, fetchAnalytics]);

  const platformPieData = analytics
    ? (analytics.byPlatform || []).map((p) => ({
        name: p._id,
        value: p.count,
      }))
    : [];

  /* ════════════════════════════════════════════════════════════════════
     AGENT ACTIVITY LOGIC
     ════════════════════════════════════════════════════════════════════ */

  const fetchAgentLocks = useCallback(async () => {
    const token = user?.token;
    if (!token) return;
    try {
      const res = await axios.get("/api/locks/all", {
        headers: { Authorization: `Bearer ${token}` },
      });
      setAgentLocks(res.data.locks || []);
    } catch (error) {
      if (error.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
    } finally {
      setAgentLocksLoading(false);
    }
  }, [user?.token, logout, navigate]);

  useEffect(() => {
    if (activeMainTab === "agents") {
      fetchAgentLocks();
      const interval = setInterval(fetchAgentLocks, 15000);
      return () => clearInterval(interval);
    }
  }, [activeMainTab, fetchAgentLocks]);

  const handleUnlock = async (conversationId, platform) => {
    if (
      !window.confirm(
        "Remove this agent assignment? The conversation will be open for anyone to reply.",
      )
    )
      return;
    try {
      const token = user?.token;
      await axios.delete(`/api/locks/${encodeURIComponent(conversationId)}`, {
        params: { platform },
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchAgentLocks();
    } catch (error) {
      alert(
        "Failed to unlock: " +
          (error.response?.data?.message || error.message),
      );
    }
  };

  /* ════════════════════════════════════════════════════════════════════
     INJECT CSS
     ════════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    const styleId = "manager-dashboard-styles";
    const existing = document.getElementById(styleId);
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes mgrFadeUp {
        from { opacity: 0; transform: translateY(14px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes mgrSlideIn {
        from { opacity: 0; transform: translateX(-10px); }
        to { opacity: 1; transform: translateX(0); }
      }
      @keyframes mgrShimmer {
        0% { background-position: -200% center; }
        100% { background-position: 200% center; }
      }
      @keyframes mgrNewMsgPulse {
        0%, 100% { background-color: rgba(110, 204, 139, 0.04); }
        50% { background-color: rgba(110, 204, 139, 0.14); }
      }
      .mgr-conv-scroll::-webkit-scrollbar { width: 5px; }
      .mgr-conv-scroll::-webkit-scrollbar-track { background: transparent; }
      .mgr-conv-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
      .mgr-conv-scroll::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }
      .mgr-msg-scroll::-webkit-scrollbar { width: 5px; }
      .mgr-msg-scroll::-webkit-scrollbar-track { background: transparent; }
      .mgr-msg-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
      .mgr-conv-row:hover { background: var(--bg-hover) !important; }
      .mgr-tab-btn:hover { background: var(--bg-hover) !important; color: var(--text-primary) !important; }
      .mgr-filter-pill:hover { background: var(--bg-hover) !important; }
      .mgr-reply-field:focus { border-color: var(--accent) !important; box-shadow: 0 0 0 3px var(--accent-glow) !important; }
      .mgr-send-btn:hover:not(:disabled) { background: var(--accent-hover) !important; transform: translateY(-1px); }
      .mgr-send-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .mgr-refresh-icon:hover { background: var(--bg-hover) !important; transform: rotate(180deg); }
      .mgr-class-dropdown { appearance: none; -webkit-appearance: none; cursor: pointer; }
      .mgr-class-dropdown option { background: var(--bg-elevated); color: var(--text-primary); }
      .mgr-email-render img { max-width: 100% !important; height: auto !important; }
      .mgr-email-render a { color: var(--accent) !important; }
      .mgr-main-tab:hover { background: var(--bg-hover) !important; }
      .mgr-delete-btn:hover { background: var(--danger, #E06C6C) !important; color: #fff !important; border-color: var(--danger, #E06C6C) !important; }
      .mgr-unlock-btn:hover { background: var(--accent-hover) !important; transform: translateY(-1px); }
    `;
    document.head.appendChild(style);
    return () => {
      const el = document.getElementById(styleId);
      if (el) el.remove();
    };
  }, []);

  /* ════════════════════════════════════════════════════════════════════
     TIME HELPER
     ════════════════════════════════════════════════════════════════════ */
  const timeAgo = (t) => {
    if (!t) return "";
    const diff = Date.now() - new Date(t).getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return new Date(t).toLocaleDateString();
  };

  /* ════════════════════════════════════════════════════════════════════
     RENDER
     ════════════════════════════════════════════════════════════════════ */

  const isChat = activeMainTab === "chats";

  return (
    <DashboardLayout noPadding={isChat}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          fontFamily: "'Hanken Grotesk', sans-serif",
          background: "var(--gradient-bg)",
          overflow: "hidden",
        }}
      >
        {/* ── Accent shimmer line ── */}
        <div
          style={{
            height: "3px",
            background:
              "linear-gradient(90deg, transparent, var(--accent), var(--accent-alt), var(--accent), transparent)",
            backgroundSize: "200% auto",
            animation: "mgrShimmer 4s linear infinite",
            flexShrink: 0,
          }}
        />

        {/* ── Header with main tabs ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 28px",
            borderBottom: "1px solid var(--border-primary)",
            backgroundColor: "var(--bg-nav)",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <h2
              style={{
                margin: 0,
                fontFamily: "'Young Serif', Georgia, serif",
                fontSize: "20px",
                fontWeight: 400,
                color: "var(--text-primary)",
                letterSpacing: "0.3px",
              }}
            >
              📊 Manager Dashboard
            </h2>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 12px",
                borderRadius: "6px",
                backgroundColor: "var(--bg-card)",
                border: "1px solid var(--border-secondary)",
                fontSize: "10px",
                color: "var(--text-secondary)",
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                fontWeight: 700,
              }}
            >
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  backgroundColor:
                    connectionStatus === "connected" ? "#6ECC8B" : "#E06C6C",
                  boxShadow:
                    connectionStatus === "connected"
                      ? "0 0 8px rgba(110,204,139,0.6)"
                      : "0 0 8px rgba(224,108,108,0.6)",
                }}
              />
              {connectionStatus === "connected" ? "LIVE" : "OFFLINE"}
            </div>
          </div>

          {/* Main Tabs */}
          <div
            style={{
              display: "flex",
              gap: "3px",
              backgroundColor: "var(--bg-card)",
              borderRadius: "10px",
              padding: "4px",
              border: "1px solid var(--border-primary)",
            }}
          >
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.key}
                  className="mgr-main-tab"
                  onClick={() => {
                    setActiveMainTab(tab.key);
                    if (tab.key !== "chats") setSelectedConv(null);
                  }}
                  style={{
                    padding: "8px 16px",
                    border: "none",
                    borderRadius: "7px",
                    backgroundColor:
                      activeMainTab === tab.key
                        ? "var(--bg-hover)"
                        : "transparent",
                    color:
                      activeMainTab === tab.key
                        ? "var(--accent)"
                        : "var(--text-faint)",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: activeMainTab === tab.key ? 700 : 600,
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    transition: "all 0.2s ease",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    ...(activeMainTab === tab.key
                      ? {
                          boxShadow:
                            "0 2px 10px rgba(0,0,0,0.15), inset 0 1px 0 var(--accent-border)",
                        }
                      : {}),
                  }}
                >
                  <Icon size={15} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ══════════════════════════════════════
           TAB: CHATS
           ══════════════════════════════════════ */}
        {activeMainTab === "chats" && (
          <>
            {/* Platform sub-tabs */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "8px 28px",
                borderBottom: "1px solid var(--border-primary)",
                backgroundColor: "var(--bg-secondary)",
                gap: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "3px",
                  backgroundColor: "var(--bg-card)",
                  borderRadius: "10px",
                  padding: "4px",
                  border: "1px solid var(--border-primary)",
                }}
              >
                {PLATFORMS.map((p) => (
                  <button
                    key={p.key}
                    className="mgr-tab-btn"
                    style={{
                      padding: "7px 14px",
                      border: "none",
                      borderRadius: "7px",
                      backgroundColor:
                        activeTab === p.key
                          ? "var(--bg-hover)"
                          : "transparent",
                      color:
                        activeTab === p.key
                          ? "var(--accent)"
                          : "var(--text-faint)",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontWeight: activeTab === p.key ? 700 : 600,
                      fontFamily: "'Hanken Grotesk', sans-serif",
                      transition: "all 0.2s ease",
                      display: "flex",
                      alignItems: "center",
                      gap: "5px",
                      ...(activeTab === p.key
                        ? {
                            boxShadow:
                              "0 2px 10px rgba(0,0,0,0.15), inset 0 1px 0 var(--accent-border)",
                          }
                        : {}),
                    }}
                    onClick={() => {
                      setActiveTab(p.key);
                      setSelectedConv(null);
                    }}
                  >
                    <PlatformIcon platform={p.key} size={16} />
                    <span>{p.label}</span>
                    {unreadCounts[p.key] > 0 && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: "var(--danger)",
                          color: "#fff",
                          borderRadius: "4px",
                          minWidth: "16px",
                          height: "16px",
                          fontSize: "9px",
                          fontWeight: 700,
                          padding: "0 4px",
                        }}
                      >
                        {unreadCounts[p.key]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Chat layout */}
            <div
              style={{
                display: "flex",
                flex: "1 1 0%",
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              {/* ── Conversation Sidebar ── */}
              <div
                style={{
                  width: "370px",
                  minWidth: "310px",
                  borderRight: "1px solid var(--border-primary)",
                  display: "flex",
                  flexDirection: "column",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "14px 20px",
                    borderBottom: "1px solid var(--border-primary)",
                  }}
                >
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      color: "var(--text-faint)",
                      textTransform: "uppercase",
                      letterSpacing: "2px",
                    }}
                  >
                    Conversations
                  </span>
                  <button
                    className="mgr-refresh-icon"
                    onClick={fetchConversations}
                    style={{
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      color: "var(--text-faint)",
                      borderRadius: "6px",
                      width: "30px",
                      height: "30px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "all 0.35s ease",
                    }}
                    title="Refresh"
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>

                {/* Search */}
                <div style={{ padding: "10px 14px 4px" }}>
                  <div className="conv-search-wrap">
                    <Search size={14} className="conv-search-icon" />
                    <input
                      className="conv-search-input"
                      type="text"
                      placeholder="Search conversations…"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>

                {/* Classification Filter */}
                <div
                  style={{
                    display: "flex",
                    gap: "4px",
                    padding: "10px 14px",
                    borderBottom: "1px solid var(--border-primary)",
                    flexWrap: "wrap",
                    backgroundColor: "var(--bg-nav)",
                  }}
                >
                  {[
                    { key: "all", label: "All" },
                    { key: "non_classifie", label: "Unclassified" },
                    { key: "cible", label: "Cible" },
                    { key: "hors_cible", label: "Hors Cible" },
                    { key: "suivi", label: "Suivi" },
                    { key: "priorite", label: "Priorité" },
                  ].map((f) => (
                    <button
                      key={f.key}
                      className="mgr-filter-pill"
                      onClick={() => setClassFilter(f.key)}
                      style={{
                        padding: "4px 9px",
                        border: "1px solid var(--border-primary)",
                        borderRadius: "5px",
                        cursor: "pointer",
                        fontSize: "10px",
                        fontWeight: 600,
                        color: "var(--text-faint)",
                        backgroundColor: "transparent",
                        transition: "all 0.15s ease",
                        display: "flex",
                        alignItems: "center",
                        fontFamily: "'Hanken Grotesk', sans-serif",
                        ...(classFilter === f.key
                          ? {
                              backgroundColor:
                                f.key === "all"
                                  ? "var(--accent)"
                                  : CLASSIFICATION_COLORS[f.key] ||
                                    "var(--accent)",
                              color: "#fff",
                              fontWeight: 700,
                              borderColor: "transparent",
                            }
                          : {}),
                      }}
                    >
                      {f.key !== "all" && (
                        <span
                          style={{
                            display: "inline-block",
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            backgroundColor:
                              CLASSIFICATION_COLORS[f.key] || "transparent",
                            marginRight: 5,
                          }}
                        />
                      )}
                      {f.label}
                    </button>
                  ))}
                </div>

                {/* Conversation Items */}
                <div
                  className="mgr-conv-scroll"
                  style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}
                >
                  {convLoading ? (
                    <div style={{ padding: "12px" }}>
                      {[0, 1, 2, 3].map((i) => (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            padding: "12px",
                            gap: "10px",
                            borderBottom: "1px solid var(--border-primary)",
                          }}
                        >
                          <div
                            className="skeleton"
                            style={{
                              width: 38,
                              height: 38,
                              borderRadius: 10,
                              flexShrink: 0,
                            }}
                          />
                          <div style={{ flex: 1 }}>
                            <div
                              className="skeleton"
                              style={{
                                height: 12,
                                width: "60%",
                                marginBottom: 8,
                              }}
                            />
                            <div
                              className="skeleton"
                              style={{ height: 10, width: "80%" }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : sortedConversations.length === 0 ? (
                    <div
                      style={{
                        padding: "48px 20px",
                        textAlign: "center",
                        color: "var(--text-faint)",
                        fontSize: "13px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 32,
                          marginBottom: 10,
                          opacity: 0.3,
                        }}
                      >
                        ◇
                      </div>
                      {fetchError ? (
                        <span style={{ color: "#E06C6C", fontSize: 12 }}>
                          Error: {fetchError}
                        </span>
                      ) : (
                        "No conversations found"
                      )}
                    </div>
                  ) : (
                    sortedConversations.map((conv, index) => {
                      const cls =
                        classifications[conv.id] || "non_classifie";
                      const isSelected = selectedConv?.id === conv.id;
                      const isUnread = unreadConvIds.has(conv.id);
                      return (
                        <div
                          key={conv.id}
                          className="mgr-conv-row"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            padding: "13px 16px",
                            borderBottom:
                              "1px solid var(--border-primary)",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                            minHeight: "70px",
                            backgroundColor: isSelected
                              ? "var(--bg-hover)"
                              : isUnread
                                ? "rgba(110, 204, 139, 0.07)"
                                : "transparent",
                            borderLeft: `3px solid ${
                              isUnread && !isSelected
                                ? "#6ECC8B"
                                : CLASSIFICATION_COLORS[cls]
                            }`,
                            animation: isUnread && !isSelected
                              ? "mgrNewMsgPulse 2.5s ease-in-out 3"
                              : `mgrSlideIn 0.35s ease-out ${index * 0.04}s both`,
                          }}
                          onClick={() => handleSelectConv(conv)}
                        >
                          <div
                            style={{
                              width: "38px",
                              height: "38px",
                              borderRadius: "10px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontWeight: 700,
                              fontSize: "14px",
                              marginRight: "12px",
                              flexShrink: 0,
                              position: "relative",
                              background:
                                conv.participants?.[0]?.profilePicUrl
                                  ? "transparent"
                                  : `linear-gradient(135deg, ${CLASSIFICATION_COLORS[cls]}33, ${CLASSIFICATION_COLORS[cls]}11)`,
                              border: `2px solid ${CLASSIFICATION_COLORS[cls]}77`,
                              color: CLASSIFICATION_COLORS[cls],
                              overflow: "hidden",
                              padding: 0,
                            }}
                          >
                            {conv.participants?.[0]?.profilePicUrl ? (
                              <img
                                src={conv.participants[0].profilePicUrl}
                                alt={conv.participants[0].name}
                                style={{
                                  width: "100%",
                                  height: "100%",
                                  objectFit: "cover",
                                  borderRadius: "50%",
                                }}
                                onError={(e) => {
                                  e.target.style.display = "none";
                                  if (e.target.nextSibling)
                                    e.target.nextSibling.style.display =
                                      "flex";
                                }}
                              />
                            ) : null}
                            <span
                              style={{
                                display:
                                  conv.participants?.[0]?.profilePicUrl
                                    ? "none"
                                    : "flex",
                                width: "100%",
                                height: "100%",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {(
                                conv.participants?.[0]?.name || "?"
                              )[0].toUpperCase()}
                            </span>
                            <span
                              style={{
                                position: "absolute",
                                bottom: -3,
                                right: -3,
                                fontSize: 12,
                                filter:
                                  "drop-shadow(0 0 2px rgba(0,0,0,0.4))",
                              }}
                            >
                              <PlatformIcon
                                platform={activeTab}
                                size={13}
                              />
                            </span>
                          </div>
                          <div
                            style={{
                              flex: 1,
                              overflow: "hidden",
                              minWidth: 0,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <strong
                                style={{
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  flex: 1,
                                  fontSize: "13px",
                                  color: "var(--text-primary)",
                                  fontWeight:
                                    isUnread && !isSelected ? 800 : 600,
                                }}
                              >
                                {conv.participants
                                  ?.map((p) => p.name)
                                  .join(", ") || "Unknown"}
                              </strong>
                              {locks[conv.id] && (
                                <span
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "3px",
                                    fontSize: "10px",
                                    fontWeight: 600,
                                    color: "var(--accent)",
                                    backgroundColor: "var(--accent)11",
                                    border: "1px solid var(--accent)33",
                                    borderRadius: "6px",
                                    padding: "1px 7px",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={`Assigned to ${locks[conv.id].agentName}`}
                                >
                                  🔒{" "}
                                  {locks[conv.id].agentName?.split(" ")[0]}
                                </span>
                              )}
                              <span
                                title={CLASSIFICATION_LABELS[cls]}
                                style={{
                                  display: "inline-block",
                                  width: 8,
                                  height: 8,
                                  borderRadius: "50%",
                                  backgroundColor:
                                    CLASSIFICATION_COLORS[cls],
                                  flexShrink: 0,
                                  marginLeft: "auto",
                                  boxShadow: `0 0 4px ${CLASSIFICATION_COLORS[cls]}88`,
                                }}
                              />
                            </div>
                            <p
                              style={{
                                margin: "3px 0",
                                fontSize: "11px",
                                color: "var(--text-faint)",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {conv.lastMessage?.text || "No messages"}
                            </p>
                            <small
                              style={{
                                fontSize: "10px",
                                color: "var(--text-dim)",
                                display: "block",
                                marginTop: "2px",
                              }}
                            >
                              {timeAgo(conv.lastMessage?.time)}
                            </small>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* ── Message View ── */}
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  minWidth: 0,
                  background: "var(--gradient-msg)",
                }}
              >
                {selectedConv ? (
                  <>
                    {/* Message Header */}
                    <div
                      style={{
                        padding: "14px 24px",
                        borderBottom: "1px solid var(--border-primary)",
                        backgroundColor: "var(--bg-secondary)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                        }}
                      >
                        {selectedConv.participants?.[0]?.profilePicUrl && (
                          <img
                            src={
                              selectedConv.participants[0].profilePicUrl
                            }
                            alt={selectedConv.participants[0].name}
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: "50%",
                              objectFit: "cover",
                              flexShrink: 0,
                              border:
                                "2px solid var(--border-primary)",
                            }}
                            onError={(e) => {
                              e.target.style.display = "none";
                            }}
                          />
                        )}
                        <h3
                          style={{
                            margin: 0,
                            fontSize: "14px",
                            fontWeight: 700,
                            color: "var(--text-primary)",
                          }}
                        >
                          {selectedConv.participants
                            ?.map((p) => p.name)
                            .join(", ") || "Conversation"}
                        </h3>
                        <span
                          style={{
                            fontSize: "9px",
                            color: "var(--accent)",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "1.2px",
                            padding: "3px 10px",
                            borderRadius: "4px",
                            backgroundColor: "var(--accent-bg)",
                            border:
                              "1px solid var(--accent-border)",
                          }}
                        >
                          {activeTab.charAt(0).toUpperCase() +
                            activeTab.slice(1)}
                        </span>
                        <select
                          value={
                            classifications[selectedConv.id] ||
                            "non_classifie"
                          }
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            updateClassification(
                              selectedConv.id,
                              e.target.value,
                            )
                          }
                          className="mgr-class-dropdown"
                          style={{
                            padding: "2px 6px",
                            border:
                              "1px solid var(--border-primary)",
                            borderRadius: "4px",
                            fontSize: "9px",
                            fontWeight: 700,
                            cursor: "pointer",
                            backgroundColor: "var(--bg-secondary)",
                            outline: "none",
                            textTransform: "uppercase",
                            letterSpacing: "0.3px",
                            fontFamily:
                              "'Hanken Grotesk', sans-serif",
                            color:
                              CLASSIFICATION_COLORS[
                                classifications[selectedConv.id] ||
                                  "non_classifie"
                              ],
                            borderColor:
                              CLASSIFICATION_COLORS[
                                classifications[selectedConv.id] ||
                                  "non_classifie"
                              ] + "55",
                          }}
                        >
                          <option value="non_classifie">
                            Non Classifié
                          </option>
                          <option value="cible">Cible</option>
                          <option value="hors_cible">
                            Hors Cible
                          </option>
                          <option value="suivi">Suivi</option>
                          <option value="priorite">Priorité</option>
                        </select>
                        <button
                          className="mgr-delete-btn"
                          style={{
                            marginLeft: "auto",
                            border:
                              "1px solid var(--border-primary)",
                            borderRadius: "7px",
                            background: "transparent",
                            color: "var(--text-faint)",
                            cursor: "pointer",
                            fontSize: "14px",
                            width: "32px",
                            height: "32px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            transition: "all 0.2s ease",
                            flexShrink: 0,
                          }}
                          title="Delete this conversation"
                          onClick={async () => {
                            if (
                              !window.confirm(
                                "Delete this conversation and all its messages? This cannot be undone.",
                              )
                            )
                              return;
                            try {
                              await axios.delete(
                                "/api/conversations",
                                {
                                  headers: {
                                    Authorization: `Bearer ${user?.token}`,
                                  },
                                  data: {
                                    conversationId: selectedConv.id,
                                    platform: activeTab,
                                  },
                                },
                              );
                              queryClient.setQueryData(
                                ["conversations", activeTab],
                                (prev = []) =>
                                  (prev || []).filter(
                                    (c) =>
                                      c.id !== selectedConv.id,
                                  ),
                              );
                              setSelectedConv(null);
                            } catch (err) {
                              alert(
                                err.response?.data?.message ||
                                  "Failed to delete conversation",
                              );
                            }
                          }}
                        >
                          🗑
                        </button>
                      </div>
                    </div>

                    {/* Messages */}
                    <div
                      className="mgr-msg-scroll"
                      style={{
                        flex: 1,
                        overflowY: "auto",
                        padding: "20px 24px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                      }}
                    >
                      {selectedConv.messages?.map((msg, idx) => {
                        const isEmail = activeTab === "email";
                        const isOther =
                          msg.direction === "incoming" ||
                          (msg.fromId &&
                            msg.fromId ===
                              selectedConv.participants?.[0]?.id) ||
                          msg.from ===
                            selectedConv.participants?.[0]?.name;
                        return (
                          <div
                            key={msg.id || idx}
                            style={{
                              ...(isEmail
                                ? {
                                    width: "100%",
                                    padding: "18px 22px",
                                    borderRadius: "10px",
                                    fontSize: "13px",
                                    border:
                                      "1px solid var(--border-primary)",
                                    wordWrap: "break-word",
                                    lineHeight: 1.6,
                                  }
                                : {
                                    maxWidth: "68%",
                                    padding: "10px 16px",
                                    borderRadius: "14px",
                                    fontSize: "13px",
                                    wordWrap: "break-word",
                                    lineHeight: 1.55,
                                  }),
                              alignSelf: isEmail
                                ? "stretch"
                                : isOther
                                  ? "flex-start"
                                  : "flex-end",
                              backgroundColor: isEmail
                                ? "var(--bg-elevated)"
                                : isOther
                                  ? "var(--msg-received-bg)"
                                  : "var(--accent)",
                              color: isEmail
                                ? "var(--text-primary)"
                                : isOther
                                  ? "var(--msg-received-color)"
                                  : "var(--bg-primary)",
                              opacity: msg.sending ? 0.5 : 1,
                              animation: `mgrFadeUp 0.3s ease-out ${idx * 0.02}s both`,
                            }}
                          >
                            <small
                              style={{
                                fontSize: "10px",
                                color: "var(--text-muted)",
                                fontWeight: 600,
                                textTransform: "uppercase",
                                letterSpacing: "0.6px",
                                display: "block",
                                marginBottom: "2px",
                              }}
                            >
                              {msg.from}
                            </small>
                            {isEmail && msg.subject && (
                              <p
                                style={{
                                  margin: "6px 0 10px",
                                  fontWeight: 700,
                                  fontSize: 14,
                                  color: "var(--accent)",
                                }}
                              >
                                {msg.subject}
                              </p>
                            )}
                            {msg.html && isEmail ? (
                              <div
                                className="mgr-email-render"
                                style={{
                                  margin: "8px 0",
                                  overflow: "auto",
                                  maxHeight: 600,
                                }}
                                dangerouslySetInnerHTML={{
                                  __html: msg.html,
                                }}
                              />
                            ) : (
                              msg.text && (
                                <p
                                  style={{
                                    margin: "4px 0",
                                    whiteSpace: "pre-wrap",
                                  }}
                                >
                                  {msg.text}
                                </p>
                              )
                            )}
                            {/* Attachments */}
                            {msg.attachments &&
                              msg.attachments.length > 0 && (
                                <div style={{ marginTop: 8 }}>
                                  {msg.attachments.map(
                                    (att, attIdx) => {
                                      const mimeType =
                                        att.mime_type ||
                                        att.contentType ||
                                        "";
                                      const imageUrl =
                                        att.image_data?.url ||
                                        att.url ||
                                        att.file_url ||
                                        "";
                                      if (
                                        mimeType.startsWith(
                                          "image",
                                        ) ||
                                        att.image_data
                                      ) {
                                        return (
                                          <img
                                            key={attIdx}
                                            src={imageUrl}
                                            alt="attachment"
                                            style={{
                                              maxWidth: "100%",
                                              maxHeight: 300,
                                              borderRadius: 10,
                                              marginTop: 6,
                                              cursor: "pointer",
                                            }}
                                            onClick={() =>
                                              window.open(
                                                imageUrl,
                                                "_blank",
                                              )
                                            }
                                          />
                                        );
                                      }
                                      if (
                                        mimeType.startsWith(
                                          "video",
                                        ) ||
                                        att.video_data
                                      ) {
                                        return (
                                          <video
                                            key={attIdx}
                                            src={
                                              att.video_data
                                                ?.url ||
                                              att.url ||
                                              ""
                                            }
                                            controls
                                            style={{
                                              maxWidth: "100%",
                                              maxHeight: 300,
                                              borderRadius: 10,
                                              marginTop: 6,
                                            }}
                                          />
                                        );
                                      }
                                      if (
                                        mimeType.startsWith(
                                          "audio",
                                        )
                                      ) {
                                        return (
                                          <audio
                                            key={attIdx}
                                            src={
                                              att.url ||
                                              att.file_url ||
                                              ""
                                            }
                                            controls
                                            style={{
                                              marginTop: 6,
                                              width: "100%",
                                            }}
                                          />
                                        );
                                      }
                                      return (
                                        <a
                                          key={attIdx}
                                          href={
                                            att.url ||
                                            att.file_url ||
                                            "#"
                                          }
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          style={{
                                            display:
                                              "inline-flex",
                                            alignItems: "center",
                                            gap: 5,
                                            marginTop: 6,
                                            color:
                                              "var(--accent)",
                                            textDecoration:
                                              "none",
                                            fontSize: 12,
                                            padding: "5px 10px",
                                            borderRadius: 6,
                                            backgroundColor:
                                              "var(--accent-bg)",
                                            border:
                                              "1px solid var(--accent-border)",
                                          }}
                                        >
                                          📎{" "}
                                          {att.name ||
                                            att.filename ||
                                            "file"}
                                        </a>
                                      );
                                    },
                                  )}
                                </div>
                              )}
                            {!msg.text &&
                              (!msg.attachments ||
                                msg.attachments.length === 0) && (
                                <p
                                  style={{
                                    margin: "4px 0",
                                    whiteSpace: "pre-wrap",
                                  }}
                                >
                                  [Empty message]
                                </p>
                              )}
                            <small
                              style={{
                                fontSize: "9px",
                                color: "var(--text-dim)",
                                marginTop: "5px",
                                display: "block",
                              }}
                            >
                              {new Date(msg.time).toLocaleString()}
                            </small>
                          </div>
                        );
                      })}
                      <div ref={messagesEndRef} />
                    </div>

                    {/* Read-only observation bar */}
                    <div
                      style={{
                        display: "flex",
                        padding: "12px 20px",
                        borderTop: "1px solid var(--border-primary)",
                        backgroundColor: "var(--bg-secondary)",
                        gap: "8px",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "12px",
                          color: "var(--text-faint)",
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        👁️ Read-only view — monitoring conversations
                        {locks[selectedConv?.id] && (
                          <span
                            style={{
                              fontSize: "10px",
                              color: "var(--accent)",
                              backgroundColor: "var(--accent-bg)",
                              border: "1px solid var(--accent-border)",
                              borderRadius: "4px",
                              padding: "2px 8px",
                              fontWeight: 700,
                            }}
                          >
                            🔒 Assigned to {locks[selectedConv.id].agentName}
                          </span>
                        )}
                      </span>
                    </div>
                  </>
                ) : (
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div style={{ textAlign: "center" }}>
                      <div
                        style={{
                          fontSize: "52px",
                          color: "var(--border-primary)",
                          marginBottom: "16px",
                        }}
                      >
                        ◈
                      </div>
                      <p
                        style={{
                          color: "var(--text-faint)",
                          fontSize: "15px",
                          fontWeight: 600,
                          margin: "0 0 6px",
                        }}
                      >
                        Select a conversation
                      </p>
                      <p
                        style={{
                          color: "var(--text-dim)",
                          fontSize: "12px",
                          margin: 0,
                        }}
                      >
                        Choose from the sidebar to begin
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* ══════════════════════════════════════
           TAB: ANALYTICS
           ══════════════════════════════════════ */}
        {activeMainTab === "analytics" && (
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "28px 32px",
            }}
          >
            {/* Range Selector */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 20,
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontFamily: "'Young Serif', serif",
                  fontSize: "18px",
                  fontWeight: 700,
                  color: "var(--text-primary)",
                }}
              >
                Analytics Overview
              </h2>
              <div className="range-tabs">
                {[1, 7, 30].map((r) => (
                  <button
                    key={r}
                    className={`range-tab${analyticsRange === r ? " active" : ""}`}
                    onClick={() => setAnalyticsRange(r)}
                  >
                    {r === 1 ? "Today" : r === 7 ? "7 days" : "30 days"}
                  </button>
                ))}
              </div>
            </div>

            {analyticsLoading ? (
              <div className="analytics-grid">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="analytics-card">
                    <div
                      className="skeleton"
                      style={{
                        height: 12,
                        width: "50%",
                        marginBottom: 10,
                      }}
                    />
                    <div
                      className="skeleton"
                      style={{ height: 28, width: "40%" }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {/* KPI Cards */}
                <div className="analytics-grid">
                  <div className="analytics-card">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <TrendingUp
                        size={16}
                        style={{ color: "#C8956A" }}
                      />
                      <div className="analytics-card-label">
                        Total ({analyticsRange}d)
                      </div>
                    </div>
                    <div
                      className="analytics-card-value"
                      style={{ color: "#C8956A" }}
                    >
                      {analytics?.totalInRange ?? "—"}
                    </div>
                    <div className="analytics-card-sub">
                      conversations
                    </div>
                  </div>
                  <div className="analytics-card">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Clock
                        size={16}
                        style={{ color: "#6ECC8B" }}
                      />
                      <div className="analytics-card-label">
                        Today
                      </div>
                    </div>
                    <div
                      className="analytics-card-value"
                      style={{ color: "#6ECC8B" }}
                    >
                      {analytics?.todayCount ?? "—"}
                    </div>
                    <div className="analytics-card-sub">
                      new today
                    </div>
                  </div>
                  <div className="analytics-card">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <CheckCircle2
                        size={16}
                        style={{ color: "#7BA3CC" }}
                      />
                      <div className="analytics-card-label">
                        This Week
                      </div>
                    </div>
                    <div
                      className="analytics-card-value"
                      style={{ color: "#7BA3CC" }}
                    >
                      {analytics?.weekCount ?? "—"}
                    </div>
                    <div className="analytics-card-sub">
                      last 7 days
                    </div>
                  </div>
                  <div className="analytics-card">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Activity
                        size={16}
                        style={{ color: "#D4A24C" }}
                      />
                      <div className="analytics-card-label">
                        Active Agents
                      </div>
                    </div>
                    <div
                      className="analytics-card-value"
                      style={{ color: "#D4A24C" }}
                    >
                      {analytics?.activeAgentCount ?? "—"}
                    </div>
                    <div className="analytics-card-sub">
                      agents working
                    </div>
                  </div>
                </div>

                {/* Charts */}
                <div className="charts-grid">
                  {/* Daily Volume */}
                  <div className="chart-card">
                    <div className="chart-card-title">
                      Daily Volume
                    </div>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart
                        data={analytics?.dailyData || []}
                        margin={{
                          top: 0,
                          right: 0,
                          left: -20,
                          bottom: 0,
                        }}
                      >
                        <XAxis
                          dataKey="date"
                          tick={{
                            fontSize: 11,
                            fill: "var(--text-faint)",
                          }}
                        />
                        <YAxis
                          tick={{
                            fontSize: 11,
                            fill: "var(--text-faint)",
                          }}
                          allowDecimals={false}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "var(--bg-card)",
                            border:
                              "1px solid var(--border-primary)",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          cursor={{ fill: "var(--bg-hover)" }}
                        />
                        <Bar
                          dataKey="total"
                          fill="#C8956A"
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Platform Pie */}
                  <div className="chart-card">
                    <div className="chart-card-title">
                      By Platform
                    </div>
                    {platformPieData.length === 0 ? (
                      <div
                        style={{
                          textAlign: "center",
                          padding: "40px 0",
                          color: "var(--text-faint)",
                          fontSize: 13,
                        }}
                      >
                        No data
                      </div>
                    ) : (
                      <ResponsiveContainer
                        width="100%"
                        height={240}
                      >
                        <PieChart>
                          <Pie
                            data={platformPieData}
                            cx="35%"
                            cy="50%"
                            innerRadius={45}
                            outerRadius={75}
                            paddingAngle={3}
                            dataKey="value"
                            label={({
                              percent,
                              cx: pcx,
                              cy: pcy,
                              midAngle,
                              outerRadius: or,
                            }) => {
                              const RADIAN = Math.PI / 180;
                              const radius = or + 18;
                              const x =
                                pcx +
                                radius *
                                  Math.cos(-midAngle * RADIAN);
                              const y =
                                pcy +
                                radius *
                                  Math.sin(-midAngle * RADIAN);
                              return (
                                <text
                                  x={x}
                                  y={y}
                                  fill="var(--text-faint)"
                                  textAnchor={
                                    x > pcx ? "start" : "end"
                                  }
                                  dominantBaseline="central"
                                  fontSize={11}
                                  fontWeight={600}
                                >
                                  {`${(percent * 100).toFixed(0)}%`}
                                </text>
                              );
                            }}
                            labelLine={false}
                          >
                            {platformPieData.map((_, idx) => (
                              <Cell
                                key={idx}
                                fill={
                                  CHART_COLORS[
                                    idx % CHART_COLORS.length
                                  ]
                                }
                              />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              background: "var(--bg-card)",
                              border:
                                "1px solid var(--border-primary)",
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                          />
                          <Legend
                            layout="vertical"
                            align="right"
                            verticalAlign="middle"
                            iconType="circle"
                            iconSize={8}
                            formatter={(value) =>
                              value.charAt(0).toUpperCase() +
                              value.slice(1)
                            }
                            wrapperStyle={{
                              fontSize: 12,
                              lineHeight: "22px",
                              paddingLeft: 10,
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>

                {/* Agent Ranking */}
                <div
                  className="chart-card"
                  style={{ marginTop: 16 }}
                >
                  <div className="chart-card-title">
                    🏆 Agent Ranking — Most Replies
                  </div>
                  {agentStats.length === 0 ? (
                    <div
                      style={{
                        textAlign: "center",
                        padding: "28px 0",
                        color: "var(--text-faint)",
                        fontSize: 13,
                      }}
                    >
                      No reply data yet
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        padding: "8px 0",
                      }}
                    >
                      {agentStats.map((agent, idx) => {
                        const max = agentStats[0]?.replies || 1;
                        const pct = Math.round(
                          (agent.replies / max) * 100,
                        );
                        const medal =
                          idx === 0
                            ? "🥇"
                            : idx === 1
                              ? "🥈"
                              : idx === 2
                                ? "🥉"
                                : `${idx + 1}.`;
                        return (
                          <div
                            key={agent.agentId || idx}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                            }}
                          >
                            <span
                              style={{
                                width: 28,
                                fontSize: 16,
                                flexShrink: 0,
                                textAlign: "center",
                              }}
                            >
                              {medal}
                            </span>
                            <div
                              style={{ flex: 1, minWidth: 0 }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent:
                                    "space-between",
                                  marginBottom: 4,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color:
                                      "var(--text-primary)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {agent.name}
                                </span>
                                <span
                                  style={{
                                    fontSize: 13,
                                    color:
                                      CHART_COLORS[
                                        idx %
                                          CHART_COLORS.length
                                      ],
                                    fontWeight: 700,
                                    marginLeft: 8,
                                    flexShrink: 0,
                                  }}
                                >
                                  {agent.replies} replies
                                </span>
                              </div>
                              <div
                                style={{
                                  height: 6,
                                  borderRadius: 3,
                                  background:
                                    "var(--bg-hover)",
                                  overflow: "hidden",
                                }}
                              >
                                <div
                                  style={{
                                    height: "100%",
                                    borderRadius: 3,
                                    width: `${pct}%`,
                                    background:
                                      CHART_COLORS[
                                        idx %
                                          CHART_COLORS.length
                                      ],
                                    transition:
                                      "width 0.4s ease",
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════
           TAB: AGENT ACTIVITY
           ══════════════════════════════════════ */}
        {activeMainTab === "agents" && (
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "28px 32px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 20,
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontFamily: "'Young Serif', serif",
                  fontSize: "18px",
                  fontWeight: 700,
                  color: "var(--text-primary)",
                }}
              >
                Active Agent Assignments
              </h2>
              <button
                onClick={fetchAgentLocks}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 16px",
                  borderRadius: "8px",
                  border: "1px solid var(--border-primary)",
                  backgroundColor: "transparent",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "'Hanken Grotesk', sans-serif",
                  transition: "all 0.2s ease",
                }}
              >
                <RefreshCw size={14} /> Refresh
              </button>
            </div>

            <div
              style={{
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border-primary)",
                borderRadius: "12px",
                padding: "24px",
              }}
            >
              {agentLocksLoading ? (
                <div
                  style={{
                    padding: "32px",
                    textAlign: "center",
                    color: "var(--text-faint)",
                    fontSize: "14px",
                  }}
                >
                  Loading assignments…
                </div>
              ) : agentLocks.length === 0 ? (
                <div
                  style={{
                    padding: "48px 20px",
                    textAlign: "center",
                    color: "var(--text-faint)",
                    fontSize: "14px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 40,
                      marginBottom: 12,
                      opacity: 0.3,
                    }}
                  >
                    ✓
                  </div>
                  No active assignments — all conversations are open.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: "13px",
                    }}
                  >
                    <thead>
                      <tr>
                        {[
                          "Platform",
                          "Conversation",
                          "Agent",
                          "Assigned Since",
                          "Action",
                        ].map((h) => (
                          <th
                            key={h}
                            style={{
                              textAlign:
                                h === "Action" ? "center" : "left",
                              padding: "10px 14px",
                              borderBottom:
                                "2px solid var(--border-primary)",
                              color: "var(--text-dim)",
                              fontWeight: 700,
                              fontSize: "11px",
                              textTransform: "uppercase",
                              letterSpacing: "0.5px",
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {agentLocks.map((lock, i) => (
                        <tr
                          key={lock.conversationId + lock.platform}
                          style={{
                            backgroundColor:
                              i % 2 === 0
                                ? "transparent"
                                : "var(--bg-hover)",
                            animation: `mgrFadeUp 0.3s ease-out ${i * 0.05}s both`,
                          }}
                        >
                          <td
                            style={{
                              padding: "12px 14px",
                              borderBottom:
                                "1px solid var(--border-primary)",
                              verticalAlign: "middle",
                            }}
                          >
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                fontSize: "12px",
                                fontWeight: 600,
                              }}
                            >
                              <PlatformIcon
                                platform={lock.platform}
                                size={20}
                              />{" "}
                              {lock.platform
                                .charAt(0)
                                .toUpperCase() +
                                lock.platform.slice(1)}
                            </span>
                          </td>
                          <td
                            style={{
                              padding: "12px 14px",
                              borderBottom:
                                "1px solid var(--border-primary)",
                              verticalAlign: "middle",
                            }}
                          >
                            <code
                              style={{
                                fontSize: "11px",
                                fontFamily: "monospace",
                                backgroundColor:
                                  "var(--bg-hover)",
                                padding: "3px 8px",
                                borderRadius: "4px",
                                color: "var(--text-faint)",
                              }}
                            >
                              {lock.conversationId.length > 24
                                ? lock.conversationId.slice(
                                    0,
                                    24,
                                  ) + "…"
                                : lock.conversationId}
                            </code>
                          </td>
                          <td
                            style={{
                              padding: "12px 14px",
                              borderBottom:
                                "1px solid var(--border-primary)",
                              verticalAlign: "middle",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "10px",
                              }}
                            >
                              <div
                                style={{
                                  width: "32px",
                                  height: "32px",
                                  borderRadius: "8px",
                                  backgroundColor:
                                    "var(--accent)22",
                                  border:
                                    "2px solid var(--accent)44",
                                  color: "var(--accent)",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontWeight: 700,
                                  fontSize: "12px",
                                  flexShrink: 0,
                                }}
                              >
                                {(
                                  lock.agentName || "?"
                                )[0].toUpperCase()}
                              </div>
                              <div>
                                <div
                                  style={{
                                    fontWeight: 600,
                                    fontSize: "13px",
                                    color:
                                      "var(--text-primary)",
                                  }}
                                >
                                  {lock.agentName}
                                </div>
                                <div
                                  style={{
                                    fontSize: "11px",
                                    color:
                                      "var(--text-faint)",
                                  }}
                                >
                                  {lock.agentEmail}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td
                            style={{
                              padding: "12px 14px",
                              borderBottom:
                                "1px solid var(--border-primary)",
                              verticalAlign: "middle",
                              color: "var(--text-primary)",
                            }}
                          >
                            {new Date(
                              lock.lockedAt,
                            ).toLocaleString()}
                          </td>
                          <td
                            style={{
                              padding: "12px 14px",
                              borderBottom:
                                "1px solid var(--border-primary)",
                              textAlign: "center",
                              verticalAlign: "middle",
                            }}
                          >
                            <button
                              className="mgr-unlock-btn"
                              style={{
                                padding: "6px 14px",
                                borderRadius: "7px",
                                border: "none",
                                backgroundColor:
                                  "var(--accent)",
                                color: "var(--bg-primary)",
                                cursor: "pointer",
                                fontSize: "12px",
                                fontWeight: 600,
                                fontFamily:
                                  "'Hanken Grotesk', sans-serif",
                                transition: "all 0.2s ease",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "5px",
                              }}
                              onClick={() =>
                                handleUnlock(
                                  lock.conversationId,
                                  lock.platform,
                                )
                              }
                            >
                              <Unlock size={13} /> Unlock
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default ManagerDashboard;
