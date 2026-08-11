import { z } from "zod";

const tagSchema = z
  .string()
  .min(1, "Tags cannot be empty")
  .max(30, "Tags must be 30 characters or fewer")
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers, and hyphens in tags");

export const quickLogRecordSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/, "Record ID is invalid"),
  title: z.string().trim().min(1, "Add a title").max(120, "Title must be 120 characters or fewer"),
  body: z.string().trim().min(1, "Write something to remember").max(4_000, "Entry must be 4,000 characters or fewer"),
  tags: z.array(tagSchema).max(8, "Use no more than 8 tags").refine((tags) => new Set(tags).size === tags.length, {
    message: "Tags must be unique"
  }),
  occurredAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true })
});

export const quickLogCollectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.array(quickLogRecordSchema)
  })
  .superRefine(({ records }, context) => {
    const ids = new Set<string>();
    records.forEach((record, index) => {
      if (ids.has(record.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate record id: ${record.id}`,
          path: ["records", index, "id"]
        });
      }
      ids.add(record.id);
      if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
        context.addIssue({
          code: "custom",
          message: "updatedAt cannot be earlier than createdAt",
          path: ["records", index, "updatedAt"]
        });
      }
    });
  });

export type QuickLogRecord = z.infer<typeof quickLogRecordSchema>;
export type QuickLogCollection = z.infer<typeof quickLogCollectionSchema>;

export function parseCollection(input: unknown): QuickLogCollection {
  return quickLogCollectionSchema.parse(input);
}

export function parseCollectionText(input: string): QuickLogCollection {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("The repository returned malformed JSON for data/records.json.");
  }
  return parseCollection(value);
}

export function formatCollection(value: QuickLogCollection): string {
  return `${JSON.stringify(quickLogCollectionSchema.parse(value), null, 2)}\n`;
}

export function normaliseTags(input: string): string[] {
  return [...new Set(input.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

export function createRecordId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const random = crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36).slice(0, 6) ?? "record";
  return `log-${stamp}-${random}`;
}
