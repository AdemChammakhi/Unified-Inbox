import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";

const PLATFORM_ICONS = {
  instagram: "📸",
  facebook: "📘",
  whatsapp: "💬",
  email: "📧",
};

const AdminDashboard = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [locks, setLocks] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchLocks = useCallback(async () => {
    const token = user?.token;
    if (!token) return;
    try {
      const res = await axios.get("/api/locks/all", {
        headers: { Authorization: `Bearer ${token}` },
      });
      setLocks(res.data.locks || []);
    } catch (error) {
      if (error.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
      console.error("Failed to fetch locks:", error.message);
    } finally {
      setLoading(false);
    }
  }, [user?.token, logout, navigate]);

  useEffect(() => {
    fetchLocks();
    const interval = setInterval(fetchLocks, 15000);
    return () => clearInterval(interval);
  }, [fetchLocks]);

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
      fetchLocks();
    } catch (error) {
      alert(
        "Failed to unlock: " + (error.response?.data?.message || error.message),
      );
    }
  };

  const grouped = locks.reduce((acc, lock) => {
    if (!acc[lock.platform]) acc[lock.platform] = [];
    acc[lock.platform].push(lock);
    return acc;
  }, {});

  return (
    <DashboardLayout>
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>🛡️ Admin Dashboard</h1>
          <p style={styles.subtitle}>
            Monitor active agent assignments across all channels.
          </p>
        </div>

        {/* Stats Row */}
        <div style={styles.statsRow}>
          <div style={styles.statCard}>
            <div style={styles.statValue}>{locks.length}</div>
            <div style={styles.statLabel}>Active Assignments</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statValue}>{Object.keys(grouped).length}</div>
            <div style={styles.statLabel}>Platforms Active</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statValue}>
              {new Set(locks.map((l) => l.agentId)).size}
            </div>
            <div style={styles.statLabel}>Agents Working</div>
          </div>
        </div>

        {/* Active Assignments Table */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Active Agent Assignments</h2>

          {loading ? (
            <div style={styles.empty}>Loading assignments…</div>
          ) : locks.length === 0 ? (
            <div style={styles.empty}>
              No active assignments — all conversations are open.
            </div>
          ) : (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Platform</th>
                    <th style={styles.th}>Conversation</th>
                    <th style={styles.th}>Agent</th>
                    <th style={styles.th}>Assigned Since</th>
                    <th style={{ ...styles.th, textAlign: "center" }}>
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {locks.map((lock, i) => (
                    <tr
                      key={lock.conversationId + lock.platform}
                      style={{
                        backgroundColor:
                          i % 2 === 0 ? "transparent" : "var(--bg-hover)",
                      }}
                    >
                      <td style={styles.td}>
                        <span style={styles.platformPill}>
                          {PLATFORM_ICONS[lock.platform] || "📡"}{" "}
                          {lock.platform.charAt(0).toUpperCase() +
                            lock.platform.slice(1)}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <code style={styles.convId}>
                          {lock.conversationId.length > 24
                            ? lock.conversationId.slice(0, 24) + "…"
                            : lock.conversationId}
                        </code>
                      </td>
                      <td style={styles.td}>
                        <div style={styles.agentInfo}>
                          <div style={styles.agentAvatar}>
                            {(lock.agentName || "?")[0].toUpperCase()}
                          </div>
                          <div>
                            <div style={styles.agentName}>{lock.agentName}</div>
                            <div style={styles.agentEmail}>
                              {lock.agentEmail}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={styles.td}>
                        {new Date(lock.lockedAt).toLocaleString()}
                      </td>
                      <td style={{ ...styles.td, textAlign: "center" }}>
                        <button
                          style={styles.unlockBtn}
                          onClick={() =>
                            handleUnlock(lock.conversationId, lock.platform)
                          }
                        >
                          🔓 Unlock
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
    </DashboardLayout>
  );
};

const styles = {
  container: {
    fontFamily: "'Hanken Grotesk', sans-serif",
    padding: "0",
  },
  header: {
    marginBottom: "28px",
  },
  title: {
    fontSize: "26px",
    fontWeight: 700,
    color: "var(--text-primary)",
    fontFamily: "'Young Serif', serif",
    margin: "0 0 6px",
  },
  subtitle: {
    fontSize: "14px",
    color: "var(--text-faint)",
    margin: 0,
  },
  statsRow: {
    display: "flex",
    gap: "16px",
    marginBottom: "28px",
  },
  statCard: {
    flex: 1,
    padding: "20px",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "12px",
    textAlign: "center",
  },
  statValue: {
    fontSize: "28px",
    fontWeight: 700,
    color: "var(--accent)",
    fontFamily: "'Young Serif', serif",
  },
  statLabel: {
    fontSize: "12px",
    color: "var(--text-dim)",
    marginTop: "4px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  section: {
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "12px",
    padding: "24px",
  },
  sectionTitle: {
    fontSize: "16px",
    fontWeight: 700,
    color: "var(--text-primary)",
    margin: "0 0 16px",
    fontFamily: "'Young Serif', serif",
  },
  empty: {
    padding: "32px",
    textAlign: "center",
    color: "var(--text-faint)",
    fontSize: "14px",
  },
  tableWrap: {
    overflowX: "auto",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "13px",
  },
  th: {
    textAlign: "left",
    padding: "10px 14px",
    borderBottom: "2px solid var(--border-primary)",
    color: "var(--text-dim)",
    fontWeight: 700,
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  td: {
    padding: "12px 14px",
    borderBottom: "1px solid var(--border-primary)",
    color: "var(--text-primary)",
    verticalAlign: "middle",
  },
  platformPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "12px",
    fontWeight: 600,
  },
  convId: {
    fontSize: "11px",
    fontFamily: "monospace",
    backgroundColor: "var(--bg-hover)",
    padding: "3px 8px",
    borderRadius: "4px",
    color: "var(--text-faint)",
  },
  agentInfo: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  agentAvatar: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    backgroundColor: "var(--accent)22",
    border: "2px solid var(--accent)44",
    color: "var(--accent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: "13px",
    flexShrink: 0,
  },
  agentName: {
    fontWeight: 600,
    fontSize: "13px",
    color: "var(--text-primary)",
  },
  agentEmail: {
    fontSize: "11px",
    color: "var(--text-dim)",
  },
  unlockBtn: {
    padding: "6px 14px",
    borderRadius: "8px",
    border: "1px solid var(--danger)",
    backgroundColor: "transparent",
    color: "var(--danger)",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 600,
    fontFamily: "'Hanken Grotesk', sans-serif",
    transition: "all 0.2s ease",
  },
};

export default AdminDashboard;
