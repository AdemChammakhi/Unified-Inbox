import React, { useState } from "react";
import axios from "axios";
import { Download } from "lucide-react";
import { useAuth } from "../context/AuthContext";

/**
 * ProspectExport — download the prospect sheet the team used to maintain by
 * hand: one row per prospect with source (incl. the originating ad), phone,
 * first/last contact, classification stage, RDV date and assigned agent.
 *
 * Excel comes color-coded like the app (and like their old spreadsheet);
 * CSV is tuned for French Excel (UTF-8 BOM, semicolons).
 * Backend: GET /api/exports/prospects — admin & manager only.
 */
const ProspectExport = ({ range = 30, platform = "all" }) => {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);

  const download = async (format) => {
    setBusy(true);
    try {
      const res = await axios.get("/api/exports/prospects", {
        params: { format, platform, range },
        headers: { Authorization: `Bearer ${user?.token}` },
        responseType: "blob",
        timeout: 120000,
      });
      const disposition = res.headers["content-disposition"] || "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename =
        match?.[1] || `prospects-medtour.${format === "csv" ? "csv" : "xlsx"}`;
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(
        err.response?.status === 403
          ? "Export réservé aux administrateurs et managers."
          : "L'export a échoué — réessayez.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (user?.role !== "admin" && user?.role !== "manager") return null;

  return (
    <div style={styles.wrap}>
      <button
        className="support-btn"
        style={styles.btn}
        onClick={() => download("xlsx")}
        disabled={busy}
        title="Feuille prospects avec code couleur, comme votre tableau de suivi"
      >
        <Download size={13} /> {busy ? "Export…" : "Excel"}
      </button>
      <button
        className="support-btn"
        style={styles.btn}
        onClick={() => download("csv")}
        disabled={busy}
        title="CSV pour Excel français (séparateur ;)"
      >
        <Download size={13} /> CSV
      </button>
    </div>
  );
};

const styles = {
  wrap: { display: "inline-flex", gap: 6 },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    fontWeight: 600,
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
};

export default ProspectExport;
