import React from "react";
import { MapPin, UserRound } from "lucide-react";
import PlatformIcon from "./PlatformIcon";

/**
 * AppointmentsPanel — the RDV agenda.
 *
 * A dossier carries the date its appointment is booked for, so the useful
 * view is not "how many did we book" but "who are we seeing, when, where and
 * with whom". Counts summarise the load; the list is ordered soonest-first
 * so the top row is always the next thing the team has to honour. Each row
 * shows the place and agency and the agent receiving the customer, when the
 * booking recorded them.
 *
 * Data: GET /api/analytics/appointments → { todayCount, next7DaysCount, … }
 */

const RDV_COLOR = "#A98BD6";

const formatWhen = (value) => {
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

/** "dans 2 h" / "dans 3 j" — how soon, at a glance. */
const countdown = (value) => {
  const diff = new Date(value).getTime() - Date.now();
  if (diff < 0) return "passé";
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `dans ${Math.max(1, Math.floor(diff / 60000))} min`;
  if (hours < 24) return `dans ${hours} h`;
  return `dans ${Math.floor(hours / 24)} j`;
};

const AppointmentsPanel = ({ data, rangeLabel = "" }) => {
  const upcoming = data?.upcoming || [];
  const isToday = (value) => {
    const d = new Date(value);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  };

  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <div className="chart-card-title">📅 Rendez-vous</div>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-faint)" }}>
        Rendez-vous fixés{rangeLabel} : date, lieu, agence et agent responsable.
      </p>

      {/* Summary counts */}
      <div style={styles.counts}>
        <div style={styles.count}>
          <div style={{ ...styles.countValue, color: RDV_COLOR }}>
            {data?.todayCount ?? "—"}
          </div>
          <div style={styles.countLabel}>aujourd’hui</div>
        </div>
        <div style={styles.count}>
          <div style={{ ...styles.countValue, color: "var(--info)" }}>
            {data?.next7DaysCount ?? "—"}
          </div>
          <div style={styles.countLabel}>7 prochains jours</div>
        </div>
        <div style={styles.count}>
          <div style={{ ...styles.countValue, color: "var(--success)" }}>
            {data?.bookedInRange ?? "—"}
          </div>
          <div style={styles.countLabel}>pris{rangeLabel}</div>
        </div>
        <div style={styles.count}>
          <div style={{ ...styles.countValue, color: "var(--text-muted)" }}>
            {data?.pastCount ?? "—"}
          </div>
          <div style={styles.countLabel}>passés</div>
        </div>
      </div>

      {upcoming.length === 0 ? (
        <div style={styles.empty}>
          Aucun rendez-vous à venir.
          <br />
          Fixez-en un depuis une conversation, avec le bouton « 📅 RDV ».
        </div>
      ) : (
        <div style={styles.list}>
          {upcoming.slice(0, 12).map((a) => (
            <div key={`${a.platform}-${a.conversationId}`} style={styles.row}>
              <div
                style={{
                  ...styles.marker,
                  backgroundColor: isToday(a.appointmentAt)
                    ? RDV_COLOR
                    : "transparent",
                  borderColor: RDV_COLOR,
                }}
              />
              <PlatformIcon platform={a.platform} size={15} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.name}>{a.name || "Client"}</div>
                <div style={styles.when}>{formatWhen(a.appointmentAt)}</div>
                {(a.agency || a.place) && (
                  <div style={styles.detail}>
                    <MapPin size={11} style={styles.detailIcon} />
                    <span style={styles.detailText}>
                      {a.agency || a.place}
                      {a.agency && a.place && !a.agency.includes(a.place)
                        ? ` · ${a.place}`
                        : ""}
                    </span>
                  </div>
                )}
                {a.agent && (
                  <div style={styles.detail}>
                    <UserRound size={11} style={styles.detailIcon} />
                    <span style={styles.detailText}>{a.agent}</span>
                  </div>
                )}
                {a.bookedBy && (
                  <div style={styles.by}>pris par {a.bookedBy}</div>
                )}
              </div>
              <span
                style={{
                  ...styles.countdownChip,
                  color: isToday(a.appointmentAt)
                    ? RDV_COLOR
                    : "var(--text-faint)",
                  borderColor: isToday(a.appointmentAt)
                    ? RDV_COLOR
                    : "var(--border-primary)",
                }}
              >
                {countdown(a.appointmentAt)}
              </span>
            </div>
          ))}
          {upcoming.length > 12 && (
            <div style={styles.more}>
              +{upcoming.length - 12} autres à venir
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const styles = {
  name: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  counts: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
    gap: 12,
    marginBottom: 18,
  },
  count: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-card)",
  },
  countValue: {
    fontSize: 22,
    fontWeight: 700,
    lineHeight: 1,
    fontFamily: "'Space Grotesk', sans-serif",
    fontVariantNumeric: "tabular-nums",
  },
  countLabel: {
    fontSize: 11,
    color: "var(--text-faint)",
    marginTop: 4,
  },
  list: { display: "flex", flexDirection: "column", gap: 8 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--border-primary)",
    backgroundColor: "var(--bg-card)",
  },
  marker: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    border: "2px solid",
    flexShrink: 0,
  },
  when: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  by: { fontSize: 11, color: "var(--text-dim)" },
  detail: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    minWidth: 0,
    marginTop: 1,
  },
  detailIcon: { color: RDV_COLOR, flexShrink: 0 },
  detailText: {
    fontSize: 12,
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  countdownChip: {
    fontSize: 10.5,
    fontWeight: 700,
    border: "1px solid",
    borderRadius: 5,
    padding: "2px 8px",
    whiteSpace: "nowrap",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  more: { fontSize: 11.5, color: "var(--text-dim)", paddingLeft: 4 },
  empty: {
    textAlign: "center",
    padding: "24px 12px",
    color: "var(--text-faint)",
    fontSize: 13,
    lineHeight: 1.6,
  },
};

export default AppointmentsPanel;
