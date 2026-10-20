import { DLP_OFF, type DlpSettings } from "@tessera/contract";
import { z } from "zod";
import { pool } from "../db/pool.js";

/** An organisation's data-handling choices, kept in orgs.settings.data. */
export const DataSettingsSchema = z.object({
  /** Keep prompt and answer text (excerpts). Off is metadata-only. */
  excerpts: z.boolean().default(true),
  /** Let people ask Claude to explain a failed tool call: sends its redacted error output to the Claude API. Off unless an owner turns it on. */
  explainFailures: z.boolean().default(false),
  dlp: z
    .object({
      emails: z.boolean().default(false),
      cards: z.boolean().default(false),
      nationalIds: z.boolean().default(false),
      ibans: z.boolean().default(false),
      terms: z.array(z.string().trim().min(2).max(80)).max(200).default([]),
    })
    .default(DLP_OFF),
  /** Days to keep each kind of data; unset uses the server's defaults. */
  retainSamplesDays: z.number().int().min(1).max(3650).nullable().default(null),
  retainEventsDays: z.number().int().min(1).max(3650).nullable().default(null),
  retainSessionsDays: z.number().int().min(1).max(3650).nullable().default(null),
  /** While on, nothing of this organisation's is pruned or erased. */
  legalHold: z.object({ reason: z.string().max(300), by: z.string(), since: z.string() }).nullable().default(null),
});
export type DataSettings = z.infer<typeof DataSettingsSchema> & { dlp: DlpSettings };

export const DEFAULT_DATA: DataSettings = DataSettingsSchema.parse({});

const cache = new Map<string, { v: DataSettings; until: number }>();

export function invalidateDataSettings(orgId: string): void {
  cache.delete(orgId);
}

export async function dataSettingsFor(orgId: string): Promise<DataSettings> {
  const hit = cache.get(orgId);
  if (hit && hit.until > Date.now()) return hit.v;
  const r = await pool.query<{ data: unknown }>("SELECT settings->'data' AS data FROM orgs WHERE id = $1", [orgId]);
  const parsed = DataSettingsSchema.safeParse(r.rows[0]?.data ?? {});
  const v = parsed.success ? parsed.data : DEFAULT_DATA;
  cache.set(orgId, { v, until: Date.now() + 30_000 });
  return v;
}

export async function saveDataSettings(orgId: string, v: DataSettings): Promise<void> {
  await pool.query("UPDATE orgs SET settings = jsonb_set(settings, '{data}', $2::jsonb, true) WHERE id = $1", [orgId, JSON.stringify(v)]);
  invalidateDataSettings(orgId);
}
