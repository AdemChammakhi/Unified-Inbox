import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "../components/DashboardLayout";
import { useAuth } from "../context/AuthContext";
import {
  Plus,
  RefreshCw,
  Pencil,
  Power,
  Download,
  Upload,
  Phone,
  MapPin,
  Search,
} from "lucide-react";

/**
 * Partners — the directory of MEDTOUR agencies and B2B partner agencies.
 *
 * Preloaded from management's spreadsheet at server startup, then maintained
 * here: any role can consult and filter it (agents use it to orient a
 * customer to the nearest office); admins and managers add, edit, deactivate,
 * and import a new spreadsheet in the same layout.
 */

const KINDS = [
  { key: "agence", label: "Agence MEDTOUR", color: "#E8833A" },
  { key: "partenaire", label: "Partenaire BtoB", color: "#5B9BD9" },
];
const kindMeta = (k) => KINDS.find((x) => x.key === k) || KINDS[1];

const EMPTY = {
  kind: "partenaire",
  name: "",
  contactName: "",
  phones: "",
  city: "",
  governorate: "",
  address: "",
  notes: "",
};

const toForm = (p) => ({
  kind: p.kind,
  name: p.name || "",
  contactName: p.contactName || "",
  phones: (p.phones || []).join(" / "),
  city: p.city || "",
  governorate: p.governorate || "",
  address: p.address || "",
  notes: p.notes || "",
});

const Partners = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const canEdit = user?.role === "admin" || user?.role === "manager";
  const fileRef = useRef(null);

  const [partners, setPartners] = useState([]);
  const [governorates, setGovernorates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);

  const [kind, setKind] = useState("");
  const [gov, setGov] = useState("");
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null); // null = closed, "new" = create
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  const auth = useMemo(
    () => ({ headers: { Authorization: `Bearer ${user?.token}` } }),
    [user?.token],
  );

  const load = useCallback(async () => {
    if (!user?.token) return;
    setLoading(true);
    try {
      const res = await axios.get("/api/partners", {
        ...auth,
        params: {
          kind: kind || undefined,
          governorate: gov || undefined,
          q: q || undefined,
          includeInactive: showInactive ? "1" : undefined,
        },
      });
      setPartners(res.data.partners || []);
      setGovernorates(res.data.governorates || []);
    } catch (err) {
      if (err.response?.status === 401) {
        logout();
        navigate("/login");
        return;
      }
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Impossible de charger la liste.",
      });
    } finally {
      setLoading(false);
    }
  }, [user?.token, auth, kind, gov, q, showInactive, logout, navigate]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const openCreate = () => {
    setForm(EMPTY);
    setEditingId("new");
    setNotice(null);
  };
  const openEdit = (p) => {
    setForm(toForm(p));
    setEditingId(p._id);
    setNotice(null);
  };
  const close = () => setEditingId(null);

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setNotice({ type: "error", text: "Le nom est obligatoire." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      if (editingId === "new") {
        await axios.post("/api/partners", form, auth);
        setNotice({ type: "ok", text: `« ${form.name.trim()} » ajouté(e) à la liste.` });
      } else {
        await axios.put(`/api/partners/${editingId}`, form, auth);
        setNotice({ type: "ok", text: "Fiche mise à jour." });
      }
      setEditingId(null);
      load();
    } catch (err) {
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Enregistrement impossible.",
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (p) => {
    setNotice(null);
    try {
      if (p.isActive) {
        if (!window.confirm(`Désactiver « ${p.name} » ? La fiche reste consultable via « Afficher les fiches désactivées ».`)) return;
        await axios.delete(`/api/partners/${p._id}`, auth);
        setNotice({ type: "ok", text: `« ${p.name} » désactivé(e).` });
      } else {
        await axios.put(`/api/partners/${p._id}`, { isActive: true }, auth);
        setNotice({ type: "ok", text: `« ${p.name} » réactivé(e).` });
      }
      load();
    } catch (err) {
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Action impossible.",
      });
    }
  };

  const importFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await axios.post("/api/partners/import", fd, auth);
      const { inserted, updated, skipped, errors = [] } = res.data;
      setNotice({
        type: errors.length ? "error" : "ok",
        text:
          `Import terminé : ${inserted} ajoutée(s), ${updated} mise(s) à jour, ${skipped} ignorée(s).` +
          (errors.length ? " " + errors.join(" · ") : ""),
      });
      load();
    } catch (err) {
      setNotice({
        type: "error",
        text: err.response?.data?.message || "Import impossible.",
      });
    } finally {
      setImporting(false);
    }
  };

  const exportXlsx = async () => {
    try {
      const res = await axios.get("/api/partners/export", { ...auth, responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = "agences-partenaires-medtour.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setNotice({ type: "error", text: "Export impossible." });
    }
  };

  // Group by gouvernorat for reading; the server already sorts the rows.
  const groups = useMemo(() => {
    const map = new Map();
    for (const p of partners) {
      const key = p.governorate || "Gouvernorat non renseigné";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    return [...map.entries()];
  }, [partners]);

  const counts = useMemo(
    () => ({
      agence: partners.filter((p) => p.kind === "agence" && p.isActive).length,
      partenaire: partners.filter((p) => p.kind === "partenaire" && p.isActive).length,
    }),
    [partners],
  );

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <DashboardLayout>
      <div style={styles.head}>
        <div>
          <h1 style={styles.title}>Agences & partenaires</h1>
          <p style={styles.sub}>
            {counts.agence} agence{counts.agence > 1 ? "s" : ""} MEDTOUR ·{" "}
            {counts.partenaire} partenaire{counts.partenaire > 1 ? "s" : ""} BtoB
            {gov ? ` · ${gov}` : " · toute la Tunisie"}
          </p>
        </div>
        <div style={styles.headRight}>
          <button className="inbox-tab-btn" style={styles.ghostBtn} onClick={load} title="Actualiser">
            <RefreshCw size={15} />
          </button>
          <button className="inbox-tab-btn" style={styles.ghostBtn} onClick={exportXlsx} title="Télécharger la liste (.xlsx)">
            <Download size={15} /> Excel
          </button>
          {canEdit && (
            <>
              <input ref={fileRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={importFile} />
              <button
                className="inbox-tab-btn"
                style={styles.ghostBtn}
                onClick={() => fileRef.current?.click()}
                disabled={importing}
                title="Importer un fichier .xlsx au même format que la liste"
              >
                <Upload size={15} /> {importing ? "Import…" : "Importer"}
              </button>
              <button className="inbox-send-action" style={styles.primaryBtn} onClick={openCreate}>
                <Plus size={15} /> Ajouter
              </button>
            </>
          )}
        </div>
      </div>

      {notice && (
        <div style={notice.type === "ok" ? styles.ok : styles.err} role="status">
          {notice.text}
        </div>
      )}

      <div style={styles.filters}>
        <div style={styles.searchWrap}>
          <Search size={14} style={{ color: "var(--text-faint)" }} />
          <input
            style={styles.search}
            placeholder="Rechercher une agence, un responsable, une ville, un numéro…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select style={styles.select} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Tous les types</option>
          {KINDS.map((k) => (
            <option key={k.key} value={k.key}>{k.label}</option>
          ))}
        </select>
        <select style={styles.select} value={gov} onChange={(e) => setGov(e.target.value)}>
          <option value="">Tous les gouvernorats</option>
          {governorates.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        {canEdit && (
          <label style={styles.check}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Afficher les fiches désactivées
          </label>
        )}
      </div>

      {editingId && canEdit && (
        <form onSubmit={save} style={styles.card}>
          <div style={styles.cardTitle}>
            {editingId === "new" ? "Nouvelle fiche" : "Modifier la fiche"}
          </div>
          <div style={styles.formGrid}>
            <label style={styles.field}>
              <span style={styles.label}>Type</span>
              <select style={styles.input} value={form.kind} onChange={set("kind")}>
                {KINDS.map((k) => (
                  <option key={k.key} value={k.key}>{k.label}</option>
                ))}
              </select>
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Nom de l'agence *</span>
              <input style={styles.input} value={form.name} onChange={set("name")} required maxLength={120} />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Responsable / contact</span>
              <input style={styles.input} value={form.contactName} onChange={set("contactName")} maxLength={120} />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Téléphone(s)</span>
              <input style={styles.input} value={form.phones} onChange={set("phones")} placeholder="98 407 489 / 71 481 042" />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Ville</span>
              <input style={styles.input} value={form.city} onChange={set("city")} maxLength={80} />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>Gouvernorat</span>
              <input style={styles.input} value={form.governorate} onChange={set("governorate")} list="gov-list" maxLength={60} />
              <datalist id="gov-list">
                {governorates.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </label>
            <label style={{ ...styles.field, gridColumn: "1 / -1" }}>
              <span style={styles.label}>Adresse</span>
              <input style={styles.input} value={form.address} onChange={set("address")} maxLength={300} />
            </label>
            <label style={{ ...styles.field, gridColumn: "1 / -1" }}>
              <span style={styles.label}>Notes internes</span>
              <input style={styles.input} value={form.notes} onChange={set("notes")} maxLength={1000} />
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

      {loading && partners.length === 0 ? (
        <p style={styles.muted}>Chargement…</p>
      ) : partners.length === 0 ? (
        <p style={styles.muted}>Aucune fiche ne correspond à ces filtres.</p>
      ) : (
        groups.map(([g, rows]) => (
          <section key={g} style={styles.group}>
            <h2 style={styles.groupTitle}>
              <MapPin size={14} /> {g}
              <span style={styles.groupCount}>{rows.length}</span>
            </h2>
            <div style={styles.grid}>
              {rows.map((p) => {
                const km = kindMeta(p.kind);
                return (
                  <article
                    key={p._id}
                    style={{ ...styles.item, opacity: p.isActive ? 1 : 0.55 }}
                  >
                    <div style={styles.itemHead}>
                      <span style={{ ...styles.kindChip, color: km.color, borderColor: km.color + "66", background: km.color + "1a" }}>
                        {km.label}
                      </span>
                      {!p.isActive && <span style={styles.offTag}>désactivée</span>}
                      {canEdit && (
                        <span style={styles.actions}>
                          <button className="inbox-tab-btn" style={styles.iconBtn} title="Modifier" onClick={() => openEdit(p)}>
                            <Pencil size={13} />
                          </button>
                          <button className="inbox-tab-btn" style={styles.iconBtn} title={p.isActive ? "Désactiver" : "Réactiver"} onClick={() => toggleActive(p)}>
                            <Power size={13} />
                          </button>
                        </span>
                      )}
                    </div>
                    <div style={styles.name}>{p.name}</div>
                    {p.contactName && <div style={styles.contact}>{p.contactName}</div>}
                    <div style={styles.meta}>
                      {p.city}
                      {p.address ? ` · ${p.address}` : ""}
                    </div>
                    {p.phones?.length > 0 ? (
                      <div style={styles.phones}>
                        {p.phones.map((ph) => (
                          <a key={ph} href={`tel:${ph.startsWith("+") ? ph : "+216" + ph}`} style={styles.phone}>
                            <Phone size={12} /> {ph.replace(/(\d{2})(?=\d)/g, "$1 ").trim()}
                          </a>
                        ))}
                      </div>
                    ) : (
                      <div style={styles.noPhone}>Numéro non renseigné</div>
                    )}
                    {p.notes && <div style={styles.notes}>{p.notes}</div>}
                  </article>
                );
              })}
            </div>
          </section>
        ))
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
  card: { background: "var(--bg-card)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: 18, marginBottom: 20 },
  cardTitle: { fontWeight: 600, fontSize: 14, color: "var(--text-primary)", marginBottom: 12 },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-faint)" },
  input: { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 13 },
  formActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 },
  muted: { color: "var(--text-muted)", fontSize: 13 },
  group: { marginBottom: 22 },
  groupTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--text-secondary)", margin: "0 0 10px" },
  groupCount: { marginLeft: 6, fontSize: 11, padding: "1px 7px", borderRadius: 10, background: "var(--bg-elevated)", color: "var(--text-faint)", border: "1px solid var(--border-primary)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 },
  item: { background: "var(--bg-card)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 5 },
  itemHead: { display: "flex", alignItems: "center", gap: 6 },
  kindChip: { fontSize: 10, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 4, border: "1px solid" },
  offTag: { fontSize: 10, color: "var(--text-faint)", border: "1px solid var(--border-primary)", borderRadius: 4, padding: "2px 6px" },
  actions: { marginLeft: "auto", display: "flex", gap: 4 },
  iconBtn: { padding: 5, borderRadius: 6, border: "1px solid var(--border-primary)", background: "var(--bg-elevated)", color: "var(--text-muted)", cursor: "pointer", display: "inline-flex" },
  name: { fontWeight: 600, fontSize: 14, color: "var(--text-primary)", marginTop: 4 },
  contact: { fontSize: 13, color: "var(--text-secondary)" },
  meta: { fontSize: 12, color: "var(--text-muted)" },
  phones: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 },
  phone: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, padding: "3px 8px", borderRadius: 6, background: "var(--accent-bg)", border: "1px solid var(--accent-border)", color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-data)" },
  noPhone: { fontSize: 12, color: "var(--text-faint)", fontStyle: "italic" },
  notes: { fontSize: 12, color: "var(--text-faint)", marginTop: 2 },
};

export default Partners;
