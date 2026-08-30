import { describe, expect, it } from "vitest";
import { HttpError } from "./http.js";
import { COMPOSER_MODELS, localModelList, reasoningEffortFromBody, resolveCursorModel } from "./models.js";

describe("resolveCursorModel", () => {
  it("maps catalog fast variants to SDK fast params", () => {
    expect(resolveCursorModel("grok-4.6")).toEqual({
      id: "grok-4.6",
      sdkId: "grok-4.6",
      params: [{ id: "fast", value: "false" }],
      reasoningEffort: null
    });
    expect(resolveCursorModel("grok-4.6-fast")).toEqual({
      id: "grok-4.6-fast",
      sdkId: "grok-4.6",
      params: [{ id: "fast", value: "true" }],
      reasoningEffort: null
    });
  });

  it("encodes effort from model id suffixes", () => {
    expect(resolveCursorModel("grok-4.6-high-fast")).toEqual({
      id: "grok-4.6-high-fast",
      sdkId: "grok-4.6",
      params: [
        { id: "fast", value: "true" },
        { id: "effort", value: "high" }
      ],
      reasoningEffort: "high"
    });
    expect(resolveCursorModel("cursorapi/grok-4.6-xhigh")).toEqual({
      id: "grok-4.6-xhigh",
      sdkId: "grok-4.6",
      params: [
        { id: "fast", value: "false" },
        { id: "effort", value: "xhigh" }
      ],
      reasoningEffort: "xhigh"
    });
  });

  it("lets body reasoning effort override id-encoded effort", () => {
    expect(resolveCursorModel("grok-4.6-low-fast", { reasoningEffort: "high" })).toEqual({
      id: "grok-4.6-high-fast",
      sdkId: "grok-4.6",
      params: [
        { id: "fast", value: "true" },
        { id: "effort", value: "high" }
      ],
      reasoningEffort: "high"
    });
  });

  it("rejects effort on composer", () => {
    expect(() => resolveCursorModel("composer-2.5", { reasoningEffort: "high" })).toThrow(HttpError);
  });

  it("rejects invalid grok effort values", () => {
    expect(() => resolveCursorModel("grok-4.6", { reasoningEffort: "max" })).toThrow(/Invalid reasoning effort/);
    expect(() => resolveCursorModel("grok-4.5", { reasoningEffort: "xhigh" })).toThrow(/Invalid reasoning effort/);
  });

  it("maps OpenAI extra-high to grok xhigh", () => {
    expect(resolveCursorModel("grok-4.6-fast", { reasoningEffort: "extra-high" }).reasoningEffort).toBe("xhigh");
  });

  it("uses reasoning param for gpt-like passthrough models", () => {
    expect(resolveCursorModel("gpt-5.5", { reasoningEffort: "high" })).toMatchObject({
      sdkId: "gpt-5.5",
      params: [{ id: "reasoning", value: "high" }],
      reasoningEffort: "high"
    });
  });
});

describe("localModelList", () => {
  it("reports catalog context_length for Rho-style OpenAI hosts", () => {
    const list = localModelList() as { data: Array<{ id: string; context_length: number }> };
    for (const model of COMPOSER_MODELS) {
      expect(list.data.find((item) => item.id === model.id)).toMatchObject({
        id: model.id,
        object: "model",
        owned_by: "cursor",
        context_length: model.contextWindow
      });
    }
  });
});

describe("reasoningEffortFromBody", () => {
  it("reads reasoning_effort and reasoning.effort", () => {
    expect(reasoningEffortFromBody({ reasoning_effort: "high" })).toBe("high");
    expect(reasoningEffortFromBody({ reasoning: { effort: "low" } })).toBe("low");
    expect(reasoningEffortFromBody({ reasoning_effort: "medium", reasoning: { effort: "low" } })).toBe("medium");
    expect(reasoningEffortFromBody({})).toBeUndefined();
  });
});
