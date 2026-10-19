# Halloween theme: before and after the holiday

Status: proposal. Nothing in this document is built yet.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY in this document are
to be interpreted as described in RFC 2119.

## Dates (2026)

| Date | Event |
|---|---|
| Oct 22 | Release with the theme ships (the latest date that leaves 9 days of use). |
| Oct 23 | Share video (`docs/halloween/showcase.mp4`) posted on X, with the demo link. |
| Oct 24 – Oct 31 | In-app invitation window. |
| Nov 1 – Nov 7 | Wind-down window. |
| From Nov 8 | Theme stays available under "Seasonal". |

## Before the holiday: inviting people to try it

Termany has no in-app notice today, so the invitation needs a small new
component: a one-time card at the foot of the sidebar, where the pumpkin
would appear.

- **LCH-1** WHILE the date is between Oct 24 and Oct 31, WHEN the app starts
  and the active theme is not `halloween`, the app SHOULD show the invitation
  card once. Users who already dismissed it are exempt.
- **LCH-2** The invitation card MUST NOT change the theme by itself.
- **LCH-3** WHEN the user clicks "Try it", the app MUST remember the current
  theme id as the previous theme and apply `halloween`.
- **LCH-4** WHEN the user clicks "Not now" or closes the card, the app MUST
  NOT show it again this season.
- **LCH-5** WHERE reduced motion is on, the invitation card MUST be static.
- **LCH-6** The share post MUST link to `termany.sh/demo?theme=halloween`
  with a campaign tag (for example `?theme=halloween&utm_source=x`), so demo
  visits from the post can be counted apart from other visits. The demo
  already applies `?theme=` (apps/web/src/main.tsx).

## After the holiday: winding down

- **LCH-7** The app MUST NOT switch anyone away from `halloween`
  automatically. Some users keep seasonal themes, and a forced switch would
  feel like a bug.
- **LCH-8** WHILE the date is between Nov 1 and Nov 7, WHEN the app starts
  with `halloween` active, the app SHOULD show one card: "Keep the pumpkin,
  or go back to <previous theme>?".
  - If no previous theme was recorded, the card SHOULD offer the default
    theme instead.
- **LCH-9** WHEN the user picks "Go back", the app MUST apply the remembered
  previous theme.
- **LCH-10** From Nov 8, the theme picker SHOULD list `halloween` under a
  "Seasonal" heading after the regular themes.
- **LCH-11** The theme MUST stay in the bundle after the holiday. Removing
  it would make `loadThemeId()` fall back to the default for everyone who
  kept it.
- **LCH-12** The same invitation window MAY run again from Oct 24 next year.

## What cannot be measured today

Termany sends no telemetry. Without a decision on that, these numbers do not
exist:

- How many users turn the theme on (adoption).
- How many keep it after Nov 7 (post-holiday retention).
- How many accept or dismiss the invitation.

What can be measured without telemetry:

- Visits to the demo link with the campaign tag, if termany.sh has analytics
  (not checked).
- Likes, replies and reposts on the post, compared with the July 21 launch
  post (119 likes, 73 replies).
- GitHub stars and release downloads in the week after the post, compared
  with the theme releases on Aug 6 and Oct 10 (step 1 baseline).

Adding an opt-in, anonymous "theme in use" count is a product decision for
the maintainers. This document does not assume it.
