// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

describe("page glow", () => {
  it("maps capture states to glow modes", async () => {
    const { glowModeFor } = await import("../src/background/glow");
    expect(glowModeFor("queued")).toBe("active");
    expect(glowModeFor("analyzing")).toBe("active");
    expect(glowModeFor("completed")).toBe("done");
    expect(glowModeFor("partial-result")).toBe("done");
    expect(glowModeFor("failed")).toBe("error");
    expect(glowModeFor("cancelled")).toBeNull();
  });

  it("injects CSS once, updates the mode, and never throws", async () => {
    vi.resetModules();
    const insertCSS = vi.fn(async () => undefined);
    const executeScript = vi.fn(async () => []);
    (globalThis as unknown as { chrome: unknown }).chrome = { scripting: { insertCSS, executeScript } };
    const { showGlow } = await import("../src/background/glow");
    await showGlow(7, "active");
    await showGlow(7, "active"); // same mode: no re-injection
    expect(insertCSS).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledTimes(1);
    await showGlow(7, "done");
    expect(executeScript).toHaveBeenCalledTimes(2);
    executeScript.mockRejectedValueOnce(new Error("Cannot access contents of the page"));
    await expect(showGlow(8, "active")).resolves.toBeUndefined();
  });

  it("builds a decorative, click-through overlay with text only", async () => {
    const { applyGlow } = await import("../src/background/glow");
    applyGlow("active", "Prepzy is analysing this job");
    const root = document.getElementById("prepzy-glow-root")!;
    expect(root.dataset.mode).toBe("active");
    expect(root.querySelector(".prepzy-text")!.textContent).toBe("Prepzy is analysing this job");
    applyGlow("done", "<b>ready</b>");
    expect(root.dataset.mode).toBe("done");
    expect(root.querySelector("b")).toBeNull(); // text, never HTML
    expect(document.querySelectorAll("#prepzy-glow-root").length).toBe(1);
  });
});
