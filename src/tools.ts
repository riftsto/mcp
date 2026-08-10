/**
 * The four tools, and the text a model actually reads.
 *
 * **Descriptions say what a tool does, never how Claude should behave.** The
 * Connectors Directory rejects descriptions that instruct the model rather
 * than describe the tool, and the rule is a good one independent of review:
 * a description is read in every conversation this server is connected to,
 * so behavioural instructions in it are a standing side effect nobody asked
 * for. Stating that an admin link is a credential is a fact about the return
 * value. Telling Claude to ask permission before returning one is not.
 * Naming when a tool applies ("use this to poll a room") is still a
 * description of the tool's purpose and is fine.
 *
 * Two further rules shape everything here:
 *
 * 1. The input schemas must not accept a question shape rifts.to's own
 *    `validateQuestions` would reject, or the model gets a 400 it cannot fix
 *    from the error text. They may be *narrower* (empty question text is
 *    accepted by the server and refused here), never wider.
 * 2. Every result carries readable prose in `content` and the raw JSON in
 *    `structuredContent`. The prose is what the model reasons over, so a
 *    dump of response rows is the wrong thing to hand it for a 200-response
 *    survey — `get_survey_results` summarises per question and lets
 *    `structuredContent` carry the rows for anything that wants them.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  Question,
  QuestionInput,
  RiftsClient,
  SurveyResults,
  SurveySummary,
} from "./client.js";

/**
 * Rating questions are stored with a `scale`, but `SurveyForm.tsx` renders a
 * hardcoded 1–10 grid and never reads it. Exposing a caller-chosen range would
 * therefore promise respondents a UI that does not exist, so the tool takes no
 * scale and always sends the one the web builder sends.
 */
const RATING_SCALE = { min: 1, max: 10 } as const;

/** Matches isValidCustomSlug in src/lib/slugs.ts. */
const CUSTOM_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const questionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("multiple_choice"),
      text: z.string().min(1).describe("The question, as the respondent reads it."),
      options: z
        .array(z.string().min(1))
        .min(1)
        .describe("The choices. Respondents pick exactly one."),
    }),
    z.object({
      type: z.literal("free_text"),
      text: z.string().min(1).describe("The question, as the respondent reads it."),
    }),
    z.object({
      type: z.literal("rating"),
      text: z
        .string()
        .min(1)
        .describe("The question, as the respondent reads it. Answered on a 1-10 scale."),
    }),
  ])
  .describe("A single question. Questions are answered in the order given.");

/** Registers every tool on `server`. Split out so server.ts stays a wiring file. */
export function registerTools(server: McpServer, client: RiftsClient): void {
  server.registerTool(
    "create_survey",
    {
      title: "Create a survey",
      description:
        "Create a live audience survey on rifts.to and get back the two links that run it: a public URL to share with the audience (anyone with the link can answer, no account or sign-in needed) and an admin URL that shows the results updating in real time. Questions can be multiple choice, free text, or a 1-10 rating, and are answered in the order given. Use this whenever someone wants to poll a room, run a quick vote, or collect open-ended feedback. The survey is open for responses immediately.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(200)
          .describe("The survey title. Respondents see it above the questions."),
        questions: z.array(questionSchema).min(1).describe("At least one question."),
        slug: z
          .string()
          .min(3)
          .max(64)
          .regex(CUSTOM_SLUG, "lowercase letters, digits and single hyphens only")
          .optional()
          .describe(
            "Optional custom link, e.g. 'standup-mood' for rifts.to/en/s/standup-mood. Omit it and rifts.to picks a readable three-word one. Fails if the name is already taken."
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ title, questions, slug }) =>
      run(async () => {
        const survey = await client.createSurvey({
          title,
          questions: questions.map(toQuestionInput),
          ...(slug ? { slug } : {}),
        });

        return result(
          [
            `Created "${survey.title}".`,
            ``,
            `Share this link with the audience: ${survey.url}`,
            `Watch the results here: ${survey.admin_url}`,
            ``,
            `Survey id: ${survey.id} (use it with get_survey_results and close_survey).`,
          ].join("\n"),
          survey as unknown as Record<string, unknown>
        );
      })
  );

  server.registerTool(
    "list_surveys",
    {
      title: "List your surveys",
      description:
        "List the surveys on the authenticated rifts.to account, newest first, with the id, title, open/closed status, response count and public link for each. Use it to find the id of a survey before reading its results or closing it. Archived surveys are never listed. Admin links are left out unless include_admin is set, so a routine listing does not fill the conversation with credentials nobody asked for.",
      inputSchema: {
        include_admin: z
          .boolean()
          .optional()
          .describe(
            "Include each survey's admin link. An admin link is a credential: anyone holding it can read every response and close the survey. Omitted by default."
          ),
        include_closed: z
          .boolean()
          .optional()
          .describe("Include surveys that are already closed. Defaults to true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ include_admin, include_closed }) =>
      run(async () => {
        const surveys = await client.listSurveys({
          ...(include_admin === undefined ? {} : { includeAdmin: include_admin }),
          ...(include_closed === undefined ? {} : { includeClosed: include_closed }),
        });

        return result(formatList(surveys), { surveys: surveys as unknown[] });
      })
  );

  server.registerTool(
    "get_survey_results",
    {
      title: "Read survey results",
      description:
        "Read the answers to one of your surveys. Returns the questions with a summary of how they were answered: the tally per option for multiple choice, the average for ratings, and every free-text answer in full, plus the total response count and the survey's current status. Responses carry no respondent identity: rifts.to never records who answered, so results cannot be attributed to a person.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe(
            "The survey id, e.g. 'fuzzy-sleepy-tornado', the last path segment of the public link. Get it from create_survey or list_surveys."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) =>
      run(async () => {
        const results = await client.getSurveyResults(id);
        return result(formatResults(results), results as unknown as Record<string, unknown>);
      })
  );

  server.registerTool(
    "close_survey",
    {
      title: "Close a survey",
      description:
        "Stop a survey from accepting new responses. The public link keeps working and shows the survey as closed, and the results stay readable with get_survey_results. Closing is not reversible through this server: reopening can only be done from the rifts.to admin dashboard.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("The survey id, e.g. 'fuzzy-sleepy-tornado'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) =>
      run(async () => {
        const closed = await client.closeSurvey(id);
        return result(
          `Closed "${closed.id}". It no longer accepts responses; the results are still readable with get_survey_results.`,
          closed as unknown as Record<string, unknown>
        );
      })
  );
}

/**
 * `scale` is added here rather than in the tool schema — see RATING_SCALE.
 */
function toQuestionInput(question: z.infer<typeof questionSchema>): QuestionInput {
  return question.type === "rating" ? { ...question, scale: { ...RATING_SCALE } } : question;
}

function result(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  // No `outputSchema` on any of these tools, deliberately: the SDK validates
  // results against one when it is declared, which would turn an additive
  // field on a versioned API into a tool failure for every caller running an
  // older copy of this package. The text is the contract for the model.
  return { content: [{ type: "text", text }], structuredContent };
}

/**
 * The SDK already converts a thrown error into an `isError` result, but doing
 * it here keeps the wording ours and independent of the SDK's internals.
 */
async function run(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

function formatList(surveys: SurveySummary[]): string {
  if (surveys.length === 0) {
    return "No surveys on this account yet. create_survey makes one.";
  }

  const lines = surveys.map((s) => {
    const parts = [
      `- ${s.title} [${s.id}]: ${s.status}, ${plural(s.response_count, "response")}`,
      `  ${s.url}`,
    ];
    if (s.admin_url) parts.push(`  admin: ${s.admin_url}`);
    return parts.join("\n");
  });

  return `${plural(surveys.length, "survey")}:\n${lines.join("\n")}`;
}

function formatResults(results: SurveyResults): string {
  const header = [
    `"${results.title}" [${results.id}]: ${results.status}, ${plural(
      results.response_count,
      "response"
    )}`,
    results.url,
  ];

  if (results.response_count === 0) {
    return [...header, "", "Nobody has answered yet."].join("\n");
  }

  const blocks = results.questions.map((question) => {
    // A response that skipped this question has no key for it at all, so an
    // unanswered question is an absence rather than an empty string.
    const answers = results.responses
      .map((r) => r.answers[String(question.index)])
      .filter((a): a is string | number | string[] => a !== undefined && a !== null && a !== "");

    return [`Q${question.index + 1}. ${question.text}`, ...summarise(question, answers)].join("\n");
  });

  return [header.join("\n"), ...blocks].join("\n\n");
}

function summarise(
  question: Question,
  answers: (string | number | string[])[]
): string[] {
  if (answers.length === 0) return ["  (no answers)"];

  switch (question.type) {
    case "multiple_choice": {
      // Seeded from the declared options so a choice nobody picked still shows
      // as 0 rather than vanishing, and counted by string value because that
      // is how an answer is stored — an option renamed after the fact stops
      // matching, which is exactly why the admin UI forbids renaming one.
      const counts = new Map<string, number>(question.options.map((o) => [o, 0]));
      let unrecognised = 0;
      for (const answer of answers) {
        const value = String(answer);
        const current = counts.get(value);
        if (current === undefined) unrecognised++;
        else counts.set(value, current + 1);
      }

      const lines = [...counts].map(
        ([option, count]) =>
          `  ${option}: ${count} (${percent(count, answers.length)})`
      );
      if (unrecognised > 0) {
        lines.push(`  (${unrecognised} answer(s) no longer match any listed option)`);
      }
      return lines;
    }

    case "rating": {
      const values = answers.map(Number).filter((n) => !Number.isNaN(n));
      if (values.length === 0) return ["  (no numeric answers)"];
      const average = values.reduce((a, b) => a + b, 0) / values.length;
      return [
        `  average ${average.toFixed(1)} out of ${question.scale?.max ?? RATING_SCALE.max}, from ${plural(
          values.length,
          "rating"
        )}`,
      ];
    }

    case "free_text":
      return answers.map((a) => `  - ${String(a)}`);
  }
}

const percent = (count: number, total: number) =>
  total === 0 ? "0%" : `${Math.round((count / total) * 100)}%`;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
