import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../../../provider/Services/ProviderService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { isSubagentThreadId, makeSubagentThreadId, parentThreadIdOf } from "./subagentThreadId.ts";
import { type SubagentStatus, ThreadsToolError, ThreadsToolkit } from "./tools.ts";

const REPORT_TEXT_LIMIT = 4_000;

/** The toolkit's coarse status vocabulary for a thread's provider session. */
export function subagentStatusOf(session: OrchestrationSession | null): SubagentStatus {
  switch (session?.status) {
    case undefined:
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "idle":
    case "ready":
      return "idle";
    case "error":
      return "failed";
    case "interrupted":
    case "stopped":
      return "stopped";
  }
}

/** Provider option id that carries reasoning effort, per driver. */
export function effortOptionId(driverKind: string): string {
  switch (driverKind) {
    case "codex":
    case "grok":
      return "reasoningEffort";
    case "opencode":
      return "variant";
    default:
      return "effort";
  }
}

const fail = (reason: string) => Effect.fail(new ThreadsToolError({ reason }));

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderService.ProviderService;
  const crypto = yield* Crypto.Crypto;

  /** Child thread id -> whether its turn results go back to the parent. In memory: a spike limit. */
  const reportBack = new Map<string, boolean>();
  /** Child thread id -> last status the parent's Agents panel was told. */
  const lastStatus = new Map<string, SubagentStatus>();
  /** Child thread id -> assistant message id last reported to the parent. */
  const lastReported = new Map<string, string>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const commandId = (tag: string) =>
    Effect.map(uuid, (id) => CommandId.make(`server:mcp-threads-${tag}:${id}`));

  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine
      .dispatch(command)
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : fail(`Command ${command.type} failed: ${Cause.pretty(cause).slice(0, 500)}`),
        ),
      );

  const threadShell = (threadId: string) =>
    snapshots.getThreadShellById(ThreadId.make(threadId)).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  const lastAssistantMessage = (threadId: string) =>
    snapshots.getThreadDetailById(ThreadId.make(threadId)).pipe(
      Effect.map((thread) => {
        if (Option.isNone(thread)) return null;
        const messages = thread.value.messages;
        const userMessageCount = messages.filter((message) => message.role === "user").length;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]!;
          if (message.role === "assistant" && message.text.trim().length > 0) {
            return { id: message.id, text: message.text, userMessageCount };
          }
        }
        return { id: null, text: null, userMessageCount };
      }),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const summarize = (thread: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const last = yield* lastAssistantMessage(thread.id);
      return {
        threadId: thread.id,
        title: thread.title,
        status: subagentStatusOf(thread.session),
        instanceId: thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
        lastError: thread.session?.lastError ?? null,
        lastAssistantMessage: last?.text ?? null,
        userMessageCount: last?.userMessageCount ?? 0,
      };
    });

  /** The calling thread, plus a guard that the target is one of its children. */
  const callerChild = (threadId: string) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (parentThreadIdOf(threadId) !== scope.threadId) {
        return yield* fail(`Thread ${threadId} is not a child of this thread.`);
      }
      const child = yield* threadShell(threadId);
      if (!child) return yield* fail(`Thread ${threadId} was not found.`);
      return child;
    });

  const appendParentActivity = (
    parentThreadId: string,
    kind: "task.started" | "task.progress" | "task.updated" | "task.completed",
    summary: string,
    payload: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId("activity"),
        threadId: ThreadId.make(parentThreadId),
        activity: {
          id: EventId.make(yield* uuid),
          tone: "info",
          kind,
          summary,
          // agentKind "agent" is what admits a task row to the Agents panel.
          payload: { agentKind: "agent", taskType: "t3_thread", ...payload },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    });

  const startTurn = (thread: OrchestrationThreadShell, text: string) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("turn"),
        threadId: thread.id,
        message: {
          messageId: MessageId.make(yield* uuid),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      });
    });

  /**
   * Mirrors a child thread's lifecycle into its parent's activities as the
   * task.* rows the Agents panel already folds, and optionally sends each
   * finished turn's reply back to the parent as a message.
   */
  const bridge = Effect.fn("ThreadsToolkit.bridge")(function* (event: OrchestrationEvent) {
    if (event.aggregateKind !== "thread" || !isSubagentThreadId(event.aggregateId)) return;
    const childId = event.aggregateId;
    const parentId = parentThreadIdOf(childId)!;
    if (event.type === "thread.created") {
      const selection = event.payload.modelSelection;
      const effort = selection.options?.find((option) =>
        ["effort", "reasoningEffort", "variant"].includes(option.id),
      )?.value;
      lastStatus.set(childId, "starting");
      yield* appendParentActivity(parentId, "task.started", `Started ${event.payload.title}`, {
        taskId: childId,
        title: event.payload.title,
        role: selection.instanceId,
        model: selection.model,
        ...(typeof effort === "string" ? { effort } : {}),
        detail: event.payload.title,
      });
      return;
    }
    if (event.type !== "thread.session-set") return;
    const status = subagentStatusOf(event.payload.session);
    const previous = lastStatus.get(childId);
    if (status === previous) return;
    lastStatus.set(childId, status);
    if (status === "running") {
      yield* appendParentActivity(parentId, "task.updated", "Subagent working", {
        taskId: childId,
        status: "running",
      });
      return;
    }
    if (status === "failed") {
      yield* appendParentActivity(parentId, "task.updated", "Subagent failed", {
        taskId: childId,
        status: "failed",
        error: event.payload.session.lastError ?? "Provider session error",
      });
      return;
    }
    if (status === "stopped") {
      yield* appendParentActivity(parentId, "task.updated", "Subagent stopped", {
        taskId: childId,
        status: "interrupted",
      });
      return;
    }
    if (status !== "idle") return;
    const last = yield* lastAssistantMessage(childId);
    yield* appendParentActivity(parentId, "task.progress", "Subagent idle", {
      taskId: childId,
      status: "idle",
      ...(last?.text ? { summary: last.text } : {}),
    });
    if (
      reportBack.get(childId) !== true ||
      !last?.id ||
      !last.text ||
      lastReported.get(childId) === last.id
    ) {
      return;
    }
    lastReported.set(childId, last.id);
    const parent = yield* threadShell(parentId);
    const child = yield* threadShell(childId);
    if (!parent) return;
    const text =
      last.text.length > REPORT_TEXT_LIMIT
        ? `${last.text.slice(0, REPORT_TEXT_LIMIT)}…`
        : last.text;
    yield* startTurn(
      parent,
      `[Subagent ${child?.title ?? childId} (thread ${childId}) finished a turn]\n\n${text}`,
    );
  });

  const events = yield* engine.subscribeDomainEvents;
  yield* Effect.forkScoped(
    Stream.runForEach(events, (event) =>
      bridge(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("threads toolkit bridge skipped an event", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    ),
  );

  return ThreadsToolkit.of({
    spawn_thread: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const parent = yield* threadShell(scope.threadId);
        if (!parent) return yield* fail(`Thread ${scope.threadId} was not found.`);
        const instanceId = ProviderInstanceId.make(
          input.instanceId ?? parent.modelSelection.instanceId,
        );
        const sameInstance = instanceId === parent.modelSelection.instanceId;
        const model = input.model ?? (sameInstance ? parent.modelSelection.model : undefined);
        if (!model) return yield* fail("Pass model when instanceId differs from this thread's.");
        const info = yield* providers
          .getInstanceInfo(instanceId)
          .pipe(Effect.catchCause(() => fail(`Unknown provider instance ${instanceId}.`)));
        if (!info.enabled) {
          return yield* fail(`Provider instance ${instanceId} is disabled in T3 Code settings.`);
        }
        const options: ProviderOptionSelection[] = input.effort
          ? [{ id: effortOptionId(info.driverKind), value: input.effort }]
          : [];
        const modelSelection = {
          instanceId,
          model,
          ...(options.length > 0 ? { options } : {}),
        };
        const childId = ThreadId.make(
          makeSubagentThreadId(parent.id, (yield* uuid).replaceAll("-", "").slice(0, 12)),
        );
        reportBack.set(childId, input.reportBack !== false);
        const createdAt = yield* nowIso;
        const runtimeMode = input.runtimeMode ?? parent.runtimeMode;
        yield* dispatch({
          type: "thread.create",
          commandId: yield* commandId("create"),
          threadId: childId,
          projectId: parent.projectId,
          title: input.title ?? `Subagent: ${input.task.slice(0, 60)}`,
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          branch: parent.branch,
          worktreePath: parent.worktreePath,
          createdAt,
        });
        const child = yield* threadShell(childId);
        if (!child) return yield* fail(`Child thread ${childId} was not created.`);
        yield* startTurn(child, input.task);
        return { threadId: childId, parentThreadId: parent.id, instanceId, model };
      }),
    message_thread: ({ threadId, text }) =>
      Effect.gen(function* () {
        const child = yield* callerChild(threadId);
        const statusBefore = subagentStatusOf(child.session);
        // Live run: a message sent before the first turn starts left a Claude
        // turn open forever, so wait for the child to be running or idle.
        if (statusBefore === "starting") {
          return yield* fail(`Thread ${threadId} is still starting. Retry in a few seconds.`);
        }
        yield* startTurn(child, text);
        return {
          threadId,
          statusBefore,
          // Live runs: Claude, Codex, OpenCode and Grok all fold a message sent
          // mid-turn into the running turn.
          delivery: statusBefore === "running" ? ("steer" as const) : ("new-turn" as const),
        };
      }),
    read_thread: ({ threadId }) => callerChild(threadId).pipe(Effect.flatMap(summarize)),
    list_child_threads: () =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const shells = yield* snapshots.getShellSnapshot().pipe(
          Effect.map((snapshot) => snapshot.threads),
          Effect.catchCause(() => fail("Could not read threads.")),
        );
        const children = shells.filter((thread) => parentThreadIdOf(thread.id) === scope.threadId);
        return { threads: yield* Effect.forEach(children, summarize) };
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
