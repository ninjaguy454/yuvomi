# Shared modal dismissal correction

This bounded follow-up to derived variables fixes two longstanding causes of
false discard prompts in the shared modal primitive:

- A mobile touch anywhere inside content scrolled to the top armed a downward
  sheet-dismiss gesture. Fast reading/scrolling could therefore request closure.
- Backdrop click and touchend handlers checked only the final target. Browsers
  can retarget a mouse click to the backdrop when text selection or dragging
  starts inside the dialog and ends outside it.

Backdrop dismissal now requires one primary pointer interaction that starts and
ends on the active backdrop, with no movement beyond an 8 CSS-pixel tap tolerance.
Travel invalidates the interaction even if it returns to its starting position.
Actual hit testing handles implicit touch capture. Pointer cancellation, scroll,
wheel, drag-and-drop, context menus and leaving the overlay during a press cancel
eligibility. Closure occurs only on the subsequent qualified click, never on
touchend alone. Each overlay owns its state; parked/inert parents cannot dismiss
their active children.

Implicit sheet swipe-to-dismiss and its decorative handle/extra spacing are
removed. Native scrolling is left to the browser. Explicit Close/Cancel,
qualified backdrop taps, Escape and browser Back retain the existing dirty guard,
focus restoration and nested-dialog/history behavior. The service-worker cache
generation advances to `vidamia.5` so installed apps receive matching JS/styles.

No database migration, new persistence, expression semantics or household data
changes. Schema remains **10030**. The existing optional profile fields,
reusable/static variables and derived-variable resolution remain intact.

## Validation and visual QA

Final affected matrix: **375 passed, zero failed or skipped** (185 shared
component checks, 90 expression/template checks, 47 guards, and 53 browser/view
checks). Six changed JavaScript files passed syntax checks, 52 tracked JSON files
parsed successfully, and diff/whitespace checks passed.

The dedicated native-input browser suite covers selection drags that really
produce an overlay-targeted click, inside-down/outside-up, travel returning to its
origin, downward touch scrolling at the top and middle, scrolling after release,
real backdrop taps/clicks, native drag-and-drop, wheel and scrollbar interaction,
Cancel/Close/Escape/browser Back, clean dismissal and nested editor restoration.
The actual variable-editor suite adds dirty desktop/mobile interaction regressions.

Browser-animated scrolling after touch release models the momentum phase because
CDP does not consistently produce platform inertial flings. This is not a claim
of physical Android/iOS device testing. Manual Chrome QA also exercised a long,
expanded expression editor at 390x844 and 1366x900 in Warm/Dark/Serif: scrolling
and selection retained the draft, deliberate Cancel/backdrop requested discard,
and canceling confirmation restored the description and expression. Existing
editor fixtures cover the theme/appearance combinations.

The affected matrix includes modal/child/history utilities, detail views, Cooking
Map workspace, Task fields/launcher/draft, expression engine/routes, Activity and
Workflow integration, service-worker privacy/upgrade, and source/suite guards.
An existing detail-view CSS guard mistakenly scanned a `max-width: 639px` media
condition as a style declaration. The test now uses the existing CSS rule parser
to inspect declaration bodies; the application stylesheet was not changed.

Separate navigation-only More-sheet gestures and custom non-modal pickers are
outside this correction. They do not use the shared dirty/discard path. No new
gesture system or broad popup/history redesign is introduced.
