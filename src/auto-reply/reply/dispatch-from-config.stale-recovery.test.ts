import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  diagnosticMocks,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  runtimePluginMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let replyRunTesting: typeof import("./reply-run-registry.js").__testing;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

const sessionKey = "agent:main:telegram:direct:1";

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

function createVisibleDispatchParams(replyResolver: () => Promise<ReplyPayload>) {
  return {
    ctx: buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "user:1",
      ChatType: "direct",
      SessionKey: sessionKey,
      MessageThreadId: "501.000",
      BodyForAgent: "second telegram direct turn",
    }),
    cfg: {
      diagnostics: {
        stuckSessionWarnMs: 1_000,
        stuckSessionAbortMs: 1_000,
      },
    } as OpenClawConfig,
    dispatcher: createDispatcher(),
    replyResolver,
  };
}

describe("dispatchReplyFromConfig stale visible admission recovery", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ createReplyOperation, __testing: replyRunTesting } =
      await import("./reply-run-registry.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  });

  beforeEach(() => {
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    runtimePluginMocks.ensureRuntimePluginsLoaded.mockReset();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset();
    setNoAbort();
    diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
  });

  it("waits for fresh visible reply work without invoking diagnostic recovery", async () => {
    vi.useFakeTimers();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    const dispatchParams = createVisibleDispatchParams(replyResolver);
    let settled = false;

    const resultPromise = dispatchReplyFromConfig(dispatchParams).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(false);
    expect(replyResolver).not.toHaveBeenCalled();
    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).not.toHaveBeenCalled();

    activeOperation.complete();
    const result = await resultPromise;

    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("reclaims stale visible reply work through admission and dispatches the turn", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    const dispatchParams = createVisibleDispatchParams(replyResolver);
    vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).not.toHaveBeenCalled();
    expect(activeOperation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("records a terminal processed diagnostic when a heartbeat yields to an active reply operation", async () => {
    // Regression: this heartbeat early-return used to leave only an audit note,
    // so a dropped reply was indistinguishable from "still running" in the
    // diagnostics (the stuck-session symptom). It must emit a terminal
    // `message processed` log without running the resolver or owning delivery.
    diagnosticMocks.logMessageProcessed.mockReset();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    const dispatchParams = {
      ...createVisibleDispatchParams(replyResolver),
      replyOptions: { isHeartbeat: true },
    };

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(result).toMatchObject({ queuedFinal: false });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatchParams.dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "skipped", reason: "reply-operation-active" }),
    );
    activeOperation.complete();
  });
});
