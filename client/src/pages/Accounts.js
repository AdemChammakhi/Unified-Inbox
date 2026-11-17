import React, { useState, useEffect, useCallback, useMemo } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";
import { UserPlus, RefreshCw, Pencil, Trash2, Power } from "lucide-react";

/**
 * Accounts — account management for the administrator.
 *
 * Two views: the accounts this admin opened, and every account in the system
 * (needed to see the agents working under accounts someone else created).
 * Suspension is offered before deletion because a deleted account takes its
 * conversation locks with it; suspension blocks sign-in and keeps history
 * attributable.
 */

const ROLES = [
  { key: "admin", label: "Admin", color: "#E8833A" },
  { key: "manager", label: "Manager", color: "#5B9BD9" },
  { key: "marketing", label: "Agent", color: "#5FBF8A" },
];

const roleMeta = (r) => ROLES.find((x) => x.key === r) || ROLES[2];
const EMPTY = { firstName: "", lastName: "", email: "", password: "", role: "marketing" };

const Accounts = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // "Tous" is the default on purpose: accounts that existed before createdBy
  // was recorded have no creator, so "Mes comptes" would be empty on an
  // established installation and look like a broken page.
  const [scope, setScope] = useState("all");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null); // {type, text}

  const [form, setForm] = useState(EMPTY);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null); // user being edited

  const auth = useMemo(
    () => ({ headers: { Authorization: `Bearer ${user?.token}` } }),
    [user?.token],
  );

  const load = useCallback(async () => {
    if (!user?.token) return;
    setLoading(true);
    try {
      const res = await axios.get("/api/auth/users", {
        params: { scope },
        headers: { Authorization: `Bearer ${user.token}` },
      });
      setUsers(res.data.users || []);
    } catch (err) {
      if (err.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Impossible de charger les comptes.",
      });
    } finally {
      setLoading(false);
    }
  }, [user?.token, scope, logout, navigate]);

  useEffect(() => {
    load();
  }, [load]);

  const submitCreate = async (e) => {
    e.preventDefault();
    setNotice(null);
    setCreating(true);
    try {
      const res = await axios.post("/api/auth/create-user", form, auth);
      setNotice({
        type: "ok",
        text: `Compte créé pour ${res.data.firstName} ${res.data.lastName} (${roleMeta(res.data.role).label}).`,
      });
      setForm(EMPTY);
      setShowForm(false);
      load();
    } catch (err) {
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Création impossible.",
      });
    } finally {
      setCreating(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setNotice(null);
    try {
      const body = {
        firstName: editing.firstName,
        lastName: editing.lastName,
        email: editing.email,
        role: editing.role,
      };
      if (editing.newPassword) body.password = editing.newPassword;
      await axios.put(`/api/auth/users/${editing._id}`, body, auth);
      setNotice({ type: "ok", text: "Compte mis à jour." });
      setEditing(null);
      load();
    } catch (err) {
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Mise à jour impossible.",
      });
    }
  };

  const toggleActive = async (u) => {
    setNotice(null);
    try {
      await axios.put(`/api/auth/users/${u._id}`, { isActive: !u.isActive }, auth);
      setNotice({
        type: "ok",
        text: u.isActive
          ? `${u.firstName} ne peut plus se connecter.`
          : `${u.firstName} peut à nouveau se connecter.`,
      });
      load();
    } catch (err) {
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Action impossible.",
      });
    }
  };

  const remove = async (u) => {
    if (
      !window.confirm(
        `Supprimer définitivement le compte de ${u.firstName} ${u.lastName} ?\n\n` +
          "Les conversations qui lui sont assignées seront libérées. " +
          "Pour bloquer l'accès sans perdre l'historique, désactivez le compte à la place.",
      )
    )
      return;
    setNotice(null);
    try {
      const res = await axios.delete(`/api/auth/users/${u._id}`, auth);
      setNotice({
        type: "ok",
        text:
          `Compte supprimé.` +
          (res.data.releasedLocks
            ? ` ${res.data.releasedLocks} conversation(s) libérée(s).`
            : ""),
      });
      load();
    } catch (err) {
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Suppression impossible.",
      });
    }
  };

  const grouped = useMemo(() => {
    const agents = users.filter((u) => u.role === "marketing");
    const staff = users.filter((u) => u.role !== "marketing");
    return { staff, agents };
  }, [users]);

  const Row = ({ u }) => {
    const meta = roleMeta(u.role);
    const isEditing = editing?._id === u._id;
    return (
      <div style={{ ...styles.row, opacity: u.isActive ? 1 : 0.55 }}>
        <div style={{ ...styles.avatar, borderColor: `${meta.color}66`, color: meta.color }}>
          {(u.firstName?.[0] || "?").toUpperCase()}
        </div>

        {isEditing ? (
          <div style={styles.editGrid}>
            <input
              style={styles.input}
              value={editing.firstName}
              onChange={(e) => setEditing({ ...editing, firstName: e.target.value })}
              placeholder="Prénom"
            />
            <input
              style={styles.input}
              value={editing.lastName}
              onChange={(e) => setEditing({ ...editing, lastName: e.target.value })}
              placeholder="Nom"
            />
            <input
              style={styles.input}
              value={editing.email}
              onChange={(e) => setEditing({ ...editing, email: e.target.value })}
              placeholder="Email"
            />
            <select
              style={styles.input}
              value={editing.role}
              onChange={(e) => setEditing({ ...editing, role: e.target.value })}
              disabled={u.isSelf}
              title={u.isSelf ? "Vous ne pouvez pas changer votre propre rôle" : ""}
            >
              {ROLES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            <input
              style={styles.input}
              type="password"
              value={editing.newPassword || ""}
              onChange={(e) => setEditing({ ...editing, newPassword: e.target.value })}
              placeholder="Nouveau mot de passe (facultatif)"
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="support-btn-primary" style={styles.primaryBtn} onClick={saveEdit}>
                Enregistrer
              </button>
              <button className="support-btn" style={styles.ghostBtn} onClick={() => setEditing(null)}>
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={styles.name}>
                {u.firstName} {u.lastName}
                {u.isSelf && <span style={styles.youTag}>vous</span>}
                {!u.isActive && <span style={styles.offTag}>désactivé</span>}
              </div>
              <div style={styles.email}>{u.email}</div>
              {u.createdBy && (
                <div style={styles.createdBy}>créé par {u.createdBy.name}</div>
              )}
            </div>
            <span style={{ ...styles.roleChip, color: meta.color, borderColor: `${meta.color}66` }}>
              {meta.label}
            </span>
            <div style={styles.actions}>
              <button
                className="support-btn"
                style={styles.iconBtn}
                title="Modifier"
                onClick={() => setEditing({ ...u, newPassword: "" })}
              >
                <Pencil size={14} />
              </button>
              <button
                className="support-btn"
                style={styles.iconBtn}
                title={u.isActive ? "Désactiver l'accès" : "Réactiver l'accès"}
                onClick={() => toggleActive(u)}
                disabled={u.isSelf}
              >
                <Power size={14} />
              </button>
              <button
                className="support-btn"
                style={{ ...styles.iconBtn, color: "var(--danger)" }}
                title="Supprimer"
                onClick={() => remove(u)}
                disabled={u.isSelf}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <DashboardLayout>
      <div style={styles.head}>
        <div>
          <h1 style={styles.title}>Comptes</h1>
          <p style={styles.sub}>
            Créez, modifiez et désactivez les accès à l'inbox.
          </p>
        </div>
        <div style={styles.headRight}>
          <div className="range-tabs">
            <button
              className={`range-tab${scope === "mine" ? " active" : ""}`}
              onClick={() => setScope("mine")}
            >
              Mes comptes
            </button>
            <button
              className={`range-tab${scope === "all" ? " active" : ""}`}
              onClick={() => setScope("all")}
            >
              Tous
            </button>
          </div>
          <button className="support-btn" style={styles.ghostBtn} onClick={load} title="Rafraîchir">
            <RefreshCw size={14} />
          </button>
          <button
            className="support-btn-primary"
            style={styles.primaryBtn}
            onClick={() => setShowForm((s) => !s)}
          >
            <UserPlus size={15} /> Nouveau compte
          </button>
        </div>
      </div>

      {notice && (
        <div style={notice.type === "ok" ? styles.ok : styles.err}>{notice.text}</div>
      )}

      {showForm && (
        <form onSubmit={submitCreate} style={styles.card}>
          <h3 style={styles.cardTitle}>Nouveau compte</h3>
          <div style={styles.formGrid}>
            <input
              style={styles.input}
              placeholder="Prénom"
              required
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            />
            <input
              style={styles.input}
              placeholder="Nom"
              required
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
            />
            <input
              style={styles.input}
              type="email"
              placeholder="email@medtours.com"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <input
              style={styles.input}
              type="password"
              placeholder="Mot de passe (6 caractères min.)"
              minLength={6}
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <select
              style={styles.input}
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {ROLES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="support-btn-primary"
              style={styles.primaryBtn}
              disabled={creating}
            >
              {creating ? "Création…" : "Créer le compte"}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div style={styles.card}>Chargement des comptes…</div>
      ) : users.length === 0 ? (
        <div style={styles.card}>
          {scope === "mine" ? (
            <>
              Aucun compte créé depuis cet écran pour l'instant.
              <br />
              <span style={styles.muted}>
                Les comptes ouverts avant cette version n'ont pas de créateur
                enregistré — ils apparaissent dans l'onglet « Tous ». Les
                nouveaux comptes que vous créez ici arriveront dans cette liste.
              </span>
            </>
          ) : (
            "Aucun compte."
          )}
        </div>
      ) : (
        <>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>
              Administrateurs et managers ({grouped.staff.length})
            </h3>
            {grouped.staff.length === 0 ? (
              <p style={styles.muted}>Aucun.</p>
            ) : (
              grouped.staff.map((u) => <Row key={u._id} u={u} />)
            )}
          </div>

          <div style={{ ...styles.card, marginTop: 16 }}>
            <h3 style={styles.cardTitle}>Agents ({grouped.agents.length})</h3>
            {grouped.agents.length === 0 ? (
              <p style={styles.muted}>
                Aucun agent {scope === "mine" ? "créé par vous" : ""}.
              </p>
            ) : (
              grouped.agents.map((u) => <Row key={u._id} u={u} />)
            )}
          </div>
        </>
      )}
    </DashboardLayout>
  );
};

const styles = {
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 20,
    flexWrap: "wrap",
  },
  headRight: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  title: {
    margin: "0 0 4px",
    fontFamily: "'Fraunces', Georgia, serif",
    fontSize: 26,
    fontWeight: 500,
    color: "var(--text-primary)",
  },
  sub: { margin: 0, fontSize: 13.5, color: "var(--text-faint)" },
  card: {
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    borderRadius: 12,
    padding: 20,
    color: "var(--text-secondary)",
    fontSize: 13.5,
  },
  cardTitle: {
    margin: "0 0 14px",
    fontFamily: "'Fraunces', Georgia, serif",
    fontSize: 16,
    fontWeight: 500,
    color: "var(--text-primary)",
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: 10,
  },
  input: {
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-card)",
    color: "var(--text-primary)",
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "11px 0",
    borderBottom: "1px solid var(--border-primary)",
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 9,
    border: "2px solid",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 13,
    flexShrink: 0,
  },
  name: {
    fontWeight: 600,
    fontSize: 13.5,
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    gap: 7,
  },
  email: { fontSize: 11.5, color: "var(--text-faint)" },
  createdBy: { fontSize: 10.5, color: "var(--text-dim)", marginTop: 1 },
  youTag: {
    fontSize: 9.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: "var(--accent)",
    border: "1px solid var(--accent-border)",
    borderRadius: 4,
    padding: "1px 6px",
  },
  offTag: {
    fontSize: 9.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: "var(--danger)",
    border: "1px solid var(--danger)",
    borderRadius: 4,
    padding: "1px 6px",
  },
  roleChip: {
    fontSize: 10.5,
    fontWeight: 700,
    border: "1px solid",
    borderRadius: 5,
    padding: "3px 10px",
    whiteSpace: "nowrap",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  actions: { display: "flex", gap: 6, flexShrink: 0 },
  iconBtn: {
    width: 30,
    height: 30,
    borderRadius: 7,
    border: "1px solid var(--border-primary)",
    background: "transparent",
    color: "var(--text-faint)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  editGrid: {
    flex: 1,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 8,
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "9px 16px",
    borderRadius: 8,
    border: "none",
    background: "var(--accent)",
    color: "var(--bg-primary)",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  ghostBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    background: "transparent",
    color: "var(--text-secondary)",
    fontWeight: 600,
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  ok: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--success)",
    background: "rgba(95,191,138,0.1)",
    color: "var(--success)",
    fontSize: 13,
    marginBottom: 14,
  },
  err: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--danger)",
    background: "rgba(226,104,95,0.1)",
    color: "var(--danger)",
    fontSize: 13,
    marginBottom: 14,
  },
  muted: { color: "var(--text-dim)", fontSize: 13, margin: 0 },
};

export default Accounts;
