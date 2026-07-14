import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHEMA_VERSION,
  buildAuditPayload,
  renderAuditComment,
  validateQuestions,
} from "../bin/lib/spike-interview.mjs";

const questions = {
  title: "Architecture decisions",
  description: "Review the recommendations.",
  questions: [
    {
      id: "architectural-001",
      bucket: "architectural",
      type: "single",
      question: "Where should the boundary live?",
      options: ["Service", "Library"],
      recommended: "Library",
      conviction: "strong",
      weight: "critical",
      context: "Recommendation reasoning: a library keeps the boundary local and avoids a network hop.",
    },
    {
      id: "product-001",
      bucket: "product",
      type: "multi",
      question: "Which launch surfaces are in scope?",
      options: ["CLI", "Web", "Mobile"],
      recommended: ["CLI", "Web"],
      conviction: "slight",
      weight: "minor",
      context: "Recommendation reasoning: CLI and Web cover current customers without a mobile dependency.",
    },
  ],
};

const metadata = {
  sourceSpike: "FLT-999",
  runId: "flt-999-20260714t120000z-abcd1234",
  channel: "agent-interview-cli/browser",
  toolVersion: "0.1.0",
  startedAt: "2026-07-14T12:00:00.000Z",
  finishedAt: "2026-07-14T12:01:00.000Z",
};

test("validates the versioned spike decision question contract", () => {
  const validated = validateQuestions(structuredClone(questions));
  assert.deepEqual(validated, questions);
});

test("rejects decision IDs that are not stable bucket-number IDs", () => {
  const invalid = structuredClone(questions);
  invalid.questions[0].id = "q1";
  assert.throws(() => validateQuestions(invalid), /stable ID/);
});

test("rejects decisions without a recommendation and reasoning context", () => {
  const noRecommendation = structuredClone(questions);
  delete noRecommendation.questions[0].recommended;
  assert.throws(() => validateQuestions(noRecommendation), /recommended/);

  const noReasoning = structuredClone(questions);
  noReasoning.questions[0].context = "";
  assert.throws(() => validateQuestions(noReasoning), /reasoning\/context/);
});

test("builds a completed audit payload with exact questions and answers", () => {
  const result = {
    status: "completed",
    responses: [
      { id: "architectural-001", value: "Library" },
      { id: "product-001", value: ["CLI", "Web"] },
    ],
  };

  const payload = buildAuditPayload(questions, result, metadata);

  assert.equal(payload.schemaVersion, SCHEMA_VERSION);
  assert.equal(payload.status, "completed");
  assert.equal(payload.decompositionGate, "OPEN");
  assert.deepEqual(payload.questions, questions.questions);
  assert.deepEqual(payload.responses, result.responses);
});

test("marks a nominally completed interview partial when a decision has no answer", () => {
  const payload = buildAuditPayload(
    questions,
    { status: "completed", responses: [{ id: "architectural-001", value: "Library" }] },
    metadata,
  );

  assert.equal(payload.status, "partial");
  assert.equal(payload.decompositionGate, "BLOCKED");
});

test("preserves partial answers for cancelled and timeout interviews", () => {
  for (const status of ["cancelled", "timeout"]) {
    const responses = [{ id: "architectural-001", value: "Service" }];
    const payload = buildAuditPayload(questions, { status, responses }, metadata);
    assert.equal(payload.status, status);
    assert.equal(payload.decompositionGate, "BLOCKED");
    assert.deepEqual(payload.responses, responses);
  }
});

test("renders a human-readable audit plus the complete machine-readable payload", () => {
  const payload = buildAuditPayload(
    questions,
    {
      status: "completed",
      responses: [
        { id: "architectural-001", value: "Library" },
        { id: "product-001", value: ["CLI", "Web"] },
      ],
    },
    metadata,
  );

  const comment = renderAuditComment(payload);
  assert.match(comment, /Spike interview audit · pi-fleet\.spike-interview\.v1/);
  assert.match(comment, /Channel:\*\* `agent-interview-cli\/browser`/);
  assert.match(comment, /### architectural-001 · architectural · critical/);
  assert.match(comment, /\*\*Recommendation:\*\* Library/);
  assert.match(comment, /\*\*Answer:\*\* Library/);

  const jsonBlock = comment.match(/```json\n([\s\S]+)\n```/);
  assert.ok(jsonBlock, "comment contains a JSON audit block");
  let parsedPayload;
  try {
    parsedPayload = JSON.parse(jsonBlock[1]);
  } catch (error) {
    assert.fail(`audit JSON block must parse: ${error}`);
  }
  assert.deepEqual(parsedPayload, payload);
});
