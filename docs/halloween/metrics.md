# Halloween theme: what to watch after launch

Status: plan. "T0" is the time the share post goes live (planned Oct 23,
docs/halloween/launch.md). Baselines come from the step 1 research, measured
on 2026-10-19.

## Baselines

| Baseline | Value |
|---|---|
| Termany launch post on X (2026-07-21) | 119 likes, 73 replies |
| Comparable posts, video of an agent-aware pixel UI ("Pixel Agents") | 10,583 and 2,691 likes |
| Comparable posts, a terminal theme shown as a screenshot | 26–144 likes |
| GitHub stars per day after earlier theme releases | +2 to +9 (Win98, Aug 6); +7 and +6 (0.2.7 retro themes, Oct 11–12) |
| GitHub stars on launch day | +103 |

## Metrics

| # | Metric | Definition | Source | When | Read against |
|---|---|---|---|---|---|
| M1 | Post engagement | Likes, reposts, replies, bookmarks and video views of the share post. | X post analytics (author's account). | T0+24 h, +72 h, +7 d | Launch post: 119 likes, 73 replies. |
| M2 | Engagement from reposts | The same counts on reposts by aggregator accounts, if any. | Each repost's public counts. | T0+7 d | Pixel Agents: 10.5k likes. |
| M3 | Demo clicks | Visits to `termany.sh/demo?theme=halloween&utm_source=x`. | termany.sh analytics, if it has any (not checked). | daily to T0+7 d | Demo visits in the 7 days before T0. |
| M4 | Demo engagement | Share of demo visits that click into the demo, the first interaction. | Needs an event on the site (not built). | T0+7 d | none yet |
| M5 | Stars | New GitHub stars per day. | GitHub API (stargazers with timestamps). | daily, T0−7 d to T0+14 d | +2 to +9 per day after the earlier theme releases. |
| M6 | Downloads | Release asset downloads of the version with the theme. | GitHub release API. | T0+7 d | Same days for 0.2.7. |
| M7 | Adoption | Share of active installs with `halloween` as the theme. | Needs opt-in telemetry (none exists). | Oct 31 | — |
| M8 | Post-holiday retention | Share of M7 still on `halloween` on Nov 8. | Same as M7. | Nov 8 | — |
| M9 | Invitation response | "Try it" vs "Not now" on the in-app card (launch.md). | Same as M7. | Oct 31 | — |
| M10 | Reported problems | Issues or replies about flicker, CPU or readability. | GitHub issues, post replies. | T0+7 d | Zero is the target for flicker and CPU. |

## Decisions these numbers drive

- **M1/M2 vs the launch post.** If the post does not beat the launch post
  (119 likes) by T0+72 h, the frame did not do its job. Compare it with the
  blind-test winner before the next seasonal theme.
- **M3 and M5.** These separate "people liked the picture" from "people
  tried Termany".
- **M7–M9.** These need a telemetry decision first (launch.md). Without
  one, report them as "not measurable" rather than guessing from stars.
