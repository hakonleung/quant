'use client';

/**
 * SET — settings pane (formerly the `cfg` tab inside the merged USR
 * pane). The 2026-05 floating-island split broke USR into three
 * independent topbar tiles (SET / LDG / WATCH); SET owns persisted UI
 * settings (theme / gestures / presets / columns / filters) and
 * surfaces the current user as the pane title.
 *
 * Body is `<FeatSysCfg bare/>` — unchanged content, just hosted in its
 * own pane chrome now instead of a USR sub-tab.
 */

import { Feat } from '../../lib/eqty/feat.js';
import { FeatSysCfg } from '../feat-sys-cfg/feat-sys-cfg.js';
import { FeatView } from '../feat-view/feat-view.js';
import type { SessionChipInfo } from '../shell/app-shell.js';
import { UserChip } from '../shell/user-chip.js';

interface FeatSettingsProps {
  /** `mobile` → render without FeatView chrome (the mobile shell owns
   *  the full screen). */
  readonly embedded?: 'mobile';
  /** Authenticated session — shown as the pane title (replaces the old
   *  USR header user chip). When omitted the title is blank. */
  readonly session?: SessionChipInfo | undefined;
}

export function FeatSettings({
  embedded,
  session,
}: FeatSettingsProps = {}): React.ReactElement {
  if (embedded === 'mobile') {
    // Mobile shell owns the screen — drop the FeatView chrome and
    // render the config surface raw, same pattern as FeatLedger /
    // FeatWatchLive on mobile.
    return <FeatSysCfg bare />;
  }
  return (
    <FeatView
      feat={Feat.Settings}
      titleSlot={
        session !== undefined ? (
          <UserChip displayName={session.displayName} mode={session.mode} />
        ) : undefined
      }
    >
      <FeatSysCfg bare />
    </FeatView>
  );
}
