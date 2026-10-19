# Blind test: which cover frame reads in one second

Status: plan. Not run yet.

## Question

A stranger scrolling X sees the cover for about one second. Which frame lets
them tell what this is (a Halloween look for a terminal where AI agents
work, with a pumpkin that reacts to them), and which one would they stop
for?

## Candidates

Export them with `scripts/halloween-showcase.mjs` (byte-identical every run):

| File | Command | What differs |
|---|---|---|
| `a1.png` | `--at 2500 --out blind-test/a1.png` | The alert moment: the eyes are on the Claude Code permission prompt and the candle flares. |
| `a3.png` | `--at 500 --out blind-test/a3.png` | The idle moment: no alert, the eyes look ahead. Tests whether the "it watches your agents" beat matters. |

## People

- 5 to 10 people who have not seen the theme, Termany's repo, or this test.
- At least half should use a terminal at work. At least two should not.
- Nobody from the team, and nobody who knows what the theme is meant to do.
- Ask each for consent to note their answers. Write down no names, only a
  code (P1, P2, …) and "uses a terminal: yes/no".

## Procedure (about 5 minutes per person)

1. **Phone-sized display.** Show every image on a phone, or in a 390 px wide
   window. That is how the X timeline shows it.
2. **One-second look.** Each person sees one of the two frames. Alternate
   (P1 → a1, P2 → a3, P3 → a1, …), so each frame gets half of the people.
   - Show it for 1 second, then hide it.
   - Ask: "What did you see?" and "What do you think this is for?" Write the
     answers word for word. Do not hint.
3. **Second chance.** Show the same frame for 5 seconds. Ask: "Anything you
   missed the first time?"
4. **Preference.** Show both side by side, with the left/right order
   switched for every other person. Ask: "Scrolling past, which would make you stop?" and "Why?"
5. **Last.** Only now explain what the theme does. Ask: "Which frame shows
   that best?"

## Scoring

Score each one-second answer by these rules, decided before any results:

| Point | When |
|---|---|
| Halloween / pumpkin | They name a pumpkin, a jack-o'-lantern or Halloween. |
| Terminal / code | They name a terminal, code, a developer tool or an editor. |
| Agent | They name AI, an agent, Claude or Codex, or something "asking for permission". |
| Reaction | They say the pumpkin is looking at, or reacting to, something. |

A frame "reads" for a person when it scores Halloween, plus terminal or
agent.

## Decision rule (set before the test)

1. Pick the frame with the highest share of people for whom it reads.
2. If two frames tie, pick the one chosen more often in step 4.
3. If no frame reads for at least half of the people who saw it, do not post
   any of them. Bring the results back for a new frame instead.

With 5–10 people this shows only large differences. It is a sanity check,
not a statistical test, and the write-up must say so.

## Response sheet

Copy this for each person.

```
Code: P_   Uses a terminal at work: yes / no   Frame shown first: a1 / a3
1 s  — what did you see:
1 s  — what is it for:
5 s  — anything new:
Preference (order shown: __ __) — pick: __  why:
After explanation — which shows it best: __
Score: Halloween _  Terminal _  Agent _  Reaction _   Reads: yes / no
```
