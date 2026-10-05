// Reset boundary tests cover resets that land before a session has persisted its header.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createScope(name: string) {
  const dir = tempDirs.make("openclaw-reset-boundary-header-");
  const sessionId = `${name}-session`;
  return {
    dir,
    scope: {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:line:direct:${name}`,
      storePath: path.join(dir, "sessions.json"),
    },
  };
}

async function expectHealthyAfterNextMessage(params: {
  dir: string;
  scope: ReturnType<typeof createScope>["scope"];
}) {
  await appendTranscriptMessage(params.scope, {
    cwd: params.dir,
    message: { role: "user", content: "first message after reset" },
  });
  const events = (await loadTranscriptEvents(params.scope)) as Array<{ type?: string }>;
  expect(events[0]).toMatchObject({
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.scope.sessionId,
  });
  expect(() => SessionManager.open(params.scope, params.dir)).not.toThrow();
  return events;
}

async function expectHeaderBeforeBoundary(scope: ReturnType<typeof createScope>["scope"]) {
  const events = (await loadTranscriptEvents(scope)) as Array<{ type?: string }>;
  expect(events.map((event) => event.type)).toEqual(["session", "reset"]);
  expect(events[0]).toMatchObject({ version: CURRENT_SESSION_VERSION, id: scope.sessionId });
}

describe("reset boundaries on transcripts without a header", () => {
  it("writes the header before the boundary when sessions.reset hits an empty transcript", async () => {
    const { dir, scope } = createScope("gateway-reset");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });

    await resetSessionEntryLifecycle({
      agentId: "main",
      storePath: scope.storePath,
      resetBoundaryReason: "reset",
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      buildNextEntry: ({ currentEntry }) => ({
        ...currentEntry,
        sessionId: scope.sessionId,
        updatedAt: 2,
      }),
    });

    await expectHeaderBeforeBoundary(scope);
    const events = await expectHealthyAfterNextMessage({ dir, scope });
    expect(events.map((event) => event.type)).toEqual(["session", "reset", "message"]);
  });

  it("writes the header before the boundary when /new runs before the first message", async () => {
    const { dir, scope } = createScope("reply-new");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });

    await applySessionEntryLifecycleMutation({
      agentId: "main",
      activeSessionKey: scope.sessionKey,
      storePath: scope.storePath,
      skipMaintenance: true,
      upserts: [
        {
          sessionKey: scope.sessionKey,
          entry: { sessionId: scope.sessionId, updatedAt: 2 },
          resetBoundaryReason: "new",
        },
      ],
    });

    await expectHeaderBeforeBoundary(scope);
    const events = await expectHealthyAfterNextMessage({ dir, scope });
    expect(events.map((event) => event.type)).toEqual(["session", "reset", "message"]);
  });

  it("still appends the boundary after existing history", async () => {
    const { dir, scope } = createScope("with-history");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      message: { role: "user", content: "before reset" },
    });

    await applySessionEntryLifecycleMutation({
      agentId: "main",
      activeSessionKey: scope.sessionKey,
      storePath: scope.storePath,
      skipMaintenance: true,
      upserts: [
        {
          sessionKey: scope.sessionKey,
          entry: { sessionId: scope.sessionId, updatedAt: 2 },
          resetBoundaryReason: "reset",
        },
      ],
    });

    const events = await expectHealthyAfterNextMessage({ dir, scope });
    expect(events.map((event) => event.type)).toEqual(["session", "message", "reset", "message"]);
  });
});
