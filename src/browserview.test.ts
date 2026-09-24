import { describe as group, it, expect } from "vitest";
import { describe, shows, askLine, host, type Activity } from "./browserview";

const act = (o: Partial<Activity> = {}): Activity => ({ agent: "Ana", browser: 1, label: "Chrome · GravityCare", tool: "navigate", action: "", at: 1_000_000, paused: false, ...o });

group("browser live view", () => {
  it("says what the agent just did in words", () => {
    expect(describe(act({ tool: "computer", action: "left_click" }))).toBe("Clicked");
    expect(describe(act({ tool: "computer", action: "type" }))).toBe("Typed");
    expect(describe(act({ tool: "form_input" }))).toBe("Filled in a field");
    expect(describe(act({ tool: "something_new" }))).toBe("Used the browser");
  });

  it("shows while the agent browsed in the last 90 seconds, or while you stopped it", () => {
    expect(shows(act(), 1_000_000 + 30_000)).toBe(true);
    expect(shows(act(), 1_000_000 + 120_000)).toBe(false);
    expect(shows(act({ paused: true }), 1_000_000 + 3_600_000)).toBe(true);
    expect(shows(undefined, 0)).toBe(false);
    expect(shows(act({ browser: 0 }), 1_000_000)).toBe(false); // stopped before it ever browsed: nothing to watch yet
  });
});

group("held clicks", () => {
  it("reads as a sentence about the agent", () => {
    expect(askLine({ agent: "Ana", what: 'Click "Đăng"' })).toBe('Ana wants to click "Đăng"');
  });
  it("names the site without www", () => {
    expect(host("https://www.facebook.com/groups/1")).toBe("facebook.com");
    expect(host("not a url")).toBe("");
  });
});
