import React, { useState, useEffect } from "react";
import axios from "axios";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";

const Inbox = () => {
  const { user } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [selectedConv, setSelectedConv] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("instagram");

  useEffect(() => {
    fetchConversations();
  }, [activeTab]);

  const fetchConversations = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await axios.get(`/api/${activeTab}/conversations`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      setConversations(res.data.conversations || []);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load conversations");
      setConversations([]);
    }
    setLoading(false);
  };

  const handleSendReply = async () => {
    if (!replyText.trim() || !selectedConv) return;
    setSending(true);
    try {
      const recipientId =
        selectedConv.participants?.find((p) => p.id !== selectedConv.id)?.id ||
        selectedConv.participants?.[0]?.id;

      await axios.post(
        `/api/${activeTab}/send`,
        { recipientId, message: replyText },
        { headers: { Authorization: `Bearer ${user.token}` } },
      );
      setReplyText("");
      fetchConversations();
    } catch (err) {
      setError(err.response?.data?.message || "Failed to send message");
    }
    setSending(false);
  };

  const formatTime = (timeStr) => {
    if (!timeStr) return "";
    const date = new Date(timeStr);
    return date.toLocaleString();
  };

  return (
    <DashboardLayout>
      <div className="dashboard-header">
        <h1>📥 Unified Inbox</h1>
        <p>All your conversations in one place</p>
      </div>

      {/* Platform tabs */}
      <div className="channels-bar">
        {[
          { key: "instagram", icon: "📸", label: "Instagram" },
          { key: "whatsapp", icon: "💬", label: "WhatsApp" },
        ].map((tab) => (
          <div
            key={tab.key}
            className={`channel-pill ${activeTab === tab.key ? "active" : ""}`}
            onClick={() => {
              setActiveTab(tab.key);
              setSelectedConv(null);
            }}
            style={{
              cursor: "pointer",
              opacity: activeTab === tab.key ? 1 : 0.6,
              border:
                activeTab === tab.key
                  ? "2px solid #4f46e5"
                  : "2px solid transparent",
            }}
          >
            <span className="channel-icon">{tab.icon}</span> {tab.label}
          </div>
        ))}
      </div>

      {error && (
        <div className="error-msg" style={{ margin: "15px 0" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 20, marginTop: 20, minHeight: 500 }}>
        {/* Conversation list */}
        <div
          style={{
            width: 320,
            background: "#fff",
            borderRadius: 12,
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "15px 20px",
              borderBottom: "1px solid #eee",
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            Conversations
          </div>

          {loading ? (
            <div style={{ padding: 30, textAlign: "center", color: "#999" }}>
              Loading...
            </div>
          ) : conversations.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: "#999" }}>
              No conversations yet
            </div>
          ) : (
            <div style={{ overflowY: "auto", maxHeight: 450 }}>
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => setSelectedConv(conv)}
                  style={{
                    padding: "12px 20px",
                    borderBottom: "1px solid #f3f3f3",
                    cursor: "pointer",
                    background:
                      selectedConv?.id === conv.id ? "#f0f0ff" : "#fff",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {conv.participants?.map((p) => p.name).join(", ") ||
                      "Unknown"}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "#888",
                      marginTop: 4,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {conv.lastMessage?.text || "No messages"}
                  </div>
                  <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>
                    {formatTime(conv.lastMessage?.time)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Message area */}
        <div
          style={{
            flex: 1,
            background: "#fff",
            borderRadius: 12,
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {selectedConv ? (
            <>
              {/* Header */}
              <div
                style={{
                  padding: "15px 20px",
                  borderBottom: "1px solid #eee",
                  fontWeight: 700,
                  fontSize: 15,
                }}
              >
                {selectedConv.participants?.map((p) => p.name).join(", ")}
              </div>

              {/* Messages */}
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {[...(selectedConv.messages || [])].reverse().map((msg, i) => (
                  <div
                    key={msg.id || i}
                    style={{
                      alignSelf:
                        msg.fromId === selectedConv.id
                          ? "flex-end"
                          : "flex-start",
                      background:
                        msg.fromId === selectedConv.id ? "#4f46e5" : "#f3f3f3",
                      color: msg.fromId === selectedConv.id ? "#fff" : "#333",
                      padding: "10px 15px",
                      borderRadius: 16,
                      maxWidth: "70%",
                      fontSize: 14,
                    }}
                  >
                    <div
                      style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}
                    >
                      {msg.from}
                    </div>
                    <div>{msg.text || "[Attachment]"}</div>
                    <div
                      style={{
                        fontSize: 10,
                        opacity: 0.7,
                        marginTop: 4,
                        textAlign: "right",
                      }}
                    >
                      {formatTime(msg.time)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Reply box */}
              <div
                style={{
                  padding: 15,
                  borderTop: "1px solid #eee",
                  display: "flex",
                  gap: 10,
                }}
              >
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendReply()}
                  placeholder="Type a reply..."
                  style={{
                    flex: 1,
                    padding: "10px 15px",
                    borderRadius: 8,
                    border: "1px solid #ddd",
                    fontSize: 14,
                  }}
                />
                <button
                  onClick={handleSendReply}
                  disabled={sending || !replyText.trim()}
                  style={{
                    padding: "10px 20px",
                    borderRadius: 8,
                    background: "#4f46e5",
                    color: "#fff",
                    border: "none",
                    cursor: "pointer",
                    fontWeight: 600,
                    opacity: sending ? 0.6 : 1,
                  }}
                >
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </>
          ) : (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#999",
                fontSize: 16,
              }}
            >
              Select a conversation to view messages
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Inbox;
