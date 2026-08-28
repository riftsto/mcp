import { describe, it, expect } from "vitest";
import { RiftsClient } from "../client.js";

/**
 * `validateQuestions` on the server answers a bad `requirement` with a fixed
 * English string in a 400's `error` field. These tests pin the readable
 * messages this client turns those into — the raw validator strings ("a
 * condition group must combine with all or any") are exactly the wording a
 * model can't act on, so a regression here would surface the wrong text in
 * every chat window that hits one of these rules.
 */
function clientWith400(error: string) {
  return new RiftsClient({
    token: "t",
    fetchImpl: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error }), { status: 400 })
      )) as unknown as typeof fetch,
  });
}

describe("requirement validation errors", () => {
  it("names the bad mode", async () => {
    const client = clientWith400("invalid requirement mode: sometimes");
    await expect(
      client.createSurvey({ title: "T", questions: [] })
    ).rejects.toThrow('requirement.mode must be "optional" or "conditional", not "sometimes".');
  });

  it("explains a forward or self reference", async () => {
    const client = clientWith400("a condition must point at an earlier question");
    await expect(client.createSurvey({ title: "T", questions: [] })).rejects.toThrow(
      "a condition's questionIndex must be the position of a question earlier in the questions array — it can't point at itself or at a later question."
    );
  });

  it("explains a trigger that isn't multiple choice", async () => {
    const client = clientWith400("a condition's trigger must be a multiple choice question");
    await expect(client.createSurvey({ title: "T", questions: [] })).rejects.toThrow(
      /must point at a multiple_choice question/
    );
  });

  it("names the option that doesn't exist", async () => {
    const client = clientWith400("a condition names an option that does not exist: Maybe");
    await expect(client.createSurvey({ title: "T", questions: [] })).rejects.toThrow(
      /"Maybe" is not one of them/
    );
  });

  it("explains all/any, the condition count floor and ceiling, and an empty values list", async () => {
    const cases: Array<[string, RegExp]> = [
      ["a condition group must combine with all or any", /"all".*"any"/],
      [
        "a conditional question needs at least one condition",
        /when\.conditions must have at least one condition/,
      ],
      ["a question may have at most 5 conditions", /at most 5 conditions/],
      ["a condition must name at least one option", /list at least one of the trigger/],
    ];

    for (const [raw, expected] of cases) {
      const client = clientWith400(raw);
      await expect(client.createSurvey({ title: "T", questions: [] })).rejects.toThrow(expected);
    }
  });

  it("falls back to the raw message for a 400 these rules don't cover", async () => {
    const client = clientWith400("title is required");
    await expect(client.createSurvey({ title: "T", questions: [] })).rejects.toThrow(
      "rifts.to rejected the request (400): title is required"
    );
  });
});

/**
 * The requests this client actually sends, and the errors it turns back into
 * something a model can act on.
 *
 * Asserted against a recording `fetch` rather than a live API: the shapes here
 * are the ones `src/lib/__tests__/apiV1Contract.test.ts` in the rifts.to
 * repository pins from the other side, and the two files are the only thing
 * keeping a versioned npm package in step with a server that ships separately.
 */
function recordingClient(response: Response) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const client = new RiftsClient({
    token: "t",
    fetchImpl: ((url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(response.clone());
    }) as unknown as typeof fetch,
  });
  return { client, sent };
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("what the client sends", () => {
  it("puts a theme in the create body only when it was given one", async () => {
    const { client, sent } = recordingClient(ok({ id: "s", theme: "ocean" }, 201));

    await client.createSurvey({ title: "T", questions: [], theme: "ocean" });
    await client.createSurvey({ title: "T", questions: [] });

    expect(bodyOf(sent[0]!.init).theme).toBe("ocean");
    expect(bodyOf(sent[1]!.init)).not.toHaveProperty("theme");
  });

  it("patches a survey with exactly the fields it was asked to change", async () => {
    const { client, sent } = recordingClient(ok({ id: "s", status: "open" }));

    await client.updateSurvey("s", { theme: "forest" });

    expect(sent[0]!.url).toBe("https://rifts.to/api/v1/surveys/s");
    expect(sent[0]!.init.method).toBe("PATCH");
    expect(bodyOf(sent[0]!.init)).toEqual({ theme: "forest" });
  });

  it("closes and reopens through the same status field", async () => {
    const { client, sent } = recordingClient(ok({ id: "s", status: "closed" }));

    await client.closeSurvey("s");
    await client.reopenSurvey("s");

    expect(bodyOf(sent[0]!.init)).toEqual({ status: "closed" });
    expect(bodyOf(sent[1]!.init)).toEqual({ status: "open" });
  });

  it("reads templates from the templates collection", async () => {
    const { client, sent } = recordingClient(ok({ templates: [{ id: "tpl-1" }] }));

    const templates = await client.listTemplates();

    expect(sent[0]!.url).toBe("https://rifts.to/api/v1/templates");
    expect(templates).toEqual([{ id: "tpl-1" }]);
  });

  it("launches a template at its own path, url-encoding the id", async () => {
    const { client, sent } = recordingClient(ok({ id: "s" }, 201));

    await client.launchTemplate("tpl 1/x", { theme: "ocean" });

    expect(sent[0]!.url).toBe("https://rifts.to/api/v1/templates/tpl%201%2Fx/launch");
    expect(bodyOf(sent[0]!.init)).toEqual({ theme: "ocean" });
  });

  it("sends an empty body rather than none when a launch asks for nothing", async () => {
    // A bare `launch it again` has no slug and no theme. The route treats an
    // unparseable body as "nothing requested", but sending `{}` keeps the
    // Content-Type honest.
    const { client, sent } = recordingClient(ok({ id: "s" }, 201));

    await client.launchTemplate("tpl-1");

    expect(bodyOf(sent[0]!.init)).toEqual({});
  });
});

describe("errors worth reading", () => {
  const failing = (status: number, body: unknown) =>
    new RiftsClient({
      token: "t",
      fetchImpl: (() =>
        Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch,
    });

  it("keeps the expiry refusal's own sentence", async () => {
    const client = failing(409, {
      error:
        "this survey has expired, so reopening it would not accept responses; change its expiry from the admin dashboard first",
      code: "survey_expired",
    });

    await expect(client.reopenSurvey("s")).rejects.toThrow(/expired/);
  });

  it("says what to do about a taken slug", async () => {
    const client = failing(409, { error: "slug taken", code: "slug_taken" });

    await expect(
      client.createSurvey({ title: "T", questions: [], slug: "standup-mood" })
    ).rejects.toThrow(/already taken.*another/i);
  });

  it("says which cap was hit", async () => {
    const surveys = failing(409, {
      error: "survey limit reached",
      code: "survey_limit_reached",
    });
    await expect(surveys.createSurvey({ title: "T", questions: [] })).rejects.toThrow(
      /500 surveys/
    );

    const templates = failing(409, {
      error: "template limit reached",
      code: "template_limit_reached",
    });
    await expect(templates.createTemplate({ name: "T", questions: [] })).rejects.toThrow(
      /200 templates/
    );
  });

  it("turns a live-edit refusal into the next thing to try", async () => {
    // The server's own wording says what is forbidden. A model reading it in a
    // chat window still has to be told what it can do instead, or it retries
    // the same edit.
    const client = failing(400, {
      error: "cannot remove or rename an option once the survey has responses",
    });

    await expect(
      client.updateSurvey("s", { questions: [] })
    ).rejects.toThrow(/new survey/i);
  });
});
