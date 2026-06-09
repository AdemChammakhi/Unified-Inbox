import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useNavigate, Link, useLocation } from "react-router-dom";
import {
  Inbox,
  LayoutDashboard,
  LogOut,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
} from "lucide-react";

const DashboardLayout = ({ children, noPadding = false }) => {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const dashboardPath = user?.role ? `/${user.role}` : "/";

  const initials = user
    ? `${user.firstName?.[0] || ""}${user.lastName?.[0] || ""}`.toUpperCase()
    : "?";

  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className={`sidebar${collapsed ? " sidebar-collapsed" : ""}`}>
        {/* Brand */}
        <div className="sidebar-brand">
          <div className="sidebar-brand-icon">
            <img src="/logo.png" alt="Unified Inbox" style={{ width: 44, height: 44, objectFit: 'contain' }} />
          </div>
          {!collapsed && (
            <span className="sidebar-brand-text">Unified Inbox</span>
          )}
        </div>

        {/* Nav */}
        <nav className="sidebar-nav">
          {user?.role !== "manager" && (
            <Link
              to="/inbox"
              className={`sidebar-link${location.pathname === "/inbox" ? " active" : ""}`}
              title="Inbox"
            >
              <Inbox size={18} className="sidebar-link-icon" />
              {!collapsed && <span>Inbox</span>}
            </Link>
          )}

          <Link
            to={dashboardPath}
            className={`sidebar-link${location.pathname === dashboardPath ? " active" : ""}`}
            title="Dashboard"
          >
            <LayoutDashboard size={18} className="sidebar-link-icon" />
            {!collapsed && <span>Dashboard</span>}
          </Link>
        </nav>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Bottom section */}
        <div className="sidebar-bottom">
          {/* Theme toggle */}
          <button
            className="sidebar-icon-btn"
            onClick={toggleTheme}
            title={
              theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
            }
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            {!collapsed && (
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            )}
          </button>

          {/* User info */}
          <div className="sidebar-user">
            <div className="sidebar-avatar">{initials}</div>
            {!collapsed && (
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">
                  {user?.firstName} {user?.lastName}
                </span>
                <span className={`sidebar-role-badge role-${user?.role}`}>
                  {user?.role}
                </span>
              </div>
            )}
          </div>

          {/* Logout */}
          <button
            className="sidebar-icon-btn sidebar-logout"
            onClick={handleLogout}
            title="Logout"
          >
            <LogOut size={16} />
            {!collapsed && <span>Logout</span>}
          </button>
        </div>

        {/* Collapse toggle */}
        <button
          className="sidebar-collapse-btn"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </aside>

      {/* ── Main content ── */}
      <main className={`main-content${noPadding ? " no-padding" : ""}`}>
        {children}
      </main>
    </div>
  );
};

export default DashboardLayout;
