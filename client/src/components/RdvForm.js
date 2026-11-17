import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { CalendarDays, MapPin, Building2, UserRound } from "lucide-react";
import { useAuth } from "../context/AuthContext";

/**
 * RdvForm — booking or changing an appointment: when, where (gouvernorat),
 * at which agency (an entry of the partners directory) and with which agent
 * (free text). One save for the four, through PUT /api/classifications.
 *
 * Used by the inbox RDV bar and by the dossier panel, so both always offer
 * the same fields.
 *
 * Props:
 *   dossier   the stored values { appointmentAt, appointmentPlace,
 *             appointmentAgencyId, appointmentAgencyName, appointmentAgent }
 *   onSave    (patch) => Promise
 *   onCancel  () => void, optional — shows "Annuler"
 *   canEdit   boolean
 */

const RDV_COLOR = "#A98BD6";
const AGENT_MAX = 120;
const DIRECTORY_TTL_MS = 5 * 60 * 1000;

// One directory fetch shared by every form on the page
let _directory = null; // { at, promise }
const loadDirectory = (token) => {
  if (_directory && Date.now() - _directory.at < DIRECTORY_TTL_MS) {
    return _directory.promise;
  }
  const promise = axios
    .get("/api/partners", { headers: { Authorization: `Bearer ${token}` } })
    .then((res) => ({
      partners: res.data?.partners || [],
      governorates: res.data?.governorates || [],
    }))
    .catch((err) => {
      _directory = null;
      throw err;
    });
  _directory = { at: Date.now(), promise };
  return promise;
};

const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The next full hour: a starting point, never a date in the past. */
const nextHour = () => {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return toLocalInput(d);
};

const same = (a, b) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

const KIND_LABEL = { agence: "Agences MEDTOUR", partenaire: "Partenaires BtoB" };

const agencyLabel = (p) =>
  p.city && !p.name.toLowerCase().includes(p.city.toLowerCase())
    ? `${p.name} — ${p.city}`
    : p.name;

const RdvForm = ({ dossier, onSave, onCancel, canEdit = true }) => {
  const { user } = useAuth();
  const d = dossier || {};
  const savedDate = toLocalInput(d.appointmentAt);

  const [date, setDate] = useState(savedDate || nextHour());
  const [place, setPlace] = useState(d.appointmentPlace || "");
  const [agencyId, setAgencyId] = useState(d.appointmentAgencyId || "");
  const [agent, setAgent] = useState(d.appointmentAgent || "");
  const [directory, setDirectory] = useState({ partners: [], governorates: [] });
  const [directoryError, setDirectoryError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Follow the stored appointment when it changes (save, another agent)
  useEffect(() => {
    setDate(savedDate || nextHour());
    setPlace(d.appointmentPlace || "");
    setAgencyId(d.appointmentAgencyId || "");
    setAgent(d.appointmentAgent || "");
  }, [savedDate, d.appointmentPlace, d.appointmentAgencyId, d.appointmentAgent]);

  useEffect(() => {
    if (!user?.token) return;
    loadDirectory(user.token)
      .then((dir) => mountedRef.current && setDirectory(dir))
      .catch(
        () =>
          mountedRef.current &&
          setDirectoryError("Annuaire des agences indisponible."),
      );
  }, [user?.token]);

  // Agencies of the chosen place, MEDTOUR agencies first
  const agencies = useMemo(() => {
    const list = directory.partners.filter(
      (p) => !place || same(p.governorate, place),
    );
    return {
      agence: list.filter((p) => p.kind === "agence"),
      partenaire: list.filter((p) => p.kind === "partenaire"),
    };
  }, [directory.partners, place]);

  // A stored agency that left the directory still has to show in the select
  const knownAgency = directory.partners.some((p) => p._id === agencyId);
  const places = useMemo(() => {
    const all = [...directory.governorates];
    if (place && !all.some((g) => same(g, place))) all.unshift(place);
    return all;
  }, [directory.governorates, place]);

  const choosePlace = (value) => {
    setPlace(value);
    // Keep the agency only when it belongs to the new place
    const current = directory.partners.find((p) => p._id === agencyId);
    if (current && value && !same(current.governorate, value)) setAgencyId("");
  };

  const chooseAgency = (value) => {
    setAgencyId(value);
    const chosen = directory.partners.find((p) => p._id === value);
    if (chosen?.governorate) setPlace(chosen.governorate);
  };

  const dirty =
    date !== savedDate ||
    !same(place, d.appointmentPlace) ||
    agencyId !== (d.appointmentAgencyId || "") ||
    agent.trim() !== (d.appointmentAgent || "");

  const run = async (patch) => {
    if (saving || !canEdit || typeof onSave !== "function") return;
    setSaving(true);
    setError("");
    try {
      await onSave(patch);
    } catch (err) {
      if (mountedRef.current) {
        setError(
          err?.response?.data?.message ||
            "Impossible d’enregistrer le rendez-vous. Réessayez.",
        );
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const confirm = () => {
    const when = new Date(date);
    if (!date || Number.isNaN(when.getTime())) {
      setError("Choisissez la date et l’heure du rendez-vous.");
      return;
    }
    run({
      appointmentAt: when.toISOString(),
      appointmentPlace: place,
      appointmentAgencyId: agencyId || null,
      appointmentAgent: agent.trim(),
    });
  };

  const disabled = !canEdit || saving;

  return (
    <div style={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <div style={styles.fields}>
        <label style={styles.field}>
          <span style={styles.label}>
            <CalendarDays size={12} /> Date et heure
          </span>
          <input
            type="datetime-local"
            className="inbox-rdv-input"
            style={{ ...styles.input, colorScheme: "dark light" }}
            value={date}
            disabled={disabled}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>

        <label style={styles.field}>
          <span style={styles.label}>
            <MapPin size={12} /> Lieu
          </span>
          <select
            style={styles.input}
            value={place}
            disabled={disabled}
            onChange={(e) => choosePlace(e.target.value)}
          >
            <option value="">— Gouvernorat —</option>
            {places.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </label>

        <label style={{ ...styles.field, flex: "2 1 220px" }}>
          <span style={styles.label}>
            <Building2 size={12} /> Agence
          </span>
          <select
            style={styles.input}
            value={agencyId}
            disabled={disabled}
            onChange={(e) => chooseAgency(e.target.value)}
          >
            <option value="">
              {place ? `— Agence (${place}) —` : "— Agence —"}
            </option>
            {agencyId && !knownAgency && (
              <option value={agencyId}>
                {d.appointmentAgencyName || "Agence enregistrée"}
              </option>
            )}
            {["agence", "partenaire"].map(
              (kind) =>
                agencies[kind].length > 0 && (
                  <optgroup key={kind} label={KIND_LABEL[kind]}>
                    {agencies[kind].map((p) => (
                      <option key={p._id} value={p._id}>{agencyLabel(p)}</option>
                    ))}
                  </optgroup>
                ),
            )}
          </select>
        </label>

        <label style={{ ...styles.field, flex: "2 1 200px" }}>
          <span style={styles.label}>
            <UserRound size={12} /> Agent responsable
          </span>
          <input
            type="text"
            style={styles.input}
            value={agent}
            maxLength={AGENT_MAX}
            disabled={disabled}
            placeholder="Nom de l’agent qui reçoit le client"
            onChange={(e) => setAgent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                confirm();
              }
            }}
          />
        </label>
      </div>

      {canEdit && (
        <div style={styles.actions}>
          <button
            type="button"
            className="inbox-send-action"
            style={styles.save}
            disabled={saving || !date || !dirty}
            onClick={confirm}
          >
            {saving ? "…" : d.appointmentAt ? "Enregistrer" : "Confirmer le RDV"}
          </button>
          {d.appointmentAt && (
            <button
              type="button"
              className="inbox-tab-btn"
              style={styles.ghost}
              disabled={saving}
              onClick={() => run({ appointmentAt: null })}
            >
              Retirer le RDV
            </button>
          )}
          {typeof onCancel === "function" && (
            <button
              type="button"
              className="inbox-tab-btn"
              style={styles.ghost}
              onClick={onCancel}
            >
              Annuler
            </button>
          )}
          {(error || directoryError) && (
            <span style={styles.error} role="alert">
              {error || directoryError}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

const styles = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  fields: {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px 12px",
    alignItems: "flex-end",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    flex: "1 1 170px",
    minWidth: 150,
  },
  label: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: RDV_COLOR,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  input: {
    padding: "7px 10px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-card)",
    color: "var(--text-primary)",
    fontSize: 12.5,
    outline: "none",
    minWidth: 0,
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  save: {
    padding: "7px 16px",
    borderRadius: 8,
    border: "none",
    backgroundColor: RDV_COLOR,
    color: "#fff",
    fontWeight: 700,
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  ghost: {
    padding: "7px 14px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "transparent",
    color: "var(--text-faint)",
    fontWeight: 600,
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "'Hanken Grotesk', sans-serif",
  },
  error: { fontSize: 12, color: "var(--danger)" },
};

export default RdvForm;
