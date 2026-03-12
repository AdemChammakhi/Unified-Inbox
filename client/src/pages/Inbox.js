import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import axios from "axios";
import { io } from "socket.io-client";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";

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

const Inbox = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState([]);
  const [selectedConv, setSelectedConv] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
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
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const selectedConvRef = useRef(selectedConv);
  const conversationsRef = useRef(conversations);
  const fetchQuietRef = useRef(null);

  // Keep refs in sync with state
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  useEffect(() => {
    selectedConvRef.current = selectedConv;
  }, [selectedConv]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Connect to Socket.IO — ONCE, not on every tab change
  useEffect(() => {
    // In dev (port 3000), connect to the API server on port 5000
    // In production, the client is served from the same server — use page origin
    const socketUrl =
      process.env.REACT_APP_API_URL ||
      (window.location.port === "3000"
        ? "http://localhost:5000"
        : window.location.origin);
    const socket = io(socketUrl, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("Socket connected:", socket.id);
      setConnectionStatus("connected");
      if (user?._id) {
        socket.emit("join", user._id);
      }
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected");
      setConnectionStatus("disconnected");
    });

    socket.on("connect_error", (err) => {
      console.error("Socket connection error:", err.message);
    });

    socket.on("reconnect", () => {
      console.log("Socket reconnected");
      setConnectionStatus("connected");
    });

    // Listen for new messages — update UI inline without refetching
    socket.on("newMessage", (data) => {
      console.log("Real-time message received:", data);
      const { platform, message } = data;
      const currentTab = activeTabRef.current;
      const currentConv = selectedConvRef.current;

      if (platform === currentTab) {
        // Check if this conversation already exists in the list
        const convs = conversationsRef.current;
        const isKnown = convs.some(
          (c) =>
            c.id === data.conversationId ||
            c.participants?.some((p) => p.id === data.senderId),
        );

        if (!isKnown) {
          // IMMEDIATELY add a temporary conversation so the new person appears instantly
          // instead of waiting for the Graph API (which can be delayed)
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
          setConversations((prev) => [tempConv, ...prev]);
          console.log(
            "Added temp conversation from socket for new sender:",
            data.senderId,
          );
        }

        // Also refetch to get full data from API + DB merge
        if (fetchQuietRef.current) fetchQuietRef.current();

        // If still not found after refetch, retry with delays
        if (!isKnown && fetchQuietRef.current) {
          setTimeout(() => fetchQuietRef.current(), 4000);
          setTimeout(() => fetchQuietRef.current(), 10000);
        }

        // Also try to append the message inline to the selected conversation
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
              const exists = prev.messages?.some((m) => m.id === message.id);
              if (exists) return prev;
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

        // If the message belongs to a known conversation, update it inline
        if (isKnown) {
          setConversations((prev) =>
            prev.map((c) => {
              const matches =
                c.id === data.conversationId ||
                c.participants?.some((p) => p.id === data.senderId);
              if (!matches) return c;
              const exists = c.messages?.some((m) => m.id === message.id);
              if (exists) return c;
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
        // Message is for a different platform tab — show unread badge
        setUnreadCounts((prev) => ({
          ...prev,
          [platform]: (prev[platform] || 0) + 1,
        }));
      }

      // Play notification sound
      try {
        const audio = new Audio(
          "data:audio/wav;base64,UklGRl9vT19teleVhZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQ==",
        );
        audio.volume = 0.3;
        audio.play().catch(() => {});
      } catch {}
    });

    // Listen for message status updates
    socket.on("messageStatus", (data) => {
      console.log("Message status update:", data);
    });

    // Listen for sent message confirmations — update UI when we send
    socket.on("messageSent", (data) => {
      console.log("Message sent confirmation:", data);
      const { platform, message } = data;
      const currentTab = activeTabRef.current;
      const currentConv = selectedConvRef.current;

      if (platform === currentTab && currentConv) {
        // Check if this sent message belongs to current conversation
        const matchesSelected = currentConv.participants?.some(
          (p) => p.id === data.recipientId,
        );
        if (matchesSelected) {
          // Replace optimistic message or add the sent message
          setSelectedConv((prev) => {
            if (!prev) return prev;
            // Remove any temp optimistic messages with same text
            const filtered = (prev.messages || []).filter(
              (m) =>
                !(m.id && m.id.startsWith("temp_") && m.text === message.text),
            );
            // Add the real message if not already there
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
    });

    // Listen for reactions
    socket.on("messageReaction", (data) => {
      console.log("Message reaction:", data);
    });

    return () => {
      socket.disconnect();
    };
  }, []); // eslint-disable-line

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selectedConv?.messages?.length]);

  // Full fetch (with loading spinner)
  const fetchConversations = useCallback(async () => {
    const token = user?.token;
    if (!token) return;
    try {
      setLoading(true);

      const axiosOpts = {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      };

      if (activeTab === "instagram") {
        const res = await axios.get("/api/instagram/conversations", axiosOpts);
        setConversations(res.data.conversations || []);
      } else if (activeTab === "facebook") {
        const res = await axios.get("/api/facebook/conversations", axiosOpts);
        setConversations(res.data.conversations || []);
      } else if (activeTab === "whatsapp") {
        const res = await axios.get("/api/instagram/messages", axiosOpts);
        setConversations(res.data.messages || []);
      } else if (activeTab === "email") {
        const res = await axios.get("/api/email/conversations", axiosOpts);
        setConversations(res.data.conversations || []);
      }
    } catch (error) {
      if (error.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
      console.error(
        "Failed to fetch conversations:",
        error.response?.status,
        error.response?.data || error.message,
      );
    } finally {
      setLoading(false);
    }
  }, [activeTab, user?.token, logout, navigate]);

  // Quiet fetch (no loading spinner — used for background real-time updates)
  const fetchConversationsQuiet = useCallback(async () => {
    const token = user?.token;
    if (!token) return;
    try {
      const tab = activeTabRef.current;
      const opts = {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      };
      let newConvs = [];

      if (tab === "instagram") {
        const res = await axios.get("/api/instagram/conversations", opts);
        newConvs = res.data.conversations || [];
      } else if (tab === "facebook") {
        const res = await axios.get("/api/facebook/conversations", opts);
        newConvs = res.data.conversations || [];
      } else if (tab === "email") {
        const res = await axios.get("/api/email/conversations", opts);
        newConvs = res.data.conversations || [];
      } else if (tab === "whatsapp") {
        const res = await axios.get("/api/instagram/messages", opts);
        newConvs = res.data.messages || [];
      }

      setConversations(newConvs);

      // Also update selectedConv if it's currently open
      const currentConv = selectedConvRef.current;
      if (currentConv) {
        const updated = newConvs.find((c) => c.id === currentConv.id);
        if (updated) {
          setSelectedConv(updated);
        }
      }
    } catch (error) {
      if (error.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
      console.error("Background fetch error:", error.message);
    }
  }, [user?.token, logout, navigate]);

  // Fetch classifications for the current platform tab
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
      console.error("Failed to fetch classifications:", error.message);
    }
  }, [activeTab, user?.token, logout, navigate]);

  // Fetch conversation locks for the current platform
  const fetchLocks = useCallback(async () => {
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
      console.error("Failed to fetch locks:", error.message);
    }
  }, [activeTab, user?.token, logout, navigate]);

  // Update classification for a conversation
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
      console.error("Failed to update classification:", error.message);
      alert("Failed to update classification");
    }
  };

  // Sorted & filtered conversations: unclassified first, then filtered
  const sortedConversations = useMemo(() => {
    let filtered = conversations;
    if (classFilter !== "all") {
      filtered = conversations.filter((conv) => {
        const cls = classifications[conv.id] || "non_classifie";
        return cls === classFilter;
      });
    }
    return [...filtered].sort((a, b) => {
      const clsA = classifications[a.id] || "non_classifie";
      const clsB = classifications[b.id] || "non_classifie";
      if (clsA === "non_classifie" && clsB !== "non_classifie") return -1;
      if (clsA !== "non_classifie" && clsB === "non_classifie") return 1;
      return 0;
    });
  }, [conversations, classifications, classFilter]);

  // Keep fetchQuietRef always pointing to the latest function
  useEffect(() => {
    fetchQuietRef.current = fetchConversationsQuiet;
  }, [fetchConversationsQuiet]);

  // Fetch on tab change
  useEffect(() => {
    fetchConversations();
    fetchClassifications();
    fetchLocks();
    // Clear unread count for this tab
    setUnreadCounts((prev) => ({ ...prev, [activeTab]: 0 }));
  }, [activeTab, fetchConversations, fetchClassifications, fetchLocks]);

  // Auto-poll every 10 seconds so new messages appear without manual refresh
  useEffect(() => {
    const interval = setInterval(() => {
      if (fetchQuietRef.current) fetchQuietRef.current();
      fetchLocks();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchLocks]);

  // When selecting a conversation, keep it in sync with latest data
  const handleSelectConv = useCallback((conv) => {
    setSelectedConv(conv);
  }, []);

  // Inject custom CSS for animations, scrollbar, hover effects
  useEffect(() => {
    const styleId = "inbox-obsidian-styles";
    const existing = document.getElementById(styleId);
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes inboxFadeUp {
        from { opacity: 0; transform: translateY(14px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes inboxPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      @keyframes inboxSlideIn {
        from { opacity: 0; transform: translateX(-10px); }
        to { opacity: 1; transform: translateX(0); }
      }
      @keyframes inboxGlowPulse {
        0%, 100% { box-shadow: 0 0 6px var(--accent-glow); }
        50% { box-shadow: 0 0 18px var(--accent-glow-strong); }
      }
      @keyframes accentShimmer {
        0% { background-position: -200% center; }
        100% { background-position: 200% center; }
      }
      .inbox-conv-scroll::-webkit-scrollbar { width: 5px; }
      .inbox-conv-scroll::-webkit-scrollbar-track { background: transparent; }
      .inbox-conv-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
      .inbox-conv-scroll::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }
      .inbox-msg-scroll::-webkit-scrollbar { width: 5px; }
      .inbox-msg-scroll::-webkit-scrollbar-track { background: transparent; }
      .inbox-msg-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
      .inbox-msg-scroll::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }
      .inbox-conv-row:hover { background: var(--bg-hover) !important; }
      .inbox-tab-btn:hover { background: var(--bg-hover) !important; color: var(--text-primary) !important; }
      .inbox-filter-pill:hover { background: var(--bg-hover) !important; }
      .inbox-reply-field:focus { border-color: var(--accent) !important; box-shadow: 0 0 0 3px var(--accent-glow) !important; }
      .inbox-send-action:hover:not(:disabled) { background: var(--accent-hover) !important; transform: translateY(-1px); }
      .inbox-send-action:disabled { opacity: 0.35; cursor: not-allowed; }
      .inbox-refresh-icon:hover { background: var(--bg-hover) !important; transform: rotate(180deg); }
      .inbox-class-dropdown { appearance: none; -webkit-appearance: none; cursor: pointer; }
      .inbox-class-dropdown option { background: var(--bg-elevated); color: var(--text-primary); }
      .inbox-email-render img { max-width: 100% !important; height: auto !important; }
      .inbox-email-render a { color: var(--accent) !important; }
      .inbox-email-render * { max-width: 100% !important; }
      .inbox-delete-btn:hover { background: var(--danger, #E06C6C) !important; color: #fff !important; border-color: var(--danger, #E06C6C) !important; }
    `;
    document.head.appendChild(style);
    return () => {
      const el = document.getElementById(styleId);
      if (el) el.remove();
    };
  }, []);

  const sendReply = async () => {
    if (!replyText.trim() || !selectedConv) return;

    const messageText = replyText.trim();
    setReplyText("");
    const tempId = "temp_" + Date.now();

    try {
      setSending(true);
      const token = user?.token;

      // Find the other participant (not the page)
      const recipient = selectedConv.participants?.[0];

      // Optimistic update — show the message immediately
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

      // Update conversation list preview
      setConversations((prev) =>
        prev.map((c) => {
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
        await axios.post(
          "/api/instagram/send",
          {
            recipientId: recipient?.id || selectedConv.id,
            conversationId: selectedConv.id,
            message: messageText,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      } else if (activeTab === "facebook") {
        await axios.post(
          "/api/facebook/send",
          {
            recipientId: recipient?.id || selectedConv.id,
            conversationId: selectedConv.id,
            message: messageText,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      } else if (activeTab === "email") {
        await axios.post(
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

      // Refresh locks after sending (may have auto-locked)
      fetchLocks();

      // Mark optimistic message as sent (remove sending state)
      setSelectedConv((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: (prev.messages || []).map((m) =>
            m.id === tempId ? { ...m, sending: false } : m,
          ),
        };
      });

      // Background refresh to sync real data after a short delay
      setTimeout(() => fetchConversationsQuiet(), 2000);
    } catch (error) {
      console.error("Failed to send reply:", error);
      alert(
        "Failed to send message: " +
          (error.response?.data?.message || error.message),
      );
      // Revert optimistic update
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

  return (
    <DashboardLayout>
      <div style={styles.container}>
        {/* Accent shimmer line */}
        <div style={styles.accentLine} />

        {/* Header Row */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <h2 style={styles.title}>Unified Inbox</h2>
            <div style={styles.statusBadge}>
              <span
                style={{
                  ...styles.statusDot,
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

          {/* Platform Tabs */}
          <div style={styles.tabGroup}>
            {[
              { key: "instagram", icon: "📸", label: "Instagram" },
              { key: "facebook", icon: "💬", label: "Facebook" },
              { key: "whatsapp", icon: "📱", label: "WhatsApp" },
              { key: "email", icon: "✉️", label: "Email" },
            ].map((p) => (
              <button
                key={p.key}
                className="inbox-tab-btn"
                style={{
                  ...styles.tab,
                  ...(activeTab === p.key ? styles.activeTab : {}),
                }}
                onClick={() => {
                  setActiveTab(p.key);
                  setSelectedConv(null);
                }}
              >
                <span style={{ fontSize: 13 }}>{p.icon}</span>
                <span>{p.label}</span>
                {unreadCounts[p.key] > 0 && (
                  <span style={styles.unreadBadge}>{unreadCounts[p.key]}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Main Layout */}
        <div style={styles.inboxLayout}>
          {/* Conversation Sidebar */}
          <div style={styles.convList}>
            <div style={styles.convListHeader}>
              <span style={styles.convListTitle}>Conversations</span>
              <button
                className="inbox-refresh-icon"
                onClick={fetchConversations}
                style={styles.refreshBtn}
              >
                ↻
              </button>
            </div>

            {/* Classification Filter */}
            <div style={styles.classFilterBar}>
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
                  className="inbox-filter-pill"
                  onClick={() => setClassFilter(f.key)}
                  style={{
                    ...styles.classFilterBtn,
                    ...(classFilter === f.key
                      ? {
                          backgroundColor:
                            f.key === "all"
                              ? "var(--accent)"
                              : CLASSIFICATION_COLORS[f.key] || "var(--accent)",
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
                        flexShrink: 0,
                      }}
                    />
                  )}
                  {f.label}
                </button>
              ))}
            </div>

            {/* Conversation Items */}
            <div className="inbox-conv-scroll" style={styles.convScrollArea}>
              {loading ? (
                <div style={styles.loadingState}>
                  <div
                    style={{
                      animation: "inboxPulse 1.5s ease-in-out infinite",
                    }}
                  >
                    Loading conversations…
                  </div>
                </div>
              ) : sortedConversations.length === 0 ? (
                <div style={styles.emptyState}>
                  <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.3 }}>
                    ◇
                  </div>
                  No conversations found
                </div>
              ) : (
                sortedConversations.map((conv, index) => {
                  const cls = classifications[conv.id] || "non_classifie";
                  const isSelected = selectedConv?.id === conv.id;
                  return (
                    <div
                      key={conv.id}
                      className="inbox-conv-row"
                      style={{
                        ...styles.convItem,
                        backgroundColor: isSelected
                          ? "var(--bg-hover)"
                          : "transparent",
                        borderLeft: `3px solid ${CLASSIFICATION_COLORS[cls]}`,
                        animation: `inboxSlideIn 0.35s ease-out ${index * 0.04}s both`,
                      }}
                      onClick={() => handleSelectConv(conv)}
                    >
                      <div
                        style={{
                          ...styles.convAvatar,
                          background: `linear-gradient(135deg, ${CLASSIFICATION_COLORS[cls]}33, ${CLASSIFICATION_COLORS[cls]}11)`,
                          border: `2px solid ${CLASSIFICATION_COLORS[cls]}77`,
                          color: CLASSIFICATION_COLORS[cls],
                        }}
                      >
                        {(conv.participants?.[0]?.name || "?")[0].toUpperCase()}
                      </div>
                      <div style={styles.convInfo}>
                        <div style={styles.convNameRow}>
                          <strong style={styles.convName}>
                            {conv.participants?.map((p) => p.name).join(", ") ||
                              "Unknown"}
                          </strong>
                          {locks[conv.id] && (
                            <span
                              style={styles.lockBadge}
                              title={`Assigned to ${locks[conv.id].agentName}`}
                            >
                              🔒 {locks[conv.id].agentName?.split(" ")[0]}
                            </span>
                          )}
                          <select
                            value={cls}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) =>
                              updateClassification(conv.id, e.target.value)
                            }
                            className="inbox-class-dropdown"
                            style={{
                              ...styles.classSelect,
                              color: CLASSIFICATION_COLORS[cls],
                              borderColor: CLASSIFICATION_COLORS[cls] + "55",
                            }}
                          >
                            <option value="non_classifie">Non Classifié</option>
                            <option value="cible">Cible</option>
                            <option value="hors_cible">Hors Cible</option>
                            <option value="suivi">Suivi</option>
                            <option value="priorite">Priorité</option>
                          </select>
                        </div>
                        <p style={styles.lastMsg}>
                          {conv.lastMessage?.text || "No messages"}
                        </p>
                        <small style={styles.time}>
                          {conv.lastMessage?.time
                            ? new Date(conv.lastMessage.time).toLocaleString()
                            : ""}
                        </small>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Message View */}
          <div style={styles.messageView}>
            {selectedConv ? (
              <>
                <div style={styles.messageHeader}>
                  <div style={styles.messageHeaderRow}>
                    <h3 style={styles.messageHeaderName}>
                      {selectedConv.participants
                        ?.map((p) => p.name)
                        .join(", ") || "Conversation"}
                    </h3>
                    <span style={styles.platformTag}>
                      {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
                    </span>
                    {(user?.role === "admin" || user?.role === "manager") && (
                      <button
                        className="inbox-delete-btn"
                        style={styles.deleteConvBtn}
                        title="Delete this conversation"
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Delete this conversation and all its messages? This cannot be undone.`,
                            )
                          )
                            return;
                          try {
                            await axios.delete("/api/conversations", {
                              headers: {
                                Authorization: `Bearer ${user?.token}`,
                              },
                              data: {
                                conversationId: selectedConv.id,
                                platform: activeTab,
                              },
                            });
                            setConversations((prev) =>
                              prev.filter((c) => c.id !== selectedConv.id),
                            );
                            setSelectedConv(null);
                          } catch (err) {
                            console.error("Delete failed:", err);
                            alert(
                              err.response?.data?.message ||
                                "Failed to delete conversation",
                            );
                          }
                        }}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </div>

                <div className="inbox-msg-scroll" style={styles.messageList}>
                  {selectedConv.messages
                    ?.slice()
                    .reverse()
                    .map((msg, idx) => {
                      const isEmail = activeTab === "email";
                      const isOther =
                        msg.from === selectedConv.participants?.[0]?.name;
                      return (
                        <div
                          key={msg.id || idx}
                          style={{
                            ...(isEmail
                              ? styles.emailBubble
                              : styles.messageBubble),
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
                            animation: `inboxFadeUp 0.3s ease-out ${idx * 0.02}s both`,
                          }}
                        >
                          <small style={styles.msgFrom}>{msg.from}</small>
                          {/* Subject for emails */}
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
                          {/* Email HTML or text */}
                          {msg.html && isEmail ? (
                            <div
                              className="inbox-email-render"
                              style={styles.emailHtmlContent}
                              dangerouslySetInnerHTML={{ __html: msg.html }}
                            />
                          ) : (
                            msg.text && <p style={styles.msgText}>{msg.text}</p>
                          )}
                          {/* Attachments */}
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div style={{ marginTop: 8 }}>
                              {msg.attachments.map((att, attIdx) => {
                                const mimeType =
                                  att.mime_type || att.contentType || "";
                                const imageUrl =
                                  att.image_data?.url ||
                                  att.url ||
                                  att.file_url ||
                                  "";
                                const videoUrl =
                                  att.video_data?.url || att.url || "";
                                const fileName =
                                  att.name || att.filename || "file";

                                if (
                                  mimeType.startsWith("image") ||
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
                                        window.open(imageUrl, "_blank")
                                      }
                                    />
                                  );
                                } else if (
                                  mimeType.startsWith("video") ||
                                  att.video_data
                                ) {
                                  return (
                                    <video
                                      key={attIdx}
                                      src={videoUrl}
                                      controls
                                      style={{
                                        maxWidth: "100%",
                                        maxHeight: 300,
                                        borderRadius: 10,
                                        marginTop: 6,
                                      }}
                                    />
                                  );
                                } else if (mimeType.startsWith("audio")) {
                                  return (
                                    <audio
                                      key={attIdx}
                                      src={att.url || att.file_url || ""}
                                      controls
                                      style={{
                                        marginTop: 6,
                                        width: "100%",
                                      }}
                                    />
                                  );
                                } else {
                                  return (
                                    <a
                                      key={attIdx}
                                      href={att.url || att.file_url || "#"}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 5,
                                        marginTop: 6,
                                        color: "var(--accent)",
                                        textDecoration: "none",
                                        fontSize: 12,
                                        padding: "5px 10px",
                                        borderRadius: 6,
                                        backgroundColor: "var(--accent-bg)",
                                        border:
                                          "1px solid var(--accent-border)",
                                      }}
                                    >
                                      📎 {fileName}
                                    </a>
                                  );
                                }
                              })}
                            </div>
                          )}
                          {!msg.text &&
                            (!msg.attachments ||
                              msg.attachments.length === 0) && (
                              <p style={styles.msgText}>[Empty message]</p>
                            )}
                          <small style={styles.msgTime}>
                            {new Date(msg.time).toLocaleString()}
                          </small>
                        </div>
                      );
                    })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Reply Box */}
                {(() => {
                  const lock = locks[selectedConv?.id];
                  const isLockedToOther =
                    lock &&
                    lock.agentId !== user?._id &&
                    user?.role !== "admin";
                  if (isLockedToOther) {
                    return (
                      <div style={styles.lockBanner}>
                        🔒 This conversation is assigned to{" "}
                        <strong>{lock.agentName}</strong>. Only they can reply.
                      </div>
                    );
                  }
                  return (
                    <div style={styles.replyBox}>
                      <input
                        type="text"
                        className="inbox-reply-field"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder="Type a message…"
                        style={styles.replyInput}
                        onKeyPress={(e) => e.key === "Enter" && sendReply()}
                      />
                      <button
                        className="inbox-send-action"
                        onClick={sendReply}
                        disabled={sending || !replyText.trim()}
                        style={styles.sendBtn}
                      >
                        {sending ? "···" : "➤"}
                      </button>
                    </div>
                  );
                })()}
              </>
            ) : (
              <div style={styles.noConv}>
                <div style={styles.noConvInner}>
                  <div style={styles.noConvGlyph}>◈</div>
                  <p style={styles.noConvTitle}>Select a conversation</p>
                  <p style={styles.noConvSub}>
                    Choose from the sidebar to begin
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

const styles = {
  container: {
    margin: "-32px",
    padding: 0,
    fontFamily: "'Hanken Grotesk', sans-serif",
    height: "calc(100% + 64px)",
    display: "flex",
    flexDirection: "column",
    background: "var(--gradient-bg)",
    position: "relative",
    overflow: "hidden",
    transition: "background 0.3s ease",
  },
  accentLine: {
    height: "3px",
    background:
      "linear-gradient(90deg, transparent, var(--accent), var(--accent-alt), var(--accent), transparent)",
    backgroundSize: "200% auto",
    animation: "accentShimmer 4s linear infinite",
    flexShrink: 0,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 28px",
    borderBottom: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-nav)",
    flexWrap: "wrap",
    gap: "12px",
    transition: "background-color 0.3s ease, border-color 0.3s ease",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
  },
  title: {
    margin: 0,
    fontFamily: "'Young Serif', Georgia, serif",
    fontSize: "22px",
    fontWeight: 400,
    color: "var(--text-primary)",
    letterSpacing: "0.3px",
  },
  statusBadge: {
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
  },
  statusDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    transition: "all 0.4s ease",
  },
  tabGroup: {
    display: "flex",
    gap: "3px",
    backgroundColor: "var(--bg-card)",
    borderRadius: "10px",
    padding: "4px",
    border: "1px solid var(--border-primary)",
    transition: "background-color 0.3s ease, border-color 0.3s ease",
  },
  tab: {
    padding: "7px 14px",
    border: "none",
    borderRadius: "7px",
    backgroundColor: "transparent",
    color: "var(--text-faint)",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 600,
    fontFamily: "'Hanken Grotesk', sans-serif",
    transition: "all 0.2s ease",
    display: "flex",
    alignItems: "center",
    gap: "5px",
    letterSpacing: "0.2px",
  },
  activeTab: {
    backgroundColor: "var(--bg-hover)",
    color: "var(--accent)",
    fontWeight: 700,
    boxShadow:
      "0 2px 10px rgba(0,0,0,0.15), inset 0 1px 0 var(--accent-border)",
  },
  inboxLayout: {
    display: "flex",
    flex: "1 1 0%",
    minHeight: 0,
    overflow: "hidden",
  },
  convList: {
    width: "370px",
    minWidth: "310px",
    borderRight: "1px solid var(--border-primary)",
    display: "flex",
    flexDirection: "column",
    backgroundColor: "var(--bg-secondary)",
    transition: "background-color 0.3s ease, border-color 0.3s ease",
  },
  convListHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 20px",
    borderBottom: "1px solid var(--border-primary)",
  },
  convListTitle: {
    fontSize: "11px",
    fontWeight: 700,
    color: "var(--text-faint)",
    textTransform: "uppercase",
    letterSpacing: "2px",
  },
  refreshBtn: {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: "18px",
    color: "var(--text-faint)",
    borderRadius: "6px",
    width: "30px",
    height: "30px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all 0.35s ease",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  classFilterBar: {
    display: "flex",
    gap: "4px",
    padding: "10px 14px",
    borderBottom: "1px solid var(--border-primary)",
    flexWrap: "wrap",
    backgroundColor: "var(--bg-nav)",
    transition: "background-color 0.3s ease",
  },
  classFilterBtn: {
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
    letterSpacing: "0.2px",
  },
  convScrollArea: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
  },
  convItem: {
    display: "flex",
    alignItems: "center",
    padding: "13px 16px",
    borderBottom: "1px solid var(--border-primary)",
    cursor: "pointer",
    transition: "all 0.15s ease",
    minHeight: "70px",
  },
  convAvatar: {
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
    transition: "all 0.2s ease",
  },
  convInfo: {
    flex: 1,
    overflow: "hidden",
    minWidth: 0,
  },
  convNameRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
  },
  convName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flex: 1,
    fontSize: "13px",
    color: "var(--text-primary)",
    fontWeight: 600,
  },
  classSelect: {
    padding: "2px 6px",
    border: "1px solid var(--border-primary)",
    borderRadius: "4px",
    fontSize: "9px",
    fontWeight: 700,
    cursor: "pointer",
    backgroundColor: "var(--bg-secondary)",
    outline: "none",
    flexShrink: 0,
    maxWidth: "100px",
    textTransform: "uppercase",
    letterSpacing: "0.3px",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  lastMsg: {
    margin: "3px 0",
    fontSize: "11px",
    color: "var(--text-faint)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
    lineHeight: 1.4,
  },
  time: {
    fontSize: "10px",
    color: "var(--text-dim)",
    display: "block",
    marginTop: "2px",
    fontVariantNumeric: "tabular-nums",
  },
  messageView: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    background: "var(--gradient-msg)",
    transition: "background 0.3s ease",
  },
  messageHeader: {
    padding: "14px 24px",
    borderBottom: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-secondary)",
    transition: "background-color 0.3s ease",
  },
  messageHeaderRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  messageHeaderName: {
    margin: 0,
    fontSize: "14px",
    fontWeight: 700,
    color: "var(--text-primary)",
    letterSpacing: "0.1px",
  },
  platformTag: {
    fontSize: "9px",
    color: "var(--accent)",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "1.2px",
    padding: "3px 10px",
    borderRadius: "4px",
    backgroundColor: "var(--accent-bg)",
    border: "1px solid var(--accent-border)",
  },
  messageList: {
    flex: 1,
    overflowY: "auto",
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  messageBubble: {
    maxWidth: "68%",
    padding: "10px 16px",
    borderRadius: "14px",
    fontSize: "13px",
    wordWrap: "break-word",
    overflowWrap: "break-word",
    wordBreak: "break-word",
    lineHeight: 1.55,
  },
  emailBubble: {
    width: "100%",
    padding: "18px 22px",
    borderRadius: "10px",
    fontSize: "13px",
    border: "1px solid var(--border-primary)",
    wordWrap: "break-word",
    overflowWrap: "break-word",
    wordBreak: "break-word",
    lineHeight: 1.6,
  },
  emailHtmlContent: {
    margin: "8px 0",
    overflow: "auto",
    maxHeight: 600,
    lineHeight: 1.6,
    wordWrap: "break-word",
    overflowWrap: "break-word",
    wordBreak: "break-word",
    color: "var(--msg-received-color)",
  },
  msgFrom: {
    fontSize: "10px",
    color: "var(--text-muted)",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.6px",
    display: "block",
    marginBottom: "2px",
  },
  msgText: {
    margin: "4px 0",
    wordWrap: "break-word",
    overflowWrap: "break-word",
    whiteSpace: "pre-wrap",
    lineHeight: 1.55,
  },
  msgTime: {
    fontSize: "9px",
    color: "var(--text-dim)",
    fontVariantNumeric: "tabular-nums",
    marginTop: "5px",
    display: "block",
  },
  replyBox: {
    display: "flex",
    padding: "14px 20px",
    borderTop: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-secondary)",
    gap: "10px",
    alignItems: "center",
    transition: "background-color 0.3s ease",
  },
  replyInput: {
    flex: 1,
    padding: "11px 18px",
    borderRadius: "10px",
    border: "1px solid var(--border-primary)",
    fontSize: "13px",
    outline: "none",
    backgroundColor: "var(--bg-card)",
    color: "var(--text-primary)",
    fontFamily: "'Hanken Grotesk', sans-serif",
    transition: "all 0.25s ease",
  },
  sendBtn: {
    width: "40px",
    height: "40px",
    borderRadius: "10px",
    border: "none",
    backgroundColor: "var(--accent)",
    color: "var(--bg-primary)",
    cursor: "pointer",
    fontSize: "16px",
    fontWeight: 700,
    transition: "all 0.2s ease",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  noConv: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  noConvInner: {
    textAlign: "center",
  },
  noConvGlyph: {
    fontSize: "52px",
    color: "var(--border-primary)",
    marginBottom: "16px",
    lineHeight: 1,
  },
  noConvTitle: {
    color: "var(--text-faint)",
    fontSize: "15px",
    fontWeight: 600,
    margin: "0 0 6px",
    letterSpacing: "0.2px",
  },
  noConvSub: {
    color: "var(--text-dim)",
    fontSize: "12px",
    margin: 0,
  },
  loadingState: {
    padding: "48px 20px",
    textAlign: "center",
    color: "var(--text-faint)",
    fontSize: "13px",
  },
  emptyState: {
    padding: "48px 20px",
    textAlign: "center",
    color: "var(--text-faint)",
    fontSize: "13px",
  },
  unreadBadge: {
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
    marginLeft: "5px",
    padding: "0 4px",
  },
  lockBadge: {
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
    marginLeft: "6px",
    whiteSpace: "nowrap",
  },
  lockBanner: {
    padding: "14px 20px",
    backgroundColor: "var(--bg-hover)",
    borderTop: "1px solid var(--border-primary)",
    color: "var(--text-faint)",
    fontSize: "13px",
    textAlign: "center",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  deleteConvBtn: {
    marginLeft: "auto",
    border: "1px solid var(--border-primary)",
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
  },
};

export default Inbox;
