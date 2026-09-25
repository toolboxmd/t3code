import { useNavigate } from "@tanstack/react-router";
import { CircleDotIcon } from "lucide-react";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export type ListMode = "pull-requests" | "issues";

/** The Pull Requests page's two lists. Both live on one route; Issues is `view=issues`. */
export function ListModeToggle({ mode }: { mode: ListMode }) {
  const navigate = useNavigate();
  return (
    <ToggleGroup
      aria-label="List"
      className="shrink-0"
      variant="segmented"
      value={[mode]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === mode) return;
        if (next === "issues") {
          void navigate({
            to: "/pull-requests",
            search: { ...readPullRequestListPreferences(), view: "issues" },
          });
        }
        if (next === "pull-requests") {
          void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
        }
      }}
    >
      <Toggle aria-label="Pull requests" value="pull-requests">
        <PullRequestGlyph.pullRequest className="size-3.5" />
        <span>PRs</span>
      </Toggle>
      <Toggle aria-label="Issues" value="issues">
        <CircleDotIcon className="size-3.5" />
        <span>Issues</span>
      </Toggle>
    </ToggleGroup>
  );
}
