import React from "react";
import PlatformIcon from "./PlatformIcon";

/**
 * "Where conversations start" — ranks the sponsored posts / ads customers
 * message from, with how many conversations each opened and the total
 * inbound volume those conversations produced.
 *
 * Data: GET /api/analytics/ad-attribution → { ads: [...] }
 */

const KIND_LABELS = {
  ad: "Ad",
  post: "Post",
  story_reply: "Story",
  share: "Shared post",
  story_mention: "Story mention",
  referral: "Link",
};

const timeAgo = (t) => {
  if (!t) return "";
  const diff = Date.now() - new Date(t).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
};

const AdAttribution = ({ ads = [], rangeLabel = "" }) => {
  const maxConversations = ads[0]
    ? Math.max(...ads.map((a) => a.conversations))
    : 1;

  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <div className="chart-card-title">Where conversations start</div>
      <p
        style={{
          margin: "0 0 14px",
          fontSize: 12,
          color: "var(--text-faint)",
        }}
      >
        Sponsored posts and ads that opened conversations{rangeLabel}.
      </p>

      {ads.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "28px 12px",
            color: "var(--text-faint)",
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          No ad-attributed conversations yet.
          <br />
          When a customer taps a sponsored post and messages you, it lands
          here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {ads.map((ad) => {
            const pct = Math.max(
              6,
              Math.round((ad.conversations / maxConversations) * 100),
            );
            return (
              <div
                key={ad.key}
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                {/* Creative thumbnail */}
                {ad.photoUrl ? (
                  <img
                    src={ad.photoUrl}
                    alt=""
                    loading="lazy"
                    style={{
                      width: 46,
                      height: 46,
                      borderRadius: 10,
                      objectFit: "cover",
                      flexShrink: 0,
                      border: "1px solid var(--border-primary)",
                    }}
                    onError={(e) => {
                      e.target.style.display = "none";
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 46,
                      height: 46,
                      borderRadius: 10,
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "var(--accent-bg)",
                      border: "1px dashed var(--accent-border)",
                      color: "var(--accent)",
                      fontSize: 18,
                    }}
                  >
                    ▣
                  </div>
                )}

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.8px",
                        color: "var(--accent)",
                        backgroundColor: "var(--accent-bg)",
                        border: "1px solid var(--accent-border)",
                        borderRadius: 4,
                        padding: "1px 6px",
                        flexShrink: 0,
                      }}
                    >
                      {KIND_LABELS[ad.kind] || "Ad"}
                    </span>
                    {ad.url ? (
                      <a
                        href={ad.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--text-primary)",
                          textDecoration: "none",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={ad.title}
                      >
                        {ad.title}
                      </a>
                    ) : (
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={ad.title}
                      >
                        {ad.title}
                      </span>
                    )}
                    <span
                      style={{
                        display: "inline-flex",
                        gap: 3,
                        flexShrink: 0,
                        lineHeight: 0,
                      }}
                    >
                      {(ad.platforms || []).map((p) => (
                        <PlatformIcon key={p} platform={p} size={13} />
                      ))}
                    </span>
                  </div>

                  <div
                    style={{
                      height: 5,
                      borderRadius: 3,
                      background: "var(--bg-hover)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        borderRadius: 3,
                        width: `${pct}%`,
                        background: "var(--accent)",
                        transition: "width 0.4s ease",
                      }}
                    />
                  </div>
                </div>

                <div
                  style={{
                    textAlign: "right",
                    flexShrink: 0,
                    minWidth: 128,
                  }}
                >
                  <span
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: "var(--accent)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {ad.conversations}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--text-faint)",
                      marginLeft: 4,
                    }}
                  >
                    conv · {ad.totalMessages} msg
                  </span>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--text-dim)",
                      marginTop: 2,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    last {timeAgo(ad.lastAt)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default AdAttribution;
