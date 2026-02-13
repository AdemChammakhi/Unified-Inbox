import React from "react";
import { useAuth } from "../context/AuthContext";
import { useNavigate } from "react-router-dom";

const DashboardLayout = ({ children }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="dashboard">
      <nav className="dashboard-nav">
        <div className="nav-brand">Unified Inbox</div>
        <div className="nav-right">
          <div className="user-info">
            <strong>
              {user?.firstName} {user?.lastName}
            </strong>
          </div>
          <span className={`badge badge-${user?.role}`}>{user?.role}</span>
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
