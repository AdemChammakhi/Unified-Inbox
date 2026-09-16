import React from "react";
import { Flame, Thermometer, Snowflake } from "lucide-react";
import { MATURITY } from "../constants/leadQualification";

/**
 * MaturityChip — Chaud / Tiède / Froid at a glance.
 *
 * The level is computed by the server (server/utils/leadMaturity.js); the
 * reason it gives ("Silencieux depuis 20 j", "Frein : Prix", …) rides in the
 * tooltip. `compact` drops the text for dense list rows.
 */

const ICONS = { chaud: Flame, tiede: Thermometer, froid: Snowflake };

const MaturityChip = ({ maturity, compact = false }) => {
  const level = maturity?.level;
  const meta = level ? MATURITY[level] : null;
  if (!meta) return null;

  const Icon = ICONS[level];
  const label = maturity.label || meta.label;
  const title = maturity.reason || label;
  const spoken = maturity.reason ? `${label}, ${maturity.reason}` : label;

  return (
    <span
      title={title}
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
    </span>
  );
};

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
};

export default MaturityChip;
