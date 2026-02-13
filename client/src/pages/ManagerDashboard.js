import React from "react";
import DashboardLayout from "../components/DashboardLayout";

const ManagerDashboard = () => {
  return (
    <DashboardLayout>
      <div className="dashboard-header">
        <h1>📊 Manager Dashboard</h1>
        <p>
          Oversee your team's performance and manage conversation assignments.
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
          <div className="stat-icon">👤</div>
          <div className="stat-value">8</div>
          <div className="stat-label">Team Members</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">💬</div>
          <div className="stat-value">342</div>
          <div className="stat-label">Open Conversations</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">⏱️</div>
          <div className="stat-value">2.4m</div>
          <div className="stat-label">Avg Response Time</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-value">89%</div>
          <div className="stat-label">Resolution Rate</div>
        </div>
      </div>

      <div className="features-section">
        <h2>Manager Tools</h2>
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">📈</div>
            <h3>Team Performance</h3>
            <p>
              Monitor individual and team KPIs, response times, and customer
              satisfaction scores.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🔀</div>
            <h3>Conversation Routing</h3>
            <p>
              Assign and reassign conversations to team members based on skills
              and availability.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📊</div>
            <h3>Sales Pipeline</h3>
            <p>
              Track leads through the sales funnel across all communication
              channels.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📝</div>
            <h3>Team Reports</h3>
            <p>
              Generate weekly and monthly performance reports for your team.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🎯</div>
            <h3>Goal Tracking</h3>
            <p>
              Set and monitor team goals for response times, conversions, and
              satisfaction.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📅</div>
            <h3>Schedule Management</h3>
            <p>
              Manage team schedules and ensure adequate coverage across all
              channels.
            </p>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default ManagerDashboard;
