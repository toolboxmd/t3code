/**
 * FleetService - server-side fleet state for externally launched Codex
 * native sessions.
 *
 * Each T3 client connection gets its own service instance (scoped): native
 * sockets are dialed lazily per configured endpoint, live notifications are
 * fanned out to that connection's subscribers, and everything is closed
 * when the connection ends. Closing never touches the native backend: no
 * stop, no archive, no permission change, no resume of `notLoaded`
 * sessions.
 *
 * Endpoints come from `ServerSettings.providerInstances`: entries whose
 * driver is `codex` and whose decoded `CodexSettings.nativeEndpoint` is a
 * ws:// or wss:// URL. The URL itself never leaves the server: RPC results
 * carry agents and events, never the endpoint.
 *
 * @module fleet/FleetService
 */
import {
  CodexSettings,
  FleetError,
  fleetAgentId,
  type EnvironmentId,
  type FleetAgent,
  type FleetAgentListResult,
  type FleetMessageDelivery,
  type FleetSendMessageInput,
  type FleetStreamEvent,
  type FleetThreadHistoryResult,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  globalWebSocketFactory,
  openFleetNativeClient,
  type FleetNativeClient,
  type FleetNativeSocketFactory,
} from "./CodexNativeWs.ts";
import {
  activeTurnOf,
  applyAgentMessageDelta,
  buildSteerInput,
  decideSend,
  decodeLoadedThreadIds,
  decodeReadTurns,
  deltaEventOf,
  discoverFleetAgents,
  executeSend,
  historyEventsOf,
  isAttachableStatus,
  isNotLoadedStatus,
  nativeItemToEvent,
  rawThreadStatusText,
  threadLoadStateOf,
  toFleetStatus,
  type FleetNativeTransport,
  type NativeThread,
} from "./FleetSessions.ts";

const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

export interface FleetServiceShape {
  readonly listAgents: Effect.Effect<FleetAgentListResult, FleetError>;
  readonly readThread: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly nativeThreadId: string;
  }) => Effect.Effect<FleetThreadHistoryResult, FleetError>;
  readonly sendMessage: (
    input: FleetSendMessageInput,
  ) => Effect.Effect<FleetMessageDelivery, FleetError>;
  readonly subscribe: Stream.Stream<FleetStreamEvent, FleetError>;
}

export class FleetService extends Context.Service<FleetService, FleetServiceShape>()(
  "t3/fleet/FleetService",
) {}

interface FleetEndpointConfig {
  readonly instanceId: ProviderInstanceId;
  readonly url: string;
}

interface OpenEndpoint {
  readonly config: FleetEndpointConfig;
  readonly client: FleetNativeClient;
  readonly scope: Scope.Scope;
  /** Latest harness status per thread, from resume results + live updates. */
  readonly statusByThread: Map<string, unknown>;
  /** Running turn per thread, from turn/started + history + completion. */
  readonly activeTurnByThread: Map<string, string>;
  /** Accumulated agent-message deltas per item id. */
  readonly deltasByItem: Map<string, string>;
  /** Threads this endpoint has reported, for removal detection. */
  readonly knownThreads: Set<string>;
}

const failFleet = <A>(
  operation: FleetError["operation"],
  message: string,
): Effect.Effect<A, FleetError> =>
  Effect.fail(
    new FleetError({
      operation,
      message,
    }),
  );

const withNativeTimeout = <A, E>(
  operation: FleetError["operation"],
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, FleetError> =>
  effect.pipe(
    Effect.timeoutOption("30 seconds"),
    Effect.flatMap((option) =>
      Option.isSome(option)
        ? Effect.succeed(option.value)
        : failFleet<A>(operation, "The native server did not answer in time."),
    ),
    Effect.mapError((cause) =>
      Schema.is(FleetError)(cause)
        ? cause
        : new FleetError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
    ),
  );

const readStringField = (value: unknown, field: string): string | null => {
  if (value !== null && typeof value === "object") {
    const candidate = (value as Record<string, unknown>)[field];
    return typeof candidate === "string" ? candidate : null;
  }
  return null;
};

export const makeFleetService = Effect.fn("FleetService.make")(function* (
  factory: FleetNativeSocketFactory = globalWebSocketFactory,
): Effect.fn.Return<FleetServiceShape, never, Scope.Scope | ServerSettings.ServerSettingsService> {
  const serviceScope = yield* Scope.Scope;
  const environmentId: EnvironmentId = yield* Effect.serviceOption(
    ServerEnvironment.ServerEnvironment,
  ).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed("env-local" as EnvironmentId),
        onSome: (serverEnvironment) =>
          serverEnvironment.getEnvironmentId.pipe(
            Effect.orElseSucceed(() => "env-local" as EnvironmentId),
          ),
      }),
    ),
  );
  const endpoints = yield* Ref.make(new Map<string, OpenEndpoint>());
  const hub = yield* PubSub.unbounded<FleetStreamEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(hub));
  // Captured at layer build: reading settings per call stays fresh (an
  // endpoint can be configured at any time) without requiring the service
  // from every RPC caller.
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const readEndpointConfigs = (): Effect.Effect<ReadonlyArray<FleetEndpointConfig>, FleetError> =>
    serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new FleetError({
            operation: "list-agents",
            message: `Failed to read server settings: ${String(cause)}`,
          }),
      ),
      Effect.map((settings) => {
        const configs: Array<FleetEndpointConfig> = [];
        for (const [instanceId, entry] of Object.entries(settings.providerInstances)) {
          if (entry.driver !== "codex") continue;
          const decoded = decodeCodexSettings(entry.config ?? {});
          if (Option.isNone(decoded)) continue;
          const endpoint = decoded.value.nativeEndpoint.trim();
          if (!/^wss?:\/\/.+/.test(endpoint)) continue;
          configs.push({ instanceId: instanceId as ProviderInstanceId, url: endpoint });
        }
        return configs;
      }),
    );

  const publish = (event: FleetStreamEvent): Effect.Effect<void> =>
    PubSub.publish(hub, event).pipe(Effect.asVoid);

  const agentIdentity = (instanceId: ProviderInstanceId, nativeThreadId: string): string =>
    fleetAgentId({ environmentId, provider: "codex", instanceId, nativeThreadId });

  const dropEndpoint = (url: string): Effect.Effect<void> =>
    Ref.modify(endpoints, (current) => {
      const open = current.get(url);
      if (open === undefined) return [Effect.void, current] as const;
      const next = new Map(current);
      next.delete(url);
      return [Scope.close(open.scope, Exit.void), next] as const;
    }).pipe(Effect.flatten);

  /**
   * One native JSON-RPC round trip with a bounded wait. Any failure drops
   * the cached socket so the next call redials and re-attaches; the current
   * call still fails (or reports uncertain delivery for sends), never
   * retries blindly.
   */
  const nativeRequest = (
    endpoint: OpenEndpoint,
    operation: FleetError["operation"],
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<unknown, FleetError> =>
    withNativeTimeout(operation, endpoint.client.request(method, params)).pipe(
      Effect.tapError(() => dropEndpoint(endpoint.config.url)),
    );

  function handleNativeNotification(
    endpoint: OpenEndpoint,
    method: string,
    params: unknown,
    at: string,
  ): Effect.Effect<void> {
    const threadId = readStringField(params, "threadId");
    switch (method) {
      case "item/started":
      case "item/completed": {
        const item = (params as Record<string, unknown> | null)?.["item"];
        const turnId = readStringField(params, "turnId");
        if (threadId !== null && turnId !== null) {
          endpoint.activeTurnByThread.set(threadId, turnId);
        }
        if (threadId === null || item === undefined) return Effect.void;
        const event = nativeItemToEvent({ nativeThreadId: threadId, item, at });
        if (event === null) return Effect.void;
        return publish({
          kind: "events-appended",
          agentId: agentIdentity(endpoint.config.instanceId, threadId),
          events: [event],
        });
      }
      case "item/agentMessage/delta": {
        const itemId = readStringField(params, "itemId");
        const delta = readStringField(params, "delta");
        const turnId = readStringField(params, "turnId");
        if (threadId !== null && turnId !== null) {
          endpoint.activeTurnByThread.set(threadId, turnId);
        }
        if (threadId === null || itemId === null || delta === null) return Effect.void;
        const accumulated = applyAgentMessageDelta(endpoint.deltasByItem, { itemId, delta });
        endpoint.deltasByItem.clear();
        for (const [key, value] of accumulated) endpoint.deltasByItem.set(key, value);
        return publish({
          kind: "events-appended",
          agentId: agentIdentity(endpoint.config.instanceId, threadId),
          events: [
            deltaEventOf({
              nativeThreadId: threadId,
              itemId,
              text: accumulated.get(itemId) ?? "",
              at,
            }),
          ],
        });
      }
      case "turn/started": {
        const turn = (params as Record<string, unknown> | null)?.["turn"];
        const turnId = readStringField(turn, "id") ?? readStringField(params, "turnId");
        if (threadId !== null && turnId !== null) {
          endpoint.activeTurnByThread.set(threadId, turnId);
        }
        return Effect.void;
      }
      case "turn/completed":
      case "turn/failed": {
        const turn = (params as Record<string, unknown> | null)?.["turn"];
        const turnId = readStringField(turn, "id") ?? readStringField(params, "turnId");
        if (threadId !== null && turnId !== null) {
          if (endpoint.activeTurnByThread.get(threadId) === turnId) {
            endpoint.activeTurnByThread.delete(threadId);
          }
        }
        if (threadId === null || turnId === null) return Effect.void;
        return publish({
          kind: "events-appended",
          agentId: agentIdentity(endpoint.config.instanceId, threadId),
          events: [
            {
              id: `turn:${turnId}`,
              nativeThreadId: threadId,
              kind: method,
              at,
              text: null,
            },
          ],
        });
      }
      case "thread/status/changed": {
        const status = (params as Record<string, unknown> | null)?.["status"];
        if (threadId === null) return Effect.void;
        endpoint.statusByThread.set(threadId, status ?? null);
        if (isNotLoadedStatus(status)) {
          endpoint.activeTurnByThread.delete(threadId);
          return publish({
            kind: "agent-removed",
            agentId: agentIdentity(endpoint.config.instanceId, threadId),
            environmentId,
            instanceId: endpoint.config.instanceId,
            nativeThreadId: threadId,
          });
        }
        if (rawThreadStatusText(status)?.trim().toLowerCase() === "idle") {
          endpoint.activeTurnByThread.delete(threadId);
        }
        return publish({
          kind: "agent-updated",
          agent: {
            environmentId,
            provider: "codex",
            instanceId: endpoint.config.instanceId,
            nativeThreadId: threadId,
            status: toFleetStatus(rawThreadStatusText(status)),
            model: null,
            role: null,
            cwd: null,
            lastSeenAt: at,
          },
        });
      }
      default:
        return Effect.void;
    }
  }

  const pumpNotifications = (endpoint: OpenEndpoint): Effect.Effect<void> =>
    Stream.runForEach(endpoint.client.notifications, (notification) =>
      DateTime.now.pipe(
        Effect.map(DateTime.formatIso),
        Effect.flatMap((at) =>
          handleNativeNotification(endpoint, notification.method, notification.params, at),
        ),
        Effect.catch((cause) =>
          Effect.logDebug("Fleet native notification failed", {
            method: notification.method,
            cause: String(cause),
          }),
        ),
      ),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logDebug("Fleet native notification stream ended", {
          url: endpoint.config.url,
          cause: String(cause),
        }),
      ),
      Effect.forkIn(endpoint.scope),
      Effect.asVoid,
    );

  const ensureEndpoint = Effect.fn("FleetService.ensureEndpoint")(function* (
    config: FleetEndpointConfig,
  ): Effect.fn.Return<OpenEndpoint, FleetError> {
    const cached = yield* Ref.get(endpoints);
    const existing = cached.get(config.url);
    if (existing !== undefined && existing.config.instanceId === config.instanceId) {
      return existing;
    }
    if (existing !== undefined) {
      yield* dropEndpoint(config.url);
    }
    const scope = yield* Scope.fork(serviceScope);
    const client = yield* Scope.provide(scope)(openFleetNativeClient(config.url, factory)).pipe(
      Effect.mapError(
        (cause) =>
          new FleetError({
            operation: "connect-endpoint",
            message: `Native Codex endpoint ${config.url} is unreachable: ${String(cause)}`,
          }),
      ),
      Effect.tapError(() => Scope.close(scope, Exit.void)),
    );
    const endpoint: OpenEndpoint = {
      config,
      client,
      scope,
      statusByThread: new Map(),
      activeTurnByThread: new Map(),
      deltasByItem: new Map(),
      knownThreads: new Set(),
    };
    yield* Ref.update(endpoints, (current) => new Map(current).set(config.url, endpoint));
    yield* pumpNotifications(endpoint);
    return endpoint;
  });

  const listLoadedIds = (
    endpoint: OpenEndpoint,
    operation: FleetError["operation"],
  ): Effect.Effect<ReadonlyArray<string>, FleetError> =>
    Effect.gen(function* () {
      const ids: Array<string> = [];
      let cursor: string | null = null;
      for (;;) {
        const raw = yield* nativeRequest(endpoint, operation, "thread/loaded/list", {
          ...(cursor === null ? {} : { cursor }),
        });
        const page = decodeLoadedThreadIds(raw);
        if (page === null) {
          return yield* failFleet<ReadonlyArray<string>>(
            operation,
            "The native server returned an unreadable thread list.",
          );
        }
        ids.push(...page.ids);
        if (page.nextCursor === null) return ids;
        cursor = page.nextCursor;
      }
    });

  const readStatusOf = (reads: ReadonlyArray<unknown>, threadId: string): unknown => {
    for (const read of reads) {
      if (read !== null && typeof read === "object") {
        const thread = (read as { readonly thread?: unknown }).thread;
        if (thread !== null && typeof thread === "object") {
          const record = thread as Record<string, unknown>;
          if (record["id"] === threadId) return record["status"] ?? null;
        }
      }
    }
    return null;
  };

  const recordResumeState = (endpoint: OpenEndpoint, threadId: string, resumed: unknown) =>
    Effect.sync(() => {
      if (resumed !== null && typeof resumed === "object") {
        const thread = (resumed as { readonly thread?: unknown }).thread as
          | NativeThread
          | undefined;
        if (thread !== undefined && thread !== null && typeof thread === "object") {
          endpoint.statusByThread.set(threadId, thread.status ?? null);
        }
      }
    });

  const unreachable = (config: FleetEndpointConfig, cause: unknown): Effect.Effect<void, never> =>
    publish({
      kind: "endpoint-unreachable",
      instanceId: config.instanceId,
      message: Schema.is(FleetError)(cause) ? cause.message : String(cause),
    });

  const discoverEndpoint = Effect.fn("FleetService.discoverEndpoint")(function* (
    endpoint: OpenEndpoint,
    at: string,
  ): Effect.fn.Return<ReadonlyArray<FleetAgent>, FleetError> {
    const ids = yield* listLoadedIds(endpoint, "list-agents");
    // A failed per-thread read aborts discovery: the caller surfaces an
    // endpoint notice and the next call redials. A silent partial listing
    // would be worse than a loud one.
    const reads: Array<unknown> = [];
    for (const id of ids) {
      reads.push(
        yield* nativeRequest(endpoint, "list-agents", "thread/read", {
          threadId: id,
        }),
      );
    }
    const agents = yield* discoverFleetAgents({
      environmentId,
      instanceId: endpoint.config.instanceId,
      threadReads: reads,
      seenAt: at,
    }).pipe(
      Effect.mapError(
        () =>
          new FleetError({
            operation: "list-agents",
            message: "The native server returned an unreadable thread.",
          }),
      ),
    );
    const seen = new Set(agents.map((agent) => agent.nativeThreadId));
    for (const previous of endpoint.knownThreads) {
      if (!seen.has(previous)) {
        endpoint.knownThreads.delete(previous);
        endpoint.activeTurnByThread.delete(previous);
        endpoint.statusByThread.delete(previous);
        yield* publish({
          kind: "agent-removed",
          agentId: agentIdentity(endpoint.config.instanceId, previous),
          environmentId,
          instanceId: endpoint.config.instanceId,
          nativeThreadId: previous,
        });
      }
    }
    for (const agent of agents) {
      endpoint.knownThreads.add(agent.nativeThreadId);
      const status = readStatusOf(reads, agent.nativeThreadId);
      endpoint.statusByThread.set(agent.nativeThreadId, status);
      if (isAttachableStatus(status)) {
        yield* nativeRequest(endpoint, "list-agents", "thread/resume", {
          threadId: agent.nativeThreadId,
          excludeTurns: true,
        }).pipe(
          Effect.tap((resumed) => recordResumeState(endpoint, agent.nativeThreadId, resumed)),
          Effect.ignore,
        );
      }
      yield* publish({ kind: "agent-updated", agent });
    }
    return agents;
  });

  const listAgents = Effect.fn("FleetService.listAgents")(function* (): Effect.fn.Return<
    FleetAgentListResult,
    FleetError
  > {
    const at = DateTime.formatIso(yield* DateTime.now);
    const configs = yield* readEndpointConfigs();
    const agents: Array<FleetAgent> = [];
    for (const config of configs) {
      const endpoint = yield* ensureEndpoint(config).pipe(
        Effect.catch((cause) =>
          unreachable(config, cause).pipe(Effect.as(null as OpenEndpoint | null)),
        ),
      );
      if (endpoint === null) continue;
      const discovered = yield* discoverEndpoint(endpoint, at).pipe(
        Effect.catch((cause) =>
          unreachable(config, cause).pipe(Effect.as([] as ReadonlyArray<FleetAgent>)),
        ),
      );
      agents.push(...discovered);
    }
    return { agents, scannedAt: at };
  });

  const endpointFor = Effect.fn("FleetService.endpointFor")(function* (
    instanceId: ProviderInstanceId,
    operation: FleetError["operation"],
  ): Effect.fn.Return<OpenEndpoint, FleetError> {
    const configs = yield* readEndpointConfigs();
    const config = configs.find((entry) => entry.instanceId === instanceId);
    if (config === undefined) {
      return yield* failFleet<OpenEndpoint>(
        operation,
        `Codex instance ${instanceId} has no native fleet endpoint configured.`,
      );
    }
    return yield* ensureEndpoint(config);
  });

  const readThread = Effect.fn("FleetService.readThread")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly nativeThreadId: string;
  }): Effect.fn.Return<FleetThreadHistoryResult, FleetError> {
    const at = DateTime.formatIso(yield* DateTime.now);
    const endpoint = yield* endpointFor(input.instanceId, "read-thread");
    const raw = yield* nativeRequest(endpoint, "read-thread", "thread/read", {
      threadId: input.nativeThreadId,
      includeTurns: true,
    });
    const turns = decodeReadTurns(raw);
    if (turns === null) {
      return yield* failFleet<FleetThreadHistoryResult>(
        "read-thread",
        "The native server returned an unreadable thread.",
      );
    }
    const events = historyEventsOf({
      nativeThreadId: input.nativeThreadId,
      threadRead: raw,
      at,
    });
    if (events === null) {
      return yield* failFleet<FleetThreadHistoryResult>(
        "read-thread",
        "The native server returned an unreadable thread.",
      );
    }
    const status = readStatusOf([raw], input.nativeThreadId);
    if (threadLoadStateOf(status) === "notLoaded") {
      return yield* failFleet<FleetThreadHistoryResult>(
        "read-thread",
        "Native session is not loaded in this backend.",
      );
    }
    const activeTurnId =
      activeTurnOf(turns) ?? endpoint.activeTurnByThread.get(input.nativeThreadId) ?? null;
    if (activeTurnId !== null) endpoint.activeTurnByThread.set(input.nativeThreadId, activeTurnId);
    endpoint.statusByThread.set(input.nativeThreadId, status);
    return {
      agent: {
        environmentId,
        provider: "codex",
        instanceId: input.instanceId,
        nativeThreadId: input.nativeThreadId,
        status: toFleetStatus(rawThreadStatusText(status)),
        model: null,
        role: null,
        cwd: null,
        lastSeenAt: at,
      },
      events,
      activeTurnId,
      fetchedAt: at,
    };
  });

  const sendMessage = Effect.fn("FleetService.sendMessage")(function* (
    input: FleetSendMessageInput,
  ): Effect.fn.Return<FleetMessageDelivery, FleetError> {
    const at = DateTime.formatIso(yield* DateTime.now);
    const text = input.text.trim();
    if (text.length === 0) {
      return yield* failFleet<FleetMessageDelivery>(
        "send-message",
        "Message text is empty. No message was sent.",
      );
    }
    const endpoint = yield* endpointFor(input.instanceId, "send-message");
    const raw = yield* nativeRequest(endpoint, "send-message", "thread/read", {
      threadId: input.nativeThreadId,
    }).pipe(
      Effect.mapError(
        () =>
          new FleetError({
            operation: "send-message",
            message: "The native session could not be read before sending.",
          }),
      ),
    );
    const status = readStatusOf([raw], input.nativeThreadId);
    const turns = decodeReadTurns(raw) ?? [];
    const resolvedTurnId =
      activeTurnOf(turns) ?? endpoint.activeTurnByThread.get(input.nativeThreadId) ?? null;
    const expected = input.expectedActiveTurnId ?? null;
    if (expected !== null && resolvedTurnId !== null && expected !== resolvedTurnId) {
      return {
        kind: "refused",
        reason: "The running turn changed since you read it. Read the thread again before sending.",
        at,
      };
    }
    const decision = decideSend({
      threadId: input.nativeThreadId,
      // A reported running turn means the session is active even when the
      // thread-level status word lags behind (it races sends).
      status: resolvedTurnId !== null ? "active" : toFleetStatus(rawThreadStatusText(status)),
      loadState: threadLoadStateOf(status),
      activeTurnId: resolvedTurnId,
      ownershipKnown: input.ownershipKnown,
      text,
    });
    const recordTurnStarted = (started: unknown) =>
      Effect.sync(() => {
        const turnId =
          readStringField(started, "turnId") ??
          readStringField((started as Record<string, unknown> | null)?.["turn"], "id");
        if (turnId !== null) endpoint.activeTurnByThread.set(input.nativeThreadId, turnId);
      });
    const transport: FleetNativeTransport = {
      steerTurn: (params) =>
        nativeRequest(endpoint, "send-message", "turn/steer", {
          threadId: params.threadId,
          expectedTurnId: params.expectedTurnId,
          input: buildSteerInput(params.text),
        }),
      startTurn: (params) =>
        nativeRequest(endpoint, "send-message", "turn/start", {
          threadId: params.threadId,
          input: buildSteerInput(params.text),
        }).pipe(Effect.tap((started) => recordTurnStarted(started))),
    };
    return yield* executeSend(transport, decision, at);
  });

  const subscribe: Stream.Stream<FleetStreamEvent, FleetError> = Stream.unwrap(
    Effect.gen(function* () {
      const snapshot = yield* listAgents();
      const initial = snapshot.agents.map(
        (agent) => ({ kind: "agent-updated", agent }) as FleetStreamEvent,
      );
      return Stream.concat(Stream.fromIterable(initial), Stream.fromPubSub(hub));
    }),
  );

  return {
    listAgents: Effect.suspend(() => listAgents()),
    readThread,
    sendMessage,
    subscribe,
  };
});

export const layer = Layer.effect(FleetService, makeFleetService(globalWebSocketFactory));

export const layerWithSocketFactory = (factory: FleetNativeSocketFactory) =>
  Layer.effect(FleetService, makeFleetService(factory));
