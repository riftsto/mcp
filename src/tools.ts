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
import { THEME_PRESETS } from "./client.js";
import type {
  LaunchTemplateInput,
  Question,
  QuestionInput,
  RiftsClient,
  SurveyResults,
  SurveySummary,
  SurveyTheme,
  Template,
  UpdateSurveyInput,
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

/** Matches HEX_RE in src/lib/palette.ts. Six digits, always with the hash. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * A survey's palette. Kept out of `create_survey`'s required fields on
 * purpose: with no `theme`, rifts.to paints the survey in whatever palette the
 * account last saved in the browser, so a default sent from here would quietly
 * override a creator's brand with the house colors every time a model made a
 * survey for them.
 */
const themeSchema = z
  .union([
    z.enum(THEME_PRESETS),
    z.object({
      primary: z
        .string()
        .regex(HEX_COLOR, "a 6-digit hex color like #7c5cfa")
        .describe("The accent color: buttons, links, the selected option."),
      background: z
        .string()
        .regex(HEX_COLOR, "a 6-digit hex color like #09090e")
        .describe("The page background. rifts.to derives text and surface colors from the pair."),
    }),
  ])
  .describe(
    'The colors respondents see. Either one of the presets — "sunset", "ocean", "forest", "rose", "slate" — or your own {primary, background} pair of 6-digit hex colors. "default" is the rifts.to house palette and clears any color a survey already has. Only the respondent page is themed; the results dashboard is not.'
  );

const conditionSchema = z.object({
  questionIndex: z
    .number()
    .int()
    .min(0)
    .describe(
      "The 0-based position, in this same `questions` array, of the multiple-choice question this condition reads — questions have no separate id or index field, position is the only way to refer to one. Must be strictly less than the position of the question this condition belongs to: a condition can only point at an earlier question, never itself or one that comes later. That rule is also why a dependency cycle can never be expressed."
    ),
  values: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "One or more strings, each matching one of the trigger question's `options` exactly. The condition is met if the respondent's answer is any of these (an OR within this one condition)."
    ),
});

const requirementSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("optional") }),
    z.object({
      mode: z.literal("conditional"),
      when: z.object({
        op: z
          .enum(["all", "any"])
          .describe(
            '"all" requires every condition to match (AND); "any" requires at least one (OR).'
          ),
        conditions: z
          .array(conditionSchema)
          .min(1)
          .max(5)
          .describe("1 to 5 conditions, combined by `op`."),
      }),
    }),
  ])
  .describe(
    "Whether an answer to this question is required. Omit this field entirely and the question is required, same as every question has always been — omitting it changes nothing for an existing caller. `optional` lets the respondent skip it outright. `conditional` requires an answer only when `when` matches the respondent's answer(s) to an earlier multiple-choice question; the rest of the time it is optional. Neither mode ever hides the question — this is not branching or skip logic, the question is always shown to every respondent, and only whether an answer is required changes. A question that is not currently required renders with an \"Optional\" marker that appears and disappears live as the trigger question is answered."
  );

const questionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("multiple_choice"),
      text: z.string().min(1).describe("The question, as the respondent reads it."),
      options: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "The choices. Respondents pick exactly one. Also the only values a later question's conditional `requirement` can name in `values` — and the only questions a later `requirement` can point at, since only multiple_choice questions can trigger one."
        ),
      requirement: requirementSchema.optional(),
    }),
    z.object({
      type: z.literal("free_text"),
      text: z.string().min(1).describe("The question, as the respondent reads it."),
      requirement: requirementSchema.optional(),
    }),
    z.object({
      type: z.literal("rating"),
      text: z
        .string()
        .min(1)
        .describe("The question, as the respondent reads it. Answered on a 1-10 scale."),
      requirement: requirementSchema.optional(),
    }),
  ])
  .describe(
    "A single question. Questions are answered in the order given, and that order is also what a `requirement.when.questionIndex` elsewhere in this array refers to."
  );

/** Registers every tool on `server`. Split out so server.ts stays a wiring file. */
export function registerTools(server: McpServer, client: RiftsClient): void {
  server.registerTool(
    "create_survey",
    {
      title: "Create a survey",
      description:
        "Create a live audience survey on rifts.to and get back the two links that run it: a public URL to share with the audience (anyone with the link can answer, no account or sign-in needed) and an admin URL that shows the results updating in real time. Questions can be multiple choice, free text, or a 1-10 rating, and are answered in the order given. Any question can be made optional, or required only when an earlier multiple-choice answer matches a condition — see each question's `requirement` field; every question stays visible either way. Use this whenever someone wants to poll a room, run a quick vote, or collect open-ended feedback. The survey is open for responses immediately.",
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
        theme: themeSchema
          .optional()
          .describe(
            'Optional colors for the respondent page. Omit it and the survey uses the palette this account last saved on rifts.to, which is usually the creator\'s own brand. Send "default" to get the rifts.to house colors instead.'
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ title, questions, slug, theme }) =>
      run(async () => {
        const survey = await client.createSurvey({
          title,
          questions: questions.map(toQuestionInput),
          ...(slug ? { slug } : {}),
          ...(theme ? { theme } : {}),
        });

        return result(
          [
            `Created "${survey.title}".`,
            ``,
            `Share this link with the audience: ${survey.url}`,
            `Watch the results here: ${survey.admin_url}`,
            ``,
            `Survey id: ${survey.id} (use it with get_survey_results and close_survey).`,
            ...themeLine(survey.theme),
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
        "Read the answers to one of your surveys. Returns the questions with a summary of how they were answered: the tally per option for multiple choice, the average for ratings, and every free-text answer in full, plus the total response count and the survey's current status. A question marked optional or conditionally required can have fewer answers than the survey has responses; that's respondents skipping a question that wasn't required for them, not missing or lost data, and the summary says so. Responses carry no respondent identity: rifts.to never records who answered, so results cannot be attributed to a person.",
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
        "Stop a survey from accepting new responses. The public link keeps working and shows the survey as closed, and the results stay readable with get_survey_results. reopen_survey undoes it, unless the survey has passed its expiry date.",
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
          `Closed "${closed.id}". It no longer accepts responses; the results are still readable with get_survey_results, and reopen_survey puts it back.`,
          closed as unknown as Record<string, unknown>
        );
      })
  );
  server.registerTool(
    "reopen_survey",
    {
      title: "Reopen a survey",
      description:
        "Let a closed survey accept responses again. Answers already collected are kept, and the same public link starts working again. A survey that has passed its expiry date cannot be reopened this way: the API refuses it rather than reporting a success that would change nothing, and clearing an expiry is done from the rifts.to admin dashboard.",
      inputSchema: {
        id: z.string().min(1).describe("The survey id, e.g. 'fuzzy-sleepy-tornado'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) =>
      run(async () => {
        const survey = await client.reopenSurvey(id);
        return result(
          `Reopened "${survey.id}". It is taking responses again on the same link.`,
          survey as unknown as Record<string, unknown>
        );
      })
  );

  server.registerTool(
    "update_survey",
    {
      title: "Change a survey's questions or colors",
      description:
        "Change a survey that already exists: its colors, its questions, or both. Send only what should change. Once people have started answering, the question list can gain questions but cannot lose them, reorder them, change their types, or rename a multiple-choice option — answers are stored by position and by the option's exact text, so those edits would orphan real answers, and the call is refused with an explanation. The survey's title cannot be changed here or anywhere else on rifts.to.",
      inputSchema: {
        id: z.string().min(1).describe("The survey id, e.g. 'fuzzy-sleepy-tornado'."),
        theme: themeSchema.optional().describe("New colors for the respondent page."),
        questions: z
          .array(questionSchema)
          .min(1)
          .optional()
          .describe(
            "The complete new question list, replacing the old one — not just the questions being added. Send the existing questions first, unchanged and in their original order, then any new ones after them."
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ id, theme, questions }) =>
      run(async () => {
        const patch: UpdateSurveyInput = {
          ...(theme ? { theme } : {}),
          ...(questions ? { questions: questions.map(toQuestionInput) } : {}),
        };

        // Checked here rather than in the schema because `registerTool` takes a
        // shape rather than an object schema, so there is no `.refine` to hang
        // this on. The API answers 400 for the same case; catching it first
        // saves a call against the caller's rate limit.
        if (Object.keys(patch).length === 0) {
          throw new Error("nothing to change: send a theme, a questions list, or both.");
        }

        const updated = await client.updateSurvey(id, patch);

        return result(
          [
            `Updated "${updated.id}".`,
            ...(patch.questions ? [`It now has ${plural(patch.questions.length, "question")}.`] : []),
            ...themeLine(updated.theme),
          ].join("\n"),
          updated as unknown as Record<string, unknown>
        );
      })
  );

  server.registerTool(
    "archive_survey",
    {
      title: "Archive a survey",
      description:
        "Hide a survey from this account's list of surveys. Archiving is a tidying action only: the survey keeps running, its public link still works, people can still answer it, and its results stay readable with get_survey_results. Use close_survey to actually stop responses. Archiving something already archived is not an error, and `restore` puts it back in the list.",
      inputSchema: {
        id: z.string().min(1).describe("The survey id, e.g. 'fuzzy-sleepy-tornado'."),
        restore: z
          .boolean()
          .optional()
          .describe("Set true to bring an archived survey back into the list instead of hiding it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, restore }) =>
      run(async () => {
        const archived = restore !== true;
        const updated = await client.updateSurvey(id, { archived });

        return result(
          archived
            ? `Archived "${id}". It is out of the survey list; the survey itself is untouched and still open on its link.`
            : `Restored "${id}" to the survey list.`,
          updated as unknown as Record<string, unknown>
        );
      })
  );

  server.registerTool(
    "list_templates",
    {
      title: "List your saved templates",
      description:
        "List the saved question sets on the authenticated rifts.to account, with the id, name and questions of each. A template is not a live survey: it collects no answers until launch_template starts one from it. Use this to find the id of a template before launching it.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const templates = await client.listTemplates();
        return result(formatTemplates(templates), { templates: templates as unknown[] });
      })
  );

  server.registerTool(
    "create_template",
    {
      title: "Save a template",
      description:
        "Save a set of questions for reuse, without starting a survey. Launching it later with launch_template creates a fresh survey each time, so a poll that runs every week keeps each week's answers separate. Editing and deleting templates is done on rifts.to, not here.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(200)
          .describe("What to call the template, e.g. 'Weekly standup'. Respondents never see it unless it becomes a survey's title at launch."),
        questions: z.array(questionSchema).min(1).describe("At least one question."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ name, questions }) =>
      run(async () => {
        const template = await client.createTemplate({
          name,
          questions: questions.map(toQuestionInput),
        });

        return result(
          [
            `Saved "${template.name}" with ${plural(template.questions.length, "question")}.`,
            `Template id: ${template.id} (use it with launch_template).`,
          ].join("\n"),
          template as unknown as Record<string, unknown>
        );
      })
  );

  server.registerTool(
    "launch_template",
    {
      title: "Launch a template",
      description:
        "Start a new live survey from a saved template and get back the two links that run it: a public URL to share and an admin URL showing results in real time. The new survey copies the template's questions as they are now — editing the template afterwards never changes a survey already launched from it, and each launch collects its own separate answers. Use this to run a recurring poll again.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("The template id, from list_templates or create_template."),
        slug: z
          .string()
          .min(3)
          .max(64)
          .regex(CUSTOM_SLUG, "lowercase letters, digits and single hyphens only")
          .optional()
          .describe(
            "Optional custom link for this launch, e.g. 'standup-mood'. Fails if the name is already taken by another survey, including an earlier launch of this same template."
          ),
        theme: themeSchema
          .optional()
          .describe(
            "Optional colors for the respondent page. Omit it and the launch uses the palette this account last saved on rifts.to."
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ id, slug, theme }) =>
      run(async () => {
        const input: LaunchTemplateInput = {
          ...(slug ? { slug } : {}),
          ...(theme ? { theme } : {}),
        };
        const survey = await client.launchTemplate(id, input);

        return result(
          [
            `Launched "${survey.title}" from template ${survey.template_id}.`,
            ``,
            `Share this link with the audience: ${survey.url}`,
            `Watch the results here: ${survey.admin_url}`,
            ``,
            `Survey id: ${survey.id} (use it with get_survey_results and close_survey).`,
            ...themeLine(survey.theme),
          ].join("\n"),
          survey as unknown as Record<string, unknown>
        );
      })
  );
}

/**
 * One line, only when there is something to say. A survey painted in the
 * account's own remembered palette is the common case and reporting it every
 * time is noise; a survey that came back untinted after a color was asked for
 * is the case worth surfacing, and this is where it shows up.
 */
function themeLine(theme: SurveyTheme | undefined): string[] {
  if (!theme || theme === "default") return [];
  return [
    typeof theme === "string"
      ? `Colors: the ${theme} palette.`
      : `Colors: ${theme.primary} on ${theme.background}.`,
  ];
}

function formatTemplates(templates: Template[]): string {
  if (templates.length === 0) {
    return "No templates saved on this account. create_template saves one, and create_survey starts a one-off survey without saving anything.";
  }

  const lines = templates.map(
    (t) => `- ${t.name} [${t.id}]: ${plural(t.questions.length, "question")}`
  );

  return `${plural(templates.length, "template")}:\n${lines.join("\n")}`;
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

    const label = requirementLabel(question.requirement);
    const lines = [
      `Q${question.index + 1}. ${question.text}${label ? ` (${label})` : ""}`,
      ...summarise(question, answers),
    ];

    // Only a question that could ever be skipped gets this line: a question
    // with no `requirement` is always required, so a shortfall there would be
    // a real anomaly rather than the expected shape of optional answers.
    const skipped = results.response_count - answers.length;
    if (question.requirement && skipped > 0) {
      lines.push(
        `  (${plural(skipped, "response")} skipped this question — it wasn't required for them)`
      );
    }

    return lines.join("\n");
  });

  return [header.join("\n"), ...blocks].join("\n\n");
}

/**
 * A short, factual label — never "hidden" or "skipped" wording, since the
 * question is shown to every respondent regardless of `requirement`.
 */
function requirementLabel(requirement: Question["requirement"]): string | undefined {
  if (!requirement) return undefined;
  return requirement.mode === "optional" ? "optional" : "required only for some respondents";
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
