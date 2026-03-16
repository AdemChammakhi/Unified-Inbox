import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";

const roles = [
  { key: "admin", icon: "🛡️", label: "Admin" },
  { key: "manager", icon: "📊", label: "Manager" },
  { key: "marketing", icon: "📢", label: "Marketing" },
];

const Signup = () => {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    role: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { signup } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!form.role) {
      setError("Please select a role");
      return;
    }

    setLoading(true);
    try {
      const data = await signup(form);
      navigate(`/${data.role}`);
    } catch (err) {
      setError(err.response?.data?.message || "Signup failed");
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

      <div className="auth-portal auth-portal-signup">
        <div className="auth-visual">
          <img
            src="/logo.png"
            alt="Unified Inbox"
            className="auth-visual-image"
            width="255"
            height="255"
          />
          <h2>Unified Inbox</h2>
          <p>Create your account to start managing messages in one place.</p>
        </div>

        <div className="auth-card auth-form-panel">
          <div className="brand">
            <span>Unified Inbox</span>
          </div>
          <h1>Create Account</h1>
          <p className="subtitle">Join the unified communication platform</p>

          {error && <div className="error-msg">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-row">
              <div className="form-group">
                <label>First Name</label>
                <input
                  name="firstName"
                  value={form.firstName}
                  onChange={handleChange}
                  placeholder="John"
                  required
                />
              </div>
              <div className="form-group">
                <label>Last Name</label>
                <input
                  name="lastName"
                  value={form.lastName}
                  onChange={handleChange}
                  placeholder="Doe"
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                name="email"
                value={form.email}
                onChange={handleChange}
                placeholder="you@company.com"
                required
              />
            </div>

            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                name="password"
                value={form.password}
                onChange={handleChange}
                placeholder="Min 6 characters"
                minLength={6}
                required
              />
            </div>

            <label className="role-selector-label">Select Your Role</label>
            <div className="role-selector">
              {roles.map((r) => (
                <div
                  key={r.key}
                  className={`role-option ${form.role === r.key ? "selected" : ""}`}
                  onClick={() => setForm({ ...form, role: r.key })}
                >
                  <div className="role-icon">{r.icon}</div>
                  <div className="role-name">{r.label}</div>
                </div>
              ))}
            </div>

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Creating account..." : "Create Account"}
            </button>
          </form>

          <p className="auth-link">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>

          <div className="auth-footer-links">
            <Link to="/terms">Terms of Service</Link>
            <Link to="/privacy">Privacy Policy</Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Signup;
