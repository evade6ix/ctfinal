import { OperationRun } from "../models/OperationRun.js";

function compactErrors(errors) {
  if (!Array.isArray(errors)) return [];

  return errors.slice(0, 100).map((error) => {
    if (typeof error === "string") return { message: error.slice(0, 1000) };
    if (!error || typeof error !== "object") return { message: String(error) };

    return {
      ...error,
      message: error.message ? String(error.message).slice(0, 1000) : undefined,
      stack: undefined,
    };
  });
}

export async function startOperationRun({
  kind,
  label,
  source = "system",
  trigger = "automatic",
  initiatedBy = "system",
  summary = {},
}) {
  try {
    return await OperationRun.create({
      kind,
      label,
      source,
      trigger,
      initiatedBy,
      summary,
      status: "running",
      startedAt: new Date(),
    });
  } catch (error) {
    console.error("[OPERATIONS] Failed to start operation record", error.message);
    return null;
  }
}

export async function finishOperationRun(
  operation,
  { status = "completed", summary = {}, errors = [] } = {}
) {
  if (!operation) return null;

  try {
    const finishedAt = new Date();
    operation.status = status;
    operation.finishedAt = finishedAt;
    operation.durationMs = Math.max(
      0,
      finishedAt.getTime() - new Date(operation.startedAt).getTime()
    );
    operation.summary = summary;
    operation.errorDetails = compactErrors(errors);
    return await operation.save();
  } catch (error) {
    console.error("[OPERATIONS] Failed to finish operation record", error.message);
    return null;
  }
}

export async function recordCompletedOperation({
  kind,
  label,
  source = "system",
  trigger = "automatic",
  initiatedBy = "system",
  startedAt = new Date(),
  status = "completed",
  summary = {},
  errors = [],
}) {
  try {
    const finishedAt = new Date();
    return await OperationRun.create({
      kind,
      label,
      source,
      trigger,
      initiatedBy,
      status,
      summary,
      errorDetails: compactErrors(errors),
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - new Date(startedAt).getTime()),
    });
  } catch (error) {
    console.error("[OPERATIONS] Failed to record operation", error.message);
    return null;
  }
}
