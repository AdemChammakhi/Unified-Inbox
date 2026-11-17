import React, { useEffect, useRef, useState } from "react";
import { Check, MessageSquareText } from "lucide-react";

/**
 * CommentField — the free comment an agent keeps on a discussion, shown next
 * to the motif / frein.
 *
 * Saves on Enter, on leaving the field, or with "Enregistrer"; Escape puts
 * the saved text back. The saved value comes back through `value` once the
 * parent has stored it.
 *
 * Give it `key={conversation.id}` when one instance follows the selected
 * conversation, so a half-typed comment never carries over to the next thread.
 */

export const COMMENT_MAX = 1000;

const CommentField = ({ value = "", onSave, disabled = false, compact = false }) => {
  const saved = value || "";
  const [text, setText] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Follow the saved value when it changes (save, refetch, another agent).
  useEffect(() => {
    setText(saved);
  }, [saved]);

  const dirty = text.trim() !== saved.trim();

  const save = async () => {
    if (!dirty || saving || disabled || typeof onSave !== "function") return;
    setSaving(true);
    setError("");
    try {
      await onSave(text.trim());
      if (!mountedRef.current) return;
      setDone(true);
      setTimeout(() => mountedRef.current && setDone(false), 1500);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err?.response?.data?.message ||
          "Impossible d’enregistrer le commentaire. Réessayez.",
      );
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const fontSize = compact ? 11 : 12;

  return (
    <div style={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <div style={styles.row}>
        <MessageSquareText
          size={compact ? 12 : 13}
          style={{ color: "var(--text-faint)", flexShrink: 0 }}
        />
        <input
          type="text"
          value={text}
          maxLength={COMMENT_MAX}
          disabled={disabled || saving}
          placeholder="Commentaire…"
          aria-label="Commentaire sur la discussion"
          title={saved || "Commentaire sur la discussion"}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              setText(saved);
              setError("");
            }
          }}
          style={{
            ...styles.input,
            fontSize,
            padding: compact ? "2px 6px" : "4px 8px",
            opacity: disabled ? 0.6 : 1,
          }}
        />
        {dirty && !disabled && (
          <button
            type="button"
            // Keep the focus in the field so this click is not preceded by
            // the blur save.
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
            disabled={saving}
            style={{
              ...styles.button,
              fontSize,
              padding: compact ? "2px 8px" : "4px 10px",
            }}
          >
            {saving ? "…" : "Enregistrer"}
          </button>
        )}
        {done && !dirty && (
          <Check size={13} style={{ color: "var(--success, #5FBF8A)", flexShrink: 0 }} />
        )}
      </div>
      {error && (
        <div style={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
};

const styles = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    flex: "1 1 220px",
    minWidth: 160,
    maxWidth: 420,
  },
  row: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  input: {
    flex: 1,
    minWidth: 0,
    borderRadius: 6,
    border: "1px solid var(--border-secondary)",
    backgroundColor: "var(--bg-card)",
    color: "var(--text-primary)",
    outline: "none",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  button: {
    borderRadius: 6,
    border: "none",
    backgroundColor: "var(--accent)",
    color: "var(--bg-primary)",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  error: { fontSize: 11, color: "var(--danger)" },
};

export default CommentField;
