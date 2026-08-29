import React, { useState, useEffect, useCallback, useMemo } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";
import PlatformIcon from "../components/PlatformIcon";
import ProspectExport from "../components/ProspectExport";
import { RefreshCw, X } from "lucide-react";

/**
 * Leads — the prospect sheet, in the app.
 *
 * The same rows the team used to keep by hand and now export to Excel, but
 * readable and filterable in place. Every column filters: free-text columns
 * take a substring, the closed sets (platform, classification, agent) become
 * dropdowns built from the data actually present, so a filter never offers a
 * value that would return nothing.
 */

const CLASSIFICATION_LABELS = {
  non_classifie: "Non classifié",
  cible: "Cible",
  hors_cible: "Hors cible",
  suivi: "Suivi",
  priorite: "Priorité",
  rdv: "RDV",
};

const CLASSIFICATION_COLORS = {
  non_classifie: "#6E7A96",
  cible: "#5FBF8A",
  hors_cible: "#E2685F",
  suivi: "#5B9BD9",
  priorite: "#E3A63C",
  rdv: "#A98BD6",
};

const PLATFORM_LABELS = {
  instagram: "Instagram",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
  email: "Email",
};

/** Column definitions drive the header, the filter row and the body. */
const COLUMNS = [
  { key: "platform", label: "Plateforme", type: "select", width: 118 },
  { key: "source", label: "Source", type: "text", width: 210 },
  { key: "name", label: "Nom prospect", type: "text", width: 170 },
  { key: "phone", label: "Téléphone", type: "text", width: 130 },
  { key: "email", label: "Email", type: "text", width: 190 },
  { key: "firstContact", label: "Premier contact", type: "date", width: 140 },
  { key: "lastContact", label: "Dernier contact", type: "date", width: 140 },
  { key: "classification", label: "Étape", type: "select", width: 120 },
  { key: "rdvAt", label: "RDV le", type: "date", width: 140 },
  { key: "agent", label: "Commercial", type: "select", width: 150 },
  { key: "messagesIn", label: "Reçus", type: "number", width: 78 },
  { key: "messagesOut", label: "Envoyés", type: "number", width: 84 },
  { key: "lastIncomingText", label: "Dernier message", type: "text", width: 300 },
];

const fmtDate = (v) => {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/** Display value for a cell — what the filter matches against, too. */
const cellText = (row, key) => {
  const v = row[key];
  if (v === null || v === undefined) return "";
  if (key === "platform") return PLATFORM_LABELS[v] || v;
  if (key === "classification") return CLASSIFICATION_LABELS[v] || v;
  if (key === "firstContact" || key === "lastContact" || key === "rdvAt") {
    return fmtDate(v);
  }
  return String(v);
};

const Leads = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [range, setRange] = useState(30);
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState({ key: "lastContact", dir: "desc" });

  const load = useCallback(async () => {
    if (!user?.token) return;
    setLoading(true);
    setError("");
    try {
      const res = await axios.get("/api/leads", {
        params: { range },
        headers: { Authorization: `Bearer ${user.token}` },
        timeout: 120000,
      });
      setRows(res.data.rows || []);
      setTruncated(Boolean(res.data.truncated));
    } catch (err) {
      if (err.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
      setError(
        err.response?.data?.message || "Impossible de charger les leads.",
      );
    } finally {
      setLoading(false);
    }
  }, [user?.token, range, logout, navigate]);

  useEffect(() => {
    load();
  }, [load]);

  /** Options for the dropdown filters, taken from the rows themselves. */
  const options = useMemo(() => {
    const build = (key) =>
      [...new Set(rows.map((r) => cellText(r, key)).filter(Boolean))].sort();
    return {
      platform: build("platform"),
      classification: build("classification"),
      agent: build("agent"),
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v !== "" && v != null);
    let out = rows;
    if (active.length > 0) {
      out = rows.filter((row) =>
        active.every(([key, value]) => {
          const col = COLUMNS.find((c) => c.key === key);
          const cell = cellText(row, key);
          if (col?.type === "select") return cell === value;
          if (col?.type === "number") {
            // "5" matches exactly; ">3" and "<3" compare
            const raw = Number(row[key] ?? 0);
            const v = String(value).trim();
            if (v.startsWith(">")) return raw > Number(v.slice(1));
            if (v.startsWith("<")) return raw < Number(v.slice(1));
            return String(raw) === v;
          }
          return cell.toLowerCase().includes(String(value).toLowerCase());
        }),
      );
    }
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => {
      const col = COLUMNS.find((c) => c.key === key);
      if (col?.type === "number") return (Number(a[key] || 0) - Number(b[key] || 0)) * mul;
      if (col?.type === "date") {
        return (new Date(a[key] || 0) - new Date(b[key] || 0)) * mul;
      }
      return cellText(a, key).localeCompare(cellText(b, key), "fr") * mul;
    });
  }, [rows, filters, sort]);

  const setFilter = (key, value) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  const activeCount = Object.values(filters).filter((v) => v !== "" && v != null).length;

  return (
    <DashboardLayout noPadding>
      <div style={styles.page}>
        <div style={styles.accent} />

        <div style={styles.header}>
          <div>
            <h2 style={styles.title}>Leads</h2>
            <p style={styles.sub}>
              {loading
                ? "Chargement…"
                : `${filtered.length} prospect${filtered.length > 1 ? "s" : ""}` +
                  (activeCount > 0 ? ` sur ${rows.length}` : "")}
            </p>
          </div>
          <div style={styles.headerRight}>
            {activeCount > 0 && (
              <button
                className="support-btn"
                style={styles.ghost}
                onClick={() => setFilters({})}
              >
                <X size={13} /> Effacer les filtres ({activeCount})
              </button>
            )}
            <div className="range-tabs">
              {[7, 30, 90].map((r) => (
                <button
                  key={r}
                  className={`range-tab${range === r ? " active" : ""}`}
                  onClick={() => setRange(r)}
                >
                  {r}j
                </button>
              ))}
              <button
                className={`range-tab${range === "all" ? " active" : ""}`}
                onClick={() => setRange("all")}
              >
                Tout
              </button>
            </div>
            <button
              className="support-btn"
              style={styles.ghost}
              onClick={load}
              title="Rafraîchir"
            >
              <RefreshCw size={13} />
            </button>
            <ProspectExport range={range} />
          </div>
        </div>

        {error && <div style={styles.error}>{error}</div>}
        {truncated && (
          <div style={styles.warn}>
            ⚠ Beaucoup de messages sur cette période : « Premier contact » et les
            compteurs peuvent être partiels pour les échanges les plus anciens.
          </div>
        )}

        <div className="support-scroll" style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    style={{ ...styles.th, minWidth: c.width }}
                    onClick={() =>
                      setSort((s) => ({
                        key: c.key,
                        dir: s.key === c.key && s.dir === "asc" ? "desc" : "asc",
                      }))
                    }
                    title="Trier"
                  >
                    {c.label}
                    {sort.key === c.key && (
                      <span style={styles.sortArrow}>
                        {sort.dir === "asc" ? " ▲" : " ▼"}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} style={styles.filterCell}>
                    {c.type === "select" ? (
                      <select
                        style={styles.filterInput}
                        value={filters[c.key] || ""}
                        onChange={(e) => setFilter(c.key, e.target.value)}
                      >
                        <option value="">Tous</option>
                        {(options[c.key] || []).map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        style={styles.filterInput}
                        value={filters[c.key] || ""}
                        placeholder={
                          c.type === "number" ? "5, >3, <10" : "filtrer…"
                        }
                        onChange={(e) => setFilter(c.key, e.target.value)}
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={COLUMNS.length} style={styles.empty}>
                    Chargement des prospects…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} style={styles.empty}>
                    {rows.length === 0
                      ? "Aucun prospect sur cette période."
                      : "Aucun prospect ne correspond à ces filtres."}
                  </td>
                </tr>
              ) : (
                filtered.map((r, i) => (
                  <tr
                    key={`${r.platform}-${r.name}-${i}`}
                    style={{
                      backgroundColor:
                        i % 2 ? "var(--bg-hover)" : "transparent",
                    }}
                  >
                    {COLUMNS.map((c) => {
                      if (c.key === "platform") {
                        return (
                          <td key={c.key} style={styles.td}>
                            <span style={styles.platformCell}>
                              <PlatformIcon platform={r.platform} size={14} />
                              {PLATFORM_LABELS[r.platform] || r.platform}
                            </span>
                          </td>
                        );
                      }
                      if (c.key === "classification") {
                        const color =
                          CLASSIFICATION_COLORS[r.classification] ||
                          CLASSIFICATION_COLORS.non_classifie;
                        return (
                          <td key={c.key} style={styles.td}>
                            <span
                              style={{
                                ...styles.classChip,
                                color,
                                borderColor: `${color}66`,
                                backgroundColor: `${color}1a`,
                              }}
                            >
                              {CLASSIFICATION_LABELS[r.classification] ||
                                r.classification}
                            </span>
                          </td>
                        );
                      }
                      const isNum = c.type === "number";
                      return (
                        <td
                          key={c.key}
                          style={{
                            ...styles.td,
                            ...(isNum ? styles.tdNum : {}),
                            ...(c.key === "lastIncomingText"
                              ? styles.tdWrap
                              : {}),
                          }}
                          title={cellText(r, c.key)}
                        >
                          {cellText(r, c.key)}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  );
};

const styles = {
  page: {
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--gradient-bg)",
    overflow: "hidden",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  accent: {
    height: 3,
    background:
      "linear-gradient(90deg, transparent, var(--accent), var(--accent-alt), var(--accent), transparent)",
    flexShrink: 0,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: "14px 26px",
    borderBottom: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-nav)",
    flexWrap: "wrap",
  },
  headerRight: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  title: {
    margin: 0,
    fontFamily: "'Fraunces', Georgia, serif",
    fontSize: 22,
    fontWeight: 500,
    color: "var(--text-primary)",
  },
  sub: {
    margin: "2px 0 0",
    fontSize: 12,
    color: "var(--text-faint)",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  ghost: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    background: "transparent",
    color: "var(--text-secondary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  error: {
    margin: "12px 26px 0",
    padding: "9px 13px",
    borderRadius: 8,
    border: "1px solid var(--danger)",
    background: "rgba(226,104,95,0.1)",
    color: "var(--danger)",
    fontSize: 13,
  },
  warn: {
    margin: "12px 26px 0",
    padding: "9px 13px",
    borderRadius: 8,
    border: "1px solid var(--warning)",
    background: "rgba(227,166,60,0.12)",
    color: "var(--warning)",
    fontSize: 12.5,
  },
  tableWrap: { flex: 1, overflow: "auto", padding: "0 26px 26px" },
  table: {
    borderCollapse: "separate",
    borderSpacing: 0,
    width: "100%",
    fontSize: 13,
  },
  th: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    textAlign: "left",
    padding: "10px 12px",
    background: "var(--bg-secondary)",
    borderBottom: "2px solid var(--border-secondary)",
    color: "var(--text-dim)",
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
    cursor: "pointer",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  sortArrow: { color: "var(--accent)" },
  filterCell: {
    position: "sticky",
    top: 36,
    zIndex: 2,
    padding: "6px 8px",
    background: "var(--bg-secondary)",
    borderBottom: "1px solid var(--border-primary)",
  },
  filterInput: {
    width: "100%",
    padding: "5px 8px",
    borderRadius: 6,
    border: "1px solid var(--border-primary)",
    background: "var(--bg-card)",
    color: "var(--text-primary)",
    fontSize: 12,
    fontFamily: "inherit",
    outline: "none",
  },
  td: {
    padding: "9px 12px",
    borderBottom: "1px solid var(--border-primary)",
    color: "var(--text-primary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 320,
  },
  tdNum: {
    textAlign: "right",
    fontFamily: "'Space Grotesk', sans-serif",
    fontVariantNumeric: "tabular-nums",
  },
  tdWrap: { color: "var(--text-secondary)" },
  platformCell: { display: "inline-flex", alignItems: "center", gap: 6 },
  classChip: {
    display: "inline-block",
    padding: "2px 9px",
    borderRadius: 5,
    border: "1px solid",
    fontSize: 10.5,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  empty: {
    padding: "44px 12px",
    textAlign: "center",
    color: "var(--text-faint)",
    fontSize: 13,
  },
};

export default Leads;
