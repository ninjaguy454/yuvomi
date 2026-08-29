# Household Planning Phases 3–5 Release Audit

Audited: August 28, 2026

This document maps the committed roadmap outcomes to the implementation and release checks. It treats later wishlist ideas as future work rather than retroactively expanding a completed phase.

## Phase 3 — Places, Availability, and Presence

Status: complete.

- Reusable Places use immutable Yuvomi IDs, support hierarchy, address/coordinates, activation, rename-safe references, and guarded deletion.
- Activity Templates and workflow steps can use fixed or variable Places.
- Weekly availability, dated exceptions, manual overrides, and expiry are first-class records.
- Presence combines manual, Calendar, workflow, and availability sources with explicit priority.
- Eligibility is evaluated for the relevant activity or meal window rather than only the current moment.
- Calendar and Meal Plan consume the same Place and availability records.
- Migration 10007 and the Phase 3 integration suite cover legacy compatibility, Places, availability, presence, and cross-module references.

Future ideas such as provider-backed Place discovery and trip orchestration were deliberately assigned to Phase 5. Broader Calendar-derived automation remains later roadmap work.

## Phase 4 — Assignment, Participation, and Meal Automation

Status: complete.

- Assignment supports Fixed, Eligible Round Robin, Eligible Random, Open/Claimable, multi-person rotating sequence, and safe per-occurrence overrides.
- Assignee, participants, beneficiary, subtask assignees, supervisor, meal chooser, cook, and meal participants remain distinct concepts.
- Durable obligations track response deadlines, attempts, acceptance, decline, timeout, fulfillment, cancellation, supersession, and fallback.
- Claims and overrides recheck skill, age, availability, presence, and participation eligibility.
- Meal selection supports Fixed, Round Robin, and Personal Choice requests, reminders, fallback, personal alternatives, and focused regeneration.
- Preview and reconciliation are idempotent and do not consume rotation state or duplicate work.
- Migration 10008 and the Phase 4 integration suite cover the assignment and meal-automation release gate.

Bounty presentation, reward settlement, and advanced visual workflow branching build on Phase 4 but remain Phases 7–9; they are not missing Phase 4 commitments.

## Phase 5 — Calendar Coordination, Locations, Travel, and Reader Mode

Status: complete; follow-up usability improvements verified for deployment.

- Planned meals and trip stages appear on the main Calendar as read-only planning overlays.
- Meal conflicts are participant-specific, fingerprinted, advisory, and reopen only after material changes.
- Focused resolutions include keeping time/window, moving the meal, changing participation, assigning backup, creating a personal alternative, and ignoring.
- Tasks support no location, a saved Yuvomi Place, a manual use-once location, or a Google Place reference.
- Google Places search is deliberate, origin-aware, field-mask limited, quota controlled, server-side, and optional. Search origins may be a reusable Place, an address/city/ZIP, or unspecified; users are not required to provide coordinates. It degrades to saved/manual locations when unconfigured.
- The reusable Places catalog is exposed from Tasks as a household address book, with manual address entry and an optional Google-backed discovery action.
- Use-once results can be promoted atomically into the Phase 3 Places catalog without changing Yuvomi's immutable Place identity.
- Trips support travelers, destination/lodging Places, departure/return times, Away periods, six itinerary stages, Calendar overlays, and optional relative Tasks.
- `/reader` provides a server-rendered, no-JavaScript interface for older e-readers and browsers, with local-password and two-factor sign-in support. It includes Today, Tasks, task creation, a navigable month Calendar with event details, Meals, and recipe browsing.
- Migrations 10009–10011 and the Phase 5 integration and Reader suites cover location identity, provider safeguards, conflicts, travel, and compatibility.

## Verification boundary

Completion means every outcome explicitly assigned to Phases 3, 4, and 5 in the roadmap has implementation and focused regression coverage. Unchecked examples or enhancements assigned to later phases remain visible in the wishlist with their later-phase status.
