/**
 * Typed client for rifts.to's public API (`/api/v1`).
 *
 * Plain `fetch`, no generated SDK and no retry layer. Two reasons: the same
 * module has to run unchanged under Node (the stdio entry point) and under
 * Cloudflare Workers (the hosted HTTP server), which rules out anything
 * Node-specific; and a retry would be wrong on this surface anyway — three of
 * the four calls are writes or rate-limited reads, and silently re-sending a
 * `create_survey` that actually succeeded would leave a duplicate survey and
 * hand the model the wrong link.
 *
 * This module reads no environment and holds no default token: the caller
 * supplies both, so nothing here can pick up a credential by accident.
 */

/** Public rifts.to. Overridable so a self-hoster can point at their own deploy. */
export const DEFAULT_BASE_URL = "https://rifts.to";

/**
 * Whether an answer is required. Absent (the historical default, and still
 * what every existing survey means) is "always required". `optional` lets
 * the respondent skip the question outright; `conditional` requires it only
 * when an earlier multiple-choice answer matches `when`, and is optional
 * otherwise. Neither mode hides the question — see the note on `when` below.
 */
export type Requirement = RequirementOptional | RequirementConditional;

export interface RequirementOptional {
  mode: "optional";
}

export interface RequirementConditional {
  mode: "conditional";
  when: ConditionGroup;
}

export interface ConditionGroup {
  /** "all" is AND across `conditions`; "any" is OR. */
  op: "all" | "any";
  /** 1–5 conditions. */
  conditions: Condition[];
}

export interface Condition {
  /**
   * 0-based position, in this same request's `questions` array, of the
   * multiple-choice question this condition reads. Must be strictly less
   * than the position of the question the condition belongs to — the server
   * rejects anything else, which is also what makes a dependency cycle
   * impossible to express.
   */
  questionIndex: number;
  /** Matched by exact string equality against the trigger's `options`; OR'd. */
  values: string[];
}

/**
 * The respondent page's palette. Either one of the presets rifts.to ships, or
 * a creator's own `{primary, background}` pair, which the server stores as
 * `custom:rrggbb:rrggbb`.
 *
 * The preset list is duplicated from `src/lib/themes.ts` in the rifts.to
 * repository rather than fetched, because this package talks HTTP and shares
 * no types with it. A preset added there and not here is refused by this
 * client's schema before it ever reaches the API — the failure is a clear
 * "not a known theme" rather than a silent 400, and adding the name here is
 * the whole fix.
 *
 * "default" is the house palette, and asking for it explicitly *clears* an
 * override rather than meaning "no opinion". Omitting `theme` entirely is what
 * means no opinion, and on create that lets the account's own remembered
 * palette apply.
 */
export const THEME_PRESETS = [
  "default",
  "sunset",
  "ocean",
  "forest",
  "rose",
  "slate",
] as const;

export type ThemePreset = (typeof THEME_PRESETS)[number];

/** Two 6-digit hex colors, `#rrggbb`. rifts.to derives the rest of the palette. */
export interface CustomTheme {
  primary: string;
  background: string;
}

export type SurveyTheme = ThemePreset | CustomTheme;

export interface MultipleChoiceQuestionInput {
  type: "multiple_choice";
  text: string;
  options: string[];
  requirement?: Requirement;
}

export interface FreeTextQuestionInput {
  type: "free_text";
  text: string;
  requirement?: Requirement;
}

export interface RatingQuestionInput {
  type: "rating";
  text: string;
  /** Always 1–10 — see the note on RATING_SCALE in tools.ts. */
  scale: { min: number; max: number };
  requirement?: Requirement;
}

/** A question as sent to the API. No `index`: the server reindexes on write. */
export type QuestionInput =
  | MultipleChoiceQuestionInput
  | FreeTextQuestionInput
  | RatingQuestionInput;

/** A question as returned by the API, carrying the position answers are keyed by. */
export type Question = QuestionInput & { index: number };

export interface SurveySummary {
  id: string;
  title: string;
  status: "open" | "closed";
  created_at: string;
  response_count: number;
  url: string;
  /** Present only when the listing was asked for with `include_admin`. */
  admin_token?: string;
  admin_url?: string;
}

export interface CreatedSurvey {
  id: string;
  title: string;
  url: string;
  admin_token: string;
  admin_url: string;
  created_at: string;
  /** The palette the survey actually got, which is not always the one asked for. */
  theme: SurveyTheme;
}

export interface SurveyResponseRow {
  id: string;
  submitted_at: string;
  /**
   * Keyed by question index, as a string because that is what JSON does to a
   * numeric key. The API deliberately carries no respondent identifier here and
   * this client must not invent one.
   */
  answers: Record<string, string | number | string[]>;
}

export interface SurveyResults {
  id: string;
  title: string;
  /**
   * Three values here, two on SurveySummary, and that is the API's shape rather
   * than a mistake in this file: the results route reports getEffectiveStatus,
   * which folds `expires_at` in, while the listing reports the stored column.
   * A survey past its expiry therefore lists as "open" and reads as "expired".
   */
  status: "open" | "closed" | "expired";
  created_at: string;
  expires_at: string | null;
  url: string;
  /**
   * The palette the respondent page is currently wearing, `"default"` when it
   * has none. Reported so a caller can read a survey's colors, change one
   * thing and hand the rest straight back to `updateSurvey` — a write-only
   * theme is a round trip nobody can complete.
   */
  theme: SurveyTheme;
  questions: Question[];
  response_count: number;
  responses: SurveyResponseRow[];
}

export interface CloseResult {
  id: string;
  status: "closed";
}

export interface CreateSurveyInput {
  title: string;
  questions: QuestionInput[];
  /** Custom slug, e.g. `standup-mood`. Subscriber-only, and may already be taken. */
  slug?: string;
  /**
   * Omit it and the survey takes the account's remembered palette — the same
   * one the web builder opens on. That fallback is the reason this is optional
   * rather than defaulted here: a default sent from this client would override
   * the creator's own brand with the house colors.
   */
  theme?: SurveyTheme;
}

/**
 * Everything `PATCH /api/v1/surveys/[id]` will change. At least one field, and
 * the server validates all of them before writing any, so a half-wrong patch
 * changes nothing at all.
 */
export interface UpdateSurveyInput {
  status?: "open" | "closed";
  theme?: SurveyTheme;
  /** Replaces the whole list. Restricted once the survey has responses. */
  questions?: QuestionInput[];
  /** Hides it from the account listing. Never closes it, never breaks its link. */
  archived?: boolean;
}

/** The survey's id and status, plus whichever fields the patch changed. */
export interface UpdatedSurvey {
  id: string;
  status: "open" | "closed";
  theme?: SurveyTheme;
  questions?: Question[];
  archived?: boolean;
}

/** A saved set of questions. Not a live survey: no link, no admin token, no answers. */
export interface Template {
  id: string;
  name: string;
  questions: Question[];
  created_at: string;
  updated_at: string;
}

export interface CreateTemplateInput {
  name: string;
  questions: QuestionInput[];
}

export interface LaunchTemplateInput {
  slug?: string;
  theme?: SurveyTheme;
}

/** A survey launched from a template: a created survey, plus its provenance. */
export type LaunchedSurvey = CreatedSurvey & { template_id: string };

export interface ListSurveysOptions {
  includeAdmin?: boolean;
  includeClosed?: boolean;
}

/**
 * A non-2xx from the API, already turned into something a person reading a
 * chat transcript can act on. `status` and `code` are kept alongside the
 * message so a caller can branch without parsing English.
 */
export class RiftsApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "RiftsApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RiftsClientOptions {
  /** Origin only, e.g. `https://rifts.to`. Paths are appended by this client. */
  baseUrl?: string;
  token: string;
  /** Injectable for tests; defaults to the global `fetch` (Node 20+, Workers). */
  fetchImpl?: typeof fetch;
}

export class RiftsClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RiftsClientOptions) {
    // Trailing slashes are the classic way a config value produces `//api/v1`,
    // which Cloudflare answers with a redirect the fetch then follows without
    // the Authorization header.
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async listSurveys(options: ListSurveysOptions = {}): Promise<SurveySummary[]> {
    const params = new URLSearchParams();
    // Both are sent only when they differ from the API's own default, so a
    // change of default on the server side is not silently pinned here.
    if (options.includeAdmin) params.set("include_admin", "1");
    if (options.includeClosed === false) params.set("include_closed", "0");

    const query = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.request<{ surveys: SurveySummary[] }>(
      "GET",
      `/api/v1/surveys${query}`
    );
    return body.surveys;
  }

  async createSurvey(input: CreateSurveyInput): Promise<CreatedSurvey> {
    return this.request<CreatedSurvey>("POST", "/api/v1/surveys", input);
  }

  async getSurveyResults(id: string): Promise<SurveyResults> {
    return this.request<SurveyResults>("GET", `/api/v1/surveys/${encodeURIComponent(id)}`);
  }

  /**
   * The one write that changes a survey already in flight. `closeSurvey`,
   * `reopenSurvey` and archiving are all this call with a different body —
   * kept as named wrappers because a tool that means "close this" should not
   * have to assemble a patch, and because the error each one can hit differs.
   */
  async updateSurvey(id: string, patch: UpdateSurveyInput): Promise<UpdatedSurvey> {
    return this.request<UpdatedSurvey>(
      "PATCH",
      `/api/v1/surveys/${encodeURIComponent(id)}`,
      patch
    );
  }

  async closeSurvey(id: string): Promise<CloseResult> {
    return this.request<CloseResult>("PATCH", `/api/v1/surveys/${encodeURIComponent(id)}`, {
      status: "closed",
    });
  }

  /**
   * Refused with a 409 when the survey's expiry has already passed: flipping
   * the column back would change a row and nothing a respondent would see, so
   * the API says so rather than reporting a success that did nothing.
   */
  async reopenSurvey(id: string): Promise<UpdatedSurvey> {
    return this.updateSurvey(id, { status: "open" });
  }

  async listTemplates(): Promise<Template[]> {
    const body = await this.request<{ templates: Template[] }>("GET", "/api/v1/templates");
    return body.templates;
  }

  async createTemplate(input: CreateTemplateInput): Promise<Template> {
    return this.request<Template>("POST", "/api/v1/templates", input);
  }

  /**
   * Copies the template's questions into a fresh survey. The copy is taken at
   * launch: editing the template afterwards never touches a survey already
   * launched from it, which is what keeps last week's answers out of this
   * week's.
   *
   * Always sends a body, even an empty one, so the request stays a well-formed
   * JSON POST rather than relying on the route's tolerance of an absent one.
   */
  async launchTemplate(
    id: string,
    input: LaunchTemplateInput = {}
  ): Promise<LaunchedSurvey> {
    return this.request<LaunchedSurvey>(
      "POST",
      `/api/v1/templates/${encodeURIComponent(id)}/launch`,
      input
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      // OAuth 2.1 and the MCP spec both forbid a token in a URI, and the API
      // reads the header only. Never move this to a query parameter.
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      // A bare `TypeError: fetch failed` in a chat window is unactionable. The
      // base URL is the thing a self-hoster typically got wrong, so name it.
      throw new Error(
        `could not reach the rifts.to API at ${this.baseUrl}: ${errorMessage(cause)}`,
        { cause }
      );
    }

    if (!response.ok) throw await toApiError(response);

    // 204 has no body; nothing on /api/v1 returns one today, but a client that
    // assumes otherwise fails with a JSON parse error rather than a clear one.
    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new Error(
        `the rifts.to API returned a ${response.status} that was not JSON`,
        { cause }
      );
    }
  }
}

/**
 * Turns a non-2xx into a message that says what to do about it. The four
 * statuses below are the ones `guardApiV1` and the route handlers produce
 * deliberately; everything else falls through to the generic branch carrying
 * the status and whatever the body's `error` field said.
 */
async function toApiError(response: Response): Promise<RiftsApiError> {
  const { error, code } = await readErrorBody(response);

  switch (response.status) {
    case 400: {
      const readable = requirementErrorMessage(error) ?? liveEditErrorMessage(error);
      return new RiftsApiError(readable ?? `rifts.to rejected the request (400)${suffix(error)}`, 400, code);
    }

    case 401:
      return new RiftsApiError(
        "rifts.to rejected the token (401). Check RIFTS_TOKEN: it may be mistyped, revoked, or from a different rifts.to deployment.",
        401,
        code
      );

    case 403:
      // Every paid route on rifts.to answers with this exact code, and
      // entitlement is re-checked on every request — so this is as likely to
      // mean "the subscription lapsed today" as "there never was one".
      if (code === "entitlement_required") {
        return new RiftsApiError(
          "an active rifts.to subscription is required to use the API (403). Check the subscription at https://rifts.to/en/account/billing.",
          403,
          code
        );
      }
      return new RiftsApiError(`rifts.to refused the request (403)${suffix(error)}`, 403, code);

    case 404:
      // The API answers 404 for a survey that belongs to someone else as well
      // as one that does not exist, on purpose, so this message must not claim
      // to know which it was.
      return new RiftsApiError("no such survey (or not yours) (404)", 404, code);

    case 409: {
      // Four distinct situations share this status, and a model that cannot
      // tell them apart retries the one thing that will never work.
      switch (code) {
        case "slug_taken":
          return new RiftsApiError(
            "that custom link is already taken by another survey. Pick a different one, or leave the slug out to get a readable three-word link.",
            409,
            code
          );
        case "survey_limit_reached":
          return new RiftsApiError(
            "this account is at its cap of 500 surveys. Archive or delete some from the rifts.to dashboard first.",
            409,
            code
          );
        case "template_limit_reached":
          return new RiftsApiError(
            "this account is at its cap of 200 templates. Delete some from the rifts.to account pages first.",
            409,
            code
          );
        default:
          // `survey_expired` and anything added later: the API's own sentence
          // already says what happened and what to do, so it is passed through
          // rather than paraphrased into something less specific.
          return new RiftsApiError(error ?? `rifts.to refused the request (409)`, 409, code);
      }
    }

    case 429: {
      const retryAfter = response.headers.get("Retry-After");
      const wait = retryAfter ? ` Retry after ${retryAfter}s.` : "";
      return new RiftsApiError(`rate limited by rifts.to (429).${wait}`, 429, code);
    }

    default:
      return new RiftsApiError(
        `rifts.to API error (${response.status})${suffix(error)}`,
        response.status,
        code
      );
  }
}

async function readErrorBody(
  response: Response
): Promise<{ error?: string; code?: string }> {
  // A gateway or the edge can answer with HTML, so parsing must never be what
  // turns a 502 into an unrelated crash.
  try {
    const text = await response.text();
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const { error, code } = parsed as { error?: unknown; code?: unknown };
    return {
      ...(typeof error === "string" ? { error } : {}),
      ...(typeof code === "string" ? { code } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * `validateQuestions` on the server answers a bad `requirement` with one of a
 * fixed set of English strings. Turned into wording a model can act on
 * instead of surfacing the validator's own vocabulary ("condition group",
 * "trigger") verbatim. Returns `undefined` for a 400 this isn't — some other
 * validation failure, or none of these rules applying — so the caller falls
 * back to the generic message.
 */
function requirementErrorMessage(error?: string): string | undefined {
  if (!error) return undefined;

  const badMode = /^invalid requirement mode: (.+)$/.exec(error);
  if (badMode) {
    return `requirement.mode must be "optional" or "conditional", not "${badMode[1]}".`;
  }

  const badOption = /^a condition names an option that does not exist: (.+)$/.exec(error);
  if (badOption) {
    return `a condition's values must exactly match one of the trigger question's options; "${badOption[1]}" is not one of them.`;
  }

  const fixed: Record<string, string> = {
    "a condition group must combine with all or any":
      'when.op must be "all" (every condition must match) or "any" (at least one must match).',
    "a conditional question needs at least one condition":
      "a conditional requirement's when.conditions must have at least one condition.",
    "a question may have at most 5 conditions": "when.conditions can have at most 5 conditions.",
    "a condition must point at an earlier question":
      "a condition's questionIndex must be the position of a question earlier in the questions array — it can't point at itself or at a later question.",
    "a condition's trigger must be a multiple choice question":
      "a condition's questionIndex must point at a multiple_choice question; free_text and rating questions can't trigger one.",
    "a condition must name at least one option":
      "a condition's values must list at least one of the trigger question's options.",
  };

  return fixed[error];
}

/**
 * `validateLiveEdit` refuses an edit that would orphan collected answers, and
 * its wording says what is forbidden. A model reading that in a chat window
 * still needs to know what it *can* do, or it retries the same edit with a
 * smaller change and fails again.
 *
 * The rule underneath is one fact: a response stores the option's text and the
 * question's position, and `responses` is frozen with no schema snapshot, so
 * nothing can reconstruct an answer whose question or option moved out from
 * under it. Adding questions is always allowed; the rest needs a new survey.
 */
function liveEditErrorMessage(error?: string): string | undefined {
  const fixed: Record<string, string> = {
    "cannot remove a question once the survey has responses":
      "a question can't be removed once people have answered — answers are keyed by position, so removing one would orphan them. You can add questions to the end, or create a new survey for the changed question set.",
    "cannot change a question's type or order once the survey has responses":
      "a question's type and position are fixed once people have answered, since that is how their answers are stored. You can add questions to the end, or create a new survey.",
    "cannot remove or rename an option once the survey has responses":
      "an option can't be renamed or removed once people have answered — answers store the option's text, so the old ones would stop matching. You can add options, or create a new survey.",
  };

  return error ? fixed[error] : undefined;
}

const suffix = (error?: string) => (error ? `: ${error}` : "");

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
