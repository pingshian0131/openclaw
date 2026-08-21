// Channel turn admission tests cover stale async contexts inherited from long-lived transports.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../../process/gateway-work-admission.test-helpers.js";
import { runChannelInboundEvent } from "./kernel.js";

describe("channel turn work admission", () => {
  beforeEach(resetGatewayWorkAdmission);
  afterEach(resetGatewayWorkAdmission);

  it("replaces a released admission inherited by a long-lived transport callback", async () => {
    let resolveResult:
      | ((value: { inheritedClosed: boolean; turnClosed: boolean }) => void)
      | undefined;
    const result = new Promise<{ inheritedClosed: boolean; turnClosed: boolean }>((resolve) => {
      resolveResult = resolve;
    });

    await runWithGatewayRootWorkAdmissionForTest(async () => {
      setImmediate(() => {
        const inheritedClosed = isGatewaySubordinateWorkAdmissionClosed();
        let turnClosed = true;
        void runChannelInboundEvent({
          channel: "test",
          raw: {},
          adapter: {
            ingest: () => {
              turnClosed = isGatewaySubordinateWorkAdmissionClosed();
              return null;
            },
            resolveTurn: vi.fn(),
          },
        }).then(() => resolveResult?.({ inheritedClosed, turnClosed }));
      });
    });

    await expect(result).resolves.toEqual({
      inheritedClosed: true,
      turnClosed: false,
    });
  });
});
