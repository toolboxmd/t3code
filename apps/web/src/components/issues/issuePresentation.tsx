import type { IssueState } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, CircleSlashIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/** GitHub's own three states, in its colors: open green, done purple, not planned grey. */
export const ISSUE_STATE_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: CircleDotIcon,
  },
  done: {
    label: "Done",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: CircleCheckIcon,
  },
  "not-planned": {
    label: "Not planned",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: CircleSlashIcon,
  },
} as const satisfies Record<IssueState, unknown>;

export function IssueStateGlyph({ state, className }: { state: IssueState; className?: string }) {
  const { Icon, label, toneClassName } = ISSUE_STATE_PRESENTATION[state];
  return <Icon aria-label={label} className={cn("size-4 shrink-0", toneClassName, className)} />;
}
