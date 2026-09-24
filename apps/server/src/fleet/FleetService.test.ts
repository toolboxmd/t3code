/**
 * FleetService integration tests.
 *
 * The full production path short of a real Codex binary: real
 * `ServerSettingsService` (in-memory layers, same as serverSettings.test.ts)
 * supplies `CodexSettings.nativeEndpoint`; the real `openFleetNativeClient`
 * dials it through an in-memory socket pair; a fake native peer replays the
 * recorded probe shapes (bare-id loaded list, turns nested in
 * `thread.turns`, metadata-only resume, `expectedTurnId` steer). Assertions
 * cover discovery identity, history, delivery semantics, live subscription,
 * and explicit `notLoaded` refusal.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import type { FleetNativeSocket, FleetNativeSocketFactory } from "./CodexNativeWs.ts";
import { FleetService, layerWithSocketFactory } from "./FleetService.ts";

const THREAD_ID = "01a0d431-b396-7023-a2aa-bc7ed6c6bc0c";
const ACTIVE_TURN_ID = "01a0d431-b3c1-70e1-957e-88bc5fe51d2b";
const ENDPOINT_URL = "ws://127.0.0.1:9/fleet";
const INSTANCE_ID = ProviderInstanceId.make("codex");

type PeerMode = "active" | "idle" | "notLoaded";

interface WireFrame {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const makePeer = (mode: { current: PeerMode }) => {
  const received: Array<WireFrame> = [];
  const notifications: Array<WireFrame> = [];
  let handlers = {
    open: () => {},
    message: (_text: string) => {},
    error: (_cause: unknown) => {},
    close: () => {},
  };

  const deliverClient = (text: string) => {
    handlers.message(text);
  };

  const threadStatus = () =>
    mode.current === "notLoaded" ? { type: "notLoaded" } : { type: "idle" };

  const turns = () =>
    mode.current === "active"
      ? [
          {
            id: ACTIVE_TURN_ID,
            status: "inProgress",
            itemsView: "full",
            items: [
              {
                type: "userMessage",
                id: "01a0d431-baf4-7592-a25e-0fe93a4aa226",
                content: [
                  { type: "text", text: "Bounded native integration probe.", text_elements: [] },
                ],
              },
              {
                type: "agentMessage",
                id: "msg_0f810051548a869a016ab54c57d5e487d299416b59c77c13b9",
                text: "FLEET_MESSAGE_ACK_8426 ORIGINAL_TASK_COMPLETE",
                phase: "final_answer",
              },
            ],
          },
        ]
      : mode.current === "idle"
        ? [{ id: "turn-done", status: "completed", itemsView: "full", items: [] }]
        : [];

  const onMessage = (text: string) => {
    const frame = JSON.parse(text) as WireFrame;
    if (frame.method !== undefined && frame.id === undefined) {
      notifications.push(frame);
      return;
    }
    received.push(frame);
    const id = frame.id;
    const method = frame.method;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const respond = (result: unknown) => {
      deliverClient(JSON.stringify({ id, result }));
    };
    if (method === "initialize") {
      respond({ userAgent: "Codex Test/0.156.1" });
    } else if (method === "thread/loaded/list") {
      respond({ data: [THREAD_ID], nextCursor: null });
    } else if (method === "thread/read") {
      respond({
        thread: {
          id: params["threadId"],
          status: threadStatus(),
          model: "gpt-5.6-luna",
          agentRole: null,
          name: null,
          cwd: "/tmp/t3-fleet-spec/probe",
          turns: turns(),
        },
      });
    } else if (method === "thread/resume") {
      respond({
        thread: {
          id: params["threadId"],
          status: threadStatus(),
          model: "gpt-5.6-luna",
          turns: [],
        },
      });
    } else if (method === "turn/steer") {
      respond({ turnId: params["expectedTurnId"] });
    } else if (method === "turn/start") {
      respond({ turn: { id: "turn-new" } });
    } else {
      deliverClient(JSON.stringify({ id, error: { code: -32601, message: "unknown" } }));
    }
  };

  const clientSocket: FleetNativeSocket = {
    send: (text: string) => {
      onMessage(text);
    },
    close: () => {
      handlers.close();
    },
    onOpen: (callback: () => void) => {
      handlers = { ...handlers, open: callback };
      callback();
    },
    onMessage: (callback: (text: string) => void) => {
      handlers = { ...handlers, message: callback };
    },
    onError: (callback: (cause: unknown) => void) => {
      handlers = { ...handlers, error: callback };
    },
    onClose: (callback: () => void) => {
      handlers = { ...handlers, close: callback };
    },
  };

  const factory: FleetNativeSocketFactory = () => clientSocket;
  return { factory, received, notifications };
};

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-fleet-service-test-",
        }),
      ),
    ),
  );

const configureEndpoint = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
  yield* serverSettings.updateSettings({
    providerInstances: {
      [INSTANCE_ID]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { nativeEndpoint: ENDPOINT_URL },
      },
    },
  });
});

it.layer(NodeServices.layer)("FleetService over the native WS transport", (it) => {
  const testLayer = (factory: FleetNativeSocketFactory) =>
    layerWithSocketFactory(factory).pipe(Layer.provideMerge(makeServerSettingsLayer()));

  it.effect("discovers the native session with stable identity", () =>
    Effect.gen(function* () {
      const peer = makePeer({ current: "active" });
      const result = yield* Effect.gen(function* () {
        const fleet = yield* FleetService;
        yield* configureEndpoint;
        return yield* fleet.listAgents;
      }).pipe(Effect.provide(testLayer(peer.factory)));
      assert.equal(result.agents.length, 1);
      const agent = result.agents[0]!;
      assert.equal(agent.nativeThreadId, THREAD_ID);
      assert.equal(agent.environmentId, "env-local");
      assert.equal(agent.instanceId, INSTANCE_ID);
      assert.equal(agent.provider, "codex");
      assert.equal(agent.model, "gpt-5.6-luna");
      const resume = peer.received.find((frame) => frame.method === "thread/resume");
      assert.deepEqual(resume?.params, { threadId: THREAD_ID, excludeTurns: true });
    }),
  );

  it.effect("reads transcript history with the running turn", () =>
    Effect.gen(function* () {
      const fleet = yield* FleetService;
      yield* configureEndpoint;
      const history = yield* fleet.readThread({
        instanceId: INSTANCE_ID,
        nativeThreadId: THREAD_ID,
      });
      assert.equal(history.activeTurnId, ACTIVE_TURN_ID);
      const texts = history.events.map((event) => event.text).filter((text) => text !== null);
      assert.ok(texts.includes("Bounded native integration probe."));
      assert.ok(texts.includes("FLEET_MESSAGE_ACK_8426 ORIGINAL_TASK_COMPLETE"));
    }).pipe(Effect.provide(testLayer(makePeer({ current: "active" }).factory))),
  );

  it.effect("steers the active turn with the expected turn id", () =>
    Effect.gen(function* () {
      const mode = { current: "active" as PeerMode };
      const peer = makePeer(mode);
      const result = yield* Effect.gen(function* () {
        const fleet = yield* FleetService;
        yield* configureEndpoint;
        return yield* fleet.sendMessage({
          instanceId: INSTANCE_ID,
          nativeThreadId: THREAD_ID,
          text: "Include FLEET_MESSAGE_ACK_8426.",
          expectedActiveTurnId: ACTIVE_TURN_ID,
          ownershipKnown: true,
        });
      }).pipe(Effect.provide(testLayer(peer.factory)));
      assert.equal(result.kind, "steered-active");
      const steer = peer.received.find((frame) => frame.method === "turn/steer");
      assert.deepEqual(steer?.params, {
        threadId: THREAD_ID,
        expectedTurnId: ACTIVE_TURN_ID,
        input: [{ type: "text", text: "Include FLEET_MESSAGE_ACK_8426.", text_elements: [] }],
      });
    }),
  );

  it.effect("refuses a stale expected turn id without sending", () =>
    Effect.gen(function* () {
      const peer = makePeer({ current: "active" });
      const result = yield* Effect.gen(function* () {
        const fleet = yield* FleetService;
        yield* configureEndpoint;
        return yield* fleet.sendMessage({
          instanceId: INSTANCE_ID,
          nativeThreadId: THREAD_ID,
          text: "hello",
          expectedActiveTurnId: "turn-stale",
          ownershipKnown: true,
        });
      }).pipe(Effect.provide(testLayer(peer.factory)));
      assert.equal(result.kind, "refused");
      assert.equal(
        peer.received.some(
          (frame) => frame.method === "turn/steer" || frame.method === "turn/start",
        ),
        false,
      );
    }),
  );

  it.effect("starts an idle follow-up only with confirmed ownership", () =>
    Effect.gen(function* () {
      const peer = makePeer({ current: "idle" });
      const run = (ownershipKnown: boolean) =>
        Effect.gen(function* () {
          const fleet = yield* FleetService;
          yield* configureEndpoint;
          return yield* fleet.sendMessage({
            instanceId: INSTANCE_ID,
            nativeThreadId: THREAD_ID,
            text: "hello",
            expectedActiveTurnId: null,
            ownershipKnown,
          });
        }).pipe(Effect.provide(testLayer(peer.factory)));
      const refused = yield* run(false);
      assert.equal(refused.kind, "refused");
      const queued = yield* run(true);
      assert.equal(queued.kind, "queued-followup");
      const start = peer.received.find((frame) => frame.method === "turn/start");
      assert.deepEqual(start?.params, {
        threadId: THREAD_ID,
        input: [{ type: "text", text: "hello", text_elements: [] }],
      });
    }),
  );

  it.effect("streams agent updates to subscribers", () =>
    Effect.gen(function* () {
      const peer = makePeer({ current: "active" });
      const events = yield* Effect.gen(function* () {
        const fleet = yield* FleetService;
        yield* configureEndpoint;
        return yield* fleet.subscribe.pipe(Stream.take(1), Stream.runCollect);
      }).pipe(Effect.provide(testLayer(peer.factory)));
      assert.equal(events.length, 1);
      const first = events[0]!;
      assert.equal(first.kind, "agent-updated");
      if (first.kind === "agent-updated") {
        assert.equal(first.agent.nativeThreadId, THREAD_ID);
      }
    }),
  );

  it.effect("never attaches or messages a notLoaded session", () =>
    Effect.gen(function* () {
      const peer = makePeer({ current: "notLoaded" });
      const outcome = yield* Effect.gen(function* () {
        const fleet = yield* FleetService;
        yield* configureEndpoint;
        const listed = yield* fleet.listAgents;
        const read = yield* Effect.flip(
          fleet.readThread({ instanceId: INSTANCE_ID, nativeThreadId: THREAD_ID }),
        );
        const sent = yield* fleet.sendMessage({
          instanceId: INSTANCE_ID,
          nativeThreadId: THREAD_ID,
          text: "hello",
          expectedActiveTurnId: null,
          ownershipKnown: true,
        });
        return { listed, read, sent };
      }).pipe(Effect.provide(testLayer(peer.factory)));
      assert.equal(outcome.listed.agents.length, 0);
      assert.equal(outcome.read._tag, "FleetError");
      assert.equal(outcome.sent.kind, "refused");
      assert.equal(
        peer.received.some(
          (frame) =>
            frame.method === "thread/resume" ||
            frame.method === "turn/steer" ||
            frame.method === "turn/start",
        ),
        false,
      );
    }),
  );
});
