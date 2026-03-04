import React from "react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useNavigate, Link } from "react-router-dom";

const DashboardLayout = ({ children }) => {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="dashboard">
      <nav className="dashboard-nav">
        <div className="nav-brand">
          <img src="/logo.png" alt="Logo" className="brand-logo" />
          <span className="brand-text">Unified Inbox</span>
        </div>
        <div className="nav-right">
          <Link
            to="/inbox"
            style={{
              textDecoration: "none",
              marginRight: 15,
              fontWeight: 600,
            }}
          >
            📥 Inbox
          </Link>
          <Link
            to={`/${user?.role}`}
            style={{
              textDecoration: "none",
              marginRight: 15,
              fontWeight: 600,
            }}
          >
            📊 Dashboard
          </Link>
          <div className="user-info">
            <strong>
              {user?.firstName} {user?.lastName}
            </strong>
          </div>
          <span className={`badge badge-${user?.role}`}>{user?.role}</span>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={
              theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
            }
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button className="btn-logout" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </nav>
      <div className="dashboard-content">{children}</div>
    </div>
  );
};

export default DashboardLayout;
