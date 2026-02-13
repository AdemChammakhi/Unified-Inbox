import React from "react";
import DashboardLayout from "../components/DashboardLayout";

const MarketingDashboard = () => {
  return (
    <DashboardLayout>
      <div className="dashboard-header">
        <h1>📢 Marketing Dashboard</h1>
        <p>
          Manage campaigns, broadcast messages, and track marketing performance.
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
          <div className="stat-icon">📣</div>
          <div className="stat-value">12</div>
          <div className="stat-label">Active Campaigns</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">📨</div>
          <div className="stat-value">15.2K</div>
          <div className="stat-label">Messages Sent</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">👁️</div>
          <div className="stat-value">68%</div>
          <div className="stat-label">Open Rate</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">🎯</div>
          <div className="stat-value">4.2%</div>
          <div className="stat-label">Conversion Rate</div>
        </div>
      </div>

      <div className="features-section">
        <h2>Marketing Tools</h2>
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">📣</div>
            <h3>Campaign Manager</h3>
            <p>
              Create and manage multi-channel marketing campaigns across all
              platforms.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📡</div>
            <h3>Broadcast Messages</h3>
            <p>
              Send targeted broadcast messages to segmented audiences on any
              channel.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">👥</div>
            <h3>Audience Segmentation</h3>
            <p>
              Build and manage audience segments based on behavior and
              demographics.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📅</div>
            <h3>Content Scheduler</h3>
            <p>
              Schedule marketing content and campaigns across all communication
              channels.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📊</div>
            <h3>Campaign Analytics</h3>
            <p>
              Track open rates, click-through rates, conversions, and ROI for
              all campaigns.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🧪</div>
            <h3>A/B Testing</h3>
            <p>
              Test different message variants to optimize engagement and
              conversion rates.
            </p>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default MarketingDashboard;
