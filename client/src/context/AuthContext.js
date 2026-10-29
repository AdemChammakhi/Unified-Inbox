import React, { createContext, useState, useContext, useEffect } from "react";
import axios from "axios";

const AuthContext = createContext(null);

// Roles with a dashboard route (/admin, /manager, /agent). A session saved
// under any other role, e.g. one opened before the agent role was renamed,
// would redirect to a page that no longer exists: drop it so the user signs
// in again and gets their current role.
const KNOWN_ROLES = new Set(["admin", "manager", "agent"]);

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (stored) {
      const saved = JSON.parse(stored);
      if (KNOWN_ROLES.has(saved?.role)) setUser(saved);
      else localStorage.removeItem("user");
    }
    setLoading(false);
  }, []);

  const login = async (email, password) => {
    const res = await axios.post("/api/auth/login", { email, password });
    const data = res.data;
    localStorage.setItem("user", JSON.stringify(data));
    setUser(data);
    return data;
  };

  const logout = () => {
    localStorage.removeItem("user");
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};
