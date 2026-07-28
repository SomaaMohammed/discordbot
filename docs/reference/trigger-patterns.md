# Natural-chat trigger patterns

Superior recognizes a curated set of natural phrases without an external model, broad fuzzy matching, or substring replacement.

## Deliberate address

A guild message is considered only when it is deliberately addressed in one of these ways:

- configured invocation first: `superior hru`
- invocation last: `what time rn, superior`
- salutation plus invocation: `hey superior, wyd?`
- direct bot mention: `<@bot> cmds`
- reply to a message verified as the bot's: `wsp`

Configured aliases may contain more than one word. Ordinary text containing an invocation in the middle of an unrelated sentence is ignored. DMs, disabled/inactive guilds, and cross-guild contexts are ignored.

Text is normalized with Unicode NFKC, lowercase comparison, straight/curly apostrophe handling, punctuation and harmless edge-emoji removal, and repeated-whitespace collapse. Aliases remain exact token/phrase matches: `hru` is recognized as its own token, but those letters inside a larger word are not changed.

## Intents and examples

| Intent    | Representative requests after the address                                        |
| --------- | -------------------------------------------------------------------------------- |
| Greeting  | `hi`, `hello`, `yo`, `sup`, `gm`, `good afternoon`                               |
| Wellbeing | `wsp`, `wsg`, `wassup`, `what's up`, `how r u`, `hru`, `hows it going`           |
| Activity  | `what are you doing`, `what r u doing`, `wyd`                                    |
| Help      | `help`, `commands`, `cmds`, `command list`, `what can u do`, `how do i use this` |
| Thanks    | `thanks`, `thank you`, `thx`, `ty`, `tysm`, `appreciate it`                      |
| Farewell  | `bye`, `cya`, `later`, `gtg`, `goodnight`, `gn`                                  |
| Status    | `ping`, `pong`, `latency`, `r u online`, `are you alive`, `you there`            |
| Uptime    | `uptime`, `how long u been up`                                                   |
| About     | `who r u`, `what are you`, `version`, `ver`, `bot info`                          |
| Time      | `what time is it`, `whats the time`, `what time rn`, `time now`                  |
| Coin      | `flip a coin`, `coin toss`, `heads or tails`                                     |

Polite prefixes such as `please`, `can you`, `could u`, and `would you` are accepted before a supported request.

Each simple intent uses a centralized typed reply pool with varied, concise, neutral responses. Factual intents insert the current measured latency, uptime, version, or configured guild-local time. Reply selection uses the runtime's injected random source so tests remain deterministic. Member-controlled values are escaped before Markdown output and allowed mentions remain restricted.

## Dice and choices

Dice accepts forms such as:

- `superior roll d20`
- `superior 2d6`
- `superior throw 3 dice with 12 sides`

One request can roll 1–20 dice with 2–1,000 sides. Malformed notation and out-of-range counts receive a bounded validation response.

Choices accept 2–20 unique options, each at most 100 Unicode characters:

- `superior choose tea or coffee`
- `superior pick red, green, blue`
- reply to the bot with `which should i pick alpha or beta`

The original option text is preserved for display after normalized duplicate detection.

## Precedence and moderation

Reply-moderation language is parsed before casual chat. A moderation-shaped reply such as `superior timeout them: repeated spam` never falls through to a friendly response. Moderation requests require the feature, a verified reply target, administrator authority, bot Moderate Members permission, safe role hierarchy, current-guild membership, and a reason no longer than 400 characters.

Casual precedence is deterministic: dice and choice validation occur before exact simple aliases, and potentially overlapping simple intents use an explicit ordered list. Unsupported or ambiguous addressed text produces no action rather than guessing.
