// Line tests cover `<!--line-split-->` markers splitting one reply into several messages.
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import {
  baseDeliveryParams,
  createDeps,
  createFlexMessage,
  LINE_TEST_CFG,
} from "./auto-reply-delivery.test-helpers.js";
import { processLineMessage } from "./markdown-to-line.js";
import { LINE_REPLY_SPLIT_MARKER, splitLineReplyText } from "./reply-split.js";

const M = LINE_REPLY_SPLIT_MARKER;

function realDeps() {
  return createDeps({ processLineMessage, chunkMarkdownText });
}

describe("splitLineReplyText", () => {
  it("returns text without a marker line unchanged", () => {
    expect(splitLineReplyText("plain")).toEqual(["plain"]);
    expect(splitLineReplyText(`inline ${M} stays`)).toEqual([`inline ${M} stays`]);
  });

  it("drops empty parts from leading, trailing and consecutive markers", () => {
    expect(splitLineReplyText(`${M}\nfirst\n\n${M}\n${M}\n  ${M}  \nsecond\n${M}\n`)).toEqual([
      "first",
      "second",
    ]);
    expect(splitLineReplyText(`${M}\n\n${M}`)).toEqual([]);
  });

  it("keeps markers inside fenced code blocks literal", () => {
    expect(splitLineReplyText(`a\n\`\`\`\n${M}\n\`\`\`\n${M}\nb`)).toEqual([
      `a\n\`\`\`\n${M}\n\`\`\``,
      "b",
    ]);
  });
});

describe("deliverLineAutoReply split markers", () => {
  it("sends two text messages for two parts on the reply token", async () => {
    const { deps, replyMessageLine, pushMessagesLine } = realDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: `您好，已收到訂單。\n${M}\n請問需要開立發票嗎？` },
      lineData: {},
      deps,
    });

    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      [
        { type: "text", text: "您好，已收到訂單。" },
        { type: "text", text: "請問需要開立發票嗎？" },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("never sends empty or marker-only messages", async () => {
    const { deps, replyMessageLine } = realDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: `${M}\nfirst\n${M}\n\n${M}\nsecond\n${M}` },
      lineData: {},
      deps,
    });

    const messages = replyMessageLine.mock.calls.flatMap((call) => call[1]);
    expect(messages).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("line-split");
  });

  it("treats a single non-empty part like an unsplit reply", async () => {
    const { deps, replyMessageLine } = realDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: `${M}\nonly part\n${M}` },
      lineData: {},
      deps,
    });

    expect(replyMessageLine.mock.calls.flatMap((call) => call[1])).toEqual([
      { type: "text", text: "only part" },
    ]);
  });

  it("still converts a code block inside a part to Flex in source order", async () => {
    const { deps, replyMessageLine } = realDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: {
        text: `intro\n${M}\nhere is code:\n\n\`\`\`js\nconsole.log(1)\n\`\`\`\n${M}\noutro`,
      },
      lineData: {},
      deps,
    });

    const messages = replyMessageLine.mock.calls.flatMap((call) => call[1]);
    expect(messages.map((message) => message.type)).toEqual(["text", "text", "flex", "text"]);
    expect(messages[0]).toEqual({ type: "text", text: "intro" });
    expect(messages[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("here is code"),
    });
    expect(messages[2]).toMatchObject({ type: "flex", altText: "Code" });
    expect(messages[3]).toEqual({ type: "text", text: "outro" });
  });

  it("keeps channelData rich messages after the split text", async () => {
    const lineData = { flexMessage: { altText: "Order", contents: { type: "bubble" } } };
    const { deps, replyMessageLine } = realDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: `one\n${M}\ntwo`, channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(replyMessageLine.mock.calls.flatMap((call) => call[1])).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      createFlexMessage("Order", { type: "bubble" }),
    ]);
  });

  it("uses the reply token for the first five parts and pushes the rest", async () => {
    const { deps, replyMessageLine, pushMessagesLine } = realDeps();
    const parts = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: parts.join(`\n${M}\n`) },
      lineData: {},
      deps,
    });

    expect(result).toMatchObject({ status: "delivered", replyTokenUsed: true });
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      parts.slice(0, 5).map((text) => ({ type: "text", text })),
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:1",
      parts.slice(5).map((text) => ({ type: "text", text })),
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("keeps quick replies on the final part", async () => {
    const { deps, replyMessageLine } = realDeps();

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: `one\n${M}\ntwo` },
      lineData: { quickReplies: ["Yes", "No"] },
      deps,
    });

    expect(replyMessageLine.mock.calls.flatMap((call) => call[1])).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two", quickReply: { items: ["Yes", "No"] } },
    ]);
  });
});
