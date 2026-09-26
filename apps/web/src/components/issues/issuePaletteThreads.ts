import type { EnvironmentId, IssueLinkedThread } from "@t3tools/contracts";
import { useMemo } from "react";

import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { issueLinkEnvironment } from "~/state/issueLinks";
import { createMergedEnvironmentQuery } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";
import { environmentIdsWithCapability } from "./issueList.logic";
import { paletteIssueThreadTargets } from "./issuePaletteThreads.logic";

const LOOKUP_DEBOUNCE_MS = 300;

const useThreadsForIssuesQuery = createMergedEnvironmentQuery(
  "web-palette:threads-for-issue",
  issueLinkEnvironment.threadsForIssues,
);

/**
 * Threads linked to the Issue the palette query names, per server, however they were linked
 * (by hand, by an agent, started from the Issue, by branch). Read once the query settles.
 */
export function usePaletteIssueThreads(query: string): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<IssueLinkedThread>;
}> {
  const settled = useDebouncedValue(query, LOOKUP_DEBOUNCE_MS);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const targets = useMemo(
    () =>
      paletteIssueThreadTargets(
        settled,
        projects,
        environmentIdsWithCapability(environments, "issueLinks"),
      ),
    [environments, projects, settled],
  );
  const result = useThreadsForIssuesQuery(targets);
  return useMemo(() => {
    // Stale answers for an earlier query never show under a new one.
    if (settled !== query) return [];
    const byEnvironment = new Map<EnvironmentId, Map<string, IssueLinkedThread>>();
    for (const [environmentId, answer] of result.values) {
      const threads = byEnvironment.get(environmentId) ?? new Map();
      for (const issue of answer.issues) {
        for (const thread of issue.threads) threads.set(thread.id, thread);
      }
      byEnvironment.set(environmentId, threads);
    }
    return [...byEnvironment]
      .filter(([, threads]) => threads.size > 0)
      .map(([environmentId, threads]) => ({ environmentId, threads: [...threads.values()] }));
  }, [query, result.values, settled]);
}
