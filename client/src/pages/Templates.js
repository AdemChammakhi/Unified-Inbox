import React, { useState, useEffect, useCallback, useMemo } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";
import { Plus, RefreshCw, Pencil, Power, Search, Copy, Trash2 } from "lucide-react";
import {
  PLACEHOLDERS,
  PLATFORM_OPTIONS,
  TEMPLATE_MAX,
  fillTemplate,
  copyText,
} from "../constants/templates";

/**
 * Templates — the library of canned replies ("modèles de messages").
 *
 * Every role can consult and copy; admins and managers create, edit,
 * deactivate and delete. Agents normally use them from the inbox, where the
 * same list sits next to the discussion and inserts straight into the
 * composer.
 */

const EMPTY = { title: "", category: "", body: "", platforms: [], sortOrder: 0 };

const toForm = (t) => ({
  title: t.title || "",
  category: t.category || "",
  body: t.body || "",
  platforms: t.platforms || [],
  sortOrder: t.sortOrder || 0,
});

const platformLabel = (k) => PLATFORM_OPTIONS.find((p) => p.key === k)?.label || k;

const Templates = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const canEdit = user?.role === "admin" || user?.role === "manager";

  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);

  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null); // null = closed, "new" = create
  const [saving, setSaving] = useState(false);

  const auth = useMemo(
    () => ({ headers: { Authorization: `Bearer ${user?.token}` } }),
    [user?.token],
  );

  const load = useCallback(async () => {
    if (!user?.token) return;
    setLoading(true);
    try {
      const res = await axios.get("/api/message-templates", {
        ...auth,
        params: { q: q || undefined, includeInactive: showInactive ? "1" : undefined },
      });
      setTemplates(res.data.templates || []);
      setCategories(res.data.categories || []);
    } catch (err) {
      if (err.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Impossible de charger les modèles.",
      });
    } finally {
      setLoading(false);
    }
  }, [user?.token, auth, q, showInactive, logout, navigate]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const visible = useMemo(
    () => (category ? templates.filter((t) => t.category === category) : templates),
    [templates, category],
  );

  const openCreate = () => {
    setForm(EMPTY);
    setEditingId("new");
    setNotice(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const openEdit = (t) => {
    setForm(toForm(t));
    setEditingId(t._id);
    setNotice(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const close = () => setEditingId(null);

  const save = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return setNotice({ type: "error", text: "Le titre est obligatoire." });
    if (!form.body.trim()) return setNotice({ type: "error", text: "Le message est obligatoire." });
    setSaving(true);
    setNotice(null);
    try {
      if (editingId === "new") {
        await axios.post("/api/message-templates", form, auth);
        setNotice({ type: "ok", text: `« ${form.title.trim()} » ajouté aux modèles.` });
      } else {
        await axios.put(`/api/message-templates/${editingId}`, form, auth);
        setNotice({ type: "ok", text: "Modèle mis à jour." });
      }
      setEditingId(null);
      load();
    } catch (err) {
      setNotice({ type: "error", text: err.response?.data?.message || "Enregistrement impossible." });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (t) => {
    setNotice(null);
    try {
      if (t.isActive) {
        await axios.delete(`/api/message-templates/${t._id}`, auth);
        setNotice({ type: "ok", text: `« ${t.title} » désactivé : il n'apparaît plus dans l'inbox.` });
      } else {
        await axios.put(`/api/message-templates/${t._id}`, { isActive: true }, auth);
        setNotice({ type: "ok", text: `« ${t.title} » réactivé.` });
      }
      load();
    } catch (err) {
      setNotice({ type: "error", text: err.response?.data?.message || "Action impossible." });
    }
  };

  const remove = async (t) => {
    if (!window.confirm(`Supprimer définitivement « ${t.title} » ?`)) return;
    setNotice(null);
    try {
      await axios.delete(`/api/message-templates/${t._id}?hard=1`, auth);
      setNotice({ type: "ok", text: `« ${t.title} » supprimé.` });
      load();
    } catch (err) {
      setNotice({ type: "error", text: err.response?.data?.message || "Suppression impossible." });
    }
  };

  const copy = async (t) => {
    const agentName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
    const ok = await copyText(fillTemplate(t.body, { agentName }));
    setNotice({ type: ok ? "ok" : "error", text: ok ? `« ${t.title} » copié.` : "Copie impossible." });
    if (ok) axios.post(`/api/message-templates/${t._id}/use`, null, auth).catch(() => {});
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const togglePlatform = (key) =>
    setForm((f) => ({
      ...f,
      platforms: f.platforms.includes(key)
        ? f.platforms.filter((p) => p !== key)
        : [...f.platforms, key],
    }));
  const insertPlaceholder = (token) =>
    setForm((f) => ({ ...f, body: f.body + (f.body && !/\s$/.test(f.body) ? " " : "") + token }));

  const activeCount = templates.filter((t) => t.isActive).length;

  return (
    <DashboardLayout>
      <div style={styles.head}>
        <div>
          <h1 style={styles.title}>Modèles de messages</h1>
          <p style={styles.sub}>
            {activeCount} modèle{activeCount > 1 ? "s" : ""} actif{activeCount > 1 ? "s" : ""} ·
            réponses prêtes à insérer depuis l'inbox, à côté de la discussion
          </p>
        </div>
        <div style={styles.headRight}>
          <button className="inbox-tab-btn" style={styles.ghostBtn} onClick={load} title="Actualiser">
            <RefreshCw size={15} />
          </button>
          {canEdit && (
            <button className="inbox-send-action" style={styles.primaryBtn} onClick={openCreate}>
              <Plus size={15} /> Nouveau modèle
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div style={notice.type === "ok" ? styles.ok : styles.err} role="status">
          {notice.text}
        </div>
      )}

      {editingId && canEdit && (
        <form onSubmit={save} style={styles.card}>
          <div style={styles.cardTitle}>
            {editingId === "new" ? "Nouveau modèle" : "Modifier le modèle"}
          </div>
          <div style={styles.formGrid}>
            <label style={styles.field}>
              <span style={styles.label}>Titre du cas *</span>
              <input
                style={styles.input}
                value={form.title}
                onChange={set("title")}
                required
                maxLength={TEMPLATE_MAX.title}
                placeholder="ex. Demande de devis Omra"
              />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Catégorie</span>
              <input
                style={styles.input}
                value={form.category}
                onChange={set("category")}
                list="tpl-cat-list"
                maxLength={TEMPLATE_MAX.category}
                placeholder="ex. Omra, Visa, Relance…"
              />
              <datalist id="tpl-cat-list">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Ordre d'affichage</span>
              <input
                type="number"
                style={styles.input}
                value={form.sortOrder}
                onChange={set("sortOrder")}
                min={-9999}
                max={9999}
              />
            </label>
            <div style={styles.field}>
              <span style={styles.label}>Plateformes (aucune = toutes)</span>
              <div style={styles.checkRow}>
                {PLATFORM_OPTIONS.map((p) => (
                  <label key={p.key} style={styles.check}>
                    <input
                      type="checkbox"
                      checked={form.platforms.includes(p.key)}
                      onChange={() => togglePlatform(p.key)}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>
            <label style={{ ...styles.field, gridColumn: "1 / -1" }}>
              <span style={styles.label}>Message complet *</span>
              <textarea
                style={styles.textarea}
                value={form.body}
                onChange={set("body")}
                required
                rows={7}
                maxLength={TEMPLATE_MAX.body}
                placeholder={"Bonjour {{prenom}},\nMerci pour votre message…"}
              />
              <span style={styles.hintRow}>
                <span style={styles.hint}>
                  {form.body.length}/{TEMPLATE_MAX.body} · variables :
                </span>
                {PLACEHOLDERS.map((p) => (
                  <button
                    key={p.token}
                    type="button"
                    style={styles.tokenBtn}
                    title={p.label}
                    onClick={() => insertPlaceholder(p.token)}
                  >
                    {p.token}
                  </button>
                ))}
              </span>
            </label>
          </div>
          <div style={styles.formActions}>
            <button type="button" className="inbox-tab-btn" style={styles.ghostBtn} onClick={close}>
              Annuler
            </button>
            <button type="submit" className="inbox-send-action" style={styles.primaryBtn} disabled={saving}>
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
          </div>
        </form>
      )}

      <div style={styles.filters}>
        <div style={styles.searchWrap}>
          <Search size={14} style={{ color: "var(--text-faint)" }} />
          <input
            style={styles.search}
            placeholder="Rechercher un titre, une catégorie, un mot du message…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select style={styles.select} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Toutes les catégories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        {canEdit && (
          <label style={styles.check}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Afficher les modèles désactivés
          </label>
        )}
      </div>

      {loading && templates.length === 0 ? (
        <p style={styles.muted}>Chargement…</p>
      ) : visible.length === 0 ? (
        <p style={styles.muted}>
          {templates.length === 0
            ? canEdit
              ? "Aucun modèle pour l'instant — créez le premier avec « Nouveau modèle »."
              : "Aucun modèle pour l'instant."
            : "Aucun modèle ne correspond à ces filtres."}
        </p>
      ) : (
        <div style={styles.grid}>
          {visible.map((t) => (
            <article key={t._id} style={{ ...styles.item, opacity: t.isActive ? 1 : 0.55 }}>
              <div style={styles.itemHead}>
                {t.category && <span style={styles.catChip}>{t.category}</span>}
                {t.platforms?.length > 0 && (
                  <span style={styles.platforms}>{t.platforms.map(platformLabel).join(" · ")}</span>
                )}
                {!t.isActive && <span style={styles.offTag}>désactivé</span>}
                <span style={styles.actions}>
                  <button className="inbox-tab-btn" style={styles.iconBtn} title="Copier le message" onClick={() => copy(t)}>
                    <Copy size={13} />
                  </button>
                  {canEdit && (
                    <>
                      <button className="inbox-tab-btn" style={styles.iconBtn} title="Modifier" onClick={() => openEdit(t)}>
                        <Pencil size={13} />
                      </button>
                      <button className="inbox-tab-btn" style={styles.iconBtn} title={t.isActive ? "Désactiver" : "Réactiver"} onClick={() => toggleActive(t)}>
                        <Power size={13} />
                      </button>
                      {!t.isActive && (
                        <button className="inbox-tab-btn" style={styles.iconBtn} title="Supprimer définitivement" onClick={() => remove(t)}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>
              <div style={styles.name}>{t.title}</div>
              <div style={styles.body}>{t.body}</div>
              <div style={styles.meta}>
                {t.usageCount > 0
                  ? `Utilisé ${t.usageCount} fois`
                  : "Jamais utilisé"}
              </div>
            </article>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
};

const styles = {
  head: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 14 },
  title: { margin: 0, fontFamily: "var(--font-display)", fontSize: 26, color: "var(--text-primary)" },
  sub: { margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" },
  headRight: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  ghostBtn: { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, fontSize: 13, cursor: "pointer", border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)" },
  primaryBtn: { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer", border: "none", background: "var(--accent)", color: "var(--bg-primary)", fontWeight: 600 },
  ok: { padding: "10px 14px", borderRadius: 8, marginBottom: 12, fontSize: 13, background: "rgba(95,191,138,.12)", color: "var(--success)", border: "1px solid rgba(95,191,138,.35)" },
  err: { padding: "10px 14px", borderRadius: 8, marginBottom: 12, fontSize: 13, background: "rgba(226,104,95,.12)", color: "var(--danger)", border: "1px solid rgba(226,104,95,.35)" },
  filters: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 18 },
  searchWrap: { display: "flex", alignItems: "center", gap: 8, flex: "1 1 320px", padding: "0 12px", borderRadius: 8, border: "1px solid var(--border-primary)", background: "var(--bg-elevated)" },
  search: { flex: 1, padding: "8px 0", border: "none", background: "transparent", color: "var(--text-primary)", fontSize: 13, outline: "none" },
  select: { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 13 },
  check: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" },
  checkRow: { display: "flex", flexWrap: "wrap", gap: 12, padding: "8px 0" },
  card: { background: "var(--bg-card)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: 18, marginBottom: 20 },
  cardTitle: { fontWeight: 600, fontSize: 14, color: "var(--text-primary)", marginBottom: 12 },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-faint)" },
  input: { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 13 },
  textarea: { padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 13, lineHeight: 1.5, fontFamily: "inherit", resize: "vertical" },
  hintRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 2 },
  hint: { fontSize: 11, color: "var(--text-faint)" },
  tokenBtn: { fontSize: 11, padding: "2px 7px", borderRadius: 6, border: "1px dashed var(--border-primary)", background: "transparent", color: "var(--accent)", cursor: "pointer", fontFamily: "monospace" },
  formActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 },
  muted: { color: "var(--text-muted)", fontSize: 13 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 },
  item: { background: "var(--bg-card)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 6 },
  itemHead: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  catChip: { fontSize: 10, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 4, border: "1px solid var(--accent)", color: "var(--accent)", background: "var(--accent-glow)" },
  platforms: { fontSize: 10, color: "var(--text-faint)" },
  offTag: { fontSize: 10, color: "var(--text-faint)", border: "1px solid var(--border-primary)", borderRadius: 4, padding: "2px 6px" },
  actions: { marginLeft: "auto", display: "flex", gap: 4 },
  iconBtn: { padding: 5, borderRadius: 6, border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-muted)", cursor: "pointer", display: "inline-flex" },
  name: { fontWeight: 600, fontSize: 14, color: "var(--text-primary)", marginTop: 2 },
  body: { fontSize: 12.5, lineHeight: 1.5, color: "var(--text-secondary)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  meta: { fontSize: 11, color: "var(--text-faint)", marginTop: "auto", paddingTop: 4 },
};

export default Templates;
