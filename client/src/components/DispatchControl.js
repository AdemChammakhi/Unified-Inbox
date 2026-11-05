import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Send, Check, X, UserRound } from "lucide-react";

/**
 * DispatchControl — the dispatch state of the open conversation, in the
 * message header.
 *
 *   agent, dispatched to them   « À traiter » chip with the admin's note and
 *                               a « Marquer comme traité » button
 *   admin, no dispatch          « Dispatcher » button → picker (agent with
 *                               their open count, note, Valider)
 *   admin, dispatched           chip « Dispatché à X par Y le … » with
 *                               Réattribuer / Annuler / Traité
 *
 * The agents list comes from GET /api/locks/agents (admin only), loaded
 * once the picker is first opened.
 */

const NOTE_MAX = 300;

const shortDate = (v) => {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) +
    " " +
    d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
};

const errorText = (err) =>
  err?.response?.data?.message || "Enregistrement impossible. Réessayez.";

const DispatchControl = ({
  token,
  role,
  userId,
  platform,
  customerId,
  mine,
  open,
  loadByAgent,
  onDispatch,
  onReassign,
  onCancel,
  onDone,
}) => {
  const isAdmin = role === "admin";
  const isStaff = isAdmin || role === "manager";
  const [picking, setPicking] = useState(false);
  const [agents, setAgents] = useState(null);
  const [agentId, setAgentId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A new conversation: close the picker, forget the draft
  useEffect(() => {
    setPicking(false);
    setNote("");
    setAgentId("");
    setError("");
  }, [platform, customerId]);

  useEffect(() => {
    if (!picking || agents !== null || !isAdmin || !token) return;
    let cancelled = false;
    axios
      .get("/api/locks/agents", { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => {
        if (cancelled) return;
        setAgents(res.data?.agents || []);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [picking, agents, isAdmin, token]);

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (mounted.current) {
        setPicking(false);
        setNote("");
        setAgentId("");
      }
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const current = open || mine;
  const isMine = Boolean(mine) || (current && current.agentId === userId);

  const openPicker = (reassigning) => {
    setAgentId(reassigning && current ? current.agentId || "" : "");
    setNote(reassigning && current ? current.note || "" : "");
    setError("");
    setPicking(true);
  };

  const submit = () =>
    run(async () => {
      if (!agentId) throw new Error("Choisissez un agent.");
      if (current && current.id) {
        await onReassign(current.id, agentId, note.trim());
      } else {
        await onDispatch({ platform, customerId, agentId, note: note.trim() });
      }
    });

  if (!isAdmin && !current) return null;

  return (
    <div style={styles.wrap} onClick={(e) => e.stopPropagation()}>
      {current && !picking && (
        <span
          style={{ ...styles.chip, ...(isMine ? styles.chipMine : {}) }}
          title={
            [
              `Dispatché à ${current.agentName || "?"} par ${current.dispatchedByName || "?"} le ${shortDate(current.dispatchedAt)}`,
              current.note ? `Consigne : ${current.note}` : "",
              current.firstReplyAt ? `Première réponse le ${shortDate(current.firstReplyAt)}` : "Pas encore de réponse",
            ]
              .filter(Boolean)
              .join("\n")
          }
        >
          <Send size={11} />
          {isMine
            ? `À traiter${current.note ? ` · ${current.note}` : ""}`
            : `→ ${current.agentName || "?"}`}
          {!isMine && current.note && <span style={styles.note}> · {current.note}</span>}
        </span>
      )}

      {current && !picking && (isMine || isStaff) && (
        <button
          type="button"
          className="support-btn"
          style={styles.doneBtn}
          disabled={busy}
          onClick={() => run(() => onDone(current.id))}
          title="Le dispatch est terminé : la discussion quitte la tête de liste"
        >
          <Check size={12} /> Marquer comme traité
        </button>
      )}

      {isAdmin && !picking && (
        <>
          <button
            type="button"
            className="support-btn"
            style={styles.ghost}
            disabled={busy}
            onClick={() => openPicker(Boolean(current))}
            title={
              current
                ? "Confier ce dispatch à un autre agent"
                : "Confier cette discussion à un agent, qui la verra en tête de sa liste"
            }
          >
            <UserRound size={12} /> {current ? "Réattribuer" : "Dispatcher"}
          </button>
          {current && (
            <button
              type="button"
              className="support-btn"
              style={styles.ghost}
              disabled={busy}
              onClick={() => {
                if (window.confirm("Annuler ce dispatch ? L’agent reste en charge de la discussion.")) {
                  run(() => onCancel(current.id));
                }
              }}
              title="Annuler le dispatch"
            >
              <X size={12} /> Annuler
            </button>
          )}
        </>
      )}

      {picking && (
        <span style={styles.picker}>
          <select
            value={agentId}
            disabled={busy || agents === null}
            onChange={(e) => setAgentId(e.target.value)}
            style={styles.select}
            aria-label="Agent"
          >
            <option value="">
              {agents === null ? "Chargement…" : "Choisir un agent…"}
            </option>
            {(agents || []).map((a) => (
              <option key={a._id} value={a._id}>
                {a.name}
                {a.role !== "marketing" ? ` (${a.role})` : ""}
                {loadByAgent?.[a._id] ? ` — ${loadByAgent[a._id]} à traiter` : ""}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={note}
            maxLength={NOTE_MAX}
            placeholder="Consigne (facultatif)"
            aria-label="Consigne pour l’agent"
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setPicking(false);
              }
            }}
            style={styles.input}
          />
          <button
            type="button"
            className="support-btn"
            style={styles.doneBtn}
            disabled={busy || !agentId}
            onClick={submit}
          >
            Valider
          </button>
          <button
            type="button"
            className="support-btn"
            style={styles.ghost}
            disabled={busy}
            onClick={() => setPicking(false)}
          >
            Fermer
          </button>
        </span>
      )}

      {busy && <span style={styles.status}>Enregistrement…</span>}
      {error && (
        <span role="alert" style={styles.error}>
          {error}
        </span>
      )}
    </div>
  );
};

const styles = {
  wrap: {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    minWidth: 0,
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    fontWeight: 700,
    color: "var(--accent)",
    backgroundColor: "var(--accent-bg)",
    border: "1px solid var(--accent-border)",
    borderRadius: 6,
    padding: "3px 8px",
    maxWidth: 360,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chipMine: {
    color: "#fff",
    backgroundColor: "var(--accent)",
    borderColor: "var(--accent)",
  },
  note: {
    fontWeight: 500,
    opacity: 0.85,
  },
  doneBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    border: "1px solid var(--accent-border)",
    borderRadius: 6,
    backgroundColor: "var(--accent-bg)",
    color: "var(--accent)",
    fontWeight: 700,
    fontSize: 11,
    padding: "3px 9px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  ghost: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    border: "1px solid var(--border-primary)",
    borderRadius: 6,
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    fontWeight: 600,
    fontSize: 11,
    padding: "3px 9px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  picker: {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  select: {
    border: "1px solid var(--border-secondary)",
    borderRadius: 6,
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 6px",
    maxWidth: 220,
    outline: "none",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  input: {
    flex: "1 1 160px",
    minWidth: 0,
    maxWidth: 280,
    border: "1px solid var(--border-secondary)",
    borderRadius: 6,
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    fontSize: 11,
    padding: "3px 8px",
    outline: "none",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  status: {
    fontSize: 11,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  },
  error: {
    fontSize: 11,
    color: "var(--danger)",
  },
};

export default DispatchControl;
