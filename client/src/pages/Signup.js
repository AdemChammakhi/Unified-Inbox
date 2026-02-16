import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

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
    <div className="auth-page">
      <div className="auth-card">
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

          <label
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
              display: "block",
              color: "#333",
            }}
          >
            Select Your Role
          </label>
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

        <div style={{ marginTop: 20, fontSize: 12, textAlign: "center" }}>
          <Link to="/terms" style={{ color: "#666", marginRight: 15 }}>
            Terms of Service
          </Link>
          <Link to="/privacy" style={{ color: "#666" }}>
            Privacy Policy
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Signup;
