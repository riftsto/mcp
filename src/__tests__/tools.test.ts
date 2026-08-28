import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import type { RiftsClient } from "../client.js";

/**
 * Drives the real server over the SDK's in-memory transport rather than
 * calling the formatting helpers directly.
 *
 * The helpers are the easy thing to test and the least useful: what actually
 * breaks in this package is the wiring between a zod schema, the SDK's
 * argument validation, and the shape a tool returns. Going through a real
 * Client exercises all three, so a schema that rejects a valid question or a
 * result the SDK refuses to serialize fails here instead of in somebody's
 * chat window.
 */

/** Records what the tools asked for, and answers with whatever the test set. */
function stubClient(overrides: Partial<RiftsClient> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string, value: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      if (value instanceof Error) throw value;
      return Promise.resolve(value);
    };

  const client = {
    createSurvey: record("createSurvey", {
      id: "fuzzy-sleepy-tornado",
      title: "Lunch",
      url: "https://rifts.to/en/s/fuzzy-sleepy-tornado",
      admin_token: "tok",
      admin_url: "https://rifts.to/en/admin/tok",
      created_at: "2026-08-10T00:00:00.000Z",
    }),
    listSurveys: record("listSurveys", []),
    getSurveyResults: record("getSurveyResults", {
      id: "fuzzy-sleepy-tornado",
      title: "Lunch",
      status: "open",
      url: "https://rifts.to/en/s/fuzzy-sleepy-tornado",
      created_at: "2026-08-10T00:00:00.000Z",
      expires_at: null,
      response_count: 0,
      questions: [],
      responses: [],
    }),
    closeSurvey: record("closeSurvey", { id: "fuzzy-sleepy-tornado", status: "closed" }),
    ...overrides,
  } as unknown as RiftsClient;

  return { client, calls };
}

async function connect(client: RiftsClient) {
  const server = createServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return { mcp, server };
}

/**
 * The recorded call, asserted to exist. `noUncheckedIndexedAccess` is on, so
 * indexing is `T | undefined`; failing here with "no call was recorded" beats
 * a non-null assertion that reports a property access on undefined.
 */
function firstCall(calls: Array<{ method: string; args: unknown[] }>) {
  const call = calls[0];
  if (!call) throw new Error("no call was recorded");
  return call;
}

const textOf = (result: unknown) =>
  ((result as { content: Array<{ type: string; text?: string }> }).content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

describe("tool listing", () => {
  it("exposes exactly the four tools, and no more", async () => {
    const { mcp } = await connect(stubClient().client);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "close_survey",
      "create_survey",
      "get_survey_results",
      "list_surveys",
    ]);
  });

  it("annotates every tool with a title and a read-only or destructive hint", async () => {
    // The Connectors Directory rejects tools missing these, and Claude uses
    // them to decide which calls can run without asking. A tool added later
    // without annotations fails here rather than at review.
    const { mcp } = await connect(stubClient().client);
    const { tools } = await mcp.listTools();

    for (const tool of tools) {
      expect(tool.annotations?.title ?? tool.title, `${tool.name} title`).toBeTruthy();
      const a = tool.annotations ?? {};
      expect(
        a.readOnlyHint === true || a.destructiveHint === true || a.readOnlyHint === false,
        `${tool.name} needs a read-only or destructive hint`
      ).toBe(true);
    }
  });

  it("marks the reads read-only and the writes not", async () => {
    const { mcp } = await connect(stubClient().client);
    const { tools } = await mcp.listTools();
    const annotationsFor = (name: string) => {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is missing`).toBeDefined();
      return tool?.annotations ?? {};
    };

    expect(annotationsFor("list_surveys").readOnlyHint).toBe(true);
    expect(annotationsFor("get_survey_results").readOnlyHint).toBe(true);
    expect(annotationsFor("create_survey").readOnlyHint).toBe(false);
    expect(annotationsFor("close_survey").destructiveHint).toBe(true);
  });

  it("keeps tool names within the 64-character limit the directory enforces", async () => {
    const { mcp } = await connect(stubClient().client);
    const { tools } = await mcp.listTools();
    for (const tool of tools) expect(tool.name.length).toBeLessThanOrEqual(64);
  });

  it("has no description that instructs Claude how to behave", async () => {
    // Directory review rejects descriptions that direct the model rather than
    // describe the tool, and such text is a standing side effect in every
    // conversation the server is connected to.
    const { mcp } = await connect(stubClient().client);
    const { tools } = await mcp.listTools();

    const banned = /\b(confirm with the user|ask the user|only ask for this|you should|make sure to|always call|do not call)\b/i;
    for (const tool of tools) {
      const text = [tool.description, JSON.stringify(tool.inputSchema)].join(" ");
      expect(banned.test(text), `${tool.name} description instructs the model`).toBe(false);
    }
  });
});

describe("create_survey", () => {
  it("accepts all three question types and returns both links", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    const res = await mcp.callTool({
      name: "create_survey",
      arguments: {
        title: "Lunch",
        questions: [
          { type: "multiple_choice", text: "Where?", options: ["Tacos", "Ramen"] },
          { type: "free_text", text: "Why?" },
          { type: "rating", text: "How hungry?" },
        ],
      },
    });

    const text = textOf(res);
    expect(text).toContain("https://rifts.to/en/s/fuzzy-sleepy-tornado");
    expect(text).toContain("https://rifts.to/en/admin/tok");
    expect(firstCall(calls).method).toBe("createSurvey");
  });

  it("supplies the rating scale itself rather than taking one from the caller", async () => {
    // SurveyForm renders a hardcoded 1-10 grid and never reads `scale`, so a
    // caller-chosen range would promise respondents a UI that does not exist.
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({
      name: "create_survey",
      arguments: { title: "T", questions: [{ type: "rating", text: "How hungry?" }] },
    });

    const sent = firstCall(calls).args[0] as { questions: Array<{ scale?: unknown }> };
    expect(sent.questions[0]?.scale).toEqual({ min: 1, max: 10 });
  });

  it("rejects a question shape the rifts.to API would refuse", async () => {
    const { client } = stubClient();
    const { mcp } = await connect(client);

    // Multiple choice with no options: the server-side validator rejects it,
    // so the schema must too rather than letting it become a 400 the model
    // cannot act on.
    const res = await mcp.callTool({
      name: "create_survey",
      arguments: {
        title: "T",
        questions: [{ type: "multiple_choice", text: "Where?", options: [] }],
      },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it("accepts an optional requirement and a conditional one, on all three question types, unchanged", async () => {
    // Omitting `requirement` entirely (the third question here) is the shape
    // every existing caller sends — the regression that matters most is that
    // it still creates exactly as it did before this field existed.
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    const questions = [
      {
        type: "multiple_choice",
        text: "Did you attend?",
        options: ["Yes", "No"],
      },
      {
        type: "free_text",
        text: "What kept you away?",
        requirement: {
          mode: "conditional",
          when: { op: "all", conditions: [{ questionIndex: 0, values: ["No"] }] },
        },
      },
      {
        type: "rating",
        text: "How was it?",
        requirement: { mode: "optional" },
      },
    ];

    await mcp.callTool({
      name: "create_survey",
      arguments: { title: "T", questions },
    });

    const sent = firstCall(calls).args[0] as { questions: unknown[] };
    expect(sent.questions[0]).not.toHaveProperty("requirement");
    expect(sent.questions[1]).toMatchObject(questions[1] as object);
    expect(sent.questions[2]).toMatchObject({
      requirement: { mode: "optional" },
      scale: { min: 1, max: 10 },
    });
  });

  it("rejects a requirement mode the API doesn't have", async () => {
    const { client } = stubClient();
    const { mcp } = await connect(client);

    const res = await mcp.callTool({
      name: "create_survey",
      arguments: {
        title: "T",
        questions: [
          { type: "free_text", text: "Why?", requirement: { mode: "sometimes" } },
        ],
      },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it("lets a forward reference reach the API rather than guessing at the rule itself", async () => {
    // Whether `questionIndex` points strictly earlier depends on every other
    // question in the array, which the server already checks. The schema
    // only validates this question's own shape (a non-negative index), and
    // leaves "earlier than what" to rifts.to's `validateQuestions` — see
    // client.test.ts for the friendly message that 400 turns into.
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({
      name: "create_survey",
      arguments: {
        title: "T",
        questions: [
          {
            type: "free_text",
            text: "Why?",
            requirement: {
              mode: "conditional",
              when: { op: "all", conditions: [{ questionIndex: 1, values: ["No"] }] },
            },
          },
          { type: "multiple_choice", text: "Did you attend?", options: ["Yes", "No"] },
        ],
      },
    });
    expect(calls.length).toBe(1);
  });

  it("rejects an empty question list", async () => {
    const { client } = stubClient();
    const { mcp } = await connect(client);
    const res = await mcp.callTool({
      name: "create_survey",
      arguments: { title: "T", questions: [] },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

describe("list_surveys", () => {
  it("does not ask the API for admin links unless the caller did", async () => {
    // Where the omission actually lives: the API returns admin_url only for
    // include_admin=1, so the tool must not request it by default. Asserting
    // on the rendered text instead would prove nothing, because the formatter
    // faithfully prints whatever the API returned.
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({ name: "list_surveys", arguments: {} });

    const options = firstCall(calls).args[0] as { includeAdmin?: boolean } | undefined;
    expect(options?.includeAdmin).toBeUndefined();
  });

  it("passes include_admin through when the caller does ask", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({ name: "list_surveys", arguments: { include_admin: true } });

    const options = firstCall(calls).args[0] as { includeAdmin?: boolean };
    expect(options.includeAdmin).toBe(true);
  });

  it("renders the admin link when the API returned one", async () => {
    const { client } = stubClient({
      listSurveys: (() =>
        Promise.resolve([
          {
            id: "a",
            title: "A",
            status: "open",
            created_at: "2026-08-10T00:00:00.000Z",
            response_count: 2,
            url: "https://rifts.to/en/s/a",
            admin_url: "https://rifts.to/en/admin/tok",
          },
        ])) as unknown as RiftsClient["listSurveys"],
    });
    const { mcp } = await connect(client);

    const text = textOf(await mcp.callTool({ name: "list_surveys", arguments: { include_admin: true } }));
    expect(text).toContain("https://rifts.to/en/admin/tok");
  });

  it("says so plainly when there is nothing to list", async () => {
    const { mcp } = await connect(stubClient().client);
    const res = await mcp.callTool({ name: "list_surveys", arguments: {} });
    expect(textOf(res)).toMatch(/no surveys/i);
  });
});

describe("get_survey_results", () => {
  it("summarises answers per question instead of dumping rows", async () => {
    const { client } = stubClient({
      getSurveyResults: (() =>
        Promise.resolve({
          id: "a",
          title: "Lunch",
          status: "open",
          url: "https://rifts.to/en/s/a",
          created_at: "2026-08-10T00:00:00.000Z",
          expires_at: null,
          response_count: 3,
          questions: [
            { index: 0, type: "multiple_choice", text: "Where?", options: ["Tacos", "Ramen"] },
            { index: 1, type: "rating", text: "Hunger", scale: { min: 1, max: 10 } },
            { index: 2, type: "free_text", text: "Notes" },
          ],
          responses: [
            { id: "r1", submitted_at: "", answers: { 0: "Tacos", 1: 9, 2: "yes" } },
            { id: "r2", submitted_at: "", answers: { 0: "Tacos", 1: 7 } },
            { id: "r3", submitted_at: "", answers: { 0: "Ramen", 1: 5, 2: "no" } },
          ],
        })) as unknown as RiftsClient["getSurveyResults"],
    });
    const { mcp } = await connect(client);

    const text = textOf(await mcp.callTool({ name: "get_survey_results", arguments: { id: "a" } }));
    expect(text).toContain("Tacos: 2");
    expect(text).toContain("Ramen: 1");
    expect(text).toMatch(/average 7\.0/);
    // A question two of three respondents skipped lists only the real answers.
    expect(text).toContain("yes");
    expect(text).toContain("no");
  });

  it("reads a partly-answered optional question as skipped, not missing", async () => {
    const { client } = stubClient({
      getSurveyResults: (() =>
        Promise.resolve({
          id: "a",
          title: "Lunch",
          status: "open",
          url: "https://rifts.to/en/s/a",
          created_at: "2026-08-10T00:00:00.000Z",
          expires_at: null,
          response_count: 3,
          questions: [
            {
              index: 0,
              type: "multiple_choice",
              text: "Did you attend?",
              options: ["Yes", "No"],
            },
            {
              index: 1,
              type: "free_text",
              text: "What kept you away?",
              requirement: {
                mode: "conditional",
                when: { op: "all", conditions: [{ questionIndex: 0, values: ["No"] }] },
              },
            },
          ],
          responses: [
            { id: "r1", submitted_at: "", answers: { 0: "Yes" } },
            { id: "r2", submitted_at: "", answers: { 0: "No", 1: "Travel" } },
            { id: "r3", submitted_at: "", answers: { 0: "No", 1: "Budget" } },
          ],
        })) as unknown as RiftsClient["getSurveyResults"],
    });
    const { mcp } = await connect(client);

    const text = textOf(await mcp.callTool({ name: "get_survey_results", arguments: { id: "a" } }));
    expect(text).toContain("(required only for some respondents)");
    expect(text).toMatch(/1 response skipped this question — it wasn't required for them/);
  });

  it("says nobody has answered rather than rendering empty sections", async () => {
    const { mcp } = await connect(stubClient().client);
    const text = textOf(await mcp.callTool({ name: "get_survey_results", arguments: { id: "a" } }));
    expect(text).toMatch(/nobody has answered/i);
  });
});

describe("error handling", () => {
  it("returns the API's message as a tool error rather than throwing", async () => {
    // A failed call has to come back as an actionable message. Directory
    // review rejects generic errors, and a thrown transport error tells the
    // model nothing it can relay.
    const { client } = stubClient({
      getSurveyResults: (() => {
        throw new Error("no such survey (or not yours) (404)");
      }) as unknown as RiftsClient["getSurveyResults"],
    });
    const { mcp } = await connect(client);

    const res = await mcp.callTool({ name: "get_survey_results", arguments: { id: "nope" } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toContain("no such survey");
  });
});
