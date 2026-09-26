import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { paletteIssueThreadTargets, parsePaletteIssueReference } from "./issuePaletteThreads.logic";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

const project = (environmentId: EnvironmentId, canonicalKey: string, provider = "github") => ({
  environmentId,
  repositoryIdentity: { canonicalKey, provider },
});

describe("parsePaletteIssueReference", () => {
  it.each([
    ["#29", { repository: null, host: null, number: 29 }],
    [" Toolboxmd/T3code#29 ", { repository: "toolboxmd/t3code", host: null, number: 29 }],
    [
      "https://github.com/toolboxmd/t3code/issues/29",
      { repository: "toolboxmd/t3code", host: "github.com", number: 29 },
    ],
  ])("reads %j", (query, expected) => {
    expect(parsePaletteIssueReference(query)).toEqual(expected);
  });

  // Plain words and numbers stay ordinary searches.
  it.each(["29", "fix login", "#", "#0", "owner/repo", "https://github.com/o/r/pull/3"])(
    "names no Issue in %j",
    (query) => {
      expect(parsePaletteIssueReference(query)).toBeNull();
    },
  );
});

describe("paletteIssueThreadTargets", () => {
  const projects = [
    project(LOCAL, "github.com/toolboxmd/t3code"),
    // A worktree of the same repository asks once.
    project(LOCAL, "github.com/toolboxmd/t3code"),
    project(LOCAL, "github.com/toolboxmd/model-router"),
    project(LOCAL, "gitlab.com/someone/elsewhere", "gitlab"),
    project(REMOTE, "github.com/toolboxmd/t3code"),
    project(EnvironmentId.make("no-links"), "github.com/toolboxmd/t3code"),
  ];

  it("asks every links server about `#N` in each of its GitHub repositories", () => {
    const targets = paletteIssueThreadTargets("#29", projects, [LOCAL, REMOTE]);
    expect(
      targets.map((target) => [
        target.environmentId,
        target.input.issues.map((issue) => `${issue.repository}#${issue.number}`),
      ]),
    ).toEqual([
      [LOCAL, ["toolboxmd/t3code#29", "toolboxmd/model-router#29"]],
      [REMOTE, ["toolboxmd/t3code#29"]],
    ]);
  });

  it("asks only about the named repository, even one no project here checks out", () => {
    expect(
      paletteIssueThreadTargets("toolboxmd/agentsmd#133", projects, [LOCAL]).map(
        (target) => target.input.issues,
      ),
    ).toEqual([
      [
        {
          host: "github.com",
          repository: "toolboxmd/agentsmd",
          number: 133,
          closingPullRequests: [],
        },
      ],
    ]);
  });

  it("bounds a bare `#N` to 20 repositories per server", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      project(LOCAL, `github.com/acme/repo-${index}`),
    );
    expect(paletteIssueThreadTargets("#1", many, [LOCAL])[0]!.input.issues).toHaveLength(20);
  });

  it("reads nothing for other queries or without links servers", () => {
    expect(paletteIssueThreadTargets("fix login", projects, [LOCAL])).toEqual([]);
    expect(paletteIssueThreadTargets("#29", projects, [])).toEqual([]);
  });
});
