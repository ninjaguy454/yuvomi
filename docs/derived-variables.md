# Derived household variables

Vidamia can calculate reusable values from the same typed inputs already used
by Activity Templates and Task Workflows. A calculated name can be reused in
ordinary template text, such as `{{derived_name}}'s Laundry`.

In **Household automation → Variables**, create a Household member input such
as `selected_household_member`, then a Text variable named `derived_name` with
the **Calculated value** source:

```text
coalesce(
  selected_household_member.nickname,
  selected_household_member.first_name,
  selected_household_member.display_name
)
```

The optional first name, last name and nickname fields are available in Account
and the existing household member editor. Display names remain independent.
Existing names are not guessed or split automatically. If nickname and first
name are blank, the example uses the existing display name.

## Expression vocabulary

- Quoted text, numbers, `true`, `false`, `null`, parentheses and named variables.
- Comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=` between compatible types.
- `coalesce(value, ...)`: first non-null, non-blank value; preserves `0` and `false`.
- `if(condition, yesValue, noValue)`: a Boolean condition and compatible results.
- `switch(value, case, result, ..., default)`: case/result pairs and a required default.
- `concat(text, ...)`, `lower(text)`, `upper(text)` and `title(text)`.

Member properties are `id`, `first_name`, `last_name`, `display_name` and
`nickname`. Place properties are `id`, `name`, `parent` and `address`. Other
properties, nested traversal and method calls are unavailable. Whole Member
and Place values retain their type; string helpers require a text property.

Member IDs are stable numeric identifiers. Use the editor's member insertion
help to build aliases without looking up IDs manually. For example, after
inserting the appropriate household IDs:

```text
switch(selected_household_member.id, 7, "Dad", 9, "Mom",
  selected_household_member.display_name)
```

Changing a display name does not change its ID. Case/result and conditional
branches must return compatible types. Only the selected branch is evaluated,
but all references and dependency cycles are checked before execution.

## Persistence and execution

Reusable definitions retain their existing identity, type, default and input
behavior. An optional `expression: { version: 1, source: "..." }` document
selects calculation instead. Linked workflow variables read the canonical
household definition; workflow-local expressions use the existing workflow
input schema. Absent expressions preserve ordinary variable behavior.

One pure parser and evaluator serves browser validation and server execution.
The server hydrates approved Member/Place metadata from database references,
resolves dependencies, then passes resolved labels through the existing
template interpolation path. Stable entity IDs continue to serve assignment,
conditions and saved workflow inputs. Created Tasks are snapshots: editing a
profile or formula affects subsequent previews/runs, not existing Task text.

Every preview/run recalculates derived values; supplied or previously resolved
derived values cannot override a formula. Missing required values and invalid
references produce errors before Task creation. Direct Activity Template use
collects the necessary ordinary inputs in the existing Task form.

Migration **10030** adds nullable `users.first_name`, `users.last_name`,
`users.nickname` and `household_variable_definitions.expression_json`. Existing
migrations, contact synchronization, recipes, portions, Cooking Maps and
grocery accounting are unchanged.

## Boundaries

This is a deterministic expression evaluator, not JavaScript. It has no
assignments, loops, arithmetic, dynamic imports, object construction, runtime
globals, network/filesystem access or side effects. Explicit property/function
allowlists and bounded source length, nesting, nodes, variables, output and
evaluation work apply on the server as well as in the editor.

The first version retains existing variable types. It does not introduce new
Recipe/Calendar reference types, general scripting, scheduling or a new
interpolation syntax. Optional metadata must be entered explicitly, and live
preview requires enough sample input to evaluate the selected calculation.
