import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useCallback } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjects } from "~/state/entities";
import { issueLinkEnvironment } from "~/state/issueLinks";
import { useAtomCommand } from "~/state/use-atom-command";
import { resolveIssueProject, type StartableIssue, startThreadFromIssue } from "./issueLinks.logic";

/**
 * "Start thread" on an Issue: a new thread in the project checked out from the Issue's
 * repository, in that project's usual worktree mode, linked at once, with the Issue waiting in
 * the composer for the user to send. `resolve` says which project, or why none.
 */
export function useStartThreadFromIssue() {
  const projects = useProjects();
  const newThread = useNewThreadHandler();
  const link = useAtomCommand(issueLinkEnvironment.link, { reportFailure: true });

  const resolve = useCallback(
    (issue: StartableIssue) => resolveIssueProject(projects, issue),
    [projects],
  );

  const start = useCallback(
    (issue: StartableIssue) =>
      startThreadFromIssue(issue, {
        projects,
        openDraft: (project) => newThread(scopeProjectRef(project.environmentId, project.id)),
        writePrompt: (draftId, prompt) =>
          useComposerDraftStore.getState().setPrompt(draftId, prompt),
        link: (project, threadId, url) =>
          link({
            environmentId: project.environmentId,
            input: { threadId, target: { url }, source: "started" },
          }),
      }),
    [link, newThread, projects],
  );

  return { resolve, start };
}
