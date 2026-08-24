import {
  DEFAULT_WELCOME_TEMPLATE,
  normalizeOnboardingTemplatePair,
  renderOnboardingTemplatePair,
} from "../src/discord/onboarding-template.js";

const CONTEXT = {
  userDisplay: "**Ava** @everyone",
  serverName: "_Superior_",
  memberCount: 42,
  accountCreatedAt: new Date("2024-01-02T03:04:05.000Z"),
  joinedAt: new Date("2026-08-23T10:00:00.000Z"),
  rulesChannelId: "123456789012345678",
} as const;

describe("onboarding lifecycle templates", () => {
  it("renders only the supported safe placeholders", () => {
    const rendered = renderOnboardingTemplatePair(
      {
        title: "{user}",
        body: "{server} · {member_count} · {account_created} · {joined_at} · {rules}",
      },
      CONTEXT,
    );

    expect(rendered.title).toContain("\\*\\*Ava\\*\\*");
    expect(rendered.title).toContain("@\u200beveryone");
    expect(rendered.body).toContain("\\_Superior\\_");
    expect(rendered.body).toContain("42");
    expect(rendered.body).toContain("<t:1704164645:F>");
    expect(rendered.body).toContain("<#123456789012345678>");
  });

  it("uses a safe rules fallback when no channel is configured", () => {
    const rendered = renderOnboardingTemplatePair(DEFAULT_WELCOME_TEMPLATE, {
      ...CONTEXT,
      rulesChannelId: null,
    });
    expect(rendered.body).toContain("the server rules");
  });

  it.each([
    ["unknown placeholders", "{username}"],
    ["nested braces", "{{user}}"],
    ["executable syntax", "${user}"],
    ["mass mentions", "@everyone"],
    ["user mentions", "<@123456789012345678>"],
    ["role mentions", "<@&123456789012345678>"],
  ])("rejects %s", (_label, body) => {
    expect(() => normalizeOnboardingTemplatePair("Title", body)).toThrow();
  });

  it("accounts for placeholder expansion at Discord limits", () => {
    expect(() =>
      normalizeOnboardingTemplatePair(`${"x".repeat(250)}{server}`, "Body"),
    ).toThrow(/256-character limit/u);
  });

  it("accounts for safe Markdown escaping at Discord limits", () => {
    expect(() =>
      normalizeOnboardingTemplatePair("*".repeat(160), "Body"),
    ).toThrow(/256-character limit/u);
  });

  it("rejects missing and invalid member data safely", () => {
    const rendered = renderOnboardingTemplatePair(
      { title: "{user}", body: "{account_created} / {joined_at}" },
      {
        ...CONTEXT,
        userDisplay: "\u0000",
        accountCreatedAt: null,
        joinedAt: new Date(Number.NaN),
      },
    );
    expect(rendered.title).toBe("Member");
    expect(rendered.body).toBe("Unavailable / Unavailable");
  });
});
