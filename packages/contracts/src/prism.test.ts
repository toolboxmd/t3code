import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_PRISM_ROLE_KITS, PrismRoleKitsPatch } from "./prism.ts";
import { ProjectSettingsOverrides, ServerSettings } from "./settings.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeProjectOverrides = Schema.decodeSync(ProjectSettingsOverrides);
const decodeKitsPatch = Schema.decodeSync(PrismRoleKitsPatch);

describe("Prism role kits", () => {
  it("default each role to its thread-tool scope with no preferred models", () => {
    expect(DEFAULT_PRISM_ROLE_KITS.planner.threadTools).toBe("planner");
    expect(DEFAULT_PRISM_ROLE_KITS.dispatcher.threadTools).toBe("children");
    expect(DEFAULT_PRISM_ROLE_KITS.reviewer.threadTools).toBe("project-read");
    for (const role of ["worker", "correction", "recovery"] as const) {
      expect(DEFAULT_PRISM_ROLE_KITS[role].threadTools).toBe("none");
    }
    expect(DEFAULT_PRISM_ROLE_KITS.worker.models).toEqual([]);
  });

  it("fill missing roles and fields when a settings file names one role", () => {
    const settings = decodeServerSettings({
      prismRoles: {
        worker: { models: [{ instanceId: "opencode", model: "opencode/muse", effort: "high" }] },
      },
    });
    expect(settings.prismRoles.worker.models).toEqual([
      { instanceId: "opencode", model: "opencode/muse", effort: "high" },
    ]);
    expect(settings.prismRoles.worker.threadTools).toBe("none");
    expect(settings.prismRoles.reviewer.threadTools).toBe("project-read");
  });

  it("accept a project override of the whole kit set", () => {
    const overrides = decodeProjectOverrides({
      prismRoles: { reviewer: { models: [{ instanceId: "codex", model: "gpt-5.6-luna" }] } },
    });
    expect(overrides.prismRoles?.reviewer.models[0]?.model).toBe("gpt-5.6-luna");
    expect(overrides.prismRoles?.planner.threadTools).toBe("planner");
  });

  it("patch one field of one role without defaults for the rest", () => {
    const patch = decodeKitsPatch({
      dispatcher: { models: [] },
    });
    expect(patch).toEqual({ dispatcher: { models: [] } });
  });
});
