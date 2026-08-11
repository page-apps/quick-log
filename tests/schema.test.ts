import { describe, expect, it } from "vitest";
import fixture from "../demo/records.json";
import { normaliseTags, parseCollection, quickLogCollectionSchema } from "../src/lib/schema";

describe("Quick Log collection", () => {
  it("accepts the bundled demo fixture", () => {
    expect(parseCollection(fixture).records).toHaveLength(3);
  });

  it("rejects duplicate record IDs", () => {
    const record = fixture.records[0];
    const result = quickLogCollectionSchema.safeParse({ schemaVersion: 1, records: [record, record] });
    expect(result.success).toBe(false);
  });

  it("normalises comma-separated tags", () => {
    expect(normaliseTags(" Work,decision, work ")).toEqual(["work", "decision"]);
  });
});
