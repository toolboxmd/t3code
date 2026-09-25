import { describe, expect, it } from "@effect/vitest";

import { closingPullRequestOf, reviewMarkOf } from "./gitHubIssues.ts";

const commit = (state: string, creator: string | null) => ({
  oid: "abc123",
  status: { context: { state, creator: creator === null ? null : { login: creator } } },
});

describe("reviewMarkOf", () => {
  it.each([
    ["SUCCESS", "success"],
    ["FAILURE", "failure"],
    ["ERROR", "failure"],
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
    ["SOMETHING_NEW", null],
  ] as const)("reads %s from the trusted account as %s", (state, expected) => {
    expect(reviewMarkOf(commit(state, "lukemaj"), "lukemaj")).toBe(expected);
  });

  it("matches the trusted login without regard to case", () => {
    expect(reviewMarkOf(commit("SUCCESS", "LukeMaj"), "lukemaj")).toBe("success");
  });

  it.each([
    ["another account", commit("SUCCESS", "someone-else")],
    ["a bot", commit("SUCCESS", "github-actions[bot]")],
    ["a deleted account", commit("SUCCESS", null)],
    ["no status", { oid: "abc123", status: null }],
    ["no review context", { oid: "abc123", status: { context: null } }],
    ["no commit", null],
  ])("ignores %s", (_label, head) => {
    expect(reviewMarkOf(head, "lukemaj")).toBeNull();
  });
});

describe("closingPullRequestOf", () => {
  const node = {
    number: 7,
    url: "https://github.com/toolboxmd/t3code/pull/7",
    state: "OPEN",
    isDraft: true,
    headRefName: "feat/29-issue-status",
    headRefOid: "abc123",
    repository: { nameWithOwner: "toolboxmd/t3code" },
    headRef: { target: commit("PENDING", "lukemaj") },
  };

  it("reads an open pull request with its head's trusted mark", () => {
    expect(closingPullRequestOf(node, "lukemaj")).toEqual({
      repository: "toolboxmd/t3code",
      number: 7,
      url: "https://github.com/toolboxmd/t3code/pull/7",
      state: "open",
      isDraft: true,
      headRefName: "feat/29-issue-status",
      headSha: "abc123",
      reviewMark: "pending",
    });
  });

  it("counts only the mark on the head GitHub reports", () => {
    const moved = { ...node, headRef: { target: { ...commit("SUCCESS", "lukemaj"), oid: "def" } } };
    expect(closingPullRequestOf(moved, "lukemaj").reviewMark).toBeNull();
  });

  it.each([
    ["MERGED", "merged"],
    ["CLOSED", "closed"],
  ] as const)("reads %s without a head branch", (state, expected) => {
    expect(closingPullRequestOf({ ...node, state, headRef: null }, "lukemaj")).toMatchObject({
      state: expected,
      headSha: "abc123",
      reviewMark: null,
    });
  });
});
