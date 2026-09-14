# Telemetry

Caret sends anonymous usage and crash data to help improve it. This page lists everything that is collected. If a pull request adds or changes an event, it must update this page — this table is the contract.

## How to turn it off

Any one of these works:

1. Click **Turn off** on the notice Caret shows the first time it runs.
2. Open **Backend → Privacy** and untick "Send anonymous usage and crash data".
3. Set the environment variable `CARET_DISABLE_TELEMETRY=1`.

When telemetry is off, no analytics client is even constructed — there is no code path that can send anything.

## What identifies you

A random UUID, generated on this machine the first time an event is sent, stored in Caret's local preferences file. It is not derived from your hardware, your username, or anything else, and it is not tied to any account (Caret has no accounts). Location lookup from your IP address is disabled (`disableGeoip`).

## What is never sent

- File contents, page contents, or anything you or the AI wrote
- Prompts, chat messages, or model output
- File paths, project names, or folder names
- Your name, email, hostname, or any account identifier
- API keys or secrets (the channels that carry them are structurally excluded from tracking)

Error messages are scrubbed before sending: absolute paths, quoted strings, and JSON bodies are all removed, because log lines can embed content.

## Where it goes

[PostHog](https://posthog.com), EU cloud (Frankfurt). The API key baked into the app is a public, write-only project key — it can send events but cannot read any data back, so keeping it secret would achieve nothing.

## Every event

Common properties on all events: `app_version`, `platform` (e.g. `darwin`), `arch` (e.g. `arm64`), `channel` (`packaged` or `dev`).

### App lifecycle

| Event | Properties |
|---|---|
| `app_launched` | `restored_windows` (count) |
| `app_quit` | `session_duration_s` |
| `project_opened` | `open_windows` (count) |
| `surface_switched` | `surface`: canvas / foundation / agent / assets |

### Foundation interview (onboarding)

| Event | Properties |
|---|---|
| `wizard_started` | `mode`: ai-led / collaborative / other |
| `wizard_step` | `action`: answer / back / retry / finish_now; `ok`; `duration_s` |
| `wizard_committed` | `ok`; `duration_s` |
| `wizard_abandoned` | `ok`; `duration_s` |

### Asset generation

| Event | Properties |
|---|---|
| `generate_step` | `stage`: clarify / brief / variants / refine / render; `lane`: image / recipe / mark / shader / model3d; `ok`; `duration_s` |
| `generate_accepted` | `lane`; `ok`; `duration_s` |
| `generate_abandoned` | `ok`; `duration_s` |

### Canvas editing

| Event | Properties |
|---|---|
| `canvas_action` | `action`: inline_edit / ai_edit / overlay_edit / param_edit / resize_commit / promote_token / flow_edge_create / flow_edge_delete / flow_edge_update / design_undo / design_redo |
| `explore_variants_requested` | — |
| `explore_variant_picked` | — |
| `explore_cancelled` | — |

### Agent

| Event | Properties |
|---|---|
| `agent_turn_completed` | `kind`: chat / edit / sync-plan / sync-apply; `ok`; `duration_s`; `files_changed` (count); `unattended` (bool) |
| `agent_turn_aborted` | `kind` |
| `agent_backend_selected` | `backend_id` (fixed vocabulary, or "other") |
| `mcp_tool_invoked` | `tool` (Caret's own fixed tool names); `ok`; `initiator`: agent |

### Sync

| Event | Properties |
|---|---|
| `sync_started` | `audience`: backend / mcp |
| `sync_blocked` | `status`: no-caret-dir / no-agent / git-not-installed / needs-git-setup / needs-design-commit |
| `sync_noop` | — |
| `sync_plan_completed` | `ok` |
| `sync_apply_completed` | `ok`; `files_changed` (count) |
| `sync_rolled_back` | `ok`; `duration_s` |

### Component catalog

| Event | Properties |
|---|---|
| `catalog_install_requested` | `initiator`: agent / auto; `library` (fixed catalog id, or "unknown") |
| `catalog_install_completed` | same |
| `catalog_install_denied` | same |

### Errors

| Event | Properties |
|---|---|
| `error_logged` | `source` (subsystem tag, e.g. `design`, `agent`); `message` (scrubbed, max 200 chars); `message_hash` |
| exceptions | scrubbed message and stack; `source`: main / renderer |
| `telemetry_disabled` | `at`: first_run_notice / settings — the one farewell event when you switch telemetry off, so the opt-out rate itself is measurable |

Errors are deduplicated per session (one send per distinct message) and hard-capped (20 error lines, 10 exceptions per session), so a crash loop cannot flood anything.

## For contributors

- The event vocabulary lives in `desktop/shared/telemetry.ts` (IPC channel allowlist, scrubber, budgets) — a channel absent from `CHANNEL_EVENTS` emits nothing.
- The client lives in `desktop/main/analytics.ts`; the design core emits through `src/core/design/telemetry-hooks.ts` and never imports an analytics library.
- Dev runs are dry-run by default: with `IS_DEV=true`, events print to the log instead of sending. Set `CARET_TELEMETRY_LIVE=1` to test real delivery.
- Tests: `desktop/shared/__tests__/telemetry.test.ts` holds the scrubbing and allowlist guarantees.
