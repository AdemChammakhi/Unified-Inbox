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
  const [newUserForm, setNewUserForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    role: "manager",
  });
  const [createUserLoading, setCreateUserLoading] = useState(false);
  const [createUserMessage, setCreateUserMessage] = useState("");
  const [createUserError, setCreateUserError] = useState("");

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

  const handleCreateUserChange = (e) => {
    const { name, value } = e.target;
    setNewUserForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setCreateUserError("");
    setCreateUserMessage("");

    const token = user?.token;
    if (!token) {
      setCreateUserError("Your session has expired. Please login again.");
      return;
    }

    setCreateUserLoading(true);
    try {
      const res = await axios.post("/api/admin/create-user", newUserForm, {
        headers: { Authorization: `Bearer ${token}` },
      });

      setCreateUserMessage(
        `User created successfully: ${res.data.user.email} (${res.data.user.role}). Share credentials manually with the user.`,
      );
      setNewUserForm({
        firstName: "",
        lastName: "",
        email: "",
        password: "",
        role: "manager",
      });
    } catch (error) {
      if (error.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }

      if (error.response?.status === 403) {
        setCreateUserError("Only admins can create new users.");
      } else {
        setCreateUserError(
          error.response?.data?.message || "Failed to create user account.",
        );
      }
    } finally {
      setCreateUserLoading(false);
    }
  };

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

        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Create New User</h2>
          <p style={styles.subtitle}>
            This form is admin-only. No invitation email is sent; share the
            initial credentials manually.
          </p>

          {createUserMessage && (
            <div style={styles.successMessage}>{createUserMessage}</div>
          )}
          {createUserError && (
            <div style={styles.errorMessage}>{createUserError}</div>
          )}

          <form onSubmit={handleCreateUser} style={styles.createUserForm}>
            <div style={styles.formRow}>
              <label style={styles.formLabel}>
                First Name
                <input
                  style={styles.formInput}
                  name="firstName"
                  value={newUserForm.firstName}
                  onChange={handleCreateUserChange}
                  required
                />
              </label>

              <label style={styles.formLabel}>
                Last Name
                <input
                  style={styles.formInput}
                  name="lastName"
                  value={newUserForm.lastName}
                  onChange={handleCreateUserChange}
                  required
                />
              </label>
            </div>

            <div style={styles.formRow}>
              <label style={{ ...styles.formLabel, flex: 2 }}>
                Email
                <input
                  style={styles.formInput}
                  type="email"
                  name="email"
                  value={newUserForm.email}
                  onChange={handleCreateUserChange}
                  required
                />
              </label>

              <label style={styles.formLabel}>
                Role
                <select
                  style={styles.formInput}
                  name="role"
                  value={newUserForm.role}
                  onChange={handleCreateUserChange}
                  required
                >
                  <option value="manager">Manager</option>
                  <option value="marketing">Marketing</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            </div>

            <div style={styles.formRow}>
              <label style={{ ...styles.formLabel, flex: 2 }}>
                Temporary Password
                <input
                  style={styles.formInput}
                  type="password"
                  name="password"
                  value={newUserForm.password}
                  onChange={handleCreateUserChange}
                  minLength={6}
                  required
                />
              </label>
            </div>

            <button
              type="submit"
              style={styles.createUserButton}
              disabled={createUserLoading}
            >
              {createUserLoading ? "Creating user..." : "Create New User"}
            </button>
          </form>
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
    marginBottom: "20px",
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
  createUserForm: {
    marginTop: "16px",
  },
  formRow: {
    display: "flex",
    gap: "12px",
    marginBottom: "12px",
    flexWrap: "wrap",
  },
  formLabel: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    color: "var(--text-faint)",
    fontSize: "13px",
    fontWeight: 600,
    flex: 1,
    minWidth: "220px",
  },
  formInput: {
    height: "40px",
    borderRadius: "10px",
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    padding: "0 12px",
    fontSize: "14px",
    outline: "none",
  },
  createUserButton: {
    marginTop: "6px",
    padding: "10px 16px",
    borderRadius: "10px",
    border: "1px solid var(--accent)",
    backgroundColor: "var(--accent)",
    color: "#fff",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  successMessage: {
    marginTop: "12px",
    marginBottom: "6px",
    borderRadius: "10px",
    padding: "10px 12px",
    fontSize: "13px",
    border: "1px solid rgba(34, 197, 94, 0.45)",
    color: "#166534",
    backgroundColor: "rgba(34, 197, 94, 0.12)",
  },
  errorMessage: {
    marginTop: "12px",
    marginBottom: "6px",
    borderRadius: "10px",
    padding: "10px 12px",
    fontSize: "13px",
    border: "1px solid rgba(220, 38, 38, 0.45)",
    color: "#7f1d1d",
    backgroundColor: "rgba(248, 113, 113, 0.14)",
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
