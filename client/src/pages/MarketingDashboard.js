import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const PLATFORM_ICONS = {
  instagram: "📸",
  facebook: "📘",
  whatsapp: "💬",
  email: "📧",
};

const MarketingDashboard = () => {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchSummary = useCallback(async () => {
    const token = user?.token;
    if (!token) return;
    try {
      const res = await axios.get("/api/analytics/marketing-summary", {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSummary(res.data);
    } catch (err) {
      console.error("Marketing analytics failed:", err.message);
    } finally {
      setLoading(false);
    }
  }, [user?.token]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const platformData = summary
    ? Object.entries(summary.byPlatform || {}).map(([name, count]) => ({
        name,
        count,
      }))
    : [];

  const recentMessages = summary?.recentMessages || [];

  return (
    <DashboardLayout>
      <div style={{ fontFamily: "'Hanken Grotesk', sans-serif" }}>
        <div style={{ marginBottom: 28 }}>
          <h1
            style={{
              fontFamily: "'Young Serif', serif",
              fontSize: 26,
              fontWeight: 400,
              color: "var(--text-primary)",
              margin: "0 0 6px",
            }}
          >
            📢 Marketing Dashboard
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-faint)", margin: 0 }}>
            Track incoming message performance across all channels.
          </p>
        </div>

        {/* Stats cards */}
        {loading ? (
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
          <div className="analytics-grid">
            <div className="analytics-card">
              <div className="analytics-card-label">Total Messages</div>
              <div
                className="analytics-card-value"
                style={{ color: "#C8956A" }}
              >
                {summary?.totalMessages ?? "—"}
              </div>
              <div className="analytics-card-sub">all time</div>
            </div>
            <div className="analytics-card">
              <div className="analytics-card-label">Today</div>
              <div
                className="analytics-card-value"
                style={{ color: "#6ECC8B" }}
              >
                {summary?.todayMessages ?? "—"}
              </div>
              <div className="analytics-card-sub">messages today</div>
            </div>
            <div className="analytics-card">
              <div className="analytics-card-label">This Week</div>
              <div
                className="analytics-card-value"
                style={{ color: "#7BA3CC" }}
              >
                {summary?.weekMessages ?? "—"}
              </div>
              <div className="analytics-card-sub">last 7 days</div>
            </div>
            <div className="analytics-card">
              <div className="analytics-card-label">Channels</div>
              <div
                className="analytics-card-value"
                style={{ color: "#D4A24C" }}
              >
                {platformData.length}
              </div>
              <div className="analytics-card-sub">active platforms</div>
            </div>
          </div>
        )}

        {/* Charts + recent */}
        <div className="charts-grid" style={{ marginTop: 24 }}>
          {/* Platform breakdown bar chart */}
          <div className="chart-card">
            <div className="chart-card-title">Messages by Platform</div>
            {platformData.length === 0 ? (
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
                <BarChart
                  data={platformData}
                  margin={{ top: 0, right: 0, left: -20, bottom: 0 }}
                >
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12, fill: "var(--text-faint)" }}
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
                  <Bar dataKey="count" fill="#C8956A" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Recent messages */}
          <div className="chart-card">
            <div className="chart-card-title">Recent Messages</div>
            {recentMessages.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "40px 0",
                  color: "var(--text-faint)",
                  fontSize: 13,
                }}
              >
                No recent messages
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {recentMessages.slice(0, 5).map((msg, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "8px 0",
                      borderBottom:
                        i < 4 ? "1px solid var(--border-primary)" : "none",
                    }}
                  >
                    <span style={{ fontSize: 18, flexShrink: 0 }}>
                      {PLATFORM_ICONS[msg.platform] || "📩"}
                    </span>
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: "var(--text-primary)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {msg.senderName || "Unknown"}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--text-faint)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {msg.text || "(no text)"}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--text-dim)",
                        flexShrink: 0,
                      }}
                    >
                      {msg.timestamp
                        ? (() => {
                            const diff =
                              Date.now() - new Date(msg.timestamp).getTime();
                            if (diff < 60000) return "just now";
                            if (diff < 3600000)
                              return `${Math.floor(diff / 60000)}m ago`;
                            if (diff < 86400000)
                              return `${Math.floor(diff / 3600000)}h ago`;
                            return `${Math.floor(diff / 86400000)}d ago`;
                          })()
                        : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default MarketingDashboard;
