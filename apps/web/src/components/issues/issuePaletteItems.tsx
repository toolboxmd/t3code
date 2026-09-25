import type { CommandPaletteGroup } from "../CommandPalette.logic";
import { ITEM_ICON_CLASS } from "../CommandPalette.logic";
import type { IssuePaletteSource } from "./issuePaletteStore";
import { IssueStateGlyph } from "./issuePresentation";

/** Rows past this are reachable through the page's own search. */
const MAX_PALETTE_ISSUES = 200;

/**
 * The Issues the page shows as the palette's first group, searchable by number, title,
 * repository, project and label. Absent unless the Issues list is open.
 */
export function withIssuePaletteGroup(
  groups: ReadonlyArray<CommandPaletteGroup>,
  source: IssuePaletteSource | null,
): ReadonlyArray<CommandPaletteGroup> {
  if (source === null || source.entries.length === 0) return groups;
  const issues: CommandPaletteGroup = {
    value: "issues",
    label: "Issues",
    items: source.entries.slice(0, MAX_PALETTE_ISSUES).map((entry) => ({
      kind: "action",
      value: `issue:${entry.environmentId}:${entry.host}/${entry.repository}#${entry.number}`,
      searchTerms: [
        `#${entry.number}`,
        String(entry.number),
        entry.title,
        entry.repository,
        entry.projectTitle,
        ...entry.labels.map((label) => label.name),
      ],
      title: `#${entry.number} ${entry.title}`,
      description: entry.repository,
      icon: <IssueStateGlyph state={entry.state} className={ITEM_ICON_CLASS} />,
      run: async () => source.open(entry),
    })),
  };
  return [issues, ...groups];
}
