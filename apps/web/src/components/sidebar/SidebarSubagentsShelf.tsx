import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Collapsible shelf for threads another thread spawned (toolboxmd/t3code#3
 * spike). Sits with the Snoozed and Settled shelves at the bottom of the
 * list but outside the sortable list: subagent rows are not drag targets.
 */
export function SidebarSubagentsShelf(props: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (props.count === 0) return null;
  return (
    <li className="list-none" data-testid="sidebar-subagents-shelf">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        data-testid="sidebar-subagents-shelf-toggle"
        className="mx-0.5 flex h-8 w-full cursor-pointer items-center gap-2 px-2 text-left text-xs font-medium text-violet-600 dark:text-violet-400"
      >
        <span className="shrink-0">
          {props.expanded ? "Subagents" : `Subagents (${props.count})`}
        </span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-violet-500/20 dark:bg-violet-400/15" />
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", props.expanded && "rotate-180")}
        />
      </button>
      {props.expanded ? (
        <ul role="list" className="flex flex-col gap-px">
          {props.children}
        </ul>
      ) : null}
    </li>
  );
}
