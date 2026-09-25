import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  ISSUE_LINKS_BATCH_MAX,
  type IssueListEntry,
  type IssuePullRequest,
  type IssueState,
  type ThreadId,
  type ThreadIssueLinkSource,
  type ThreadsForIssuesInput,
  type ThreadsForIssuesResult,
} from "@t3tools/contracts";
import { isThreadShellWorking } from "@t3tools/shared/childThreadActivity";

import { childThreadActivityByThreadKey } from "../SidebarChildActivity.logic";
import { issueKey } from "./issueList.logic";

/**
 * The computed Issue status (toolboxmd/t3code#29), in the order of the status table in
 * toolboxmd/t3code#25: the first rule that matches wins, and groups show in this order.
 */
export const ISSUE_STATUSES = [
  "done",
  "not-planned",
  "in-review",
  "in-progress",
  "waiting-for-merge",
  "changes-requested",
  "waiting-for-review",
  "paused",
  "blocked",
  "discussion",
  "to-do",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Groups that start collapsed: finished work. */
export const COLLAPSED_ISSUE_STATUSES: ReadonlySet<IssueStatus> = new Set(["done", "not-planned"]);

export interface IssueStatusInput {
  readonly state: IssueState;
  readonly openBlockerCount: number;
  /** Pull requests that close the Issue; only open ones (drafts included) count. */
  readonly pullRequests: ReadonlyArray<Pick<IssuePullRequest, "state" | "reviewMark">>;
  /** A linked thread's branch names the Issue (`<type>/<number>-<slug>`). */
  readonly hasTaskBranch: boolean;
  readonly linkedThreadCount: number;
  /** A linked thread, or any of its descendant child threads, is working now. */
  readonly workingNow: boolean;
}

/**
 * The status table, first match wins. Review marks arrive already filtered to the trusted
 * account, so without them the three review statuses cannot come up.
 */
export function issueStatusOf(input: IssueStatusInput): IssueStatus {
  if (input.state === "done") return "done";
  if (input.state === "not-planned") return "not-planned";
  const open = input.pullRequests.filter((pullRequest) => pullRequest.state === "open");
  const marks = new Set(open.map((pullRequest) => pullRequest.reviewMark));
  if (marks.has("pending")) return "in-review";
  if ((input.hasTaskBranch || open.length > 0) && input.workingNow) return "in-progress";
  if (marks.has("success")) return "waiting-for-merge";
  if (marks.has("failure")) return "changes-requested";
  if (open.length > 0) return "waiting-for-review";
  if (input.hasTaskBranch) return "paused";
  if (input.openBlockerCount > 0) return "blocked";
  if (input.linkedThreadCount > 0) return "discussion";
  return "to-do";
}

export type IssueLinkedFilter = "linked" | "unlinked";

export interface IssueStatusFilters {
  /** Any of these; absent or empty means every status. */
  readonly statuses?: ReadonlyArray<IssueStatus> | undefined;
  readonly linked?: IssueLinkedFilter | undefined;
}

export function matchesIssueStatusFilters(
  derived: { readonly status: IssueStatus; readonly linkedThreadCount: number },
  filters: IssueStatusFilters,
): boolean {
  if (
    filters.statuses !== undefined &&
    filters.statuses.length > 0 &&
    !filters.statuses.includes(derived.status)
  ) {
    return false;
  }
  if (filters.linked === "linked") return derived.linkedThreadCount > 0;
  if (filters.linked === "unlinked") return derived.linkedThreadCount === 0;
  return true;
}

/** Rows grouped by status in table order, keeping each group's incoming order; empty groups drop. */
export function groupIssuesByStatus<Entry>(
  entries: ReadonlyArray<Entry>,
  statusOf: (entry: Entry) => IssueStatus,
): ReadonlyArray<{ readonly status: IssueStatus; readonly entries: ReadonlyArray<Entry> }> {
  const byStatus = new Map<IssueStatus, Array<Entry>>();
  for (const entry of entries) {
    const status = statusOf(entry);
    const group = byStatus.get(status);
    if (group === undefined) byStatus.set(status, [entry]);
    else group.push(entry);
  }
  return ISSUE_STATUSES.flatMap((status) => {
    const group = byStatus.get(status);
    return group === undefined ? [] : [{ status, entries: group }];
  });
}

/**
 * Scoped keys of threads working now, each counted also while any descendant child thread
 * (subagents, Prism jobs) works.
 */
export function workingThreadKeys(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, activity] of childThreadActivityByThreadKey(shells)) {
    if (activity.workingCount > 0) keys.add(key);
  }
  for (const shell of shells) {
    if (isThreadShellWorking(shell))
      keys.add(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)));
  }
  return keys;
}

export interface IssueRowThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly sources: ReadonlyArray<ThreadIssueLinkSource>;
}

/** The status table's inputs for one row, from its GitHub read and its linked threads. */
export function issueStatusInputOf(
  entry: Pick<IssueListEntry, "state" | "openBlockerCount" | "closingPullRequests">,
  threads: ReadonlyArray<IssueRowThread>,
  working: ReadonlySet<string>,
): IssueStatusInput {
  return {
    state: entry.state,
    openBlockerCount: entry.openBlockerCount,
    pullRequests: entry.closingPullRequests,
    hasTaskBranch: threads.some((thread) => thread.sources.includes("branch")),
    linkedThreadCount: threads.length,
    workingNow: threads.some((thread) =>
      working.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    ),
  };
}

/**
 * One `threadsForIssues` read per server per 100 rows, for the servers that keep Issue links.
 * Each row asks the server that listed it, with the closing pull requests its page already read.
 */
export function issueThreadTargets(
  entries: ReadonlyArray<
    Pick<IssueListEntry, "host" | "repository" | "number" | "closingPullRequests"> & {
      readonly environmentId: EnvironmentId;
    }
  >,
  linkEnvironments: ReadonlySet<EnvironmentId>,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly input: ThreadsForIssuesInput }> {
  const byEnvironment = new Map<EnvironmentId, Array<ThreadsForIssuesInput["issues"][number]>>();
  for (const entry of entries) {
    if (!linkEnvironments.has(entry.environmentId)) continue;
    const issues = byEnvironment.get(entry.environmentId) ?? [];
    issues.push({
      host: entry.host,
      repository: entry.repository,
      number: entry.number,
      closingPullRequests: entry.closingPullRequests.map(({ repository, number }) => ({
        repository,
        number,
      })),
    });
    byEnvironment.set(entry.environmentId, issues);
  }
  return [...byEnvironment].flatMap(([environmentId, issues]) => {
    const targets = [];
    for (let start = 0; start < issues.length; start += ISSUE_LINKS_BATCH_MAX) {
      targets.push({
        environmentId,
        input: { issues: issues.slice(start, start + ISSUE_LINKS_BATCH_MAX) },
      });
    }
    return targets;
  });
}

/** Linked threads per `issueKey`, each thread once. */
export function mergeIssueRowThreads(
  values: ReadonlyArray<readonly [EnvironmentId, ThreadsForIssuesResult]>,
): ReadonlyMap<string, ReadonlyArray<IssueRowThread>> {
  const byIssue = new Map<string, Array<IssueRowThread>>();
  const seen = new Set<string>();
  for (const [environmentId, result] of values) {
    for (const issue of result.issues) {
      const key = issueKey(issue);
      for (const thread of issue.threads) {
        const seenKey = `${key} ${scopedThreadKey(scopeThreadRef(environmentId, thread.id))}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        const threads = byIssue.get(key) ?? [];
        threads.push({ ...thread, environmentId });
        byIssue.set(key, threads);
      }
    }
  }
  return byIssue;
}
