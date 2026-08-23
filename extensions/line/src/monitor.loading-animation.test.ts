// Line tests cover monitor loading-animation lifecycle plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LINE_LOADING_KEEPALIVE_MS, LINE_LOADING_SECONDS } from "./reply-typing-feedback.js";

type LineOnMessage = (ctx: unknown) => Promise<void>;
type LineLoadingOpts = { loadingSeconds?: number };
type ResolvedTurn = {
  replyPipeline?: { typingCallbacks?: { onReplyStart: () => Promise<void> } };
  delivery: { deliver: (payload: unknown, info: unknown) => Promise<void> };
};
type InboundRun = (params: {
  adapter: { resolveTurn: () => ResolvedTurn };
}) => Promise<{ dispatched: boolean }>;

const {
  createLineBotMock,
  showLoadingAnimationMock,
  getUserDisplayNameMock,
  inboundRunMock,
  registerWebhookTargetWithPluginRouteMock,
} = vi.hoisted(() => ({
  createLineBotMock: vi.fn((_opts: { onMessage?: LineOnMessage }) => ({
    account: { accountId: "default" },
    handleWebhook: vi.fn(async () => {}),
  })),
  showLoadingAnimationMock: vi.fn(async (_chatId: string, _opts: LineLoadingOpts) => {}),
  getUserDisplayNameMock: vi.fn(async () => "Tester"),
  inboundRunMock: vi.fn<InboundRun>(),
  registerWebhookTargetWithPluginRouteMock: vi.fn(() => ({ unregister: vi.fn() })),
}));

vi.mock("./bot.js", () => ({
  createLineBot: createLineBotMock,
}));

vi.mock("./runtime.js", () => ({
  getLineRuntime: () => ({
    channel: {
      inbound: { run: inboundRunMock },
      session: { recordInboundSession: vi.fn() },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
    },
  }),
}));

vi.mock("./auto-reply-delivery.js", () => ({
  deliverLineAutoReply: vi.fn(async () => ({ status: "sent", replyTokenUsed: true })),
}));

vi.mock("./markdown-to-line.js", () => ({ processLineMessage: vi.fn() }));
vi.mock("./reply-chunks.js", () => ({ sendLineReplyChunks: vi.fn() }));
vi.mock("./template-messages.js", () => ({ buildTemplateMessageFromPayload: vi.fn() }));
vi.mock("./monitor-durable.js", () => ({ resolveLineDurableReplyOptions: vi.fn(() => ({})) }));

vi.mock("./send.js", () => ({
  createFlexMessage: vi.fn(),
  createImageMessage: vi.fn(),
  createLocationMessage: vi.fn(),
  createQuickReplyItems: vi.fn(),
  createTextMessageWithQuickReplies: vi.fn(),
  getUserDisplayName: getUserDisplayNameMock,
  pushMessageLine: vi.fn(),
  pushMessagesLine: vi.fn(),
  pushTextMessageWithQuickReplies: vi.fn(),
  replyMessageLine: vi.fn(),
  showLoadingAnimation: showLoadingAnimationMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  chunkMarkdownText: vi.fn(),
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    danger: (value: unknown) => String(value),
    logVerbose: vi.fn(),
    waitForAbortSignal: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/webhook-ingress", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-ingress")>(
    "openclaw/plugin-sdk/webhook-ingress",
  );
  return {
    ...actual,
    normalizePluginHttpPath: (path: string | undefined, fallback: string) => path ?? fallback,
    registerWebhookTargetWithPluginRoute: registerWebhookTargetWithPluginRouteMock,
  };
});

let monitorLineProvider: typeof import("./monitor.js").monitorLineProvider;

// The keepalive must renew well inside the loading window; probe past both.
const BEYOND_KEEPALIVE_MS = 30_000;

function lineInboundContext() {
  return {
    ctxPayload: { From: "line:U1", MessageSid: "m-1", RawBody: "hi", BodyForAgent: "hi" },
    turn: { storePath: "/tmp/line-store", record: {} },
    event: { type: "message" },
    userId: "U1",
    groupId: undefined,
    roomId: undefined,
    isGroup: false,
    route: { accountId: "default", agentId: "agent", sessionKey: "line:U1" },
    replyToken: "reply-token",
    accountId: "default",
  };
}

async function captureOnMessage(): Promise<LineOnMessage> {
  await monitorLineProvider({
    channelAccessToken: "token",
    channelSecret: "secret", // pragma: allowlist secret
    config: {} as OpenClawConfig,
    runtime: {} as RuntimeEnv,
  });
  const onMessage = createLineBotMock.mock.calls.at(-1)?.[0]?.onMessage;
  if (!onMessage) {
    throw new Error("expected LINE bot onMessage handler");
  }
  return onMessage;
}

describe("monitorLineProvider loading animation", () => {
  beforeAll(async () => {
    ({ monitorLineProvider } = await import("./monitor.js"));
  });

  afterAll(() => {
    vi.doUnmock("./bot.js");
    vi.doUnmock("./runtime.js");
    vi.doUnmock("./auto-reply-delivery.js");
    vi.doUnmock("./markdown-to-line.js");
    vi.doUnmock("./reply-chunks.js");
    vi.doUnmock("./template-messages.js");
    vi.doUnmock("./monitor-durable.js");
    vi.doUnmock("./send.js");
    vi.doUnmock("openclaw/plugin-sdk/reply-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    showLoadingAnimationMock.mockClear();
    getUserDisplayNameMock.mockClear();
    createLineBotMock.mockClear();
    inboundRunMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the loading animation to the core typing lifecycle", async () => {
    let resolvedTurn: ResolvedTurn | undefined;
    inboundRunMock.mockImplementation(async (params) => {
      resolvedTurn = params.adapter.resolveTurn();
      return { dispatched: true };
    });

    const onMessage = await captureOnMessage();
    const startCalls = showLoadingAnimationMock.mock.calls.length;
    await onMessage(lineInboundContext());

    // The animation doubles as the read receipt, so it starts up front.
    expect(showLoadingAnimationMock.mock.calls.length).toBeGreaterThan(startCalls);
    // Core owns run-complete and dispatch-idle; a hand-rolled keepalive cannot
    // see either and renews past the final reply.
    expect(resolvedTurn?.replyPipeline?.typingCallbacks).toBeDefined();
  });

  it("renews well inside each animation window", async () => {
    inboundRunMock.mockImplementation(async (params) => {
      params.adapter.resolveTurn();
      return { dispatched: true };
    });

    const onMessage = await captureOnMessage();
    await onMessage(lineInboundContext());

    expect(showLoadingAnimationMock).toHaveBeenCalled();
    for (const [, opts] of showLoadingAnimationMock.mock.calls) {
      expect(opts.loadingSeconds).toBe(LINE_LOADING_SECONDS);
    }
  });

  it("uses a loading window LINE accepts, with slack for a stalled renewal", () => {
    // LINE rejects anything that is not a multiple of 5 between 5 and 60.
    expect(LINE_LOADING_SECONDS % 5).toBe(0);
    expect(LINE_LOADING_SECONDS).toBeGreaterThanOrEqual(5);
    expect(LINE_LOADING_SECONDS).toBeLessThanOrEqual(60);

    // The keepalive drops a tick whose predecessor is still in flight, so one
    // skipped renewal must not be able to expose a gap in the animation.
    const slackMs = LINE_LOADING_SECONDS * 1000 - LINE_LOADING_KEEPALIVE_MS;
    expect(slackMs).toBeGreaterThanOrEqual(LINE_LOADING_KEEPALIVE_MS);

    // A stranded animation runs its full window, so keep that bounded too.
    expect(LINE_LOADING_SECONDS).toBeLessThanOrEqual(10);
  });

  it("does not start a loading animation from the delivery path", async () => {
    let deliverAnimationCalls = 0;
    inboundRunMock.mockImplementation(async (params) => {
      const resolved = params.adapter.resolveTurn();
      const beforeDeliver = showLoadingAnimationMock.mock.calls.length;
      await resolved.delivery.deliver({ channelData: {} }, { kind: "final" });
      deliverAnimationCalls = showLoadingAnimationMock.mock.calls.length - beforeDeliver;
      return { dispatched: true };
    });

    const onMessage = await captureOnMessage();
    await onMessage(lineInboundContext());

    // Starting an animation right before the reply it precedes races that reply;
    // when the start lands second nothing is left to dismiss it.
    expect(deliverAnimationCalls).toBe(0);
  });

  it("stops renewing the animation once the turn finishes", async () => {
    inboundRunMock.mockImplementation(async (params) => {
      params.adapter.resolveTurn();
      return { dispatched: true };
    });

    const onMessage = await captureOnMessage();
    await onMessage(lineInboundContext());
    const afterTurn = showLoadingAnimationMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(BEYOND_KEEPALIVE_MS);

    // A tick landing after the last reply would strand the animation for its
    // full window, so the callbacks must be sealed by the end of the turn.
    expect(showLoadingAnimationMock.mock.calls.length).toBe(afterTurn);
  });

  it("stops renewing the animation when the turn throws before dispatch", async () => {
    inboundRunMock.mockImplementation(async () => {
      throw new Error("gateway draining");
    });

    const onMessage = await captureOnMessage();
    await onMessage(lineInboundContext());
    const afterTurn = showLoadingAnimationMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(BEYOND_KEEPALIVE_MS);

    expect(showLoadingAnimationMock.mock.calls.length).toBe(afterTurn);
  });

  it("keeps renewing the animation while the turn is still running", async () => {
    let releaseTurn: (() => void) | undefined;
    inboundRunMock.mockImplementation(async (params) => {
      params.adapter.resolveTurn();
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      return { dispatched: true };
    });

    const onMessage = await captureOnMessage();
    const turn = onMessage(lineInboundContext());
    await vi.advanceTimersByTimeAsync(0);
    const duringTurn = showLoadingAnimationMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(BEYOND_KEEPALIVE_MS);
    expect(showLoadingAnimationMock.mock.calls.length).toBeGreaterThan(duringTurn);

    releaseTurn?.();
    await turn;
  });

  it("skips the animation for group chats", async () => {
    inboundRunMock.mockImplementation(async (params) => {
      const resolved = params.adapter.resolveTurn();
      expect(resolved.replyPipeline?.typingCallbacks).toBeUndefined();
      return { dispatched: true };
    });

    const onMessage = await captureOnMessage();
    await onMessage({ ...lineInboundContext(), isGroup: true, groupId: "G1" });

    expect(showLoadingAnimationMock).not.toHaveBeenCalled();
  });
});
