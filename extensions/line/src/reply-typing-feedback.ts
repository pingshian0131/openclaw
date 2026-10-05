// Line plugin module implements reply typing feedback behavior.
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { showLoadingAnimation } from "./send.js";

// LINE only exposes `chat/loading/start`; there is no endpoint to dismiss an
// animation already in flight. An animation therefore ends when the user
// receives a message or when loadingSeconds elapses, whichever comes first.
//
// The core typing lifecycle seals these callbacks at run completion, so the
// only animation that can outlive a reply is one whose request was already in
// flight. That leaves the window free to favour uninterrupted renewal: the
// keepalive runs on a fixed interval and drops a tick whose predecessor is
// still in flight, so the slack between interval and window has to absorb both
// request latency and event-loop stalls from the agent sharing this process.
// LINE requires a multiple of 5 between 5 and 60.
export const LINE_LOADING_SECONDS = 10;
export const LINE_LOADING_KEEPALIVE_MS = 5_000;

// Long tool-heavy turns should keep the indicator alive, but not indefinitely.
const LINE_REPLY_TYPING_MAX_DURATION_MS = 10 * 60_000;

export type LineReplyTypingFeedback = ReturnType<typeof createTypingCallbacks>;

/**
 * Builds typing callbacks that render LINE's loading animation for one turn.
 *
 * The core typing controller owns the returned callbacks: it refreshes them
 * while the run streams and seals them once the run completes and the
 * dispatcher goes idle, so no `loading/start` is issued after the last reply.
 */
export function createLineReplyTypingFeedback(params: {
  cfg: OpenClawConfig;
  userId: string;
  accountId?: string;
  log: (message: string) => void;
  loadingSeconds?: number;
  keepaliveIntervalMs?: number;
  maxDurationMs?: number;
}): LineReplyTypingFeedback {
  return createTypingCallbacks({
    start: () =>
      showLoadingAnimation(params.userId, {
        cfg: params.cfg,
        accountId: params.accountId,
        loadingSeconds: params.loadingSeconds ?? LINE_LOADING_SECONDS,
      }),
    // No stop(): LINE cannot dismiss an active loading animation on request.
    onStartError: (err) => {
      logTypingFailure({
        log: params.log,
        channel: "line",
        target: params.userId,
        error: err,
      });
    },
    keepaliveIntervalMs: params.keepaliveIntervalMs ?? LINE_LOADING_KEEPALIVE_MS,
    maxDurationMs: params.maxDurationMs ?? LINE_REPLY_TYPING_MAX_DURATION_MS,
  });
}
