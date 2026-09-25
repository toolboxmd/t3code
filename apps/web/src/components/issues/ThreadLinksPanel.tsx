import type { ScopedThreadRef } from "@t3tools/contracts";

import { ThreadPullRequestsPanel } from "../pullRequest/ThreadPullRequestsPanel";
import { ThreadIssueLinks } from "./ThreadIssueLinks";

/** The thread's right-panel links: Issues above pull requests. */
export function ThreadLinksPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadIssueLinks threadRef={threadRef} />
      <div className="min-h-0 flex-1">
        <ThreadPullRequestsPanel threadRef={threadRef} />
      </div>
    </div>
  );
}
