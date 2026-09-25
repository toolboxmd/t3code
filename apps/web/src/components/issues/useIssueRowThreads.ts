import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadShells } from "~/state/entities";
import { issueLinkEnvironment } from "~/state/issueLinks";
import { createMergedEnvironmentQuery } from "~/state/pullRequests";
import type { EnvironmentIssueEntry } from "./issueList.logic";
import { issueThreadTargets, mergeIssueRowThreads, workingThreadKeys } from "./issueStatus.logic";

const useThreadsForIssuesQuery = createMergedEnvironmentQuery(
  "web-issues:threads-for-issues",
  issueLinkEnvironment.threadsForIssues,
);

/**
 * The loaded rows' linked threads, read in batches from the servers that keep Issue links, and
 * which threads work now. Both feed the computed status; no GitHub read happens here.
 */
export function useIssueRowThreads(
  entries: ReadonlyArray<EnvironmentIssueEntry>,
  linkEnvironments: ReadonlySet<EnvironmentId>,
) {
  const targets = useMemo(
    () => issueThreadTargets(entries, linkEnvironments),
    [entries, linkEnvironments],
  );
  const query = useThreadsForIssuesQuery(targets);
  const threadsByIssue = useMemo(() => mergeIssueRowThreads(query.values), [query.values]);
  const shells = useThreadShells();
  // Shells change on every thread event; statuses recompute only when who is working changes.
  const workingKey = useMemo(() => [...workingThreadKeys(shells)].toSorted().join("\n"), [shells]);
  const working = useMemo(
    (): ReadonlySet<string> => new Set(workingKey.length === 0 ? [] : workingKey.split("\n")),
    [workingKey],
  );
  return { threadsByIssue, working };
}
