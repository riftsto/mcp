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
