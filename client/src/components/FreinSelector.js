import React, { useEffect, useRef, useState } from "react";
import { FREINS } from "../constants/leadQualification";

/**
 * FreinSelector — record the main need or obstacle of an exchange.
 *
 * Picking a code saves straight away, except "Autre", which opens a short
 * note field confirmed with "Valider". The saved value comes back through
 * `value` once the caller refetches; until then the local choice is shown.
 *
 * Give it `key={conversation.id}` when one instance follows the selected
 * conversation, so a half-typed note never carries over to the next thread.
 */

const NOTE_MAX = 200;

const errorText = (err) =>
  err?.response?.data?.message ||
  "Impossible d’enregistrer le motif. Réessayez.";

const FreinSelector = ({
  value,
  onSave,
  required = false,
  disabled = false,
  compact = false,
}) => {
  const savedCode = value?.code || "";
  const savedNote = value?.note || "";
  const [selected, setSelected] = useState(savedCode);
  const [note, setNote] = useState(savedNote);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Follow the saved value when it changes (refetch, another agent's save).
  useEffect(() => {
    setSelected(savedCode);
    setNote(savedNote);
  }, [savedCode, savedNote]);

  const save = async (code, noteText) => {
    if (typeof onSave !== "function") return;
    setSaving(true);
    setError("");
    try {
      await onSave(code, noteText);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorText(err));
      setSelected(savedCode);
      setNote(savedNote);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const handleChange = (e) => {
    const code = e.target.value;
    if (!code) return;
    setError("");
    setSelected(code);
    if (code === "autre") {
      setNote(savedCode === "autre" ? savedNote : "");
      return;
    }
    save(code, "");
  };

  const trimmedNote = note.trim();
  const noteUnchanged = savedCode === "autre" && trimmedNote === savedNote.trim();

  const submitNote = () => {
    if (saving || disabled || noteUnchanged) return;
    save("autre", trimmedNote);
  };

  const cancelNote = () => {
    setSelected(savedCode);
    setNote(savedNote);
    setError("");
  };

  const missing = required && !savedCode;
  const fontSize = compact ? 11 : 12;

  return (
    <div style={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <div style={styles.row}>
        <select
          value={selected}
          onChange={handleChange}
          disabled={disabled || saving}
          aria-label="Motif ou frein principal"
          aria-invalid={missing || undefined}
          title={value?.label || "Motif ou frein principal de l’échange"}
          style={{
            ...styles.select,
            fontSize,
            padding: compact ? "2px 6px" : "4px 8px",
            maxWidth: compact ? 150 : 230,
            color: selected ? "var(--text-primary)" : "var(--text-muted)",
            borderColor: missing ? "var(--danger)" : "var(--border-secondary)",
            boxShadow: missing ? "0 0 0 1px var(--danger)" : "none",
            opacity: disabled ? 0.6 : 1,
            cursor: disabled || saving ? "default" : "pointer",
          }}
        >
          <option value="" disabled>
            Motif / frein…
          </option>
          {FREINS.map((f) => (
            <option key={f.code} value={f.code}>
              {f.label}
            </option>
          ))}
        </select>

        {selected === "autre" && (
          <>
            <input
              type="text"
              value={note}
              maxLength={NOTE_MAX}
              placeholder="Précisez…"
              aria-label="Précision du motif"
              disabled={disabled || saving}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitNote();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelNote();
                }
              }}
              style={{
                ...styles.note,
                fontSize,
                padding: compact ? "2px 6px" : "4px 8px",
              }}
            />
            <button
              type="button"
              onClick={submitNote}
              disabled={disabled || saving || noteUnchanged}
              style={{
                ...styles.button,
                fontSize,
                padding: compact ? "2px 8px" : "4px 10px",
                opacity: disabled || saving || noteUnchanged ? 0.5 : 1,
                cursor:
                  disabled || saving || noteUnchanged ? "default" : "pointer",
              }}
            >
              Valider
            </button>
          </>
        )}

        {saving && (
          <span style={styles.status} aria-live="polite">
            Enregistrement…
          </span>
        )}
        {!saving && missing && <span style={styles.missing}>À qualifier</span>}
      </div>

      {error && (
        <div role="alert" style={styles.error}>
          {error}
        </div>
      )}
    </div>
  );
};

const styles = {
  wrap: {
    display: "inline-flex",
    flexDirection: "column",
    gap: 3,
    minWidth: 0,
    maxWidth: "100%",
  },
  row: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    minWidth: 0,
  },
  select: {
    border: "1px solid var(--border-secondary)",
    borderRadius: 6,
    backgroundColor: "var(--bg-secondary)",
    fontWeight: 600,
    outline: "none",
    minWidth: 0,
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  note: {
    flex: "1 1 140px",
    minWidth: 0,
    maxWidth: 260,
    border: "1px solid var(--border-secondary)",
    borderRadius: 6,
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    outline: "none",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  button: {
    border: "1px solid var(--accent-border)",
    borderRadius: 6,
    backgroundColor: "var(--accent-bg)",
    color: "var(--accent)",
    fontWeight: 700,
    whiteSpace: "nowrap",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  status: {
    fontSize: 11,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  },
  missing: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--danger)",
    whiteSpace: "nowrap",
  },
  error: {
    fontSize: 11,
    color: "var(--danger)",
  },
};

export default FreinSelector;
