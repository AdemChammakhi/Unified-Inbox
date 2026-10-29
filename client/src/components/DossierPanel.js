import React, { useEffect, useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { TYPOLOGIES } from "../constants/pipeline";

/**
 * DossierPanel — the customer's file, beyond the étape and the
 * qualification (both set from the conversation header): typologie of the
 * request and RDV date. Every field saves on its own; the parent persists
 * through PUT /api/classifications and passes the stored values back as
 * `dossier`.
 *
 * Props:
 *   dossier    { stage, qualification, typologie, appointmentAt } | undefined
 *   onSave     (patch) => Promise   — patch holds only the changed field(s)
 *   canEdit    boolean
 */

const toLocalInput = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatRdv = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const DossierPanel = ({ dossier, onSave, canEdit = true }) => {
  const d = dossier || {};
  const [rdv, setRdv] = useState(toLocalInput(d.appointmentAt));
  const [saving, setSaving] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    setRdv(toLocalInput(d.appointmentAt));
  }, [d.appointmentAt]);

  const save = async (field, patch) => {
    setSaving(field);
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(err?.response?.data?.message || "Enregistrement impossible.");
    } finally {
      setSaving("");
    }
  };

  const busy = (f) => saving === f;

  return (
    <div style={styles.panel}>
      <div style={styles.grid}>
        <label style={styles.field}>
          <span style={styles.label}>Typologie de la demande</span>
          <select
            style={styles.input}
            value={d.typologie || ""}
            disabled={!canEdit || busy("typologie")}
            onChange={(e) => save("typologie", { typologie: e.target.value })}
          >
            <option value="">— Non renseignée —</option>
            {TYPOLOGIES.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </label>

        <label style={styles.field}>
          <span style={styles.label}>
            <CalendarDays size={12} /> Rendez-vous
          </span>
          <span style={styles.inline}>
            <input
              type="datetime-local"
              style={{ ...styles.input, flex: 1, colorScheme: "dark light" }}
              value={rdv}
              disabled={!canEdit || busy("appointmentAt")}
              onChange={(e) => setRdv(e.target.value)}
            />
            {canEdit && rdv && rdv !== toLocalInput(d.appointmentAt) && (
              <button
                className="inbox-send-action"
                style={styles.smallBtn}
                disabled={busy("appointmentAt")}
                onClick={() =>
                  save("appointmentAt", { appointmentAt: new Date(rdv).toISOString() })
                }
              >
                Confirmer
              </button>
            )}
            {canEdit && d.appointmentAt && (
              <button
                className="inbox-tab-btn"
                style={styles.iconBtn}
                title="Retirer le rendez-vous"
                disabled={busy("appointmentAt")}
                onClick={() => save("appointmentAt", { appointmentAt: null })}
              >
                <X size={13} />
              </button>
            )}
          </span>
          {d.appointmentAt && (
            <span style={styles.hint}>Fixé le {formatRdv(d.appointmentAt)}</span>
          )}
        </label>
      </div>

      {error && <div style={styles.error} role="alert">{error}</div>}
    </div>
  );
};

const styles = {
  panel: {
    padding: "12px 24px 14px",
    borderBottom: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-elevated)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: 12,
  },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  label: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: "var(--text-faint)",
  },
  inline: { display: "flex", gap: 6, alignItems: "center" },
  input: {
    padding: "7px 10px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-card)",
    color: "var(--text-primary)",
    fontSize: 12.5,
    outline: "none",
  },
  smallBtn: {
    padding: "6px 11px",
    borderRadius: 8,
    border: "none",
    backgroundColor: "var(--accent)",
    color: "var(--bg-primary)",
    fontWeight: 700,
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  iconBtn: {
    padding: 6,
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "inline-flex",
  },
  hint: { fontSize: 11, color: "var(--text-muted)" },
  error: {
    fontSize: 12,
    color: "var(--danger)",
  },
};

export default DossierPanel;
