import React from "react";
import DashboardLayout from "../components/DashboardLayout";

const AdminDashboard = () => {
  return (
    <DashboardLayout>
      <div className="dashboard-header">
        <h1>🛡️ Admin Dashboard</h1>
        <p>
          Full platform control — manage users, channels, and system settings.
        </p>
      </div>

      <div className="channels-bar">
        <div className="channel-pill">
          <span className="channel-icon">💬</span> WhatsApp
        </div>
        <div className="channel-pill">
          <span className="channel-icon">📘</span> Messenger
        </div>
        <div className="channel-pill">
          <span className="channel-icon">📸</span> Instagram
        </div>
        <div className="channel-pill">
          <span className="channel-icon">🎵</span> TikTok
        </div>
        <div className="channel-pill">
          <span className="channel-icon">📧</span> Email
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">👥</div>
          <div className="stat-value">24</div>
          <div className="stat-label">Total Users</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">💬</div>
          <div className="stat-value">1,248</div>
          <div className="stat-label">Total Conversations</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">📡</div>
          <div className="stat-value">5</div>
          <div className="stat-label">Active Channels</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">⚡</div>
          <div className="stat-value">99.9%</div>
          <div className="stat-label">System Uptime</div>
        </div>
      </div>

      <div className="features-section">
        <h2>Admin Tools</h2>
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">👥</div>
            <h3>User Management</h3>
            <p>
              Create, edit, and manage user accounts. Assign roles and
              permissions across the platform.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🔌</div>
            <h3>Channel Integrations</h3>
            <p>
              Configure and manage WhatsApp, Messenger, Instagram, TikTok, and
              Email connections.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📊</div>
            <h3>Analytics & Reports</h3>
            <p>
              View platform-wide analytics, conversation metrics, and generate
              detailed reports.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">⚙️</div>
            <h3>System Settings</h3>
            <p>
              Configure platform settings, security policies, and automated
              workflows.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📋</div>
            <h3>Audit Logs</h3>
            <p>
              Track all platform activity, user actions, and system events for
              compliance.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🔔</div>
            <h3>Notifications</h3>
            <p>
              Configure system-wide notification rules and alert thresholds.
            </p>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default AdminDashboard;
