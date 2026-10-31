import React, { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";
import PlatformIcon from "../components/PlatformIcon";
import ProspectExport from "../components/ProspectExport";
import MaturityChip from "../components/MaturityChip";
import FreinSelector from "../components/FreinSelector";
import CommentField from "../components/CommentField";
import {
  FREINS,
  MATURITY,
  MATURITY_RANK,
} from "../constants/leadQualification";
import {
  STAGE_LABELS,
  STAGE_COLORS,
  STAGES,
  TYPOLOGIES,
  TYPOLOGY_LABELS,
} from "../constants/pipeline";
import { copyText } from "../constants/templates";
import { RefreshCw, X, UserRound, Phone, Copy, Check, PhoneIncoming } from "lucide-react";

/**
 * PAX in a sheet cell: a small number field saved on Enter or when the
 * cursor leaves it; empty clears it. Follows the stored value after saves.
 */
const PaxCell = ({ value, onSave }) => {
  const stored = Number.isInteger(value) ? String(value) : "";
  const [text, setText] = useState(stored);
  useEffect(() => setText(stored), [stored]);
  const commit = () => {
    const t = text.trim();
    if (t === stored) return;
    onSave(t === "" ? null : Number(t)).catch(() => setText(stored));
  };
  return (
    <input
      type="number"
      min={1}
      max={999}
      value={text}
      placeholder="—"
      title="Nombre de PAX (voyageurs)"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setText(stored);
      }}
      style={{
        width: 60,
        padding: "3px 6px",
        borderRadius: 6,
        border: "1px solid var(--border-primary)",
        backgroundColor: "var(--bg-card)",
        color: "var(--text-primary)",
        fontSize: 12,
        outline: "none",
        fontFamily: "'Space Grotesk', sans-serif",
      }}
    />
  );
};

const EMPTY_CALL = { name: "", phone: "", email: "", typologie: "", pax: "", comment: "" };

/**
 * Leads — the prospect sheet, in the app.
 *
 * The same rows the team used to keep by hand and now export to Excel, but
 * readable and filterable in place. Every column filters: free-text columns
 * take a substring, the closed sets (platform, classification, maturity,
 * frein, agent) become dropdowns built from the data actually present, so a
 * filter never offers a value that would return nothing.
 *
 * Maturity and frein come from the server (buildProspectRows): `maturity`,
 * `maturityLevel`, `maturityReason`, `frein` (label, "Autre : note" included)
 * and `freinCode`.
 */

// Pipeline stages and typologies come from the shared constants
const CLASSIFICATION_LABELS = STAGE_LABELS;
const CLASSIFICATION_COLORS = STAGE_COLORS;

const PLATFORM_LABELS = {
  instagram: "Instagram",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
  email: "Email",
  telephone: "Téléphone",
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
  { key: "classification", label: "Étape", type: "select", width: 140 },
  { key: "typologie", label: "Typologie", type: "select", width: 150 },
  { key: "pax", label: "PAX", type: "number", width: 84 },
  { key: "maturity", label: "Maturité", type: "select", width: 118 },
  { key: "frein", label: "Motif / frein", type: "select", width: 180 },
  { key: "comment", label: "Commentaire", type: "text", width: 240 },
  { key: "rdvAt", label: "RDV le", type: "date", width: 140 },
  { key: "invoiceRef", label: "Réf. facture", type: "text", width: 130 },
  { key: "agent", label: "Commercial", type: "select", width: 150 },
  { key: "messagesIn", label: "Reçus", type: "number", width: 78 },
  { key: "messagesOut", label: "Envoyés", type: "number", width: 84 },
  { key: "lastMessage", label: "Dernier message", type: "text", width: 300 },
];

// Built once: toLocaleString / localeCompare with a locale build a new
// formatter or collator on every call, and sorting a few thousand rows calls
// them tens of thousands of times.
const DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const COLLATOR = new Intl.Collator("fr");

const fmtDate = (v) => {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return DATE_FORMAT.format(d);
};

/** Rows drawn at first, and added per "Afficher plus". */
const PAGE_ROWS = 200;

const FREIN_LABELS = Object.fromEntries(FREINS.map((f) => [f.code, f.label]));

/** Filter value that selects the rows with no frein recorded yet. */
const FREIN_NONE = "__none__";

/** chaud / tiede / froid / gagne / perdu, from the level or the label. */
const maturityLevelOf = (row) => {
  if (row.maturityLevel && MATURITY[row.maturityLevel]) return row.maturityLevel;
  if (!row.maturity) return null;
  const hit = Object.entries(MATURITY).find(([, m]) => m.label === row.maturity);
  return hit ? hit[0] : null;
};

/** Display value for a cell — what the text filters match against, too. */
const cellText = (row, key) => {
  if (key === "maturity") {
    const level = maturityLevelOf(row);
    return (level && MATURITY[level].label) || String(row.maturity || "");
  }
  if (key === "frein") return String(row.frein || "");
  if (key === "typologie") return String(row.typologieLabel || "");
  if (key === "pax") return Number.isInteger(row.pax) ? String(row.pax) : "";
  const v = row[key];
  if (v === null || v === undefined) return "";
  if (key === "platform") return PLATFORM_LABELS[v] || v;
  if (key === "classification") return CLASSIFICATION_LABELS[v] || v;
  if (key === "firstContact" || key === "lastContact" || key === "rdvAt") {
    return fmtDate(v);
  }
  return String(v);
};

/**
 * Value a dropdown filter compares with. Same as the cell text, except the
 * frein: "Autre : <note>" filters as "Autre", so free notes do not each
 * become a dropdown entry.
 */
const selectText = (row, key) => {
  if (key === "frein") {
    return FREIN_LABELS[row.freinCode] || cellText(row, key);
  }
  return cellText(row, key);
};

/** Orders present values the way the vocabulary lists them, extras last. */
const orderedLike = (present, order) => [
  ...order.filter((v) => present.has(v)),
  ...[...present].filter((v) => !order.includes(v)).sort(),
];

const MATURITY_ORDER = Object.keys(MATURITY_RANK)
  .sort((a, b) => MATURITY_RANK[a] - MATURITY_RANK[b])
  .map((level) => MATURITY[level].label);
const FREIN_ORDER = FREINS.map((f) => f.label);

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
  // An agent only ever receives his own leads (the server cuts the sheet,
  // routes/leads.js scopedFor); admins and managers get everything and can
  // narrow it with the "Mes leads" toggle.
  const ownOnly = user?.role === "marketing";
  const [mine, setMine] = useState(false);
  const myId = user?._id ? String(user._id) : "";
  const myName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
  // Phone just copied, for the short "Copié" confirmation on that row
  const [copiedKey, setCopiedKey] = useState(null);
  // Corrections from the sheet (admins and managers): stage, typologie,
  // priority, motif and comment, saved on the customer's dossier. None of
  // them moves the lead: "Commercial en charge" comes from the conversation
  // lock and the latest reply, never from who edited the dossier.
  const canEdit = user?.role === "admin" || user?.role === "manager";
  // Agents update their own leads here too (management's process note,
  // 22 Oct 2026: "modifier leur qualification … ajouter des commentaires"
  // from the Leads page). The server only ever sends an agent his own rows,
  // and phone leads have no inbox conversation to edit them from.
  const canEditRow = () => canEdit || user?.role === "marketing";
  const [editError, setEditError] = useState("");
  // "+ Appel entrant": record a prospect who called (every role); the
  // recording agent is put in charge of the lead.
  const [callOpen, setCallOpen] = useState(false);
  const [callForm, setCallForm] = useState(EMPTY_CALL);
  const [callSaving, setCallSaving] = useState(false);
  const [callNotice, setCallNotice] = useState(null); // { type, text }
  // Reassigning a discussion (admin only): the "Commercial" cell becomes a
  // picker. It moves the conversation lock to the chosen agent, who then
  // replies to it as usual; the previous agent can no longer answer it.
  const canAssign = user?.role === "admin";
  const [agents, setAgents] = useState([]);
  useEffect(() => {
    if (!canAssign || !user?.token) return;
    axios
      .get("/api/locks/agents", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
      .then((res) => setAgents(res.data?.agents || []))
      .catch(() => setAgents([]));
  }, [canAssign, user?.token]);

  // One request at a time: switching the period cancels the previous fetch
  // so an older, slower answer cannot land on top of the newer one, and the
  // rows already on screen stay visible while the next period loads.
  const abortRef = useRef(null);

  // `silent` refreshes the rows behind the table instead of replacing it
  // with "Chargement…" — used after a correction, when the sheet is
  // rebuilt only to recompute the maturity.
  const load = useCallback(async (opts) => {
    if (!user?.token) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!(opts && opts.silent === true)) setLoading(true);
    setError("");
    try {
      const res = await axios.get("/api/leads", {
        params: { range },
        headers: { Authorization: `Bearer ${user.token}` },
        timeout: 120000,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setRows(res.data.rows || []);
      setTruncated(Boolean(res.data.truncated));
    } catch (err) {
      if (axios.isCancel(err) || controller.signal.aborted) return;
      if (err.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
      setError(
        err.response?.data?.message ||
          (err.code === "ECONNABORTED"
            ? "Le chargement a pris trop de temps. Réessayez dans un instant."
            : "Impossible de charger les leads."),
      );
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }, [user?.token, range, logout, navigate]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  /** Options for the dropdown filters, taken from the rows themselves. */
  const options = useMemo(() => {
    const present = (key) =>
      new Set(rows.map((r) => selectText(r, key)).filter(Boolean));
    const build = (key) => [...present(key)].sort();
    return {
      platform: build("platform"),
      classification: orderedLike(
        present("classification"),
        STAGES.map((s) => s.label),
      ),
      typologie: build("typologie"),
      maturity: orderedLike(present("maturity"), MATURITY_ORDER),
      frein: orderedLike(present("frein"), FREIN_ORDER),
      agent: build("agent"),
      // Offer "Non renseigné" only when some row actually lacks a frein.
      freinMissing: rows.some((r) => !selectText(r, "frein")),
    };
  }, [rows]);

  // Typing in a filter updates the field at once; the table follows when
  // React has time, instead of re-filtering every row on each keystroke.
  const deferredFilters = useDeferredValue(filters);

  const filtered = useMemo(() => {
    const active = Object.entries(deferredFilters)
      .filter(([, v]) => v !== "" && v != null)
      .map(([key, value]) => [
        key,
        value,
        COLUMNS.find((c) => c.key === key),
        String(value).toLowerCase(),
      ]);
    // By id; the name only stands in for a sheet built before ids were sent
    let out = mine
      ? rows.filter((row) =>
          row.agentId ? row.agentId === myId : row.agent === myName,
        )
      : rows;
    if (active.length > 0) {
      out = out.filter((row) =>
        active.every(([key, value, col, needle]) => {
          if (col?.type === "select") {
            const picked = selectText(row, key);
            if (key === "frein" && value === FREIN_NONE) return !picked;
            return picked === value;
          }
          const cell = cellText(row, key);
          if (col?.type === "number") {
            // "5" matches exactly; ">3" and "<3" compare
            const raw = Number(row[key] ?? 0);
            const v = String(value).trim();
            if (v.startsWith(">")) return raw > Number(v.slice(1));
            if (v.startsWith("<")) return raw < Number(v.slice(1));
            return String(raw) === v;
          }
          return cell.toLowerCase().includes(needle);
        }),
      );
    }
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    const col = COLUMNS.find((c) => c.key === key);
    return [...out].sort((a, b) => {
      if (key === "maturity") {
        // Ascending = hottest first (Chaud, Tiède, Froid, then the closed
        // dossiers Gagné and Perdu). Rows without a level stay last either
        // way; ties put the prospects waiting for an answer first, then the
        // most messages received.
        const la = maturityLevelOf(a);
        const lb = maturityLevelOf(b);
        if (la !== lb) {
          if (!la) return 1;
          if (!lb) return -1;
          return (MATURITY_RANK[la] - MATURITY_RANK[lb]) * mul;
        }
        if (Boolean(a.awaitingReply) !== Boolean(b.awaitingReply)) {
          return a.awaitingReply ? -1 : 1;
        }
        return Number(b.messagesIn || 0) - Number(a.messagesIn || 0);
      }
      if (key === "frein") {
        // Unqualified rows stay last either way.
        const fa = cellText(a, key);
        const fb = cellText(b, key);
        if (!fa || !fb) return fa ? -1 : fb ? 1 : 0;
        return COLLATOR.compare(fa, fb) * mul;
      }
      if (col?.type === "number") return (Number(a[key] || 0) - Number(b[key] || 0)) * mul;
      if (col?.type === "date") {
        return (new Date(a[key] || 0) - new Date(b[key] || 0)) * mul;
      }
      return COLLATOR.compare(cellText(a, key), cellText(b, key)) * mul;
    });
  }, [rows, deferredFilters, sort, mine, myId, myName]);

  // Each row holds several inputs (stage, typologie, PAX, motif, comment):
  // drawing thousands at once froze the page. Show the first PAGE_ROWS and
  // more on demand; back to the first page when the selection changes, but
  // not after an edit's silent reload.
  const [shown, setShown] = useState(PAGE_ROWS);
  useEffect(() => setShown(PAGE_ROWS), [deferredFilters, sort, mine, range]);
  const visible = useMemo(() => filtered.slice(0, shown), [filtered, shown]);

  // What the Excel / CSV buttons export: the rows on screen, in their
  // order, and a line describing how they were chosen for the file's title.
  const exportView = useMemo(() => {
    const parts = Object.entries(deferredFilters)
      .filter(([, v]) => v !== "" && v != null)
      .map(([key, value]) => {
        const col = COLUMNS.find((c) => c.key === key);
        const shown = key === "frein" && value === FREIN_NONE ? "Non renseigné" : value;
        return `${col?.label || key} : ${shown}`;
      });
    if (mine) parts.unshift("Mes leads");
    const sortCol = COLUMNS.find((c) => c.key === sort.key);
    if (sortCol) parts.push(`tri ${sortCol.label} ${sort.dir === "asc" ? "▲" : "▼"}`);
    return {
      keys: filtered.map((r) => `${r.platform}:${r.customerId}`),
      note: parts.join(" · "),
    };
  }, [filtered, deferredFilters, mine, sort]);

  const copyPhone = async (row) => {
    const ok = await copyText(row.phone);
    if (!ok) return;
    const key = `${row.platform}:${row.phone}`;
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
  };

  // One row per person: platform + customer id identifies it across sorts
  const rowKey = (r) => `${r.platform}:${r.customerId || r.name}`;
  const patchRow = (r, changes) =>
    setRows((prev) =>
      prev.map((x) => (rowKey(x) === rowKey(r) ? { ...x, ...changes } : x)),
    );
  const showEditError = (err) => {
    setEditError(
      err?.response?.data?.message || "Enregistrement impossible. Réessayez.",
    );
    setTimeout(() => setEditError(""), 5000);
  };

  /** Stage, typologie, priority or comment, through the dossier API. */
  const saveDossier = async (r, patch) => {
    try {
      const res = await axios.put(
        "/api/classifications",
        { conversationId: r.customerId, platform: r.platform, ...patch },
        { headers: { Authorization: `Bearer ${user?.token}` } },
      );
      const d = res.data?.dossier || {};
      patchRow(r, {
        classification: d.stage,
        classificationLabel: STAGE_LABELS[d.stage] || d.stage,
        typologie: d.typologie || "",
        typologieLabel: TYPOLOGY_LABELS[d.typologie] || "",
        isPriority: d.isPriority === true,
        comment: d.comment || "",
        invoiceRef: d.invoiceRef || "",
        pax: Number.isInteger(d.pax) ? d.pax : null,
        rdvAt: d.appointmentAt || null,
      });
      // The stage and the flag feed the maturity: rebuild quietly
      if (patch.stage !== undefined || patch.isPriority !== undefined) {
        load({ silent: true });
      }
    } catch (err) {
      showEditError(err);
      throw err;
    }
  };

  /** Give the discussion to another agent (or release it with ""). */
  const assignAgent = async (r, agentId) => {
    const target = agents.find((a) => a._id === agentId);
    const label = target ? target.name : "personne (discussion libérée)";
    if (
      !window.confirm(
        `Attribuer la discussion avec ${r.name} à ${label} ?\n` +
          (r.agentId
            ? `${r.agent} ne pourra plus y répondre.`
            : "Elle n’était attribuée à personne."),
      )
    ) {
      return;
    }
    try {
      const res = await axios.put(
        "/api/locks/assign",
        { platform: r.platform, customerId: r.customerId, agentId: agentId || null },
        { headers: { Authorization: `Bearer ${user?.token}` } },
      );
      patchRow(r, {
        agentId: res.data?.agentId || null,
        agent: res.data?.agent || "Non attribué",
      });
      // A released discussion falls back to its latest replier: rebuild
      load({ silent: true });
    } catch (err) {
      showEditError(err);
    }
  };

  const setCall = (k) => (e) => setCallForm((f) => ({ ...f, [k]: e.target.value }));
  const saveCall = async (e) => {
    e.preventDefault();
    if (!callForm.name.trim() || !callForm.phone.trim()) {
      setCallNotice({ type: "error", text: "Le nom et le téléphone sont obligatoires." });
      return;
    }
    setCallSaving(true);
    setCallNotice(null);
    try {
      const res = await axios.post(
        "/api/leads/incoming-call",
        { ...callForm, pax: callForm.pax === "" ? null : Number(callForm.pax) },
        { headers: { Authorization: `Bearer ${user?.token}` } },
      );
      const d = res.data || {};
      setCallNotice({
        type: "ok",
        text: d.created
          ? `« ${d.name} » ajouté aux leads (Appel entrant).`
          : `${d.phone} était déjà un lead : appel n° ${d.callCount} enregistré` +
            (d.heldBy ? `, suivi par ${d.heldBy}.` : "."),
      });
      setCallForm(EMPTY_CALL);
      setCallOpen(false);
      load({ silent: true });
    } catch (err) {
      setCallNotice({
        type: "error",
        text: err?.response?.data?.message || "Enregistrement impossible. Réessayez.",
      });
    } finally {
      setCallSaving(false);
    }
  };

  /** The motif / frein lives with the lead insights, not the dossier. */
  const saveFrein = async (r, code, note) => {
    try {
      const res = await axios.put(
        "/api/lead-insights/frein",
        { platform: r.platform, customerId: r.customerId, code, note },
        { headers: { Authorization: `Bearer ${user?.token}` } },
      );
      const f = res.data?.frein || {};
      patchRow(r, {
        frein: f.label || "",
        freinCode: f.code || "",
        freinNote: f.note || "",
      });
    } catch (err) {
      showEditError(err);
      throw err;
    }
  };

  const setFilter = (key, value) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  const activeCount = Object.values(filters).filter((v) => v !== "" && v != null).length;

  return (
    <DashboardLayout noPadding>
      <div style={styles.page}>
        <div style={styles.accent} />

        <div style={styles.header}>
          <div>
            <h2 style={styles.title}>{ownOnly ? "Mes leads" : "Leads"}</h2>
            <p style={styles.sub}>
              {loading
                ? "Chargement…"
                : `${filtered.length} prospect${filtered.length > 1 ? "s" : ""}` +
                  (activeCount > 0 || mine ? ` sur ${rows.length}` : "") +
                  (ownOnly ? " dont vous êtes le commercial en charge" : "")}
            </p>
          </div>
          <div style={styles.headerRight}>
            {!ownOnly && (
              <button
                className="support-btn"
                style={{ ...styles.ghost, ...(mine ? styles.ghostOn : {}) }}
                onClick={() => setMine((v) => !v)}
                title="Les prospects dont vous êtes le commercial en charge"
                aria-pressed={mine}
              >
                <UserRound size={13} /> Mes leads
              </button>
            )}
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
            <button
              className="support-btn"
              style={{ ...styles.ghost, ...(callOpen ? styles.ghostOn : {}) }}
              onClick={() => {
                setCallOpen((v) => !v);
                setCallNotice(null);
              }}
              title="Enregistrer un prospect qui a appelé l’agence"
            >
              <PhoneIncoming size={13} /> + Appel entrant
            </button>
            <ProspectExport range={range} view={exportView} />
          </div>
        </div>

        {callOpen && (
          <form onSubmit={saveCall} style={styles.callCard}>
            <div style={styles.callTitle}>
              <PhoneIncoming size={14} /> Nouveau lead — appel entrant
            </div>
            <div style={styles.callGrid}>
              <label style={styles.callField}>
                <span style={styles.callLabel}>Nom du prospect *</span>
                <input style={styles.callInput} value={callForm.name} onChange={setCall("name")} maxLength={120} required autoFocus />
              </label>
              <label style={styles.callField}>
                <span style={styles.callLabel}>Téléphone *</span>
                <input style={styles.callInput} type="tel" value={callForm.phone} onChange={setCall("phone")} maxLength={30} placeholder="98 123 456" required />
              </label>
              <label style={styles.callField}>
                <span style={styles.callLabel}>Email</span>
                <input style={styles.callInput} type="email" value={callForm.email} onChange={setCall("email")} maxLength={160} />
              </label>
              <label style={styles.callField}>
                <span style={styles.callLabel}>Typologie</span>
                <select style={styles.callInput} value={callForm.typologie} onChange={setCall("typologie")}>
                  <option value="">— Non renseignée —</option>
                  {TYPOLOGIES.map((t) => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
              </label>
              <label style={styles.callField}>
                <span style={styles.callLabel}>Nombre de PAX</span>
                <input style={styles.callInput} type="number" min={1} max={999} value={callForm.pax} onChange={setCall("pax")} />
              </label>
              <label style={{ ...styles.callField, gridColumn: "1 / -1" }}>
                <span style={styles.callLabel}>Commentaire</span>
                <input style={styles.callInput} value={callForm.comment} onChange={setCall("comment")} maxLength={1000} placeholder="Ce que le client demande, quand le rappeler…" />
              </label>
            </div>
            <div style={styles.callActions}>
              <span style={styles.callHint}>
                Vous serez le commercial en charge de ce lead. Un numéro déjà enregistré compte un appel de plus sur le même lead.
              </span>
              <button type="button" className="support-btn" style={styles.ghost} onClick={() => setCallOpen(false)}>
                Annuler
              </button>
              <button type="submit" className="support-btn" style={styles.callSave} disabled={callSaving}>
                {callSaving ? "Enregistrement…" : "Enregistrer le lead"}
              </button>
            </div>
          </form>
        )}
        {callNotice && (
          <div style={callNotice.type === "ok" ? styles.okNotice : styles.error} role="status">
            {callNotice.text}
          </div>
        )}

        {error && <div style={styles.error}>{error}</div>}
        {editError && (
          <div style={styles.error} role="alert">
            {editError}
          </div>
        )}
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
                        {c.key === "frein" && options.freinMissing && (
                          <option value={FREIN_NONE}>Non renseigné</option>
                        )}
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
                      ? ownOnly
                        ? "Aucun prospect ne vous est attribué sur cette période. Un prospect devient le vôtre dès que vous lui répondez depuis l’inbox."
                        : "Aucun prospect sur cette période."
                      : "Aucun prospect ne correspond à ces filtres."}
                  </td>
                </tr>
              ) : (
                visible.map((r, i) => (
                  <tr
                    key={rowKey(r)}
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
                          CLASSIFICATION_COLORS.nouveau_lead;
                        return (
                          <td key={c.key} style={styles.td}>
                            {canEditRow(r) && r.customerId ? (
                              <select
                                value={r.classification || "nouveau_lead"}
                                onChange={(e) =>
                                  saveDossier(r, { stage: e.target.value }).catch(() => {})
                                }
                                title="Changer l’étape — le commercial en charge ne change pas"
                                style={{
                                  ...styles.classChip,
                                  ...styles.cellSelect,
                                  color,
                                  borderColor: `${color}66`,
                                  backgroundColor: `${color}1a`,
                                }}
                              >
                                {STAGES.map((s) => (
                                  <option key={s.key} value={s.key}>{s.label}</option>
                                ))}
                              </select>
                            ) : (
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
                            )}
                          </td>
                        );
                      }
                      if (canEditRow(r) && r.customerId && c.key === "typologie") {
                        return (
                          <td key={c.key} style={styles.td}>
                            <select
                              value={r.typologie || ""}
                              onChange={(e) =>
                                saveDossier(r, { typologie: e.target.value }).catch(() => {})
                              }
                              title="Typologie de la demande"
                              style={styles.plainSelect}
                            >
                              <option value="">—</option>
                              {TYPOLOGIES.map((t) => (
                                <option key={t.key} value={t.key}>{t.label}</option>
                              ))}
                            </select>
                          </td>
                        );
                      }
                      if (canEditRow(r) && r.customerId && c.key === "pax") {
                        return (
                          <td key={c.key} style={styles.td}>
                            <PaxCell
                              value={r.pax}
                              onSave={(pax) => saveDossier(r, { pax })}
                            />
                          </td>
                        );
                      }
                      if (canEditRow(r) && r.customerId && c.key === "frein") {
                        return (
                          <td key={c.key} style={styles.td}>
                            <FreinSelector
                              value={
                                r.freinCode
                                  ? { code: r.freinCode, note: r.freinNote || "", label: r.frein }
                                  : null
                              }
                              onSave={(code, note) => saveFrein(r, code, note)}
                              compact
                            />
                          </td>
                        );
                      }
                      if (canAssign && r.customerId && c.key === "agent" && agents.length > 0) {
                        const known = agents.some((a) => a._id === r.agentId);
                        return (
                          <td key={c.key} style={styles.td}>
                            <select
                              value={r.agentId || ""}
                              onChange={(e) => assignAgent(r, e.target.value)}
                              title="Réattribuer la discussion — le nouvel agent y répond normalement"
                              style={{
                                ...styles.plainSelect,
                                ...(r.agentId ? {} : { color: "var(--text-muted)" }),
                              }}
                            >
                              <option value="">Non attribué</option>
                              {r.agentId && !known && (
                                <option value={r.agentId}>{r.agent}</option>
                              )}
                              {agents.map((a) => (
                                <option key={a._id} value={a._id}>
                                  {a.name}
                                  {a.role !== "marketing" ? ` (${a.role})` : ""}
                                </option>
                              ))}
                            </select>
                          </td>
                        );
                      }
                      if (canEditRow(r) && r.customerId && c.key === "comment") {
                        return (
                          <td key={c.key} style={{ ...styles.td, overflow: "visible" }}>
                            <CommentField
                              value={r.comment || ""}
                              onSave={(comment) => saveDossier(r, { comment })}
                              compact
                            />
                          </td>
                        );
                      }
                      if (c.key === "maturity") {
                        const level = maturityLevelOf(r);
                        return (
                          <td
                            key={c.key}
                            style={styles.td}
                            title={r.maturityReason || cellText(r, c.key)}
                          >
                            {level ? (
                              <MaturityChip
                                maturity={{
                                  level,
                                  label: r.maturity || MATURITY[level].label,
                                  reason: r.maturityReason || "",
                                }}
                              />
                            ) : (
                              cellText(r, c.key)
                            )}
                          </td>
                        );
                      }
                      if (c.key === "phone" && r.phone) {
                        const copied = copiedKey === `${r.platform}:${r.phone}`;
                        return (
                          <td key={c.key} style={styles.td} title={r.phone}>
                            <span style={styles.phoneCell}>
                              <a
                                href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}
                                style={styles.phoneLink}
                                title="Appeler"
                              >
                                <Phone size={12} /> {r.phone}
                              </a>
                              <button
                                type="button"
                                className="support-btn"
                                style={styles.copyBtn}
                                onClick={() => copyPhone(r)}
                                title="Copier le numéro"
                                aria-label="Copier le numéro"
                              >
                                {copied ? (
                                  <Check size={12} style={{ color: "var(--success)" }} />
                                ) : (
                                  <Copy size={12} />
                                )}
                              </button>
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
                            ...(c.key === "lastMessage"
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
              {!loading && filtered.length > shown && (
                <tr>
                  <td colSpan={COLUMNS.length} style={styles.empty}>
                    {shown} prospects affichés sur {filtered.length}.{" "}
                    <button
                      className="support-btn"
                      style={styles.ghost}
                      onClick={() => setShown((n) => n + PAGE_ROWS)}
                    >
                      Afficher {Math.min(PAGE_ROWS, filtered.length - shown)} de plus
                    </button>{" "}
                    <button
                      className="support-btn"
                      style={styles.ghost}
                      onClick={() => setShown(filtered.length)}
                    >
                      Tout afficher
                    </button>
                  </td>
                </tr>
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
  ghostOn: {
    color: "var(--accent)",
    borderColor: "var(--accent)",
    backgroundColor: "var(--accent-glow)",
  },
  // Corrections in the cells (admins and managers)
  cellSelect: {
    cursor: "pointer",
    outline: "none",
    fontFamily: "'Hanken Grotesk', sans-serif",
    maxWidth: "100%",
  },
  plainSelect: {
    padding: "3px 6px",
    borderRadius: 6,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-card)",
    color: "var(--text-primary)",
    fontSize: 12,
    cursor: "pointer",
    outline: "none",
    maxWidth: "100%",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  // "+ Appel entrant" form
  callCard: {
    margin: "12px 26px 0",
    padding: "14px 16px",
    borderRadius: 10,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-card)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  callTitle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    fontWeight: 700,
    color: "var(--text-primary)",
  },
  callGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: 10,
  },
  callField: { display: "flex", flexDirection: "column", gap: 4 },
  callLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: "var(--text-faint)",
  },
  callInput: {
    padding: "7px 10px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-elevated)",
    color: "var(--text-primary)",
    fontSize: 12.5,
    outline: "none",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  callActions: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 8,
  },
  callHint: { flex: "1 1 260px", fontSize: 11.5, color: "var(--text-muted)" },
  callSave: {
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 14px",
    borderRadius: 8,
    border: "none",
    backgroundColor: "var(--accent)",
    color: "var(--bg-primary)",
    fontWeight: 700,
    fontSize: 12.5,
    cursor: "pointer",
  },
  okNotice: {
    margin: "12px 26px 0",
    padding: "9px 13px",
    borderRadius: 8,
    border: "1px solid var(--success)",
    background: "rgba(95,191,138,0.1)",
    color: "var(--success)",
    fontSize: 13,
  },
  phoneCell: { display: "inline-flex", alignItems: "center", gap: 6 },
  phoneLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    color: "var(--text-primary)",
    textDecoration: "none",
    fontFamily: "'Space Grotesk', sans-serif",
    fontVariantNumeric: "tabular-nums",
  },
  copyBtn: {
    display: "inline-flex",
    padding: 3,
    borderRadius: 5,
    border: "1px solid var(--border-primary)",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
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
