// Line plugin module splits one reply into several LINE text bubbles at explicit markers.
import type { ProcessedLineMessage } from "./markdown-to-line.js";

/**
 * A line containing only this marker ends one LINE message and starts the next.
 * It is an HTML comment so renderers that never split (web chat, logs) hide it.
 */
export const LINE_REPLY_SPLIT_MARKER = "<!--line-split-->";

const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/;

function trimBlankEdgeLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

/**
 * Splits reply text at lines that contain only {@link LINE_REPLY_SPLIT_MARKER}.
 *
 * Markers inside fenced code blocks are literal content. Blank parts (leading,
 * trailing or consecutive markers) are dropped, so a marker never yields an
 * empty message. Text without a marker line is returned unchanged as one part.
 */
export function splitLineReplyText(text: string): string[] {
  if (!text.includes(LINE_REPLY_SPLIT_MARKER)) {
    return [text];
  }
  const lines = text.split("\n");
  const parts: string[] = [];
  let current: string[] = [];
  let openFence: string | undefined;
  let sawMarker = false;
  for (const line of lines) {
    const fence = FENCE_PATTERN.exec(line)?.[1];
    if (fence) {
      if (!openFence) {
        openFence = fence;
      } else if (fence[0] === openFence[0] && fence.length >= openFence.length) {
        openFence = undefined;
      }
    }
    if (!openFence && line.trim() === LINE_REPLY_SPLIT_MARKER) {
      sawMarker = true;
      parts.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  parts.push(current.join("\n"));
  if (!sawMarker) {
    return [text];
  }
  return parts.map(trimBlankEdgeLines).filter((part) => part.trim().length > 0);
}

/**
 * Converts reply text into LINE delivery parts, honoring split markers.
 *
 * Without a marker this is exactly `processLineMessage(text)`. With several
 * parts, each part is processed on its own (so tables/code still become Flex)
 * and the results are returned as source-ordered `segments`; each text segment
 * is chunked into its own message(s) by the caller, which is what turns one
 * part into one LINE bubble.
 */
export function processLineReplyText(
  text: string,
  processLineMessage: (text: string) => ProcessedLineMessage,
): ProcessedLineMessage {
  const parts = splitLineReplyText(text);
  if (parts.length === 0) {
    return { text: "", flexMessages: [] };
  }
  if (parts.length === 1) {
    return processLineMessage(parts[0] ?? "");
  }
  const segments: NonNullable<ProcessedLineMessage["segments"]> = [];
  const flexMessages: ProcessedLineMessage["flexMessages"] = [];
  for (const part of parts) {
    const processed = processLineMessage(part);
    const partSegments = processed.segments ?? [
      { type: "text" as const, text: processed.text },
      ...processed.flexMessages.map((message) => ({ type: "flex" as const, message })),
    ];
    for (const segment of partSegments) {
      if (segment.type === "text") {
        if (segment.text.trim()) {
          segments.push(segment);
        }
        continue;
      }
      segments.push(segment);
      flexMessages.push(segment.message);
    }
  }
  return {
    text: segments
      .flatMap((segment) => (segment.type === "text" ? [segment.text] : []))
      .join("\n\n"),
    flexMessages,
    segments,
  };
}
