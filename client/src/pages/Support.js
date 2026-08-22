import React, { useState, useEffect, useCallback, useRef } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";
import { LifeBuoy, Plus, RefreshCw, Paperclip, Send } from "lucide-react";
import { compressImage, formatBytes } from "../utils/compressImage";

/**
 * Support — file problems to the Better Call Fedi help desk and follow the
 * replies. Tickets live in a shared database; the backend scopes everything
 * to this project, so this page only ever sees our own.
 *
 * Fedi owns status, priority re-triage and fixes; we only file tickets and
 * add comments. The UI reflects that: those fields are read-only here.
 */

const STATUS_META = {
  OPEN: { label: "Open", color: "var(--accent)" },
  IN_PROGRESS: { label: "In progress", color: "var(--info)" },
  WAITING_ON_REPORTER: { label: "Needs your reply", color: "var(--warning)" },
  RESOLVED: { label: "Resolved", color: "var(--success)" },
  CLOSED: { label: "Closed", color: "var(--text-muted)" },
};

const PRIORITY_META = {
  LOW: { label: "Low", color: "var(--text-muted)" },
  MEDIUM: { label: "Medium", color: "var(--info)" },
  HIGH: { label: "High", color: "var(--warning)" },
  CRITICAL: { label: "Critical", color: "var(--danger)" },
};

const MAX_SCREENSHOTS = 4;
const POLL_MS = 45000; // contract suggests 30–60s while the view is open

const timeAgo = (t) => {
  if (!t) return "";
  const diff = Date.now() - Number(t);
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(Number(t)).toLocaleDateString();
};

const statusOf = (s) => STATUS_META[s] || STATUS_META.OPEN;
const priorityOf = (p) => PRIORITY_META[p] || PRIORITY_META.MEDIUM;

const Support = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deskError, setDeskError] = useState("");
  const [selected, setSelected] = useState(null);
  const [composing, setComposing] = useState(false);

  // New-ticket form
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [shots, setShots] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const fileRef = useRef(null);

  // Reply box
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);

  const authHeader = { headers: { Authorization: `Bearer ${user?.token}` } };

  const fetchTickets = useCallback(async () => {
    if (!user?.token) return;
    try {
      const res = await axios.get("/api/support/tickets", {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      setTickets(res.data.tickets || []);
      setDeskError("");
    } catch (err) {
      if (err.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
      setDeskError(
        err.response?.data?.message || "Could not reach the support desk",
      );
    } finally {
      setLoading(false);
    }
  }, [user?.token, logout, navigate]);

  useEffect(() => {
    fetchTickets();
    const id = setInterval(fetchTickets, POLL_MS);
    return () => clearInterval(id);
  }, [fetchTickets]);

  const openTicket = async (ticket) => {
    setComposing(false);
    setSelected(ticket); // show immediately from the list data
    try {
      const res = await axios.get(
        `/api/support/tickets/${ticket.id}`,
        authHeader,
      );
      setSelected(res.data.ticket);
    } catch {
      /* keep the list version if the detail fetch fails */
    }
  };

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    setFormError("");
    const room = MAX_SCREENSHOTS - shots.length;
    if (room <= 0) {
      setFormError(`You can attach at most ${MAX_SCREENSHOTS} screenshots`);
      return;
    }
    for (const file of files.slice(0, room)) {
      try {
        const shot = await compressImage(file);
        setShots((prev) => [...prev, shot]);
      } catch (err) {
        setFormError(err.message);
      }
    }
  };

  const submitTicket = async (e) => {
    e.preventDefault();
    setFormError("");
    if (!title.trim() || !description.trim()) {
      setFormError("Give the ticket a title and describe what happened");
      return;
    }
    setSubmitting(true);
    try {
      const res = await axios.post(
        "/api/support/tickets",
        {
          title: title.trim(),
          description: description.trim(),
          priority,
          screenshots: shots.map((s) => s.dataUrl),
        },
        authHeader,
      );
      setTitle("");
      setDescription("");
      setPriority("MEDIUM");
      setShots([]);
      setComposing(false);
      setSelected(res.data.ticket);
      fetchTickets();
    } catch (err) {
      setFormError(
        err.response?.data?.message || "Could not file the ticket",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const sendReply = async () => {
    if (!reply.trim() || !selected) return;
    setReplying(true);
    try {
      const res = await axios.post(
        `/api/support/tickets/${selected.id}/comments`,
        { text: reply.trim() },
        authHeader,
      );
      setReply("");
      setSelected((prev) =>
        prev ? { ...res.data.ticket, screenshots: prev.screenshots } : prev,
      );
      fetchTickets();
    } catch (err) {
      alert(err.response?.data?.message || "Could not send your reply");
    } finally {
      setReplying(false);
    }
  };

  const needsReply = tickets.filter(
    (t) => t.status === "WAITING_ON_REPORTER",
  ).length;

  return (
    <DashboardLayout noPadding>
      <div style={styles.container}>
        <div style={styles.accentLine} />

        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <LifeBuoy size={20} style={{ color: "var(--accent)" }} />
            <h2 style={styles.title}>Support</h2>
            {needsReply > 0 && (
              <span style={styles.needsBadge}>
                {needsReply} waiting on you
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="support-btn"
              style={styles.ghostBtn}
              onClick={fetchTickets}
              title="Refresh"
            >
              <RefreshCw size={14} /> Refresh
            </button>
            <button
              className="support-btn-primary"
              style={styles.primaryBtn}
              onClick={() => {
                setComposing(true);
                setSelected(null);
              }}
            >
              <Plus size={15} /> Report a problem
            </button>
          </div>
        </div>

        {deskError && <div style={styles.deskError}>{deskError}</div>}

        <div style={styles.layout}>
          {/* ── Ticket list ── */}
          <div style={styles.list}>
            <div style={styles.listHeader}>Your tickets</div>
            <div className="support-scroll" style={styles.listScroll}>
              {loading ? (
                <div style={{ padding: 12 }}>
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="skeleton"
                      style={{ height: 58, marginBottom: 10, borderRadius: 8 }}
                    />
                  ))}
                </div>
              ) : tickets.length === 0 ? (
                <div style={styles.empty}>
                  <div style={{ fontSize: 30, opacity: 0.3, marginBottom: 10 }}>
                    ◇
                  </div>
                  No tickets yet.
                  <br />
                  Hit “Report a problem” when something breaks.
                </div>
              ) : (
                tickets.map((t) => {
                  const st = statusOf(t.status);
                  const isSel = selected?.id === t.id;
                  return (
                    <div
                      key={t.id}
                      className="support-row"
                      style={{
                        ...styles.row,
                        backgroundColor: isSel
                          ? "var(--bg-hover)"
                          : "transparent",
                        borderLeft: `3px solid ${st.color}`,
                      }}
                      onClick={() => openTicket(t)}
                    >
                      <div style={styles.rowTop}>
                        <span style={{ ...styles.statusChip, color: st.color }}>
                          {st.label}
                        </span>
                        <span
                          style={{
                            ...styles.priorityDot,
                            backgroundColor: priorityOf(t.priority).color,
                          }}
                          title={`${priorityOf(t.priority).label} priority`}
                        />
                      </div>
                      <div style={styles.rowTitle}>{t.title}</div>
                      <div style={styles.rowMeta}>
                        {timeAgo(t.updatedAt)}
                        {t.comments?.length > 0 &&
                          ` · ${t.comments.length} message${t.comments.length > 1 ? "s" : ""}`}
                        {t.fixes?.length > 0 && ` · ${t.fixes.length} fix`}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* ── Detail / compose ── */}
          <div style={styles.detail}>
            {composing ? (
              <form onSubmit={submitTicket} style={styles.form}>
                <h3 style={styles.formTitle}>Report a problem</h3>
                <p style={styles.formHint}>
                  One ticket per problem — separate issues are easier to fix.
                </p>

                {formError && <div style={styles.formError}>{formError}</div>}

                <label style={styles.label}>What went wrong?</label>
                <input
                  style={styles.input}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Reply fails on day-old Facebook threads"
                  maxLength={200}
                />

                <label style={styles.label}>
                  Steps to reproduce, expected vs actual
                </label>
                <textarea
                  style={{ ...styles.input, minHeight: 150, resize: "vertical" }}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={
                    "1. Open a conversation last updated yesterday\n2. Send a reply\n\nExpected: message sends\nActual: error dialog"
                  }
                  maxLength={10000}
                />

                <label style={styles.label}>How urgent is it?</label>
                <div style={styles.priorityRow}>
                  {Object.entries(PRIORITY_META).map(([key, meta]) => (
                    <button
                      key={key}
                      type="button"
                      className="support-btn"
                      onClick={() => setPriority(key)}
                      style={{
                        ...styles.priorityBtn,
                        ...(priority === key
                          ? {
                              backgroundColor: meta.color,
                              color: "var(--bg-primary)",
                              borderColor: "transparent",
                              fontWeight: 700,
                            }
                          : {}),
                      }}
                    >
                      {meta.label}
                    </button>
                  ))}
                </div>

                <label style={styles.label}>
                  Screenshots ({shots.length}/{MAX_SCREENSHOTS})
                </label>
                <div style={styles.shotRow}>
                  {shots.map((s, i) => (
                    <div key={i} style={styles.shotThumb}>
                      <img src={s.dataUrl} alt="" style={styles.shotImg} />
                      <button
                        type="button"
                        style={styles.shotRemove}
                        onClick={() =>
                          setShots((prev) => prev.filter((_, x) => x !== i))
                        }
                        title="Remove"
                      >
                        ✕
                      </button>
                      <span style={styles.shotSize}>
                        {formatBytes(s.bytes)}
                      </span>
                    </div>
                  ))}
                  {shots.length < MAX_SCREENSHOTS && (
                    <button
                      type="button"
                      className="support-btn"
                      style={styles.shotAdd}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Paperclip size={16} />
                      <span style={{ fontSize: 11 }}>Add</span>
                    </button>
                  )}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: "none" }}
                    onChange={handleFiles}
                  />
                </div>
                <p style={styles.shotHint}>
                  Images are resized and compressed automatically before they
                  are sent.
                </p>

                <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                  <button
                    type="submit"
                    className="support-btn-primary"
                    style={styles.primaryBtn}
                    disabled={submitting}
                  >
                    {submitting ? "Sending…" : "Send ticket"}
                  </button>
                  <button
                    type="button"
                    className="support-btn"
                    style={styles.ghostBtn}
                    onClick={() => setComposing(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : selected ? (
              <div style={styles.ticketView}>
                <div style={styles.ticketHead}>
                  <div style={styles.ticketHeadRow}>
                    <span
                      style={{
                        ...styles.statusChipLarge,
                        color: statusOf(selected.status).color,
                        borderColor: statusOf(selected.status).color,
                      }}
                    >
                      {statusOf(selected.status).label}
                    </span>
                    <span
                      style={{
                        ...styles.statusChipLarge,
                        color: priorityOf(selected.priority).color,
                        borderColor: priorityOf(selected.priority).color,
                      }}
                    >
                      {priorityOf(selected.priority).label}
                    </span>
                    <span style={styles.ticketDate}>
                      filed {timeAgo(selected.createdAt)}
                    </span>
                  </div>
                  <h3 style={styles.ticketTitle}>{selected.title}</h3>
                </div>

                <div className="support-scroll" style={styles.ticketBody}>
                  {selected.status === "WAITING_ON_REPORTER" && (
                    <div style={styles.waitingBanner}>
                      Fedi is waiting on an answer from you — reply below to
                      unblock this ticket.
                    </div>
                  )}

                  <p style={styles.ticketDesc}>{selected.description}</p>

                  {selected.screenshots?.length > 0 && (
                    <div style={styles.shotRow}>
                      {selected.screenshots.map((src, i) => (
                        <img
                          key={i}
                          src={
                            src.startsWith("data:")
                              ? src
                              : `data:image/jpeg;base64,${src}`
                          }
                          alt={`Screenshot ${i + 1}`}
                          style={styles.viewShot}
                          onClick={() => {
                            const w = window.open();
                            if (w) {
                              w.document.write(
                                `<img src="${src.startsWith("data:") ? src : `data:image/jpeg;base64,${src}`}" style="max-width:100%">`,
                              );
                            }
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {selected.fixes?.length > 0 && (
                    <div style={styles.fixBlock}>
                      <div style={styles.fixHead}>Fixes shipped</div>
                      {selected.fixes.map((f) => (
                        <div key={f.id} style={styles.fixItem}>
                          <div style={{ fontWeight: 600 }}>{f.description}</div>
                          <div style={styles.fixMeta}>
                            {f.version && `v${f.version} · `}
                            {timeAgo(f.appliedAt)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={styles.threadHead}>Conversation</div>
                  {selected.comments?.length === 0 && (
                    <p style={styles.threadEmpty}>
                      No replies yet. Fedi will answer here.
                    </p>
                  )}
                  {selected.comments?.map((c) => (
                    <div
                      key={c.id}
                      style={{
                        ...styles.comment,
                        alignSelf: c.fromAdmin ? "flex-start" : "flex-end",
                        backgroundColor: c.fromAdmin
                          ? "var(--bg-elevated)"
                          : "var(--accent)",
                        color: c.fromAdmin
                          ? "var(--text-primary)"
                          : "var(--bg-primary)",
                      }}
                    >
                      <div style={styles.commentAuthor}>
                        {c.fromAdmin ? `${c.author || "Fedi"} · support` : c.author}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{c.text}</div>
                      <div style={styles.commentTime}>
                        {timeAgo(c.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>

                {selected.status !== "CLOSED" && (
                  <div style={styles.replyBox}>
                    <input
                      style={styles.replyInput}
                      className="support-reply"
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      placeholder="Reply to Fedi…"
                      onKeyPress={(e) => e.key === "Enter" && sendReply()}
                    />
                    <button
                      className="support-btn-primary"
                      style={styles.sendBtn}
                      onClick={sendReply}
                      disabled={replying || !reply.trim()}
                    >
                      <Send size={15} />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div style={styles.placeholder}>
                <LifeBuoy size={44} style={{ color: "var(--border-primary)" }} />
                <p style={styles.placeholderTitle}>Something broken?</p>
                <p style={styles.placeholderSub}>
                  Pick a ticket to see its progress, or report a new problem.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

const styles = {
  container: {
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--gradient-bg)",
    fontFamily: "var(--font-body, 'Hanken Grotesk', sans-serif)",
    overflow: "hidden",
  },
  accentLine: {
    height: 3,
    background:
      "linear-gradient(90deg, transparent, var(--accent), var(--accent-alt), var(--accent), transparent)",
    flexShrink: 0,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 28px",
    borderBottom: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-nav)",
    gap: 12,
    flexWrap: "wrap",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  title: {
    margin: 0,
    fontFamily: "'Fraunces', Georgia, serif",
    fontSize: 22,
    fontWeight: 500,
    color: "var(--text-primary)",
  },
  needsBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--warning)",
    border: "1px solid var(--warning)",
    borderRadius: 6,
    padding: "3px 9px",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    borderRadius: 8,
    border: "none",
    backgroundColor: "var(--accent)",
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
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  deskError: {
    margin: "12px 28px 0",
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--danger)",
    backgroundColor: "rgba(226,104,95,0.1)",
    color: "var(--danger)",
    fontSize: 13,
  },
  layout: { display: "flex", flex: "1 1 0%", minHeight: 0, overflow: "hidden" },
  list: {
    width: 330,
    minWidth: 280,
    borderRight: "1px solid var(--border-primary)",
    display: "flex",
    flexDirection: "column",
    backgroundColor: "var(--bg-secondary)",
  },
  listHeader: {
    padding: "14px 20px",
    borderBottom: "1px solid var(--border-primary)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: "var(--text-faint)",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  listScroll: { flex: 1, overflowY: "auto" },
  row: {
    padding: "12px 16px",
    borderBottom: "1px solid var(--border-primary)",
    cursor: "pointer",
    transition: "background 0.15s ease",
  },
  rowTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  statusChip: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  priorityDot: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
  rowTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1.35,
    marginBottom: 3,
  },
  rowMeta: {
    fontSize: 10.5,
    color: "var(--text-dim)",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  empty: {
    padding: "44px 20px",
    textAlign: "center",
    color: "var(--text-faint)",
    fontSize: 13,
    lineHeight: 1.6,
  },
  detail: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    background: "var(--gradient-msg)",
  },
  form: { padding: "24px 32px", overflowY: "auto" },
  formTitle: {
    margin: "0 0 4px",
    fontFamily: "'Fraunces', Georgia, serif",
    fontSize: 20,
    fontWeight: 500,
    color: "var(--text-primary)",
  },
  formHint: { margin: "0 0 20px", fontSize: 13, color: "var(--text-faint)" },
  formError: {
    padding: "9px 13px",
    borderRadius: 8,
    border: "1px solid var(--danger)",
    backgroundColor: "rgba(226,104,95,0.1)",
    color: "var(--danger)",
    fontSize: 13,
    marginBottom: 14,
  },
  label: {
    display: "block",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: "var(--text-dim)",
    margin: "16px 0 6px",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  input: {
    width: "100%",
    maxWidth: 620,
    padding: "10px 13px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-card)",
    color: "var(--text-primary)",
    fontSize: 13.5,
    fontFamily: "inherit",
    outline: "none",
  },
  priorityRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  priorityBtn: {
    padding: "6px 14px",
    borderRadius: 7,
    border: "1px solid var(--border-primary)",
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  shotRow: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  shotThumb: {
    position: "relative",
    width: 84,
    height: 84,
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid var(--border-primary)",
  },
  shotImg: { width: "100%", height: "100%", objectFit: "cover" },
  shotRemove: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 18,
    height: 18,
    borderRadius: "50%",
    border: "none",
    background: "rgba(0,0,0,0.65)",
    color: "#fff",
    cursor: "pointer",
    fontSize: 10,
    lineHeight: 1,
  },
  shotSize: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    fontSize: 9,
    textAlign: "center",
    padding: "1px 0",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  shotAdd: {
    width: 84,
    height: 84,
    borderRadius: 8,
    border: "1.5px dashed var(--border-secondary)",
    background: "transparent",
    color: "var(--text-faint)",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  shotHint: { fontSize: 11, color: "var(--text-dim)", margin: "8px 0 0" },
  ticketView: { display: "flex", flexDirection: "column", height: "100%" },
  ticketHead: {
    padding: "16px 28px",
    borderBottom: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-secondary)",
  },
  ticketHeadRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    flexWrap: "wrap",
  },
  statusChipLarge: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1,
    padding: "3px 10px",
    borderRadius: 5,
    border: "1px solid",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  ticketDate: {
    fontSize: 11,
    color: "var(--text-dim)",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  ticketTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1.3,
  },
  ticketBody: {
    flex: 1,
    overflowY: "auto",
    padding: "20px 28px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  waitingBanner: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--warning)",
    backgroundColor: "rgba(227,166,60,0.12)",
    color: "var(--warning)",
    fontSize: 13,
    fontWeight: 600,
  },
  ticketDesc: {
    margin: 0,
    whiteSpace: "pre-wrap",
    fontSize: 14,
    color: "var(--text-secondary)",
    lineHeight: 1.6,
  },
  viewShot: {
    width: 120,
    height: 120,
    objectFit: "cover",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    cursor: "pointer",
  },
  fixBlock: {
    border: "1px solid var(--success)",
    borderRadius: 10,
    padding: "12px 16px",
    backgroundColor: "rgba(95,191,138,0.08)",
  },
  fixHead: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    color: "var(--success)",
    marginBottom: 8,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  fixItem: { fontSize: 13, color: "var(--text-primary)", marginBottom: 6 },
  fixMeta: {
    fontSize: 11,
    color: "var(--text-dim)",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  threadHead: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    color: "var(--text-faint)",
    marginTop: 10,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  threadEmpty: { fontSize: 13, color: "var(--text-dim)", margin: 0 },
  comment: {
    maxWidth: "72%",
    padding: "10px 14px",
    borderRadius: 12,
    fontSize: 13.5,
    lineHeight: 1.5,
  },
  commentAuthor: {
    fontSize: 9.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    opacity: 0.7,
    marginBottom: 3,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  commentTime: {
    fontSize: 9.5,
    opacity: 0.6,
    marginTop: 5,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  replyBox: {
    display: "flex",
    gap: 10,
    padding: "14px 24px",
    borderTop: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-secondary)",
  },
  replyInput: {
    flex: 1,
    padding: "10px 16px",
    borderRadius: 10,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-card)",
    color: "var(--text-primary)",
    fontSize: 13.5,
    fontFamily: "inherit",
    outline: "none",
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 10,
    border: "none",
    backgroundColor: "var(--accent)",
    color: "var(--bg-primary)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  placeholder: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  placeholderTitle: {
    color: "var(--text-faint)",
    fontSize: 15,
    fontWeight: 600,
    margin: "12px 0 0",
  },
  placeholderSub: { color: "var(--text-dim)", fontSize: 12.5, margin: 0 },
};

export default Support;
