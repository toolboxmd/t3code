import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  ISSUE_LINKS_WS_METHODS,
  type IssueKey,
  type IssueLinkChange,
  issueKeyString,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

/** Every change to stored Issue links on an environment. */
const changes = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issue-links:changes",
  tag: ISSUE_LINKS_WS_METHODS.subscribeChanges,
});

/**
 * A refresh signal that moves only for changes `matches` accepts, so a link change refreshes the
 * thread and Issue rows it names rather than every mounted query on the environment.
 */
const changeSignal = Atom.family((key: string) => {
  const { environmentId, threadId, issues } = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly threadId: string | null;
    readonly issues: ReadonlyArray<string>;
  };
  const wanted = new Set(issues);
  const matches = (change: IssueLinkChange) =>
    change.threadId === threadId ||
    change.issues.some((issue) => wanted.has(issueKeyString(issue)));
  return Atom.make((get) => {
    const previous = Option.getOrElse(get.self<number>(), () => 0);
    const change = AsyncResult.value(get(changes({ environmentId, input: {} })));
    return Option.isSome(change) && matches(change.value) ? previous + 1 : previous;
  }).pipe(Atom.withLabel(`issue-links:change-signal:${key}`));
});

const signalFor = (
  environmentId: EnvironmentId,
  threadId: string | null,
  issues: ReadonlyArray<IssueKey>,
) =>
  changeSignal(
    JSON.stringify({ environmentId, threadId, issues: issues.map(issueKeyString).toSorted() }),
  );

export const issueLinkEnvironment = {
  forThread: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:issue-links:for-thread",
    tag: ISSUE_LINKS_WS_METHODS.forThread,
    staleTimeMs: 0,
    refreshTrigger: ({ environmentId, input }) => signalFor(environmentId, input.threadId, []),
  }),
  /** Threads for a page of Issues in one read; Issue rows and computed status use this. */
  threadsForIssues: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:issue-links:threads-for-issues",
    tag: ISSUE_LINKS_WS_METHODS.threadsForIssues,
    staleTimeMs: 30_000,
    refreshTrigger: ({ environmentId, input }) => signalFor(environmentId, null, input.issues),
  }),
  link: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-links:link",
    tag: ISSUE_LINKS_WS_METHODS.link,
  }),
  unlink: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-links:unlink",
    tag: ISSUE_LINKS_WS_METHODS.unlink,
  }),
};
