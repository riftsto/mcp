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
    getSurveySummary: record("getSurveySummary", {
      id: "fuzzy-sleepy-tornado",
      title: "Lunch",
      status: "open",
      created_at: "2026-08-10T00:00:00.000Z",
      expires_at: null,
      url: "https://rifts.to/en/s/fuzzy-sleepy-tornado",
      theme: "default",
      response_count: 3,
      first_response_at: "2026-08-10T01:00:00.000Z",
      last_response_at: "2026-08-10T03:00:00.000Z",
      questions: [
        {
          index: 0,
          type: "multiple_choice",
          text: "Which day?",
          answered: 3,
          unmatched: 0,
          counts: [
            { option: "Monday", count: 2 },
            { option: "Tuesday", count: 0 },
            { option: "Wednesday", count: 1 },
          ],
        },
        {
          index: 1,
          type: "rating",
          text: "How useful?",
          answered: 3,
          mean: 6.67,
          distribution: [
            { value: 4, count: 1 },
            { value: 7, count: 1 },
            { value: 9, count: 1 },
          ],
        },
        { index: 2, type: "free_text", text: "Anything else?", answered: 2 },
      ],
    }),
    cloneSurvey: record("cloneSurvey", {
      id: "spiky-fritter-garlic",
      title: "Lunch, week 2",
      url: "https://rifts.to/en/s/spiky-fritter-garlic",
      admin_token: "tok2",
      admin_url: "https://rifts.to/en/admin/tok2",
      created_at: "2026-08-17T00:00:00.000Z",
      cloned_from: "fuzzy-sleepy-tornado",
      theme: "ocean",
    }),
    saveSurveyAsTemplate: record("saveSurveyAsTemplate", {
      id: "tpl-1",
      name: "Weekly lunch",
      question_count: 3,
      created_at: "2026-08-17T00:00:00.000Z",
      saved_from: "fuzzy-sleepy-tornado",
    }),
    renameSurvey: record("renameSurvey", {
      id: "fuzzy-sleepy-tornado",
      title: "Lunch, renamed",
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
    reopenSurvey: record("reopenSurvey", { id: "fuzzy-sleepy-tornado", status: "open" }),
    updateSurvey: record("updateSurvey", { id: "fuzzy-sleepy-tornado", status: "open" }),
    listTemplates: record("listTemplates", []),
    createTemplate: record("createTemplate", {
      id: "tpl-1",
      name: "Weekly standup",
      questions: [{ index: 0, type: "rating", text: "How's the week going?", scale: { min: 1, max: 10 } }],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }),
    launchTemplate: record("launchTemplate", {
      id: "fuzzy-sleepy-tornado",
      title: "Weekly standup",
      url: "https://rifts.to/en/s/fuzzy-sleepy-tornado",
      admin_token: "tok",
      admin_url: "https://rifts.to/en/admin/tok",
      created_at: "2026-08-10T00:00:00.000Z",
      template_id: "tpl-1",
      theme: "ocean",
    }),
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
  it("exposes exactly the fourteen tools, and no more", async () => {
    const { mcp } = await connect(stubClient().client);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "archive_survey",
      "clone_survey",
      "close_survey",
      "create_survey",
      "create_template",
      "get_survey_results",
      "get_survey_summary",
      "launch_template",
      "list_surveys",
      "list_templates",
      "rename_survey",
      "reopen_survey",
      "save_survey_as_template",
      "update_survey",
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
    expect(annotationsFor("list_templates").readOnlyHint).toBe(true);
    expect(annotationsFor("reopen_survey").readOnlyHint).toBe(false);
    expect(annotationsFor("update_survey").readOnlyHint).toBe(false);
    expect(annotationsFor("launch_template").readOnlyHint).toBe(false);
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

/**
 * The tools added when /api/v1 caught up with the browser: a survey created
 * from a chat client can now be themed, reopened, edited, archived, and
 * launched from a saved template. Each is asserted through the real server for
 * the reason the file's header gives — the wiring between a zod schema and the
 * SDK is what actually breaks.
 */
describe("create_survey — theme", () => {
  it("passes a preset through unchanged", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({
      name: "create_survey",
      arguments: {
        title: "T",
        questions: [{ type: "free_text", text: "Why?" }],
        theme: "ocean",
      },
    });

    expect((firstCall(calls).args[0] as { theme?: unknown }).theme).toBe("ocean");
  });

  it("passes a custom hex pair through as an object", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({
      name: "create_survey",
      arguments: {
        title: "T",
        questions: [{ type: "free_text", text: "Why?" }],
        theme: { primary: "#aa00ff", background: "#101014" },
      },
    });

    expect((firstCall(calls).args[0] as { theme?: unknown }).theme).toEqual({
      primary: "#aa00ff",
      background: "#101014",
    });
  });

  it("refuses a color the API would refuse, before spending a call", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    const res = await mcp.callTool({
      name: "create_survey",
      arguments: {
        title: "T",
        questions: [{ type: "free_text", text: "Why?" }],
        theme: { primary: "puce", background: "#101014" },
      },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a preset name that does not exist", async () => {
    const { client } = stubClient();
    const { mcp } = await connect(client);

    const res = await mcp.callTool({
      name: "create_survey",
      arguments: {
        title: "T",
        questions: [{ type: "free_text", text: "Why?" }],
        theme: "chartreuse",
      },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

describe("reopen_survey", () => {
  it("reopens by id and says the survey is taking answers again", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    const res = await mcp.callTool({
      name: "reopen_survey",
      arguments: { id: "fuzzy-sleepy-tornado" },
    });

    expect(firstCall(calls).method).toBe("reopenSurvey");
    expect(firstCall(calls).args[0]).toBe("fuzzy-sleepy-tornado");
    expect(textOf(res)).toMatch(/open/i);
  });

  it("hands back the expiry refusal rather than reporting success", async () => {
    // The API refuses to reopen an expired survey because flipping the column
    // would change nothing a respondent sees. That distinction is worthless if
    // the tool swallows it.
    const { client } = stubClient({
      reopenSurvey: () => {
        throw new Error(
          "this survey has expired, so reopening it would not accept responses; change its expiry from the admin dashboard first"
        );
      },
    } as unknown as Partial<RiftsClient>);
    const { mcp } = await connect(client);

    const res = await mcp.callTool({
      name: "reopen_survey",
      arguments: { id: "fuzzy-sleepy-tornado" },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/expired/i);
  });
});

describe("update_survey", () => {
  it("repaints a survey without touching anything else", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({
      name: "update_survey",
      arguments: { id: "fuzzy-sleepy-tornado", theme: "forest" },
    });

    const call = firstCall(calls);
    expect(call.method).toBe("updateSurvey");
    expect(call.args[1]).toEqual({ theme: "forest" });
  });

  it("sends a rewritten question list with the rating scale filled in", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({
      name: "update_survey",
      arguments: {
        id: "fuzzy-sleepy-tornado",
        questions: [{ type: "rating", text: "How was it?" }],
      },
    });

    expect(firstCall(calls).args[1]).toEqual({
      questions: [{ type: "rating", text: "How was it?", scale: { min: 1, max: 10 } }],
    });
  });

  it("refuses a call that changes nothing", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    const res = await mcp.callTool({
      name: "update_survey",
      arguments: { id: "fuzzy-sleepy-tornado" },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("relays a refusal that protects collected answers", async () => {
    const { client } = stubClient({
      updateSurvey: () => {
        throw new Error("cannot remove a question once the survey has responses");
      },
    } as unknown as Partial<RiftsClient>);
    const { mcp } = await connect(client);

    const res = await mcp.callTool({
      name: "update_survey",
      arguments: {
        id: "fuzzy-sleepy-tornado",
        questions: [{ type: "free_text", text: "Only one now" }],
      },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/responses/i);
  });
});

describe("archive_survey", () => {
  it("archives by id", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({ name: "archive_survey", arguments: { id: "fuzzy-sleepy-tornado" } });

    expect(firstCall(calls).args[1]).toEqual({ archived: true });
  });

  it("puts one back when asked to restore it", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({
      name: "archive_survey",
      arguments: { id: "fuzzy-sleepy-tornado", restore: true },
    });

    expect(firstCall(calls).args[1]).toEqual({ archived: false });
  });

  it("says archiving leaves the survey running", async () => {
    // The word "archive" reads like "close" to a model that has not been told
    // otherwise, and getting that wrong stops a live poll mid-session.
    const { mcp } = await connect(stubClient().client);
    const { tools } = await mcp.listTools();
    const tool = tools.find((t) => t.name === "archive_survey");

    expect(tool?.description).toMatch(/still|keeps working|does not close/i);
  });
});

describe("templates", () => {
  it("lists them with their question counts", async () => {
    const { client } = stubClient({
      listTemplates: () =>
        Promise.resolve([
          {
            id: "tpl-1",
            name: "Weekly standup",
            questions: [
              { index: 0, type: "rating", text: "How's the week going?", scale: { min: 1, max: 10 } },
            ],
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-02T00:00:00.000Z",
          },
        ]),
    } as unknown as Partial<RiftsClient>);
    const { mcp } = await connect(client);

    const text = textOf(await mcp.callTool({ name: "list_templates", arguments: {} }));

    expect(text).toContain("Weekly standup");
    expect(text).toContain("tpl-1");
    expect(text).toMatch(/1 question/);
  });

  it("says so when there are none, rather than returning an empty list", async () => {
    const { mcp } = await connect(stubClient().client);
    const text = textOf(await mcp.callTool({ name: "list_templates", arguments: {} }));
    expect(text).toMatch(/no templates/i);
  });

  it("saves a question set", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    await mcp.callTool({
      name: "create_template",
      arguments: { name: "Weekly standup", questions: [{ type: "rating", text: "How's the week going?" }] },
    });

    const sent = firstCall(calls).args[0] as { name: string; questions: Array<{ scale?: unknown }> };
    expect(sent.name).toBe("Weekly standup");
    expect(sent.questions[0]?.scale).toEqual({ min: 1, max: 10 });
  });

  it("launches one and returns both links plus the id to read results with", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    const text = textOf(
      await mcp.callTool({ name: "launch_template", arguments: { id: "tpl-1", theme: "ocean" } })
    );

    expect(firstCall(calls).method).toBe("launchTemplate");
    expect(firstCall(calls).args[1]).toEqual({ theme: "ocean" });
    expect(text).toContain("https://rifts.to/en/s/fuzzy-sleepy-tornado");
    expect(text).toContain("https://rifts.to/en/admin/tok");
    expect(text).toContain("fuzzy-sleepy-tornado");
  });

  it("refuses a slug the API would refuse", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);

    const res = await mcp.callTool({
      name: "launch_template",
      arguments: { id: "tpl-1", slug: "Not A Slug" },
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("get_survey_summary", () => {
  it("reads as an answer, and states the zero rather than omitting it", async () => {
    const { client } = stubClient();
    const { mcp } = await connect(client);
    const text = textOf(await mcp.callTool({ name: "get_survey_summary", arguments: { id: "fuzzy-sleepy-tornado" } }));

    expect(text).toContain("Monday: 2");
    // "nobody picked Tuesday" is usually the finding, so a zero has to survive
    // into the prose the model reasons over.
    expect(text).toContain("Tuesday: 0");
    expect(text).toContain("mean 6.67");
  });

  it("says written answers are elsewhere rather than letting the model infer there are none", async () => {
    const { client } = stubClient();
    const { mcp } = await connect(client);
    const text = textOf(await mcp.callTool({ name: "get_survey_summary", arguments: { id: "fuzzy-sleepy-tornado" } }));

    expect(text).toContain("2 written answers");
    expect(text).toContain("get_survey_results");
  });

  it("does not pretend to summarize a survey with no responses", async () => {
    const { client } = stubClient({
      getSurveySummary: (() =>
        Promise.resolve({
          id: "empty-survey-here",
          title: "Empty",
          status: "open",
          created_at: "2026-08-10T00:00:00.000Z",
          expires_at: null,
          url: "https://rifts.to/en/s/empty-survey-here",
          theme: "default",
          response_count: 0,
          first_response_at: null,
          last_response_at: null,
          questions: [],
        })) as unknown as RiftsClient["getSurveySummary"],
    });
    const { mcp } = await connect(client);
    const text = textOf(await mcp.callTool({ name: "get_survey_summary", arguments: { id: "empty-survey-here" } }));

    expect(text).toContain("Nothing to summarize yet");
  });
});

describe("rename_survey", () => {
  it("renames and says what did not change", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);
    const text = textOf(
      await mcp.callTool({ name: "rename_survey", arguments: { id: "fuzzy-sleepy-tornado", title: "Lunch, renamed" } })
    );

    expect(calls).toContainEqual({
      method: "renameSurvey",
      args: ["fuzzy-sleepy-tornado", "Lunch, renamed"],
    });
    expect(text).toContain("Lunch, renamed");
    expect(text).toContain("unchanged");
  });

  it("refuses a title over the 200 characters the API takes", async () => {
    const { mcp } = await connect(stubClient().client);
    const res = await mcp.callTool({
      name: "rename_survey",
      arguments: { id: "fuzzy-sleepy-tornado", title: "x".repeat(201) },
    });
    // Refused here rather than as a 400 the model cannot read its way out of.
    expect(res.isError).toBe(true);
  });
});

describe("clone_survey", () => {
  it("returns both links and names the admin one as a credential", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);
    const text = textOf(await mcp.callTool({ name: "clone_survey", arguments: { id: "fuzzy-sleepy-tornado" } }));

    expect(calls).toContainEqual({ method: "cloneSurvey", args: ["fuzzy-sleepy-tornado", {}] });
    expect(text).toContain("https://rifts.to/en/s/spiky-fritter-garlic");
    expect(text).toContain("https://rifts.to/en/admin/tok2");
    expect(text).toContain("credential");
    expect(text).toContain("no responses");
  });

  it("passes only the fields it was given, so unset ones keep the original's", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);
    await mcp.callTool({ name: "clone_survey", arguments: { id: "fuzzy-sleepy-tornado", title: "Week 2" } });

    // Not `{title, slug: undefined, theme: undefined}`: an explicit undefined
    // theme would read as "no theme" and drop the original's palette.
    expect(calls).toContainEqual({
      method: "cloneSurvey",
      args: ["fuzzy-sleepy-tornado", { title: "Week 2" }],
    });
  });

  it("refuses a malformed custom slug", async () => {
    const { mcp } = await connect(stubClient().client);
    const res = await mcp.callTool({
      name: "clone_survey",
      arguments: { id: "fuzzy-sleepy-tornado", slug: "Not A Slug" },
    });
    expect(res.isError).toBe(true);
  });
});

describe("save_survey_as_template", () => {
  it("saves and points at the tool that runs it again", async () => {
    const { client, calls } = stubClient();
    const { mcp } = await connect(client);
    const text = textOf(
      await mcp.callTool({ name: "save_survey_as_template", arguments: { id: "fuzzy-sleepy-tornado" } })
    );

    expect(calls).toContainEqual({
      method: "saveSurveyAsTemplate",
      args: ["fuzzy-sleepy-tornado", undefined],
    });
    expect(text).toContain("Weekly lunch");
    expect(text).toContain("3 questions");
    expect(text).toContain("launch_template");
  });
});
