import React, { useState } from "react";
import { useNavigate, Link, Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";

const Login = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login, user, loading: authLoading } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const showRegistrationClosedMessage =
    searchParams.get("registration") === "closed";

  // If user is already logged in, redirect to their dashboard
  if (authLoading)
    return <div style={{ padding: 40, textAlign: "center" }}>Loading...</div>;
  if (user) return <Navigate to={`/${user.role}`} replace />;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await login(email, password);
      navigate(`/${data.role}`);
    } catch (err) {
      setError(err.response?.data?.message || "Login failed");
    }
    setLoading(false);
  };

  return (
    <div className="auth-page auth-shell">
      <button
        className="theme-toggle auth-theme-toggle"
        onClick={toggleTheme}
        title={
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
        }
      >
        {theme === "dark" ? "☀️" : "🌙"}
      </button>

      <div className="auth-portal">
        <div className="auth-visual">
          <img
            src="/logo.png"
            alt="Unified Inbox"
            className="auth-visual-image"
            width="255"
            height="255"
          />
          <h2>Unified Inbox</h2>
          <p>Your entire social inbox, organized with clarity and speed.</p>
        </div>

        <div className="auth-card auth-form-panel">
          <div className="brand">
            <span>Unified Inbox</span>
          </div>
          <h1>Welcome Back</h1>
          <p className="subtitle">Sign in to your communication hub</p>

          {showRegistrationClosedMessage && (
            <div
              style={{
                marginBottom: "12px",
                borderRadius: "10px",
                border: "1px solid var(--border-primary)",
                backgroundColor: "var(--bg-hover)",
                color: "var(--text-faint)",
                padding: "10px 12px",
                fontSize: "13px",
              }}
            >
              Registration is currently closed to the public. Please sign in
              with an existing account.
            </div>
          )}

          {error && <div className="error-msg">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
              />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
              />
            </div>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>

          <div className="auth-footer-links">
            <Link to="/terms">Terms of Service</Link>
            <Link to="/privacy">Privacy Policy</Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
