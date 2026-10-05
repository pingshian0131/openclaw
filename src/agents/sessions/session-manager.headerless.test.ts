// Session manager tests cover headerless transcripts left behind by early reset boundaries.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  replaceTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SessionManager.open headerless transcripts", () => {
  it("adopts a headerless transcript that starts with a reset boundary", async () => {
    // Regression: a /new or /reset before the first message appended the reset boundary into an
    // empty transcript, so the next append skipped the header and every later open threw.
    const dir = tempDirs.make("openclaw-session-manager-");
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "headerless-reset-session";
    const sessionKey = "agent:main:line:direct:headerless";
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(scope, [
      {
        type: "reset",
        id: "reset-1",
        parentId: null,
        timestamp: "2026-10-01T00:00:00.000Z",
        reason: "reset",
      },
      {
        type: "message",
        id: "user-1",
        parentId: "reset-1",
        timestamp: "2026-10-01T00:00:01.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
    ]);

    const manager = SessionManager.open(scope, dir);
    expect(manager.getSessionId()).toBe(sessionId);
    expect(manager.getHeader()).toMatchObject({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
    });
    expect(manager.getEntries().map((entry) => entry.id)).toEqual(["reset-1", "user-1"]);
    const assistantId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });

    const reopened = SessionManager.open(scope, dir);
    expect(reopened.getEntries().map((entry) => entry.id)).toEqual([
      "reset-1",
      "user-1",
      assistantId,
    ]);
  });

  it("still rejects headerless transcripts whose rows are not current-format", async () => {
    const dir = tempDirs.make("openclaw-session-manager-");
    const scope = {
      agentId: "main",
      sessionId: "headerless-legacy-session",
      sessionKey: "agent:main:headerless-legacy-session",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(scope, [
      { type: "message", message: { role: "user", content: "legacy message" } },
    ]);

    expect(() => SessionManager.open(scope, dir)).toThrow(
      "require doctor/import migration before runtime use",
    );
  });
});
