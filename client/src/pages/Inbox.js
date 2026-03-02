import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import axios from "axios";
import { io } from "socket.io-client";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";

const CLASSIFICATION_LABELS = {
  non_classifie: "Non Classifié",
  cible: "Cible",
  hors_cible: "Hors Cible",
};

const CLASSIFICATION_COLORS = {
  non_classifie: "#9e9e9e",
  cible: "#4CAF50",
  hors_cible: "#f44336",
};

const PRIORITY_LABELS = {
  non_definie: "Non définie",
  haute: "Haute",
  moyenne: "Moyenne",
  basse: "Basse",
};

const Inbox = () => {
  const { user } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [selectedConv, setSelectedConv] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [activeTab, setActiveTab] = useState("instagram");
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [classifications, setClassifications] = useState({});
  const [priorities, setPriorities] = useState({});
  const [suivis, setSuivis] = useState({});
  const [classFilter, setClassFilter] = useState("all");
  const [unreadCounts, setUnreadCounts] = useState({
    instagram: 0,
    facebook: 0,
    whatsapp: 0,
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
    const socketUrl = process.env.REACT_APP_API_URL || window.location.origin;
    const socket = io(socketUrl, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
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
        // Always refetch conversations to get the latest data from the API
        if (fetchQuietRef.current) fetchQuietRef.current();

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
    try {
      setLoading(true);
      const token = user?.token;

      if (activeTab === "instagram") {
        const res = await axios.get("/api/instagram/conversations", {
          headers: { Authorization: `Bearer ${token}` },
        });
        setConversations(res.data.conversations || []);
      } else if (activeTab === "facebook") {
        const res = await axios.get("/api/facebook/conversations", {
          headers: { Authorization: `Bearer ${token}` },
        });
        setConversations(res.data.conversations || []);
      } else if (activeTab === "whatsapp") {
        const res = await axios.get("/api/instagram/messages", {
          headers: { Authorization: `Bearer ${token}` },
        });
        setConversations(res.data.messages || []);
      }
    } catch (error) {
      console.error(
        "Failed to fetch conversations:",
        error.response?.status,
        error.response?.data || error.message,
      );
    } finally {
      setLoading(false);
    }
  }, [activeTab, user?.token]);

  // Quiet fetch (no loading spinner — used for background real-time updates)
  const fetchConversationsQuiet = useCallback(async () => {
    try {
      const token = user?.token;
      const tab = activeTabRef.current;
      let newConvs = [];

      if (tab === "instagram") {
        const res = await axios.get("/api/instagram/conversations", {
          headers: { Authorization: `Bearer ${token}` },
        });
        newConvs = res.data.conversations || [];
      } else if (tab === "facebook") {
        const res = await axios.get("/api/facebook/conversations", {
          headers: { Authorization: `Bearer ${token}` },
        });
        newConvs = res.data.conversations || [];
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
      console.error("Background fetch error:", error.message);
    }
  }, [user?.token]);

  // Fetch classifications for the current platform tab
  const fetchClassifications = useCallback(async () => {
    try {
      const token = user?.token;
      const res = await axios.get("/api/classifications", {
        params: { platform: activeTab },
        headers: { Authorization: `Bearer ${token}` },
      });
      setClassifications(res.data.classifications || {});
    } catch (error) {
      console.error("Failed to fetch classifications:", error.message);
    }
  }, [activeTab, user?.token]);

  // Update classification, priority, and suivi for a conversation
  const updateClassification = async (
    conversationId,
    classification,
    priority,
    suivi,
  ) => {
    try {
      const token = user?.token;
      await axios.put(
        "/api/classifications",
        {
          conversationId,
          platform: activeTab,
          classification,
          priority,
          suivi,
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setClassifications((prev) => ({
        ...prev,
        [conversationId]: classification,
      }));
      setPriorities((prev) => ({
        ...prev,
        [conversationId]: priority,
      }));
      setSuivis((prev) => ({
        ...prev,
        [conversationId]: suivi,
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
    // Clear unread count for this tab
    setUnreadCounts((prev) => ({ ...prev, [activeTab]: 0 }));
  }, [activeTab, fetchConversations, fetchClassifications]);

  // Auto-poll every 10 seconds so new messages appear without manual refresh
  useEffect(() => {
    const interval = setInterval(() => {
      if (fetchQuietRef.current) fetchQuietRef.current();
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // When selecting a conversation, keep it in sync with latest data
  const handleSelectConv = useCallback((conv) => {
    setSelectedConv(conv);
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
            message: messageText,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      } else if (activeTab === "facebook") {
        await axios.post(
          "/api/facebook/send",
          {
            recipientId: recipient?.id || selectedConv.id,
            message: messageText,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      }

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
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>📥 Unified Inbox</h2>
          <div style={styles.statusBadge}>
            <span
              style={{
                ...styles.statusDot,
                backgroundColor:
                  connectionStatus === "connected" ? "#4CAF50" : "#f44336",
              }}
            />
            {connectionStatus === "connected" ? "Real-time" : "Disconnected"}
          </div>
        </div>

        {/* Tabs */}
        <div style={styles.tabs}>
          <button
            style={activeTab === "instagram" ? styles.activeTab : styles.tab}
            onClick={() => {
              setActiveTab("instagram");
              setSelectedConv(null);
            }}
          >
            📸 Instagram
            {unreadCounts.instagram > 0 && (
              <span style={styles.unreadBadge}>{unreadCounts.instagram}</span>
            )}
          </button>
          <button
            style={activeTab === "facebook" ? styles.activeTab : styles.tab}
            onClick={() => {
              setActiveTab("facebook");
              setSelectedConv(null);
            }}
          >
            💬 Facebook
            {unreadCounts.facebook > 0 && (
              <span style={styles.unreadBadge}>{unreadCounts.facebook}</span>
            )}
          </button>
          <button
            style={activeTab === "whatsapp" ? styles.activeTab : styles.tab}
            onClick={() => {
              setActiveTab("whatsapp");
              setSelectedConv(null);
            }}
          >
            💬 WhatsApp
            {unreadCounts.whatsapp > 0 && (
              <span style={styles.unreadBadge}>{unreadCounts.whatsapp}</span>
            )}
          </button>
        </div>

        <div style={styles.inboxLayout}>
          {/* Conversation List */}
          <div style={styles.convList}>
            <div style={styles.convListHeader}>
              <h3>Conversations</h3>
              <button onClick={fetchConversations} style={styles.refreshBtn}>
                🔄
              </button>
            </div>

            {/* Classification Filter */}
            <div style={styles.classFilterBar}>
              {[
                { key: "all", label: "Tous" },
                { key: "non_classifie", label: "Non Classifié" },
                { key: "cible", label: "Cible" },
                { key: "hors_cible", label: "Hors Cible" },
              ].map((f) => (
                <button
                  key={f.key}
                  onClick={() => setClassFilter(f.key)}
                  style={{
                    ...styles.classFilterBtn,
                    backgroundColor:
                      classFilter === f.key ? "#0084ff" : "#f0f0f0",
                    color: classFilter === f.key ? "#fff" : "#333",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {loading ? (
              <p style={styles.loading}>Loading...</p>
            ) : sortedConversations.length === 0 ? (
              <p style={styles.empty}>No conversations found</p>
            ) : (
              sortedConversations.map((conv) => {
                const cls = classifications[conv.id] || "non_classifie";
                const priority = priorities[conv.id] || "non_definie";
                const suivi =
                  typeof suivis[conv.id] === "boolean"
                    ? suivis[conv.id]
                    : false;
                return (
                  <div
                    key={conv.id}
                    style={{
                      ...styles.convItem,
                      backgroundColor:
                        selectedConv?.id === conv.id ? "#e3f2fd" : "#fff",
                      borderLeft: `4px solid ${CLASSIFICATION_COLORS[cls]}`,
                    }}
                    onClick={() => handleSelectConv(conv)}
                  >
                    <div style={styles.convAvatar}>
                      {(conv.participants?.[0]?.name || "?")[0].toUpperCase()}
                    </div>
                    <div style={styles.convInfo}>
                      <div style={styles.convNameRow}>
                        <strong>
                          {conv.participants?.map((p) => p.name).join(", ") ||
                            "Unknown"}
                        </strong>
                        <span style={{ marginRight: 8 }}>
                          <span
                            style={{
                              color: CLASSIFICATION_COLORS[cls],
                              fontWeight: "bold",
                            }}
                          >
                            {CLASSIFICATION_LABELS[cls]}
                          </span>
                          {suivi && (
                            <span
                              style={{
                                marginLeft: 6,
                                color: "#0084ff",
                                fontSize: 12,
                                fontWeight: "bold",
                              }}
                            >
                              • Suivi
                            </span>
                          )}
                        </span>
                        <select
                          value={cls}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            updateClassification(
                              conv.id,
                              e.target.value,
                              priority,
                              suivi,
                            )
                          }
                          style={{
                            ...styles.classSelect,
                            color: CLASSIFICATION_COLORS[cls],
                            borderColor: CLASSIFICATION_COLORS[cls],
                          }}
                        >
                          <option value="non_classifie">Non Classifié</option>
                          <option value="cible">Cible</option>
                          <option value="hors_cible">Hors Cible</option>
                        </select>
                        <select
                          value={priority}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            updateClassification(
                              conv.id,
                              cls,
                              e.target.value,
                              suivi,
                            )
                          }
                          style={{
                            marginLeft: 8,
                            padding: "2px 8px",
                            borderRadius: 4,
                            border: "1px solid #ccc",
                          }}
                        >
                          <option value="non_definie">
                            Priorité: Non définie
                          </option>
                          <option value="haute">Priorité: Haute</option>
                          <option value="moyenne">Priorité: Moyenne</option>
                          <option value="basse">Priorité: Basse</option>
                        </select>
                        <label style={{ marginLeft: 8, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={suivi}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) =>
                              updateClassification(
                                conv.id,
                                cls,
                                priority,
                                e.target.checked,
                              )
                            }
                            style={{ marginRight: 4 }}
                          />
                          Suivi
                        </label>
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

          {/* Message View */}
          <div style={styles.messageView}>
            {selectedConv ? (
              <>
                <div style={styles.messageHeader}>
                  <h3>
                    {selectedConv.participants?.map((p) => p.name).join(", ") ||
                      "Conversation"}
                  </h3>
                </div>

                <div style={styles.messageList}>
                  {selectedConv.messages
                    ?.slice()
                    .reverse()
                    .map((msg, idx) => (
                      <div
                        key={msg.id || idx}
                        style={{
                          ...styles.messageBubble,
                          alignSelf:
                            msg.from === selectedConv.participants?.[0]?.name
                              ? "flex-start"
                              : "flex-end",
                          backgroundColor:
                            msg.from === selectedConv.participants?.[0]?.name
                              ? "#f1f1f1"
                              : "#0084ff",
                          color:
                            msg.from === selectedConv.participants?.[0]?.name
                              ? "#000"
                              : "#fff",
                          opacity: msg.sending ? 0.6 : 1,
                        }}
                      >
                        <small style={styles.msgFrom}>{msg.from}</small>
                        <p style={styles.msgText}>{msg.text}</p>
                        <small style={styles.msgTime}>
                          {new Date(msg.time).toLocaleString()}
                        </small>
                      </div>
                    ))}
                  <div ref={messagesEndRef} />
                </div>

                {/* Reply Box */}
                <div style={styles.replyBox}>
                  <input
                    type="text"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Type a message..."
                    style={styles.replyInput}
                    onKeyPress={(e) => e.key === "Enter" && sendReply()}
                  />
                  <button
                    onClick={sendReply}
                    disabled={sending || !replyText.trim()}
                    style={styles.sendBtn}
                  >
                    {sending ? "..." : "Send"}
                  </button>
                </div>
              </>
            ) : (
              <div style={styles.noConv}>
                <p>Select a conversation to view messages</p>
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
    maxWidth: "1200px",
    margin: "0 auto",
    padding: "20px",
    fontFamily: "Arial, sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "20px",
  },
  title: { margin: 0 },
  statusBadge: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 12px",
    borderRadius: "20px",
    backgroundColor: "#f5f5f5",
    fontSize: "13px",
  },
  statusDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
  },
  tabs: {
    display: "flex",
    gap: "10px",
    marginBottom: "20px",
  },
  tab: {
    padding: "10px 20px",
    border: "1px solid #ddd",
    borderRadius: "8px",
    backgroundColor: "#fff",
    cursor: "pointer",
    fontSize: "14px",
  },
  activeTab: {
    padding: "10px 20px",
    border: "1px solid #0084ff",
    borderRadius: "8px",
    backgroundColor: "#0084ff",
    color: "#fff",
    cursor: "pointer",
    fontSize: "14px",
  },
  inboxLayout: {
    display: "flex",
    border: "1px solid #ddd",
    borderRadius: "12px",
    height: "600px",
    overflow: "hidden",
  },
  convList: {
    width: "350px",
    borderRight: "1px solid #ddd",
    overflowY: "auto",
    backgroundColor: "#fafafa",
  },
  convListHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "15px",
    borderBottom: "1px solid #ddd",
  },
  refreshBtn: {
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: "18px",
  },
  classFilterBar: {
    display: "flex",
    gap: "4px",
    padding: "8px 10px",
    borderBottom: "1px solid #ddd",
    flexWrap: "wrap",
  },
  classFilterBtn: {
    padding: "4px 10px",
    border: "none",
    borderRadius: "12px",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: "bold",
  },
  convNameRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "6px",
  },
  classSelect: {
    padding: "2px 4px",
    border: "1px solid #ccc",
    borderRadius: "6px",
    fontSize: "10px",
    fontWeight: "bold",
    cursor: "pointer",
    backgroundColor: "#fff",
    outline: "none",
    flexShrink: 0,
  },
  convItem: {
    display: "flex",
    alignItems: "center",
    padding: "12px 15px",
    borderBottom: "1px solid #eee",
    cursor: "pointer",
    transition: "background 0.2s",
  },
  convAvatar: {
    width: "45px",
    height: "45px",
    borderRadius: "50%",
    backgroundColor: "#0084ff",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: "bold",
    fontSize: "18px",
    marginRight: "12px",
    flexShrink: 0,
  },
  convInfo: { flex: 1, overflow: "hidden" },
  lastMsg: {
    margin: "4px 0",
    fontSize: "13px",
    color: "#666",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  time: { fontSize: "11px", color: "#999" },
  messageView: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
  },
  messageHeader: {
    padding: "15px",
    borderBottom: "1px solid #ddd",
    backgroundColor: "#fff",
  },
  messageList: {
    flex: 1,
    overflowY: "auto",
    padding: "15px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  messageBubble: {
    maxWidth: "70%",
    padding: "10px 14px",
    borderRadius: "18px",
    fontSize: "14px",
  },
  msgFrom: { fontSize: "11px", opacity: 0.7 },
  msgText: { margin: "4px 0" },
  msgTime: { fontSize: "10px", opacity: 0.6 },
  replyBox: {
    display: "flex",
    padding: "15px",
    borderTop: "1px solid #ddd",
    backgroundColor: "#fff",
    gap: "10px",
  },
  replyInput: {
    flex: 1,
    padding: "10px 15px",
    borderRadius: "25px",
    border: "1px solid #ddd",
    fontSize: "14px",
    outline: "none",
  },
  sendBtn: {
    padding: "10px 20px",
    borderRadius: "25px",
    border: "none",
    backgroundColor: "#0084ff",
    color: "#fff",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: "bold",
  },
  noConv: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#999",
  },
  loading: { padding: "20px", textAlign: "center", color: "#999" },
  empty: { padding: "20px", textAlign: "center", color: "#999" },
  unreadBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f44336",
    color: "#fff",
    borderRadius: "50%",
    width: "20px",
    height: "20px",
    fontSize: "11px",
    fontWeight: "bold",
    marginLeft: "8px",
  },
};

export default Inbox;
