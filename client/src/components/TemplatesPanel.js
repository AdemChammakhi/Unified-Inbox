import React, { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { Search, Copy, CornerDownLeft, Settings2, X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { fillTemplate, copyText } from "../constants/templates";

/**
 * TemplatesPanel — the list of canned replies shown beside a discussion.
 *
 * Agents search by title, category or content, then either insert the
 * message into the composer (placeholders filled with the customer's and
 * agent's names) or copy it to the clipboard. Admins and managers maintain
 * the list on /modeles.
 *
 * Props:
 *   platform      current inbox tab — hides templates limited to other platforms
 *   customerName  the customer as shown in the header, for {{prenom}} / {{nom}}
 *   onInsert      (text) => void — puts the filled message into the composer
 *   onClose       () => void
 */
const TemplatesPanel = ({ platform, customerName, onInsert, onClose }) => {
  const { user } = useAuth();
  const canManage = user?.role === "admin" || user?.role === "manager";

  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [flash, setFlash] = useState(null); // { id, text }

  const auth = useMemo(
    () => ({ headers: { Authorization: `Bearer ${user?.token}` } }),
    [user?.token],
  );

  const load = useCallback(async () => {
    if (!user?.token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get("/api/message-templates", {
        ...auth,
        params: { platform: platform || undefined },
      });
      setTemplates(res.data.templates || []);
      setCategories(res.data.categories || []);
    } catch (err) {
      setError(err.response?.data?.message || "Impossible de charger les modèles.");
    } finally {
      setLoading(false);
    }
  }, [user?.token, auth, platform]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return templates.filter((t) => {
      if (category && t.category !== category) return false;
      if (!needle) return true;
      return (
        t.title.toLowerCase().includes(needle) ||
        t.body.toLowerCase().includes(needle) ||
        (t.category || "").toLowerCase().includes(needle)
      );
    });
  }, [templates, q, category]);

  const agentName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
  const fill = (t) => fillTemplate(t.body, { customerName, agentName });

  const countUse = (id) => {
    axios.post(`/api/message-templates/${id}/use`, null, auth).catch(() => {});
  };

  const showFlash = (id, text) => {
    setFlash({ id, text });
    setTimeout(() => setFlash((f) => (f && f.id === id ? null : f)), 1600);
  };

  const insert = (t) => {
    onInsert(fill(t));
    countUse(t._id);
    showFlash(t._id, "Inséré dans le message");
  };

  const copy = async (t) => {
    const ok = await copyText(fill(t));
    if (ok) countUse(t._id);
    showFlash(t._id, ok ? "Copié" : "Copie impossible");
  };

  return (
    <aside style={styles.panel} aria-label="Modèles de messages">
      <div style={styles.head}>
        <span style={styles.title}>📝 Modèles de messages</span>
        <span style={styles.headActions}>
          {canManage && (
            <Link to="/modeles" style={styles.manageLink} title="Gérer les modèles">
              <Settings2 size={14} />
            </Link>
          )}
          <button
            type="button"
            className="inbox-tab-btn"
            style={styles.closeBtn}
            onClick={onClose}
            title="Fermer"
          >
            <X size={14} />
          </button>
        </span>
      </div>

      <div style={styles.searchRow}>
        <Search size={13} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
        <input
          style={styles.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher un cas…"
        />
      </div>

      {categories.length > 0 && (
        <div style={styles.chips}>
          <button
            type="button"
            style={{ ...styles.chip, ...(category === "" ? styles.chipOn : {}) }}
            onClick={() => setCategory("")}
          >
            Tous
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              style={{ ...styles.chip, ...(category === c ? styles.chipOn : {}) }}
              onClick={() => setCategory(category === c ? "" : c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="inbox-msg-scroll" style={styles.list}>
        {loading && <div style={styles.muted}>Chargement…</div>}
        {error && <div style={styles.error}>{error}</div>}
        {!loading && !error && visible.length === 0 && (
          <div style={styles.muted}>
            {templates.length === 0
              ? canManage
                ? "Aucun modèle pour l'instant. Créez-en depuis la page Modèles."
                : "Aucun modèle disponible pour l'instant."
              : "Aucun modèle ne correspond."}
          </div>
        )}
        {visible.map((t) => {
          const open = expanded === t._id;
          return (
            <div key={t._id} style={styles.item}>
              <button
                type="button"
                style={styles.itemHead}
                onClick={() => setExpanded(open ? null : t._id)}
                title={open ? "Réduire" : "Voir le message complet"}
              >
                <span style={styles.itemTitle}>{t.title}</span>
                {t.category && <span style={styles.itemCat}>{t.category}</span>}
              </button>
              <div
                style={{
                  ...styles.itemBody,
                  ...(open ? {} : styles.itemBodyClamp),
                }}
              >
                {t.body}
              </div>
              <div style={styles.itemActions}>
                {flash?.id === t._id && <span style={styles.flash}>{flash.text}</span>}
                <button
                  type="button"
                  className="inbox-tab-btn"
                  style={styles.actionBtn}
                  onClick={() => copy(t)}
                  title="Copier le message"
                >
                  <Copy size={12} /> Copier
                </button>
                <button
                  type="button"
                  className="inbox-send-action"
                  style={styles.actionPrimary}
                  onClick={() => insert(t)}
                  title="Insérer dans la zone de saisie"
                >
                  <CornerDownLeft size={12} /> Insérer
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
};

const styles = {
  panel: {
    width: 320,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    borderLeft: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-secondary)",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 14px 8px",
  },
  title: { fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" },
  headActions: { display: "inline-flex", alignItems: "center", gap: 4 },
  manageLink: {
    display: "inline-flex",
    padding: 5,
    borderRadius: 6,
    color: "var(--text-muted)",
  },
  closeBtn: {
    display: "inline-flex",
    padding: 5,
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: "0 14px 8px",
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-card)",
  },
  search: {
    flex: 1,
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--text-primary)",
    fontSize: 12.5,
    fontFamily: "inherit",
  },
  chips: { display: "flex", flexWrap: "wrap", gap: 5, padding: "0 14px 8px" },
  chip: {
    padding: "3px 9px",
    borderRadius: 999,
    border: "1px solid var(--border-primary)",
    background: "transparent",
    color: "var(--text-muted)",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  chipOn: {
    color: "var(--accent)",
    borderColor: "var(--accent)",
    backgroundColor: "var(--accent-glow)",
    fontWeight: 700,
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "0 14px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  muted: { fontSize: 12, color: "var(--text-muted)", padding: "8px 2px" },
  error: { fontSize: 12, color: "var(--danger)", padding: "8px 2px" },
  item: {
    border: "1px solid var(--border-primary)",
    borderRadius: 10,
    backgroundColor: "var(--bg-card)",
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  itemHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    border: "none",
    background: "transparent",
    padding: 0,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
  },
  itemTitle: { fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" },
  itemCat: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: "var(--text-faint)",
    whiteSpace: "nowrap",
  },
  itemBody: {
    fontSize: 12,
    lineHeight: 1.45,
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  itemBodyClamp: {
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  itemActions: {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 6,
  },
  flash: { fontSize: 11, color: "var(--accent)", marginRight: "auto" },
  actionBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "5px 9px",
    borderRadius: 7,
    border: "1px solid var(--border-primary)",
    background: "transparent",
    color: "var(--text-muted)",
    fontSize: 11.5,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  actionPrimary: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "5px 10px",
    borderRadius: 7,
    border: "none",
    backgroundColor: "var(--accent)",
    color: "var(--bg-primary)",
    fontSize: 11.5,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
};

export default TemplatesPanel;
