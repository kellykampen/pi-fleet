export const SCHEMA_VERSION = "pi-fleet.spike-interview.v1";
export const TOOL_VERSION = "0.1.0";

const BUCKETS = new Set(["architectural", "technical", "dependency", "product"]);
const DECISION_TYPES = new Set(["single", "multi"]);
const RESULT_STATUSES = new Set([
  "completed",
  "partial",
  "cancelled",
  "timeout",
  "aborted",
  "unavailable",
  "error",
]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function optionLabel(option) {
  return typeof option === "string" ? option : option?.label;
}

function hasAnswer(response) {
  if (!response || !("value" in response)) return false;
  if (typeof response.value === "string") return response.value.trim().length > 0;
  if (Array.isArray(response.value)) return response.value.length > 0;
  return response.value !== null && response.value !== undefined;
}

export function validateQuestions(input) {
  assertObject(input, "questions file");
  if (input.title !== undefined && typeof input.title !== "string") {
    throw new Error("questions file title must be a string");
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    throw new Error("questions file must contain a non-empty questions array");
  }

  const ids = new Set();
  for (const [index, question] of input.questions.entries()) {
    assertObject(question, `question at index ${index}`);
    if (typeof question.id !== "string" || !/^[a-z][a-z0-9-]*-\d{3}$/.test(question.id)) {
      throw new Error(`question at index ${index} must use a stable ID ending in a three-digit number`);
    }
    if (ids.has(question.id)) throw new Error(`duplicate question ID: ${question.id}`);
    ids.add(question.id);

    if (!BUCKETS.has(question.bucket)) {
      throw new Error(`question ${question.id} bucket must be architectural, technical, dependency, or product`);
    }
    if (!question.id.startsWith(`${question.bucket}-`)) {
      throw new Error(`question ${question.id} stable ID must begin with its bucket`);
    }
    if (typeof question.question !== "string" || question.question.trim() === "") {
      throw new Error(`question ${question.id} must contain question text`);
    }
    if (!DECISION_TYPES.has(question.type)) {
      throw new Error(`question ${question.id} must be a single or multi decision`);
    }
    if (!Array.isArray(question.options) || question.options.length < 2) {
      throw new Error(`question ${question.id} must contain at least two options`);
    }

    const labels = question.options.map(optionLabel);
    if (labels.some((label) => typeof label !== "string" || label.trim() === "")) {
      throw new Error(`question ${question.id} options must have non-empty labels`);
    }
    if (new Set(labels).size !== labels.length) {
      throw new Error(`question ${question.id} option labels must be unique`);
    }

    if (question.recommended === undefined) {
      throw new Error(`question ${question.id} must include recommended`);
    }
    const recommendations = Array.isArray(question.recommended)
      ? question.recommended
      : [question.recommended];
    if (question.type === "single" && recommendations.length !== 1) {
      throw new Error(`question ${question.id} recommended must select one option`);
    }
    if (recommendations.length === 0 || recommendations.some((value) => !labels.includes(value))) {
      throw new Error(`question ${question.id} recommended must match its options`);
    }

    if (typeof question.context !== "string" || question.context.trim() === "") {
      throw new Error(`question ${question.id} must include recommendation reasoning/context`);
    }
    if (!new Set(["critical", "minor"]).has(question.weight)) {
      throw new Error(`question ${question.id} weight must be critical or minor`);
    }
    if (question.conviction !== undefined && !new Set(["strong", "slight"]).has(question.conviction)) {
      throw new Error(`question ${question.id} conviction must be strong or slight`);
    }
  }

  return input;
}

function validateResult(result, questionIds) {
  assertObject(result, "interview result");
  if (!RESULT_STATUSES.has(result.status)) {
    throw new Error(`unsupported interview status: ${result.status}`);
  }
  if (!Array.isArray(result.responses)) {
    throw new Error("interview result responses must be an array");
  }

  const responseIds = new Set();
  for (const response of result.responses) {
    assertObject(response, "interview response");
    if (typeof response.id !== "string" || !questionIds.has(response.id)) {
      throw new Error(`interview response has unknown question ID: ${response.id}`);
    }
    if (responseIds.has(response.id)) {
      throw new Error(`interview result contains duplicate response ID: ${response.id}`);
    }
    responseIds.add(response.id);
  }
}

export function buildAuditPayload(questionInput, result, metadata) {
  const validatedQuestions = validateQuestions(questionInput);
  assertObject(metadata, "audit metadata");
  const questionIds = new Set(validatedQuestions.questions.map((question) => question.id));
  validateResult(result, questionIds);

  const answeredIds = new Set(result.responses.filter(hasAnswer).map((response) => response.id));
  const allAnswered = validatedQuestions.questions.every((question) => answeredIds.has(question.id));
  const status = result.status === "completed" && !allAnswered ? "partial" : result.status;

  return {
    schemaVersion: SCHEMA_VERSION,
    sourceSpike: metadata.sourceSpike,
    interviewId: metadata.runId,
    status,
    channel: metadata.channel,
    tool: `agent-interview-cli@${metadata.toolVersion}`,
    startedAt: metadata.startedAt,
    finishedAt: metadata.finishedAt,
    decompositionGate: status === "completed" ? "OPEN" : "BLOCKED",
    questions: validatedQuestions.questions,
    responses: result.responses,
  };
}

function displayValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value === undefined || value === null || value === "") return "_No answer recorded._";
  return String(value);
}

export function renderAuditComment(payload) {
  assertObject(payload, "audit payload");
  const responses = new Map(payload.responses.map((response) => [response.id, response.value]));
  const lines = [
    `## Spike interview audit · ${SCHEMA_VERSION}`,
    "",
    `- **Source spike:** \`${payload.sourceSpike}\``,
    `- **Interview ID:** \`${payload.interviewId}\``,
    `- **Status:** \`${payload.status}\``,
    `- **Channel:** \`${payload.channel}\``,
    `- **Tool:** \`${payload.tool}\``,
    `- **Started:** \`${payload.startedAt}\``,
    `- **Finished:** \`${payload.finishedAt}\``,
    `- **Decomposition gate:** **${payload.decompositionGate}**`,
    "",
  ];

  for (const question of payload.questions) {
    lines.push(`### ${question.id} · ${question.bucket} · ${question.weight}`);
    lines.push("");
    lines.push(`**Question:** ${question.question}`);
    lines.push("");
    lines.push(`**Recommendation:** ${displayValue(question.recommended)}`);
    lines.push("");
    lines.push(`**Conviction:** ${question.conviction ?? "not specified"}`);
    lines.push("");
    lines.push(`**Reasoning/context:** ${question.context}`);
    lines.push("");
    lines.push(`**Answer:** ${displayValue(responses.get(question.id))}`);
    lines.push("");
  }

  lines.push("<details>");
  lines.push("<summary>Machine-readable audit payload</summary>");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(payload, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}
