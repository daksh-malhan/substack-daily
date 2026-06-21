import { describe, expect, test } from "bun:test";
import { docketStates, INITIAL_STATUS, parseSse, PRESS_STEPS, statusForStage } from "./progress.ts";

describe("docketStates", () => {
  test("first phase is active when nothing is done", () => {
    const states = docketStates([]);
    expect(states.map((s) => s.state)).toEqual(["active", "pending", "pending", "pending"]);
    expect(states[0]!.stage).toBe("pick");
  });
  test("completed phases are done; the next is active", () => {
    const states = docketStates(["pick", "fetch"]);
    expect(states.map((s) => s.state)).toEqual(["done", "done", "active", "pending"]);
  });
  test("all done when every phase completed", () => {
    const states = docketStates(PRESS_STEPS.map((s) => s.stage));
    expect(states.every((s) => s.state === "done")).toBe(true);
  });
});

describe("statusForStage", () => {
  test("maps each completed stage to a forward-looking message", () => {
    expect(INITIAL_STATUS).toContain("Choosing");
    expect(statusForStage("pick")).toContain("archive");
    expect(statusForStage("fetch")).toContain("Sorting");
    expect(statusForStage("curate")).toContain("deep-dives");
    expect(statusForStage("synthesize")).toContain("images");
    expect(statusForStage("persist")).toContain("ready");
    expect(statusForStage("unknown")).toBe("Working…");
  });
});

describe("parseSse", () => {
  test("parses complete events and carries an incomplete remainder", () => {
    const chunk1 = `event: stage\ndata: {"stage":"pick"}\n\nevent: stage\ndata: {"stage":"fetch"}\n\nevent: res`;
    const { events, rest } = parseSse(chunk1);
    expect(events).toEqual([
      { event: "stage", data: `{"stage":"pick"}` },
      { event: "stage", data: `{"stage":"fetch"}` },
    ]);
    expect(rest).toBe("event: res");

    // the remainder completes on the next chunk
    const { events: more } = parseSse(rest + `ult\ndata: {"ok":true}\n\n`);
    expect(more).toEqual([{ event: "result", data: `{"ok":true}` }]);
  });

  test("defaults the event name and joins multi-line data", () => {
    const { events } = parseSse(`data: line1\ndata: line2\n\n`);
    expect(events).toEqual([{ event: "message", data: "line1\nline2" }]);
  });

  test("returns nothing for an empty / partial buffer", () => {
    expect(parseSse("").events).toEqual([]);
    expect(parseSse("event: stage\ndata: {}").events).toEqual([]); // no blank line yet
  });
});
