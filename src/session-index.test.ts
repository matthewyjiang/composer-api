import { describe, expect, it } from "vitest";
import {
  leftoverAfterTranscript,
  matchPrefixSession,
  matchTranscriptPrefix,
  rememberPrefixSession,
  resetSessionIndex
} from "./session-index.js";

const user = (text: string) => ({ type: "message", role: "user", content: text });
const assistant = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }]
});
const call = (id: string) => ({
  type: "function_call",
  call_id: id,
  name: "read_file",
  arguments: "{\"path\":\"README.md\"}"
});
const output = (id: string, text: string) => ({
  type: "function_call_output",
  call_id: id,
  output: text
});

describe("leftoverAfterTranscript", () => {
  it("treats unmatched current items as a delta", () => {
    expect(leftoverAfterTranscript([user("next")], [user("first")], [assistant("ok")])).toEqual([user("next")]);
  });

  it("drops a resent user turn against stored input", () => {
    expect(leftoverAfterTranscript(
      [user("first"), user("next")],
      [user("first")],
      [assistant("ok")]
    )).toEqual([user("next")]);
  });

  it("drops a replay of input plus output", () => {
    expect(leftoverAfterTranscript(
      [user("first"), assistant("ok"), user("next")],
      [user("first")],
      [assistant("ok")]
    )).toEqual([user("next")]);
  });

  it("strips reattached function_calls after an input prefix", () => {
    const leftover = leftoverAfterTranscript(
      [user("first"), call("call_1"), output("call_1", "docs")],
      [user("first")],
      [call("call_1")]
    );
    expect(leftover).toEqual([output("call_1", "docs")]);
  });
});

describe("matchPrefixSession", () => {
  it("returns leftover and stored transcript for the same first item", () => {
    resetSessionIndex();
    rememberPrefixSession({
      ownerKey: "direct:local",
      sessionKey: "conv_abc",
      inputItems: [user("unique prefix leftover zzz")],
      outputItems: [call("call_1")],
      updatedAt: 1
    });
    const match = matchPrefixSession("direct:local", [
      user("unique prefix leftover zzz"),
      call("call_1"),
      output("call_1", "docs")
    ]);
    expect(match?.sessionKey).toBe("conv_abc");
    expect(match?.newInputItems).toEqual([output("call_1", "docs")]);
    expect(match?.inputItems).toEqual([user("unique prefix leftover zzz")]);
  });

  it("does not match a different first item", () => {
    resetSessionIndex();
    rememberPrefixSession({
      ownerKey: "direct:local",
      sessionKey: "conv_abc",
      inputItems: [user("alpha")],
      outputItems: [],
      updatedAt: 1
    });
    expect(matchPrefixSession("direct:local", [user("beta")])).toBeUndefined();
  });
});

describe("matchTranscriptPrefix", () => {
  it("marks an empty follow-up as matched leftover", () => {
    expect(matchTranscriptPrefix([], [user("first")], [])).toEqual({ leftover: [], matched: true });
  });
});
