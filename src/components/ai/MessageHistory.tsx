// ── MessageHistory ──────────────────────────────────
// Per-worker conversation history display.
// Virtualized list with IntersectionObserver — no DOM overflow.
// Reverse infinite scroll to load more.
// Message groups by session/time.

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { useMessageHistoryStore } from "#store/message-history";
import type { AiMessage } from "#store/types";
import { AIMessageStream } from "./AIMessageStream.tsx";

interface MessageHistoryProps {
  /** Worker ID to display history for. */
  readonly workerId: string;
  /** Number of messages to load per batch. */
  readonly batchSize?: number;
}

// ── Styles (OKLCH) ──────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflow: "hidden",
  background: "oklch(0.08 0.02 220)",
};

const scrollAreaStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  scrollbarWidth: "thin",
  scrollbarColor: "oklch(0.28 0.05 220) oklch(0 0 0 / 0)",
};

const groupHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 0",
  color: "oklch(0.55 0.04 220)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const dividerStyle: CSSProperties = {
  flex: 1,
  height: 1,
  background: "oklch(0.20 0.03 220)",
};

const userMsgStyle: CSSProperties = {
  alignSelf: "flex-end",
  maxWidth: "75%",
  padding: "8px 12px",
  borderRadius: "10px 10px 3px 10px",
  background: "oklch(0.78 0.18 205 / 0.12)",
  border: "1px solid oklch(0.78 0.18 205 / 0.25)",
  color: "oklch(0.88 0.03 220)",
  fontSize: 13,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const assistantMsgStyle: CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "85%",
};

const timestampStyle: CSSProperties = {
  fontSize: 10,
  color: "oklch(0.55 0.03 220)",
  marginTop: 3,
};

const sentinelStyle: CSSProperties = {
  height: 1,
  width: "100%",
  flexShrink: 0,
};

const loadMoreStyle: CSSProperties = {
  textAlign: "center",
  padding: "8px 0",
  fontSize: 12,
  color: "oklch(0.50 0.06 205)",
};

const emptyStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flex: 1,
  color: "oklch(0.55 0.03 220)",
  fontSize: 13,
};

// ── Time Grouping ───────────────────────────────────

interface MessageGroup {
  readonly label: string;
  readonly messages: AiMessage[];
}

function groupByTime(messages: AiMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentLabel = "";
  let currentGroup: AiMessage[] = [];

  for (const msg of messages) {
    const date = new Date(msg.timestamp);
    const today = new Date();
    const isToday = date.toDateString() === today.toDateString();

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    let label: string;
    if (isToday) {
      const hour = date.getHours();
      if (hour < 6) label = "Today - Early Morning";
      else if (hour < 12) label = "Today - Morning";
      else if (hour < 18) label = "Today - Afternoon";
      else label = "Today - Evening";
    } else if (isYesterday) {
      label = "Yesterday";
    } else {
      label = date.toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
    }

    if (label !== currentLabel) {
      if (currentGroup.length > 0) {
        groups.push({ label: currentLabel, messages: currentGroup });
      }
      currentLabel = label;
      currentGroup = [msg];
    } else {
      currentGroup.push(msg);
    }
  }

  if (currentGroup.length > 0) {
    groups.push({ label: currentLabel, messages: currentGroup });
  }

  return groups;
}

// ── Virtual Item ────────────────────────────────────

function VirtualMessage({
  message,
  onVisible,
}: {
  message: AiMessage;
  onVisible?: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          onVisible?.();
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible]);

  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (!isVisible) {
    // Placeholder maintains scroll position without rendering full content
    return (
      <div
        ref={ref}
        style={{
          ...(message.role === "user" ? userMsgStyle : assistantMsgStyle),
          minHeight: 40,
          opacity: 0,
        }}
      />
    );
  }

  if (message.role === "user") {
    return (
      <div ref={ref} style={userMsgStyle}>
        <div>{message.content}</div>
        <div style={{ ...timestampStyle, textAlign: "right" }}>{time}</div>
      </div>
    );
  }

  return (
    <div ref={ref} style={assistantMsgStyle}>
      <AIMessageStream content={message.content} isStreaming={false} />
      <div style={timestampStyle}>{time}</div>
    </div>
  );
}

// ── Component ───────────────────────────────────────

/**
 * Per-worker conversation history with virtualized rendering.
 *
 * - IntersectionObserver-based virtualization to avoid DOM overflow
 * - Reverse infinite scroll (scroll up to load more)
 * - Messages grouped by session/time
 * - OKLCH styled, glass-panel backgrounds
 */
export function MessageHistory({
  workerId,
  batchSize = 20,
}: MessageHistoryProps): React.ReactElement {
  const allMessages = useMessageHistoryStore((s) => s.getMessages(workerId));
  const [visibleCount, setVisibleCount] = useState(batchSize);

  const topSentinelRef = useRef<HTMLDivElement>(null);

  // Slice from the end for the most recent messages
  const displayMessages = (() => {
    const start = Math.max(0, allMessages.length - visibleCount);
    return allMessages.slice(start);
  })();

  const hasMore = visibleCount < allMessages.length;

  const groups = groupByTime(displayMessages);

  // Reverse infinite scroll: observe top sentinel
  useEffect(() => {
    const el = topSentinelRef.current;
    if (!el || !hasMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + batchSize, allMessages.length));
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, batchSize, allMessages.length]);

  const handleLoadMore = () => {
    setVisibleCount((prev) => Math.min(prev + batchSize, allMessages.length));
  };

  if (allMessages.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={emptyStyle}>No Conversation History</div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={scrollAreaStyle}>
        {/* Top sentinel for reverse infinite scroll */}
        <div ref={topSentinelRef} style={sentinelStyle} />

        {hasMore && (
          <button
            type="button"
            onClick={handleLoadMore}
            style={{
              ...loadMoreStyle,
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            Load Older Messages ({allMessages.length - visibleCount} Remaining)
          </button>
        )}

        {groups.map((group) => (
          <div key={group.label}>
            <div style={groupHeaderStyle}>
              <span style={dividerStyle} />
              <span>{group.label}</span>
              <span style={dividerStyle} />
            </div>

            {group.messages.map((msg) => (
              <VirtualMessage key={msg.id} message={msg} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
