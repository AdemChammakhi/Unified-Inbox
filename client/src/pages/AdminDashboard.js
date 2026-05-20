import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";
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

const EMPTY_FORM = {
  firstName: "",
  lastName: "",
  email: "",
  password: "",
  role: "",
};

const ROLES = [
  { key: "admin", icon: "🛡️", label: "Admin" },
  { key: "manager", icon: "📊", label: "Manager" },
  { key: "marketing", icon: "📢", label: "Marketing" },
];

const CHART_COLORS = ["#C8956A", "#6ECC8B", "#7BA3CC", "#E06C6C", "#D4A24C"];

const AdminDashboard = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [analyticsRange, setAnalyticsRange] = useState(7);
  const [analytics, setAnalytics] = useState(null);
  const [agentStats, setAgentStats] = useState([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);

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
    fetchAnalytics(analyticsRange);
  }, [fetchAnalytics, analyticsRange]);

  const [locks, setLocks] = useState([]);
  const [loading, setLoading] = useState(true);

  // Create Account state
  const [form, setForm] = useState(EMPTY_FORM);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");

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

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setFormError("");
    setFormSuccess("");

    if (!form.role) {
      setFormError("Please select a role");
      return;
    }

    setFormLoading(true);
    try {
      const res = await axios.post("/api/auth/create-user", form, {
        headers: { Authorization: `Bearer ${user?.token}` },
      });
      setFormSuccess(
        `Account created for ${res.data.firstName} ${res.data.lastName} (${res.data.role})`,
      );
      setForm(EMPTY_FORM);
    } catch (err) {
      setFormError(err.response?.data?.message || "Failed to create account");
    } finally {
      setFormLoading(false);
    }
  };

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

  const platformPieData = analytics
    ? (analytics.byPlatform || []).map((p) => ({
        name: p._id,
        value: p.count,
      }))
    : [];

  return (
    <DashboardLayout>
      <div style={styles.container}>
        <div style={styles.header}>
          <h1 style={styles.title}>🛡️ Admin Dashboard</h1>
          <p style={styles.subtitle}>
            Monitor active agent assignments across all channels.
          </p>
        </div>

        {/* ── Analytics Section ── */}
        <div style={{ marginBottom: 28 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <h2 style={{ ...styles.sectionTitle, margin: 0 }}>
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
                    style={{ height: 12, width: "50%", marginBottom: 10 }}
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
              <div className="analytics-grid">
                <div className="analytics-card">
                  <div className="analytics-card-label">
                    Total ({analyticsRange}d)
                  </div>
                  <div
                    className="analytics-card-value"
                    style={{ color: "#C8956A" }}
                  >
                    {analytics?.totalInRange ?? "—"}
                  </div>
                  <div className="analytics-card-sub">conversations</div>
                </div>
                <div className="analytics-card">
                  <div className="analytics-card-label">Today</div>
                  <div
                    className="analytics-card-value"
                    style={{ color: "#6ECC8B" }}
                  >
                    {analytics?.todayCount ?? "—"}
                  </div>
                  <div className="analytics-card-sub">new today</div>
                </div>
                <div className="analytics-card">
                  <div className="analytics-card-label">This Week</div>
                  <div
                    className="analytics-card-value"
                    style={{ color: "#7BA3CC" }}
                  >
                    {analytics?.weekCount ?? "—"}
                  </div>
                  <div className="analytics-card-sub">last 7 days</div>
                </div>
                <div className="analytics-card">
                  <div className="analytics-card-label">Active Agents</div>
                  <div
                    className="analytics-card-value"
                    style={{ color: "#D4A24C" }}
                  >
                    {analytics?.activeAgentCount ?? "—"}
                  </div>
                  <div className="analytics-card-sub">agents working</div>
                </div>
              </div>

              <div className="charts-grid">
                {/* Daily message volume */}
                <div className="chart-card">
                  <div className="chart-card-title">Daily Volume</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart
                      data={analytics?.dailyData || []}
                      margin={{ top: 0, right: 0, left: -20, bottom: 0 }}
                    >
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11, fill: "var(--text-faint)" }}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "var(--text-faint)" }}
                        allowDecimals={false}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--bg-card)",
                          border: "1px solid var(--border-primary)",
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

                {/* Platform breakdown */}
                <div className="chart-card">
                  <div className="chart-card-title">By Platform</div>
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
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie
                          data={platformPieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={50}
                          outerRadius={80}
                          paddingAngle={3}
                          dataKey="value"
                          label={({ name, percent }) =>
                            `${name} ${(percent * 100).toFixed(0)}%`
                          }
                          labelLine={false}
                        >
                          {platformPieData.map((_, idx) => (
                            <Cell
                              key={idx}
                              fill={CHART_COLORS[idx % CHART_COLORS.length]}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: "var(--bg-card)",
                            border: "1px solid var(--border-primary)",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Legend
                          formatter={(value) =>
                            value.charAt(0).toUpperCase() + value.slice(1)
                          }
                          wrapperStyle={{ fontSize: 12 }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {/* Agent Reply Ranking */}
              <div className="chart-card" style={{ marginTop: 16 }}>
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
                      const pct = Math.round((agent.replies / max) * 100);
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
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                marginBottom: 4,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 13,
                                  fontWeight: 600,
                                  color: "var(--text-primary)",
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
                                    CHART_COLORS[idx % CHART_COLORS.length],
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
                                background: "var(--bg-hover)",
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  height: "100%",
                                  borderRadius: 3,
                                  width: `${pct}%`,
                                  background:
                                    CHART_COLORS[idx % CHART_COLORS.length],
                                  transition: "width 0.4s ease",
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
                          <PlatformIcon platform={lock.platform} size={20} />{" "}
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
        {/* Create Account Section */}
        <div style={{ ...styles.section, marginTop: "24px" }}>
          <h2 style={styles.sectionTitle}>➕ Create Account</h2>
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-dim)",
              marginBottom: "20px",
              marginTop: 0,
            }}
          >
            Create a new user account with the appropriate role.
          </p>

          {formError && (
            <div style={styles.formAlert("var(--danger)")}>{formError}</div>
          )}
          {formSuccess && (
            <div style={styles.formAlert("var(--success, #22c55e)")}>
              {formSuccess}
            </div>
          )}

          <form onSubmit={handleCreateUser} style={styles.createForm}>
            <div style={styles.formRow}>
              <div style={styles.formGroup}>
                <label style={styles.label}>First Name</label>
                <input
                  style={styles.input}
                  type="text"
                  placeholder="First name"
                  required
                  value={form.firstName}
                  onChange={(e) =>
                    setForm({ ...form, firstName: e.target.value })
                  }
                />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>Last Name</label>
                <input
                  style={styles.input}
                  type="text"
                  placeholder="Last name"
                  required
                  value={form.lastName}
                  onChange={(e) =>
                    setForm({ ...form, lastName: e.target.value })
                  }
                />
              </div>
            </div>

            <div style={styles.formRow}>
              <div style={styles.formGroup}>
                <label style={styles.label}>Email</label>
                <input
                  style={styles.input}
                  type="email"
                  placeholder="user@company.com"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>Password</label>
                <input
                  style={styles.input}
                  type="password"
                  placeholder="Strong password"
                  minLength={6}
                  required
                  value={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                />
              </div>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Select Your Role</label>
              <div style={styles.roleSelector}>
                {ROLES.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => setForm({ ...form, role: r.key })}
                    style={styles.roleOption(form.role === r.key)}
                  >
                    <span style={styles.roleIcon}>{r.icon}</span>
                    <span style={styles.roleName}>{r.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ ...styles.formRow, alignItems: "flex-end" }}>
              <div style={{ ...styles.formGroup, flex: "0 0 auto" }}>
                <button
                  type="submit"
                  style={styles.createBtn}
                  disabled={formLoading}
                >
                  {formLoading ? "Creating…" : "Create Account"}
                </button>
              </div>
            </div>
          </form>
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
  createForm: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  formRow: {
    display: "flex",
    gap: "14px",
    flexWrap: "wrap",
  },
  formGroup: {
    flex: 1,
    minWidth: "180px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  label: {
    fontSize: "12px",
    fontWeight: 700,
    color: "var(--text-dim)",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  input: {
    padding: "9px 12px",
    borderRadius: "8px",
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    fontSize: "13px",
    fontFamily: "'Hanken Grotesk', sans-serif",
    outline: "none",
  },
  roleSelector: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "10px",
  },
  roleOption: (selected) => ({
    border: selected
      ? "1px solid var(--accent)"
      : "1px solid var(--border-primary)",
    backgroundColor: selected ? "var(--accent)18" : "var(--bg-primary)",
    color: "var(--text-primary)",
    borderRadius: "8px",
    padding: "10px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    cursor: "pointer",
    fontFamily: "'Hanken Grotesk', sans-serif",
    fontSize: "13px",
    fontWeight: selected ? 700 : 600,
    justifyContent: "center",
  }),
  roleIcon: {
    fontSize: "16px",
    lineHeight: 1,
  },
  roleName: {
    lineHeight: 1,
  },
  createBtn: {
    padding: "10px 22px",
    borderRadius: "8px",
    border: "none",
    backgroundColor: "var(--accent)",
    color: "#fff",
    fontWeight: 700,
    fontSize: "13px",
    fontFamily: "'Hanken Grotesk', sans-serif",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  formAlert: (color) => ({
    padding: "10px 14px",
    borderRadius: "8px",
    border: `1px solid ${color}`,
    backgroundColor: `${color}18`,
    color: color,
    fontSize: "13px",
    marginBottom: "8px",
  }),
};

export default AdminDashboard;
