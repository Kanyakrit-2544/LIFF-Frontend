import type { Db } from "mongodb";
import { COLLECTIONS, type StatusIncidentDoc } from "../db/models";
import { log } from "../logger";
import type { StatusIssue } from "./evaluate";

export interface StatusSink {
  send(issue: StatusIssue): Promise<void>;
}

export class ConsoleStatusSink implements StatusSink {
  async send(issue: StatusIssue): Promise<void> {
    const fields = { code: issue.code, count: issue.count, ageMinutes: issue.ageMinutes };
    if (issue.severity === "critical") log.error("system status incident", fields);
    else log.warn("system status incident", fields);
  }
}

export interface IncidentUpdateResult {
  newlyReported: string[];
  stillOpen: string[];
  resolved: string[];
}

export async function updateStatusIncidents(
  db: Db,
  issues: readonly StatusIssue[],
  sink: StatusSink = new ConsoleStatusSink(),
  now = new Date()
): Promise<IncidentUpdateResult> {
  const collection = db.collection<StatusIncidentDoc>(COLLECTIONS.statusIncidents);
  const current = new Map(issues.map((issue) => [issue.code, issue]));
  const existing = await collection.find({}).toArray();
  const byCode = new Map(existing.map((row) => [row.code, row]));
  const result: IncidentUpdateResult = { newlyReported: [], stillOpen: [], resolved: [] };

  for (const issue of issues) {
    const previous = byCode.get(issue.code);
    if (previous?.status === "open" && previous.reportedAt) {
      await collection.updateOne({ _id: previous._id }, { $set: { lastSeenAt: now }, $inc: { occurrences: 1 } });
      result.stillOpen.push(issue.code);
      continue;
    }
    const firstSeenAt = now;
    await collection.updateOne(
      { _id: issue.code },
      {
        $set: {
          code: issue.code, severity: issue.severity, status: "open", firstSeenAt, lastSeenAt: now,
          reportedAt: null, resolvedAt: null, schemaVersion: 1,
        },
        $inc: { occurrences: 1 },
      },
      { upsert: true }
    );
    await sink.send(issue);
    await collection.updateOne({ _id: issue.code, status: "open" }, { $set: { reportedAt: now } });
    result.newlyReported.push(issue.code);
  }

  for (const row of existing) {
    if (row.status !== "open" || current.has(row.code)) continue;
    await collection.updateOne({ _id: row._id, status: "open" }, { $set: { status: "resolved", resolvedAt: now, lastSeenAt: now } });
    result.resolved.push(row.code);
  }
  return result;
}
