import React, { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";

const Inbox = () => {
  const { user } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [selectedConv, setSelectedConv] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [activeTab, setActiveTab] = useState("instagram");
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Connect to Socket.IO
  useEffect(() => {
    socketRef.current = io("http://localhost:5000", {
      transports: ["websocket", "polling"],
    });

    socketRef.current.on("connect", () => {
      console.log("Socket connected:", socketRef.current.id);
      setConnectionStatus("connected");

      // Join user room
      if (user?._id) {
        socketRef.current.emit("join", user._id);
      }
    });

    socketRef.current.on("disconnect", () => {
      console.log("Socket disconnected");
      setConnectionStatus("disconnected");
    });

    // Listen for new messages
    socketRef.current.on("newMessage", (data) => {
      console.log("New message received:", data);
      if (data.platform === activeTab) {
        fetchConversations();
      }
    });

    // Listen for message status updates
    socketRef.current.on("messageStatus", (data) => {
      console.log("Message status update:", data);
    });

    // Listen for reactions
    socketRef.current.on("messageReaction", (data) => {
      console.log("Message reaction:", data);
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [activeTab]); // eslint-disable-line

  // Scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selectedConv]);

  const fetchConversations = async () => {
    try {
      setLoading(true);
      const token = user?.token;

      if (activeTab === "instagram") {
        const res = await axios.get("/api/instagram/conversations", {
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
      console.error("Failed to fetch conversations:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConversations();
  }, [activeTab]);

  const sendReply = async () => {
    if (!replyText.trim() || !selectedConv) return;

    try {
      setSending(true);
      const token = user?.token;

      // Find the other participant (not the page)
      const recipient = selectedConv.participants?.find(
        (p) => p.id !== process.env.REACT_APP_PAGE_ID,
      );

      if (activeTab === "instagram") {
        await axios.post(
          "/api/instagram/send",
          {
            recipientId: recipient?.id || selectedConv.id,
            message: replyText,
          },
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
      }

      setReplyText("");
      // Refresh conversations
      fetchConversations();
    } catch (error) {
      console.error("Failed to send reply:", error);
      alert(
        "Failed to send message: " +
          (error.response?.data?.message || error.message),
      );
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
          </button>
          <button
            style={activeTab === "whatsapp" ? styles.activeTab : styles.tab}
            onClick={() => {
              setActiveTab("whatsapp");
              setSelectedConv(null);
            }}
          >
            💬 WhatsApp
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

            {loading ? (
              <p style={styles.loading}>Loading...</p>
            ) : conversations.length === 0 ? (
              <p style={styles.empty}>No conversations found</p>
            ) : (
              conversations.map((conv) => (
                <div
                  key={conv.id}
                  style={{
                    ...styles.convItem,
                    backgroundColor:
                      selectedConv?.id === conv.id ? "#e3f2fd" : "#fff",
                  }}
                  onClick={() => setSelectedConv(conv)}
                >
                  <div style={styles.convAvatar}>
                    {(conv.participants?.[0]?.name || "?")[0].toUpperCase()}
                  </div>
                  <div style={styles.convInfo}>
                    <strong>
                      {conv.participants?.map((p) => p.name).join(", ") ||
                        "Unknown"}
                    </strong>
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
              ))
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
};

export default Inbox;
