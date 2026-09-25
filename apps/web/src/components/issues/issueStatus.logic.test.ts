import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  type IssueListEntry,
  type IssuePullRequest,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupIssuesByStatus,
  ISSUE_STATUSES,
  issueStatusInputOf,
  issueStatusOf,
  issueThreadTargets,
  matchesIssueStatusFilters,
  mergeIssueRowThreads,
  workingThreadKeys,
  type IssueStatus,
  type IssueStatusInput,
} from "./issueStatus.logic";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

const pr = (
  state: IssuePullRequest["state"],
  reviewMark: IssuePullRequest["reviewMark"] = null,
): Pick<IssuePullRequest, "state" | "reviewMark"> => ({ state, reviewMark });

const input = (overrides: Partial<IssueStatusInput> = {}): IssueStatusInput => ({
  state: "open",
  openBlockerCount: 0,
  pullRequests: [],
  hasTaskBranch: false,
  linkedThreadCount: 0,
  workingNow: false,
  ...overrides,
});

describe("issueStatusOf: every row of the status table", () => {
  it.each<[IssueStatus, Partial<IssueStatusInput>]>([
    ["done", { state: "done" }],
    ["not-planned", { state: "not-planned" }],
    ["in-review", { pullRequests: [pr("open", "pending")] }],
    ["in-progress", { hasTaskBranch: true, linkedThreadCount: 1, workingNow: true }],
    ["in-progress", { pullRequests: [pr("open")], linkedThreadCount: 1, workingNow: true }],
    ["waiting-for-merge", { pullRequests: [pr("open", "success")] }],
    ["changes-requested", { pullRequests: [pr("open", "failure")] }],
    ["waiting-for-review", { pullRequests: [pr("open")] }],
    ["paused", { hasTaskBranch: true, linkedThreadCount: 1 }],
    ["blocked", { openBlockerCount: 2 }],
    ["discussion", { linkedThreadCount: 1 }],
    ["to-do", {}],
  ])("%s", (expected, overrides) => {
    expect(issueStatusOf(input(overrides))).toBe(expected);
  });
});

describe("issueStatusOf: first match wins", () => {
  const everything: Partial<IssueStatusInput> = {
    openBlockerCount: 1,
    pullRequests: [pr("open", "pending"), pr("open", "success"), pr("open", "failure"), pr("open")],
    hasTaskBranch: true,
    linkedThreadCount: 2,
    workingNow: true,
  };

  it.each<[string, IssueStatus, Partial<IssueStatusInput>]>([
    ["Done over every other signal", "done", { ...everything, state: "done" }],
    ["Not planned over every other signal", "not-planned", { ...everything, state: "not-planned" }],
    ["In review over In progress", "in-review", everything],
    [
      "In progress over Waiting for merge",
      "in-progress",
      { ...everything, pullRequests: [pr("open", "success")] },
    ],
    [
      "Waiting for merge over Changes requested",
      "waiting-for-merge",
      { pullRequests: [pr("open", "failure"), pr("open", "success")] },
    ],
    [
      "Changes requested over Waiting for review",
      "changes-requested",
      { pullRequests: [pr("open"), pr("open", "failure")] },
    ],
    [
      "Waiting for review over Paused",
      "waiting-for-review",
      { pullRequests: [pr("open")], hasTaskBranch: true, linkedThreadCount: 1 },
    ],
    [
      "Paused over Blocked",
      "paused",
      { hasTaskBranch: true, linkedThreadCount: 1, openBlockerCount: 1 },
    ],
    ["Blocked over Discussion", "blocked", { openBlockerCount: 1, linkedThreadCount: 1 }],
    ["Discussion over To do", "discussion", { linkedThreadCount: 1 }],
  ])("%s", (_label, expected, overrides) => {
    expect(issueStatusOf(input(overrides))).toBe(expected);
  });
});

describe("issueStatusOf: which signals count", () => {
  it("ignores closed and merged pull requests and their marks", () => {
    expect(
      issueStatusOf(input({ pullRequests: [pr("merged", "pending"), pr("closed", "success")] })),
    ).toBe("to-do");
  });

  it("reads an open draft as an open pull request", () => {
    expect(issueStatusOf(input({ pullRequests: [pr("open")] }))).toBe("waiting-for-review");
  });

  it("keeps a working thread without a branch or pull request in Discussion", () => {
    expect(issueStatusOf(input({ linkedThreadCount: 1, workingNow: true }))).toBe("discussion");
  });

  it("never shows the review statuses without review marks", () => {
    const review = new Set<IssueStatus>(["in-review", "waiting-for-merge", "changes-requested"]);
    for (const state of ["open", "done", "not-planned"] as const) {
      for (const pullRequests of [[], [pr("open")], [pr("merged")], [pr("open"), pr("closed")]]) {
        for (const hasTaskBranch of [false, true]) {
          for (const workingNow of [false, true]) {
            for (const openBlockerCount of [0, 1]) {
              const status = issueStatusOf(
                input({
                  state,
                  pullRequests,
                  hasTaskBranch,
                  workingNow,
                  openBlockerCount,
                  linkedThreadCount: 1,
                }),
              );
              expect(review.has(status)).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe("matchesIssueStatusFilters", () => {
  it.each([
    [{}, "to-do", 0, true],
    [{ statuses: [] }, "paused", 1, true],
    [{ statuses: ["paused", "blocked"] }, "blocked", 0, true],
    [{ statuses: ["paused"] }, "blocked", 0, false],
    [{ linked: "linked" }, "discussion", 1, true],
    [{ linked: "linked" }, "to-do", 0, false],
    [{ linked: "unlinked" }, "blocked", 0, true],
    [{ linked: "unlinked" }, "paused", 2, false],
    [{ statuses: ["blocked"], linked: "linked" }, "blocked", 0, false],
  ] as const)("%j keeps %s with %i threads: %s", (filters, status, linkedThreadCount, kept) => {
    expect(matchesIssueStatusFilters({ status, linkedThreadCount }, filters)).toBe(kept);
  });
});

describe("groupIssuesByStatus", () => {
  it("orders groups by the status table and keeps each group's row order", () => {
    const rows: Array<[string, IssueStatus]> = [
      ["a", "to-do"],
      ["b", "done"],
      ["c", "in-progress"],
      ["d", "to-do"],
      ["e", "blocked"],
    ];
    const groups = groupIssuesByStatus(rows, ([, status]) => status);
    expect(groups.map((group) => [group.status, group.entries.map(([name]) => name)])).toEqual([
      ["done", ["b"]],
      ["in-progress", ["c"]],
      ["blocked", ["e"]],
      ["to-do", ["a", "d"]],
    ]);
  });

  it("knows every status once", () => {
    expect(new Set(ISSUE_STATUSES).size).toBe(11);
  });
});

function entry(
  number: number,
  environmentId: EnvironmentId,
  closingPullRequests: ReadonlyArray<IssuePullRequest> = [],
): Pick<IssueListEntry, "host" | "repository" | "number" | "closingPullRequests"> & {
  environmentId: EnvironmentId;
} {
  return {
    host: "github.com",
    repository: "toolboxmd/t3code",
    number,
    closingPullRequests,
    environmentId,
  };
}

describe("issueThreadTargets", () => {
  it("asks each row's own server, in batches of 100, only where links are kept", () => {
    const closing: IssuePullRequest = {
      repository: "toolboxmd/t3code",
      number: 40,
      url: "https://github.com/toolboxmd/t3code/pull/40",
      state: "merged",
      isDraft: false,
      headRefName: "feat/1-a",
      headSha: "abc",
      reviewMark: null,
    };
    const entries = [
      entry(1, LOCAL, [closing]),
      ...Array.from({ length: 150 }, (_, index) => entry(index + 2, LOCAL)),
      entry(900, REMOTE),
      entry(901, EnvironmentId.make("no-links")),
    ];
    const targets = issueThreadTargets(entries, new Set([LOCAL, REMOTE]));
    expect(targets.map((target) => [target.environmentId, target.input.issues.length])).toEqual([
      [LOCAL, 100],
      [LOCAL, 51],
      [REMOTE, 1],
    ]);
    expect(targets[0]!.input.issues[0]).toEqual({
      host: "github.com",
      repository: "toolboxmd/t3code",
      number: 1,
      closingPullRequests: [{ repository: "toolboxmd/t3code", number: 40 }],
    });
  });
});

describe("mergeIssueRowThreads", () => {
  it("keys threads by Issue across servers, each thread once", () => {
    const thread = {
      id: ThreadId.make("t1"),
      projectId: ProjectId.make("p"),
      title: "Build it",
      archivedAt: null,
      sources: ["branch" as const],
    };
    const merged = mergeIssueRowThreads([
      [
        LOCAL,
        {
          issues: [
            { host: "github.com", repository: "Toolboxmd/T3code", number: 5, threads: [thread] },
          ],
        },
      ],
      [
        LOCAL,
        {
          issues: [
            { host: "github.com", repository: "toolboxmd/t3code", number: 5, threads: [thread] },
          ],
        },
      ],
      [
        REMOTE,
        {
          issues: [
            { host: "github.com", repository: "toolboxmd/t3code", number: 5, threads: [thread] },
          ],
        },
      ],
    ]);
    expect(merged.get("github.com toolboxmd/t3code#5")?.map((row) => row.environmentId)).toEqual([
      LOCAL,
      REMOTE,
    ]);
  });
});

function shell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: LOCAL,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-25T09:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("working now", () => {
  const running = {
    threadId: ThreadId.make("x"),
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-25T10:00:00.000Z",
  };

  it("counts a thread whose own session runs, or whose descendant child thread works", () => {
    const working = workingThreadKeys([
      shell("own", { session: running }),
      shell("parent"),
      shell("sub.parent.a"),
      shell("sub.sub.parent.a.b", { session: running }),
      shell("idle"),
    ]);
    expect([...working].toSorted()).toEqual([
      "local:own",
      "local:parent",
      "local:sub.parent.a",
      "local:sub.sub.parent.a.b",
    ]);
  });

  it("feeds the status: a branch-linked thread with a working child is In progress", () => {
    const working = workingThreadKeys([
      shell("parent"),
      shell("sub.parent.job", { session: running }),
    ]);
    const threads = [
      {
        environmentId: LOCAL,
        id: ThreadId.make("parent"),
        title: "parent",
        archivedAt: null,
        sources: ["branch" as const],
      },
    ];
    const row = { state: "open" as const, openBlockerCount: 0, closingPullRequests: [] };
    expect(issueStatusOf(issueStatusInputOf(row, threads, working))).toBe("in-progress");
    expect(issueStatusOf(issueStatusInputOf(row, threads, new Set()))).toBe("paused");
    // The same thread on another server is a different thread.
    expect(
      issueStatusOf(issueStatusInputOf(row, [{ ...threads[0]!, environmentId: REMOTE }], working)),
    ).toBe("paused");
  });
});
