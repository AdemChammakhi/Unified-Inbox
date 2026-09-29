import React from "react";
import { Flame, Thermometer, Snowflake, Trophy, Ban, Reply } from "lucide-react";
import { MATURITY } from "../constants/leadQualification";

/**
 * MaturityChip — Chaud / Tiède / Froid, or Gagné / Perdu, at a glance.
 *
 * The level is computed by the server (server/utils/leadMaturity.js) along
 * with the reason ("Prospect actif hier", "Silencieux depuis 20 j · Frein :
 * Prix", …). `showReason` writes that reason on the chip — used where there
 * is room, the conversation header — otherwise it rides in the tooltip.
 * `compact` drops the text altogether for dense list rows.
 */

const ICONS = {
  chaud: Flame,
  tiede: Thermometer,
  froid: Snowflake,
  gagne: Trophy,
  perdu: Ban,
};

const MaturityChip = ({ maturity, compact = false, showReason = false }) => {
  const level = maturity?.level;
  const meta = level ? MATURITY[level] : null;
  if (!meta) return null;

  const Icon = ICONS[level];
  const label = maturity.label || meta.label;
  const reason = maturity.reason || "";
  const spoken = reason ? `${label}, ${reason}` : label;

  return (
    <span
      title={reason || label}
      aria-label={`Maturité : ${spoken}`}
      role="img"
      style={{
        ...styles.chip,
        ...(compact ? styles.compact : styles.full),
        color: meta.color,
        backgroundColor: `${meta.color}1a`,
        borderColor: `${meta.color}55`,
      }}
    >
      <Icon
        size={compact ? 10 : 12}
        strokeWidth={2.4}
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      />
      {!compact && <span>{label}</span>}
      {!compact && showReason && reason && (
        <span style={styles.reason}>· {reason}</span>
      )}
    </span>
  );
};

/**
 * AwaitingReplyBadge — the prospect wrote last and nobody has answered.
 * Solid on purpose: of everything on a row, this is the one to act on.
 */
export const AwaitingReplyBadge = ({ compact = false }) => (
  <span
    title="Le prospect attend une réponse"
    style={{
      ...styles.chip,
      ...(compact ? styles.compact : styles.full),
      ...styles.awaiting,
    }}
  >
    <Reply
      size={compact ? 10 : 12}
      strokeWidth={2.6}
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    />
    <span>À répondre</span>
  </span>
);

const styles = {
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    border: "1px solid",
    fontWeight: 700,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    flexShrink: 0,
    maxWidth: "100%",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  full: {
    fontSize: 11,
    borderRadius: 6,
    padding: "2px 8px",
  },
  compact: {
    fontSize: 9,
    borderRadius: 4,
    padding: "2px 4px",
  },
  reason: {
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 300,
  },
  awaiting: {
    color: "#fff",
    backgroundColor: "#D9534F",
    borderColor: "#D9534F",
  },
};

export default MaturityChip;
