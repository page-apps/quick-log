import { describe, expect, it } from "vitest";
import { hasDraftContent, isDraft } from "../src/lib/drafts";

describe("local draft validation", () => {
  it("recognises complete persisted drafts", () => {
    expect(isDraft({
      id: "",
      title: "Recovered",
      body: "Still here",
      tags: "local",
      occurredAt: "2026-08-09T11:00",
      savedAt: "2026-08-09T11:01:00.000Z"
    })).toBe(true);
  });

  it("rejects incomplete storage values", () => {
    expect(isDraft({ title: "partial" })).toBe(false);
  });

  it("does not persist an empty editor", () => {
    expect(hasDraftContent({ title: " ", body: "", tags: "" })).toBe(false);
  });
});
