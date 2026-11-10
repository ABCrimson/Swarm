// ── useSettingsBridge ───────────────────────────────
// Starts the settings sync (#lib/settings-sync) once at the app root.
// The root renders only after `appSettingsAtom` is preloaded
// (#store/persisted), so the sync never sees a pre-hydration default.
// The effect only starts and stops the subscription; the pushes, the
// acknowledged syncs and the once-on-launch update check live in the lib.

import { useStore } from "jotai";
import { useEffect, useState } from "react";
import { createSettingsSync } from "#lib/settings-sync";

export function useSettingsBridge(): void {
  const store = useStore();
  const [sync] = useState(() => createSettingsSync(store));

  useEffect(() => sync.start(), [sync]);
}
