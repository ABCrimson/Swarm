import { open } from "@tauri-apps/plugin-shell";
import type { CSSProperties } from "react";
import { useEffect } from "react";
import { Pill } from "#components/ui/Pill";
import { Spinner } from "#components/ui/Spinner";
import { useShip } from "#hooks/useShip";
import { ShipPreview } from "./ShipPreview.tsx";
import { ShipProgress } from "./ShipProgress.tsx";

interface ShipPanelProps {
  readonly workerId: string;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflowY: "auto",
  background: "oklch(0.10 0.03 220)",
};

const centeredStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: 24,
};

const messageStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.8125rem",
  color: "oklch(0.65 0.04 220)",
  textAlign: "center",
};

const receiptStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 16,
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
};

const receiptRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  color: "oklch(0.80 0.03 220)",
};

/**
 * Ship tab content for a worker's worktree: a preflight-driven
 * preview → confirm → progress → receipt flow, backed by `useShip`.
 * Preflight runs automatically the first time a worker's Ship tab is
 * opened; the "Ship Again" action re-runs it explicitly (working-tree
 * state can change between ships without SWARM knowing).
 */
export function ShipPanel({ workerId }: ShipPanelProps): React.ReactElement {
  const ship = useShip(workerId);

  useEffect(() => {
    if (ship.state === "idle") {
      void ship.runPreflight();
    }
    // `ship.runPreflight` is stable per `workerId` (memoized in
    // useShip), and a worker switch already resets `ship.state` back
    // to `"idle"` (see useShip's own effect) — so depending on
    // `ship.state` and `ship.runPreflight` alone re-fires this
    // exactly on the idle → preflighting transition, once per worker,
    // with no separate `workerId` dependency needed.
  }, [ship.state, ship.runPreflight]);

  if (ship.state === "idle" || ship.state === "preflighting") {
    return (
      <div style={containerStyle}>
        <div style={centeredStyle}>
          <Spinner size="md" />
          <span style={messageStyle}>Running Ship Preflight…</span>
        </div>
      </div>
    );
  }

  if (ship.state === "failed" && ship.preflight == null) {
    return (
      <div style={containerStyle}>
        <div style={centeredStyle}>
          <span style={{ ...messageStyle, color: "oklch(0.75 0.18 25)" }}>
            {ship.error?.message ?? "Ship Preflight Failed."}
          </span>
          <Pill interactive tone="neutral" size="md" onClick={() => void ship.runPreflight()}>
            Retry Preflight
          </Pill>
        </div>
      </div>
    );
  }

  if (ship.state === "running") {
    return (
      <div style={containerStyle}>
        <ShipProgress rows={ship.progress} />
      </div>
    );
  }

  if (ship.state === "settled") {
    return (
      <div style={containerStyle}>
        <div style={receiptStyle}>
          <span style={{ ...messageStyle, color: "oklch(0.75 0.16 150)", textAlign: "left" }}>
            Shipped
          </span>
          {ship.result?.commitSha != null && (
            <div style={receiptRowStyle}>
              <span>Commit</span>
              <span>{ship.result.commitSha.slice(0, 12)}</span>
            </div>
          )}
          {ship.result?.pushedRef != null && (
            <div style={receiptRowStyle}>
              <span>Pushed</span>
              <span>{ship.result.pushedRef}</span>
            </div>
          )}
          {ship.result?.prUrl != null && (
            <div style={receiptRowStyle}>
              <span>Compare Page</span>
              <button
                type="button"
                onClick={() => void open(ship.result?.prUrl ?? "")}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "oklch(0.78 0.18 205)",
                  cursor: "pointer",
                  textDecoration: "underline",
                  fontFamily: "inherit",
                  fontSize: "inherit",
                }}
              >
                Open
              </button>
            </div>
          )}
        </div>
        <div style={{ padding: "0 16px 16px" }}>
          <Pill interactive tone="neutral" size="md" onClick={ship.reset}>
            Ship Again
          </Pill>
        </div>
      </div>
    );
  }

  if (ship.state === "failed") {
    return (
      <div style={containerStyle}>
        {ship.preflight != null && (
          <ShipPreview
            preflight={ship.preflight}
            message={ship.message}
            onMessageChange={ship.setMessage}
            mode={ship.mode}
            onModeChange={ship.setMode}
            busy={false}
            onCommitOnly={() => void ship.commitOnly()}
            onCommitAndPush={() => void ship.commitAndPush()}
            onCommitPushAndOpenCompare={() => void ship.commitPushAndOpenCompare()}
          />
        )}
        <div style={{ padding: "0 16px 16px" }} role="alert">
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: "oklch(0.68 0.20 25 / 0.10)",
              border: "1px solid oklch(0.68 0.20 25 / 0.3)",
              color: "oklch(0.80 0.15 25)",
              fontFamily: "var(--font-body)",
              fontSize: "0.8125rem",
            }}
          >
            {ship.error?.message ?? "Ship Failed."}
          </div>
        </div>
      </div>
    );
  }

  // previewing
  if (ship.preflight == null) {
    return <div style={containerStyle} />;
  }

  return (
    <div style={containerStyle}>
      <ShipPreview
        preflight={ship.preflight}
        message={ship.message}
        onMessageChange={ship.setMessage}
        mode={ship.mode}
        onModeChange={ship.setMode}
        busy={false}
        onCommitOnly={() => void ship.commitOnly()}
        onCommitAndPush={() => void ship.commitAndPush()}
        onCommitPushAndOpenCompare={() => void ship.commitPushAndOpenCompare()}
      />
    </div>
  );
}
