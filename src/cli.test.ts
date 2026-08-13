import { describe, expect, it } from "vitest";
import { main } from "./cli.js";

describe("cli", () => {
  it("prints help", async () => {
    const code = await main(["help"]);
    expect(code).toBe(0);
  });

  it("lists local model ids", async () => {
    const code = await main(["models"]);
    expect(code).toBe(0);
  });

  it("rejects an unknown setup agent", async () => {
    const code = await main(["setup", "nope"]);
    expect(code).toBe(1);
  });
});
