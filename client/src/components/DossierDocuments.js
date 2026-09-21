import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { Download, Paperclip, Trash2, Upload } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import {
  DOC_TYPES,
  DOC_ACCEPT,
  DOC_MAX_BYTES,
  docTypeLabel,
} from "../constants/dossier";

/**
 * DossierDocuments — pièces jointes du dossier client.
 *
 * Lists the documents attached to one customer (invoice, passport copy,
 * quote…), lets an agent download or delete them, and add a new one.
 *
 * `customerId` must be the customer's own id (IGSID / PSID / phone / email),
 * never a t_… thread id — the server refuses those (CLAUDE.md §6).
 *
 * Downloads go through the authenticated route with the JWT in the
 * Authorization header (fetched as a blob), so the token never appears in a
 * URL or an access log.
 */

const errorText = (err, fallback) =>
  err?.response?.data?.message || fallback;

const formatSize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
  if (n >= 1024) return `${Math.round(n / 1024)} Ko`;
  return `${n} o`;
};

const formatDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const uploaderName = (u) =>
  u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || "Agent" : "Agent";

/**
 * Download through an authenticated request and hand the bytes to the
 * browser as a blob: the JWT travels in the Authorization header, never in a
 * URL that proxies and Nginx would write to their access logs. (The server
 * also accepts ?token= for plain links, but these are passport copies.)
 */
async function downloadDocument(doc, token) {
  const res = await axios.get(
    `/api/dossier-documents/${encodeURIComponent(doc.id)}/download`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: "blob" },
  );
  const url = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.originalName || "document";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const DossierDocuments = ({ platform, customerId, compact = false }) => {
  const { user } = useAuth();
  const token = user?.token;
  const canDeleteAny = user?.role === "admin" || user?.role === "manager";

  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [docType, setDocType] = useState("");
  const [label, setLabel] = useState("");
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [deletingId, setDeletingId] = useState(null);
  const fileRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const auth = useMemo(
    () => ({ headers: { Authorization: `Bearer ${token}` } }),
    [token],
  );

  const ready = Boolean(token && platform && customerId);

  const load = useCallback(async () => {
    if (!ready) {
      setDocuments([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await axios.get("/api/dossier-documents", {
        ...auth,
        params: { platform, customerId },
      });
      if (!mountedRef.current) return;
      setDocuments(res.data?.documents || []);
    } catch (err) {
      if (!mountedRef.current) return;
      setDocuments([]);
      setError(errorText(err, "Impossible de charger les documents."));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [ready, auth, platform, customerId]);

  // Reload and clear any half-filled form when the customer changes.
  useEffect(() => {
    setShowForm(false);
    setDocType("");
    setLabel("");
    setFile(null);
    setProgress(0);
    load();
  }, [load]);

  const resetForm = () => {
    setDocType("");
    setLabel("");
    setFile(null);
    setProgress(0);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleFileChange = (e) => {
    const picked = e.target.files?.[0] || null;
    setError("");
    if (picked && picked.size > DOC_MAX_BYTES) {
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setError("Fichier trop volumineux (15 Mo maximum).");
      return;
    }
    setFile(picked);
  };

  const canSubmit = ready && !uploading && Boolean(docType) && Boolean(file);

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setUploading(true);
    setProgress(0);
    setError("");
    const form = new FormData();
    form.append("platform", platform);
    form.append("customerId", customerId);
    form.append("docType", docType);
    form.append("label", label.trim());
    form.append("file", file);
    try {
      const res = await axios.post("/api/dossier-documents", form, {
        ...auth,
        onUploadProgress: (evt) => {
          if (!mountedRef.current) return;
          const total = evt.total || file.size || 0;
          if (total > 0) {
            setProgress(Math.min(100, Math.round((evt.loaded / total) * 100)));
          }
        },
      });
      if (!mountedRef.current) return;
      const created = res.data?.document;
      if (created) setDocuments((prev) => [created, ...prev]);
      resetForm();
      setShowForm(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorText(err, "Impossible d’enregistrer le document."));
    } finally {
      if (mountedRef.current) setUploading(false);
    }
  };

  const remove = async (doc) => {
    const name = doc.label || doc.originalName || docTypeLabel(doc.docType);
    if (!window.confirm(`Supprimer « ${name} » du dossier client ?`)) return;
    setDeletingId(doc.id);
    setError("");
    try {
      await axios.delete(
        `/api/dossier-documents/${encodeURIComponent(doc.id)}`,
        auth,
      );
      if (!mountedRef.current) return;
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorText(err, "Impossible de supprimer le document."));
    } finally {
      if (mountedRef.current) setDeletingId(null);
    }
  };

  const canDelete = (doc) =>
    canDeleteAny ||
    (doc.uploadedBy?.id && user?._id && doc.uploadedBy.id === String(user._id));

  const fontSize = compact ? 11 : 12;
  const iconSize = compact ? 13 : 15;

  return (
    <div style={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <div style={styles.header}>
        <span style={{ ...styles.title, fontSize: compact ? 12 : 13 }}>
          <Paperclip size={iconSize} style={{ marginRight: 5 }} />
          Pièces jointes du dossier
          {documents.length > 0 && (
            <span style={styles.count}>{documents.length}</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => {
            setError("");
            setShowForm((v) => !v);
          }}
          disabled={!ready || uploading}
          style={{
            ...styles.button,
            fontSize,
            padding: compact ? "3px 8px" : "5px 10px",
            opacity: !ready || uploading ? 0.5 : 1,
            cursor: !ready || uploading ? "default" : "pointer",
          }}
        >
          <Upload size={iconSize - 2} style={{ marginRight: 4 }} />
          {showForm ? "Annuler" : "Ajouter un document"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} style={styles.form}>
          <div style={styles.formRow}>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              disabled={uploading}
              required
              aria-label="Type de document"
              style={{
                ...styles.select,
                fontSize,
                padding: compact ? "3px 6px" : "5px 8px",
                color: docType ? "var(--text-primary)" : "var(--text-muted)",
              }}
            >
              <option value="" disabled>
                Type de document…
              </option>
              {DOC_TYPES.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={label}
              maxLength={120}
              placeholder="Libellé (facultatif)"
              aria-label="Libellé du document"
              disabled={uploading}
              onChange={(e) => setLabel(e.target.value)}
              style={{
                ...styles.input,
                fontSize,
                padding: compact ? "3px 6px" : "5px 8px",
              }}
            />
          </div>
          <div style={styles.formRow}>
            <input
              ref={fileRef}
              type="file"
              accept={DOC_ACCEPT}
              onChange={handleFileChange}
              disabled={uploading}
              aria-label="Fichier à joindre"
              style={{ ...styles.fileInput, fontSize }}
            />
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                ...styles.button,
                ...styles.primary,
                fontSize,
                padding: compact ? "3px 10px" : "5px 12px",
                opacity: canSubmit ? 1 : 0.5,
                cursor: canSubmit ? "pointer" : "default",
              }}
            >
              {uploading ? `Envoi… ${progress}%` : "Joindre"}
            </button>
          </div>
          {uploading && (
            <div style={styles.progressTrack} aria-hidden="true">
              <div style={{ ...styles.progressBar, width: `${progress}%` }} />
            </div>
          )}
          <div style={styles.hint}>
            Images, PDF, Word ou Excel · 15 Mo maximum
          </div>
        </form>
      )}

      {error && (
        <div role="alert" style={styles.error}>
          {error}
        </div>
      )}

      {loading && documents.length === 0 ? (
        <div style={{ ...styles.empty, fontSize }}>Chargement…</div>
      ) : documents.length === 0 ? (
        <div style={{ ...styles.empty, fontSize }}>Aucun document</div>
      ) : (
        <ul style={styles.list}>
          {documents.map((doc) => {
            const name = doc.label || doc.originalName || docTypeLabel(doc.docType);
            const deleting = deletingId === doc.id;
            return (
              <li key={doc.id} style={{ ...styles.item, fontSize }}>
                <span style={{ ...styles.badge, fontSize: fontSize - 1 }}>
                  {docTypeLabel(doc.docType)}
                </span>
                <span style={styles.meta}>
                  <span style={styles.name} title={doc.originalName || name}>
                    {name}
                  </span>
                  <span style={styles.sub}>
                    {formatSize(doc.size)} · {uploaderName(doc.uploadedBy)} ·{" "}
                    {formatDate(doc.createdAt)}
                  </span>
                </span>
                <span style={styles.actions}>
                  <button
                    type="button"
                    onClick={() =>
                      downloadDocument(doc, token).catch(() =>
                        setError("Téléchargement impossible."),
                      )
                    }
                    title="Télécharger"
                    aria-label={`Télécharger ${name}`}
                    style={{ ...styles.iconLink, cursor: "pointer", background: "none" }}
                  >
                    <Download size={iconSize} />
                  </button>
                  {canDelete(doc) && (
                    <button
                      type="button"
                      onClick={() => remove(doc)}
                      disabled={deleting}
                      title="Supprimer"
                      aria-label={`Supprimer ${name}`}
                      style={{
                        ...styles.iconButton,
                        opacity: deleting ? 0.5 : 1,
                        cursor: deleting ? "default" : "pointer",
                      }}
                    >
                      <Trash2 size={iconSize} />
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const styles = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minWidth: 0,
    maxWidth: "100%",
    padding: 10,
    border: "1px solid var(--border-primary)",
    borderRadius: 8,
    backgroundColor: "var(--bg-elevated)",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 6,
  },
  title: {
    display: "inline-flex",
    alignItems: "center",
    fontWeight: 700,
    color: "var(--text-primary)",
  },
  count: {
    marginLeft: 6,
    padding: "0 6px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    color: "var(--accent)",
    backgroundColor: "var(--accent-bg)",
    border: "1px solid var(--accent-border)",
  },
  button: {
    display: "inline-flex",
    alignItems: "center",
    border: "1px solid var(--border-primary)",
    borderRadius: 6,
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    fontWeight: 600,
    whiteSpace: "nowrap",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  primary: {
    border: "1px solid var(--accent-border)",
    backgroundColor: "var(--accent-bg)",
    color: "var(--accent)",
    fontWeight: 700,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 8,
    border: "1px dashed var(--border-primary)",
    borderRadius: 6,
  },
  formRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  select: {
    flex: "1 1 160px",
    minWidth: 0,
    border: "1px solid var(--border-secondary)",
    borderRadius: 6,
    backgroundColor: "var(--bg-secondary)",
    fontWeight: 600,
    outline: "none",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  input: {
    flex: "2 1 160px",
    minWidth: 0,
    border: "1px solid var(--border-secondary)",
    borderRadius: 6,
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    outline: "none",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  fileInput: {
    flex: "1 1 200px",
    minWidth: 0,
    color: "var(--text-primary)",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "var(--border-primary)",
    overflow: "hidden",
  },
  progressBar: {
    height: "100%",
    backgroundColor: "var(--accent)",
    transition: "width 0.2s ease",
  },
  hint: {
    fontSize: 11,
    color: "var(--text-muted)",
  },
  error: {
    fontSize: 11,
    color: "var(--danger)",
  },
  empty: {
    color: "var(--text-muted)",
    fontStyle: "italic",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
    padding: "6px 8px",
    borderRadius: 6,
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-secondary)",
  },
  badge: {
    flex: "0 0 auto",
    padding: "1px 6px",
    borderRadius: 4,
    fontWeight: 700,
    color: "var(--accent)",
    backgroundColor: "var(--accent-bg)",
    border: "1px solid var(--accent-border)",
    whiteSpace: "nowrap",
  },
  meta: {
    flex: "1 1 auto",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  name: {
    fontWeight: 600,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sub: {
    fontSize: 11,
    color: "var(--text-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  actions: {
    flex: "0 0 auto",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
  },
  iconLink: {
    display: "inline-flex",
    alignItems: "center",
    padding: 4,
    borderRadius: 6,
    color: "var(--accent)",
    textDecoration: "none",
  },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    padding: 4,
    border: "none",
    borderRadius: 6,
    background: "transparent",
    color: "var(--danger)",
  },
};

export default DossierDocuments;
