/**
 * CodexNativeWs transport tests.
 *
 * An in-memory socket pair stands in for a real TCP WebSocket while the
 * production `openFleetNativeClient` path runs unchanged: the same
 * JSON-RPC framing, request/response matching, and notification fan-out
 * from the vendored protocol layer. A fake native peer replays the proven
 * sequence (initialize, loaded/list, metadata-only resume, steer) and
 * records every frame so tests assert the exact wire params.
 *
 * Delivery is synchronous (no timers, no sleeps): frames move through
 * queues between fibers, and tests yield control with `Effect.yieldNow`
 * until the expected frame lands, failing fast on a bounded poll instead
 * of hanging on a timeout.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  openFleetNativeClient,
  type FleetNativeSocket,
  type FleetNativeSocketFactory,
} from "./CodexNativeWs.ts";
import type * as CodexError from "effect-codex-app-server/errors";

const THREAD_ID = "01a0d431-b396-7023-a2aa-bc7ed6c6bc0c";
const TURN_ID = "01a0d431-b3c1-70e1-957e-88bc5fe51d2b";

interface WireFrame {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
}

interface FakePeer {
  readonly clientSocket: FleetNativeSocket;
  readonly received: Array<WireFrame>;
  readonly notifications: Array<WireFrame>;
  readonly notify: (method: string, params: Record<string, unknown>) => void;
  readonly closePeer: () => void;
}

const makeSocketPair = (): { client: FleetNativeSocket; peer: FakePeer } => {
  const received: Array<WireFrame> = [];
  const notifications: Array<WireFrame> = [];
  let clientHandlers = {
    open: () => {},
    message: (_text: string) => {},
    error: (_cause: unknown) => {},
    close: () => {},
  };
  let peerHandlers = {
    message: (_text: string) => {},
    close: () => {},
  };
  let peerClosed = false;

  // Synchronous delivery: every frame moves through Effect queues between
  // fibers, so no timers or sleeps are needed for the fake to behave.
  const deliverClient = (text: string) => {
    clientHandlers.message(text);
  };
  const deliverPeer = (text: string) => {
    if (!peerClosed) peerHandlers.message(text);
  };

  const parse = (text: string): WireFrame => JSON.parse(text) as WireFrame;

  const peer = {
    message: (text: string) => {
      const frame = parse(text);
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
        respond({ userAgent: "Codex Test/0.156.1", codexHome: "/tmp/codex-home" });
      } else if (method === "thread/loaded/list") {
        const cursor = params["cursor"];
        if (cursor === undefined || cursor === null) {
          respond({ data: [THREAD_ID], nextCursor: "cursor-1" });
        } else {
          respond({ data: [], nextCursor: null });
        }
      } else if (method === "thread/resume") {
        respond({
          thread: {
            id: params["threadId"],
            status: { type: "idle" },
            model: "gpt-5.6-luna",
            turns: [],
          },
          initialTurnsPage: null,
        });
      } else if (method === "thread/read") {
        respond({
          thread: {
            id: params["threadId"],
            status: { type: "idle" },
            model: "gpt-5.6-luna",
            turns: [],
          },
        });
      } else if (method === "turn/steer") {
        respond({ turnId: params["expectedTurnId"] });
      } else if (method === "turn/start") {
        respond({ turn: { id: "turn-new" } });
      } else {
        deliverClient(
          JSON.stringify({ id, error: { code: -32601, message: `unknown ${String(method)}` } }),
        );
      }
    },
  };

  const clientSocket: FleetNativeSocket = {
    send: (text: string) => {
      deliverPeer(text);
    },
    close: () => {
      peerClosed = true;
      clientHandlers.close();
      peerHandlers.close();
    },
    onOpen: (callback: () => void) => {
      clientHandlers.open = callback;
      callback();
    },
    onMessage: (callback: (text: string) => void) => {
      const previous = clientHandlers;
      clientHandlers = { ...previous, message: callback };
    },
    onError: (callback: (cause: unknown) => void) => {
      const previous = clientHandlers;
      clientHandlers = { ...previous, error: callback };
    },
    onClose: (callback: () => void) => {
      const previous = clientHandlers;
      clientHandlers = { ...previous, close: callback };
    },
  };

  peerHandlers.message = peer.message;

  const fakePeer: FakePeer = {
    clientSocket: {
      send: clientSocket.send,
      close: clientSocket.close,
      onOpen: clientSocket.onOpen,
      onMessage: clientSocket.onMessage,
      onError: clientSocket.onError,
      onClose: clientSocket.onClose,
    },
    received,
    notifications,
    notify: (method: string, params: Record<string, unknown>) => {
      deliverClient(JSON.stringify({ method, params }));
    },
    closePeer: () => {
      peerClosed = true;
    },
  };
  return { client: clientSocket, peer: fakePeer };
};

type FleetRequest = (
  method: string,
  params?: Record<string, unknown>,
) => Effect.Effect<unknown, CodexError.CodexAppServerError>;

const withClient = <A>(
  peer: FakePeer,
  use: (request: FleetRequest) => Effect.Effect<A, CodexError.CodexAppServerError>,
): Effect.Effect<A, CodexError.CodexAppServerError, Scope.Scope> =>
  Effect.gen(function* () {
    const factory: FleetNativeSocketFactory = () => peer.clientSocket;
    const client = yield* openFleetNativeClient("ws://127.0.0.1:9/fleet", factory);
    return yield* use((method, params) => client.request(method, params));
  });

/**
 * Yield until `ready()` is true. The protocol drains outbound frames on a
 * forked fiber, so the fake observes them a few yields after the test
 * fiber moves on. Fails fast on a bounded poll instead of sleeping.
 */
const waitFor = (ready: () => Effect.Effect<boolean>): Effect.Effect<void, "fleet-test-timeout"> =>
  Effect.gen(function* () {
    for (let step = 0; step < 1000; step += 1) {
      if (yield* ready()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.fail("fleet-test-timeout" as const);
  });

describe("CodexNativeWs transport", () => {
  it.effect("completes the native handshake on open", () =>
    Effect.gen(function* () {
      const { peer } = makeSocketPair();
      yield* Effect.scoped(
        withClient(peer, (request) =>
          // Await one round trip: the protocol drains outbound frames FIFO,
          // so a completed request proves the earlier `initialized`
          // notification already flushed to the peer.
          request("thread/loaded/list", {}).pipe(Effect.asVoid),
        ),
      );
      yield* waitFor(() => Effect.succeed(peer.notifications.length > 0));
      const initialize = peer.received.find((frame) => frame.method === "initialize");
      expect(initialize).toBeDefined();
      expect((initialize?.params as Record<string, unknown>)?.["capabilities"]).toEqual({
        experimentalApi: true,
      });
      expect(peer.notifications).toContainEqual(expect.objectContaining({ method: "initialized" }));
    }),
  );

  it.effect("matches concurrent requests to their responses", () =>
    Effect.gen(function* () {
      const { peer } = makeSocketPair();
      const results = yield* Effect.scoped(
        withClient(peer, (request) =>
          Effect.all(
            [
              request("thread/loaded/list", {}),
              request("thread/read", { threadId: THREAD_ID, includeTurns: true }),
              request("turn/steer", {
                threadId: THREAD_ID,
                expectedTurnId: TURN_ID,
                input: [{ type: "text", text: "hello", text_elements: [] }],
              }),
            ],
            { concurrency: "unbounded" },
          ),
        ),
      );
      expect((results[0] as { data: Array<string> }).data).toEqual([THREAD_ID]);
      expect((results[1] as { thread: { id: string } }).thread.id).toBe(THREAD_ID);
      expect((results[2] as { turnId: string }).turnId).toBe(TURN_ID);
    }),
  );

  it.effect("pages thread/loaded/list through the cursor", () =>
    Effect.gen(function* () {
      const { peer } = makeSocketPair();
      const ids: Array<string> = [];
      yield* Effect.scoped(
        withClient(peer, (request) =>
          Effect.gen(function* () {
            let cursor: string | null = null;
            for (;;) {
              const page = (yield* request("thread/loaded/list", {
                ...(cursor === null ? {} : { cursor }),
              })) as { data: Array<string>; nextCursor: string | null };
              ids.push(...page.data);
              if (page.nextCursor === null) return;
              cursor = page.nextCursor;
            }
          }),
        ),
      );
      expect(ids).toEqual([THREAD_ID]);
      expect(peer.received.filter((frame) => frame.method === "thread/loaded/list")).toHaveLength(
        2,
      );
    }),
  );

  it.effect("sends metadata-only resume with no settings payload", () =>
    Effect.gen(function* () {
      const { peer } = makeSocketPair();
      yield* Effect.scoped(
        withClient(peer, (request) =>
          request("thread/resume", { threadId: THREAD_ID, excludeTurns: true }),
        ),
      );
      const resume = peer.received.find((frame) => frame.method === "thread/resume");
      expect(resume?.params).toEqual({ threadId: THREAD_ID, excludeTurns: true });
    }),
  );

  it.effect("delivers native notifications to subscribers", () =>
    Effect.gen(function* () {
      const { peer } = makeSocketPair();
      const seen = yield* Ref.make<Array<string>>([]);
      const scope = yield* Scope.make();
      const factory: FleetNativeSocketFactory = () => peer.clientSocket;
      const client = yield* Scope.provide(scope)(
        openFleetNativeClient("ws://127.0.0.1:9/fleet", factory),
      );
      const fiber = yield* Stream.runForEach(client.notifications, (notification) =>
        Ref.update(seen, (current) => [...current, notification.method]),
      ).pipe(Effect.forkDetach);
      peer.notify("item/completed", {
        threadId: THREAD_ID,
        item: { id: "exec-1", type: "commandExecution" },
      });
      peer.notify("turn/completed", { threadId: THREAD_ID, turn: { id: TURN_ID } });
      yield* waitFor(() => Ref.get(seen).pipe(Effect.map((methods) => methods.length >= 2)));
      yield* Fiber.interrupt(fiber);
      yield* Scope.close(scope, Exit.void);
      expect(yield* Ref.get(seen)).toEqual(["item/completed", "turn/completed"]);
    }),
  );

  it.effect("fails pending requests with a protocol error, not a hang", () =>
    Effect.gen(function* () {
      const { peer } = makeSocketPair();
      const tag = yield* Effect.scoped(
        withClient(peer, (request) =>
          request("thread/unknown", {}).pipe(
            Effect.as("ok" as const),
            Effect.catch((error) => Effect.succeed(error._tag)),
          ),
        ),
      );
      expect(tag).toBe("CodexAppServerRequestError");
    }),
  );
});
