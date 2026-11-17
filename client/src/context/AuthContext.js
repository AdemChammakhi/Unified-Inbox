import React, { createContext, useState, useContext, useEffect, useCallback, useMemo } from "react";
import axios from "axios";

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

/**
 * When the token stops being valid, in ms since the epoch (its `exp` claim),
 * or null when it cannot be read. Only read to know when to log out: the
 * server still verifies every request.
 */
const tokenExpiry = (token) => {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = JSON.parse(json)?.exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
};

const isExpired = (token) => {
  const at = tokenExpiry(token);
  return at !== null && at <= Date.now();
};

// setTimeout fires at once beyond ~24.8 days; re-arm in steps instead
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

const readStoredUser = () => {
  try {
    const stored = JSON.parse(localStorage.getItem("user") || "null");
    if (stored?.token && !isExpired(stored.token)) return stored;
  } catch {
    /* unreadable — treated as logged out */
  }
  localStorage.removeItem("user");
  return null;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // An expired session is dropped here instead of opening a dashboard
    // whose every request would then fail.
    setUser(readStoredUser());
    setLoading(false);
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await axios.post("/api/auth/login", { email, password });
    const data = res.data;
    localStorage.setItem("user", JSON.stringify(data));
    setUser(data);
    return data;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("user");
    setUser(null);
  }, []);

  // Log out when the token expires, even on a page that is just open and
  // not calling the API. ProtectedRoute then sends the user to /login.
  useEffect(() => {
    if (!user?.token) return undefined;
    const at = tokenExpiry(user.token);
    if (at === null) return undefined;
    let timer;
    const arm = () => {
      const left = at - Date.now();
      if (left <= 0) {
        logout();
        return;
      }
      timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
    };
    arm();
    // A laptop waking from sleep does not run late timers on time: check
    // again whenever the tab comes back.
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() >= at) logout();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user?.token, logout]);

  // Any API call refused for authentication (expired or revoked token, a
  // suspended account) ends the session everywhere, not only on the pages
  // that check for 401 themselves. Login's own 401 (wrong password) is not
  // a session ending.
  useEffect(() => {
    const id = axios.interceptors.response.use(undefined, (error) => {
      const url = String(error?.config?.url || "");
      if (
        error?.response?.status === 401 &&
        url.includes("/api/") &&
        !url.includes("/api/auth/login")
      ) {
        logout();
      }
      return Promise.reject(error);
    });
    return () => axios.interceptors.response.eject(id);
  }, [logout]);

  // Logging out in one tab logs out the others
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === "user" && !e.newValue) setUser(null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
