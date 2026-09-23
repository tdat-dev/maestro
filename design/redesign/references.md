# Maestro redesign — Mobbin references

Researched 2026-09-23 via Mobbin MCP (~85 screens viewed, ~40 relevant). Each row: what we took, and where.

## Queue (triage list)
| Pattern taken | Source |
|---|---|
| Row = title first, subtitle second, time right; list + detail split | [Linear Inbox](https://mobbin.com/screens/beb9d6b3-ec34-46d7-9332-320fcb32a338) |
| Status subline in colour under the title ("PR is ready · 1") | [Devin sessions](https://mobbin.com/screens/92e0222c-8ba8-4abe-bc18-3ddef5b2e357) |
| `+17 −0` diff counts on the agent row; Draft / Branch / Merged chip | [Cursor agents](https://mobbin.com/screens/9042dc24-874c-4f95-821e-b9b63972426e) |
| Folder counts Open / Later / Done; status Open · Waiting · Resolved | [Front](https://mobbin.com/screens/d2c36bc8-4873-4542-8099-ce62ebaff44f) |
| J/K, E done, H snooze, X select — keyboard-first triage | [Superhuman shortcuts](https://mobbin.com/screens/0e821e22-026a-4641-a91b-ac63b0c9e4bc) |
| Status as dot + word + duration, never colour alone | [Vercel deployments](https://mobbin.com/screens/b9d9cc23-34a1-434c-a4ed-52a2a4f49bb7) |
| Floating "N selected · Actions" bulk bar | [Linear bulk](https://mobbin.com/screens/be6c4ee4-aa93-42b4-89b3-dcfc8386f022), [ClickUp](https://mobbin.com/screens/e9639493-e0a6-46c9-93d1-d3189cbdc3c7) |
| Calm "All clear" empty state, no illustration needed | [folk](https://mobbin.com/screens/c6b36328-75fa-4807-bd64-a2b1d80d21a5), [Todoist](https://mobbin.com/screens/563db5cb-70c8-4aa1-be46-67ddca6c7d60) |

## Stage (one agent)
| Pattern taken | Source |
|---|---|
| Approval docks at the composer: "Always allow · Stop · Approve ↵" | [Higgsfield](https://mobbin.com/screens/f0ee7046-b34e-415a-a830-564baf6f902d) |
| Question as numbered options + "Something else" + Skip | [Claude](https://mobbin.com/screens/34aa9592-2138-4be6-95f6-4aa7410e9bb9) |
| "Agent is running…" strip + Stop button on the composer | [Emergent](https://mobbin.com/screens/4a3b2d78-ee1c-406f-824e-6a5d5f4fa8a8) |
| "3 Files Changed" block closes the agent's turn, per-file +N | [Cursor agent run](https://mobbin.com/screens/2d15a5ae-b0e1-41b7-bcc0-d6c6c9bf5901) |
| Step list with checks, collapsible tool calls | [Lindy](https://mobbin.com/screens/9f4affd5-f387-4149-860e-95c83f9bbba5) |

## Review
| Pattern taken | Source |
|---|---|
| "0 / 2 files viewed" + Viewed checkbox per file | [GitHub PR](https://mobbin.com/screens/72783a50-4cc2-4e3d-83f9-048f9a2455cf) |
| File tree + diff + "Mark as viewed", review in the same app | [Devin Review](https://mobbin.com/screens/943c5aac-94ad-4e06-bbab-70d3a88e3fa1) |
| Review box: comment + request changes / approve at the bottom | [Graphite](https://mobbin.com/screens/b16e3604-0116-4db7-8fbe-effb138c49d6) |
| Git tab: Merged chip, `branch → main`, Diff / Review / Commits | [Cursor Git tab](https://mobbin.com/screens/d00c5e44-2ada-4ac0-8ba8-757a2b3ceeee) |

## Race (several agents, one task)
| Pattern taken | Source |
|---|---|
| Base vs comparison columns, same input, pick a winner | [Braintrust playground](https://mobbin.com/screens/da7f4d57-a8bd-4efd-b827-1dabf6d7ef30) |
| Side-by-side model outputs with token counts | [Google AI Studio compare](https://mobbin.com/screens/c6a5dd57-4d2f-4c6b-83cf-21a32c897eb3), [Chatbase](https://mobbin.com/screens/fa79d27e-f521-4410-a6a0-87aa921b6319) |

## Palette, new task, shortcuts
| Pattern taken | Source |
|---|---|
| Palette teaches the shortcut next to every action | [Superhuman Command](https://mobbin.com/screens/85dc5994-9360-428d-9092-7425e070ed7f) |
| Footer hints "↑↓ navigate · ↵ select · esc" | [Vapi](https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b), [Magnific](https://mobbin.com/screens/14ceb943-f04a-460f-b4f5-2ebd78d74aff) |
| New item = big text + one row of property chips + "Create more" | [Linear New issue](https://mobbin.com/screens/7d2d62c7-8fb9-40d8-bd36-f1a8ff0a860c) |
| Repo / branch / model picked around the prompt | [Cursor new agent](https://mobbin.com/screens/59358834-5391-4d2d-8a18-e80750431b58) |
| `?` opens a shortcut sheet on the right | [Front](https://mobbin.com/screens/6b6a701f-8589-415c-9c52-c91d4feade1c), [Superhuman](https://mobbin.com/screens/3ae6bf95-6bbd-4232-b045-3160b748393c) |

## Dark palette calibration
Near-neutral grounds, low-chroma borders, colour only on status: [Railway](https://mobbin.com/screens/dd6801ce-350b-479d-b296-7210dbb2c252), [Supabase](https://mobbin.com/screens/782baf2b-1d87-4a1c-a461-a87acc585ba9), [Neon](https://mobbin.com/screens/cf45e7bf-4a0e-40cc-9db5-a29845b58d4e), [Modal](https://mobbin.com/screens/dead35ef-913f-4e93-ae99-888e3f17d95a).

## Deliberately not taken
- Card grids for agents (Cursor dashboard thumbnails): too little signal per pixel at 10+ agents.
- Big-number KPI tiles (Railway usage, Sentry): cost is a line in the header, not a dashboard.
- Illustrated empty states (Kiwi, Todoist kite): a dev tool says "All clear" and gets out of the way.
