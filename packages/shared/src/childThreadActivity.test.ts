import { describe, expect, it } from "vite-plus/test";

import {
  childThreadActivityByParent,
  type ChildThreadActivityShell,
} from "./childThreadActivity.ts";

// Same convention as the fork's `sub.<parent>.<suffix>` child-thread ids.
function parentThreadIdOf(threadId: string): string | null {
  if (!threadId.startsWith("sub.") || threadId.lastIndexOf(".") <= 4) return null;
  return threadId.slice(4, threadId.lastIndexOf("."));
}

function shell(
  id: string,
  overrides: Partial<ChildThreadActivityShell> = {},
): ChildThreadActivityShell {
  return {
    id,
    archivedAt: null,
    session: { status: "ready" },
    backgroundLiveness: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

const running = { session: { status: "running" } };

function activityOf(shells: ReadonlyArray<ChildThreadActivityShell>) {
  return Object.fromEntries(childThreadActivityByParent(shells, parentThreadIdOf));
}

describe("childThreadActivityByParent", () => {
  it("has no entry for a thread without children or with only its own work", () => {
    expect(activityOf([shell("parent", running), shell("other")])).toEqual({});
  });

  it("counts working children, including a live background fleet after the turn", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.coder-a", running),
        shell("sub.parent.coder-b", { session: { status: "starting" } }),
        shell("sub.parent.coder-c", { backgroundLiveness: "working" }),
      ]),
    ).toEqual({ parent: { workingCount: 3, hasPendingApprovals: false } });
  });

  it("counts a nested child toward every ancestor", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.dispatcher"),
        shell("sub.sub.parent.dispatcher.coder", running),
      ]),
    ).toEqual({
      parent: { workingCount: 1, hasPendingApprovals: false },
      "sub.parent.dispatcher": { workingCount: 1, hasPendingApprovals: false },
    });
  });

  it("ignores finished, failed, monitoring-only and archived children", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.done"),
        shell("sub.parent.failed", { session: { status: "error" }, backgroundLiveness: "working" }),
        shell("sub.parent.watching", { backgroundLiveness: "monitoring" }),
        shell("sub.parent.archived", { ...running, archivedAt: "2026-09-01T00:00:00.000Z" }),
      ]),
    ).toEqual({});
  });

  it("surfaces a child awaiting approval without counting it as working", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.coder", { ...running, hasPendingApprovals: true }),
      ]),
    ).toEqual({ parent: { workingCount: 0, hasPendingApprovals: true } });
  });

  it("does not count a child waiting on user input", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.coder", { ...running, hasPendingUserInput: true }),
      ]),
    ).toEqual({});
  });
});
