import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPRESSION_LIMITS, normalizeExpression, parseExpression, validateExpression,
  expressionDependencies, validateVariableDefinitions, resolveExpressionVariables,
  renameExpressionReference,
} from '../public/utils/variable-expressions.js';

const member = { id: 7, first_name: 'Grace', last_name: 'LaPrease', display_name: 'Gracelynn LaPrease', nickname: 'Gracie' };
const base = { id: 'selected_household_member', type: 'household_member', label: 'Household member' };
const derived = (id, source, type = 'text') => ({ id, type, expression: { version: 1, source } });
const calculate = (source, inputs = { selected_household_member: member }, type = 'text', definitions = [base]) => resolveExpressionVariables([...definitions, derived('result', source, type)], inputs, { keys: ['result'] }).values.result;

for (const property of ['first_name', 'last_name', 'display_name', 'nickname', 'id']) {
  test(`Member ${property} is resolved from safe structured metadata`, () => {
    assert.equal(calculate(`selected_household_member.${property}`, undefined, property === 'id' ? 'number' : 'text'), member[property]);
  });
}
test('nickname fallback uses first name, then display name without guessing name parts', () => {
  const expression = 'coalesce(selected_household_member.nickname, selected_household_member.first_name, selected_household_member.display_name)';
  for (const [metadata, expected] of [[member, 'Gracie'], [{ ...member, nickname: null }, 'Grace'], [{ ...member, nickname: ' ', first_name: '' }, 'Gracelynn LaPrease']]) {
    assert.equal(calculate(expression, { selected_household_member: metadata }), expected);
  }
});
test('coalesce preserves zero and false but skips empty text/null', () => {
  assert.equal(calculate('coalesce(null, 0, 4)', {}, 'number', []), 0);
  assert.equal(calculate('coalesce(null, false, true)', {}, 'boolean', []), false);
  assert.equal(calculate('coalesce("", "  ", "Ready")', {}, 'text', []), 'Ready');
  assert.equal(calculate('coalesce(null, "")', {}, 'text', []), null);
});
test('if uses typed boolean/comparison conditions and evaluates only the selected branch', () => {
  assert.equal(calculate('if(selected_household_member.id == 7, "Yes", "No")'), 'Yes');
  assert.equal(calculate('if(false, unavailable, "Ready")', {}, 'text', [{ id: 'unavailable', type: 'text' }]), 'Ready');
  assert.throws(() => calculate('if("yes", "A", "B")'), /Yes\/No/);
  assert.throws(() => calculate('if(true, "A", 2)'), /same kind/);
});
test('switch uses stable numeric Member IDs even after a display-name change', () => {
  const expression = 'switch(selected_household_member.id, 7, "Daughter", 9, "Dad", selected_household_member.first_name)';
  assert.equal(calculate(expression), 'Daughter');
  assert.equal(calculate(expression, { selected_household_member: { ...member, display_name: 'Renamed person' } }), 'Daughter');
  assert.equal(calculate(expression, { selected_household_member: { ...member, id: 9, first_name: 'Duane' } }), 'Dad');
  assert.equal(calculate(expression, { selected_household_member: { ...member, id: 10, first_name: 'Jamie' } }), 'Jamie');
  assert.throws(() => calculate('switch(selected_household_member.id, "7", "Alias", "Default")'), /same type/);
  assert.throws(() => calculate('switch(7, 7, "Alias")'), /arguments/);
  assert.throws(() => calculate('switch(7, 7, "Alias", 8, "Extra")'), /default/);
});
test('string helpers support text and Unicode without coercing structured entities', () => {
  assert.equal(calculate('concat(upper(selected_household_member.nickname), " / ", lower(selected_household_member.first_name))'), 'GRACIE / grace');
  assert.equal(calculate('title("éLÉONORE’S laundry")', {}, 'text', []), 'Éléonore’s Laundry');
  assert.throws(() => calculate('upper(selected_household_member)'), /needs text/);
  assert.throws(() => calculate('concat("Portions: ", 2)'), /needs text/);
  assert.throws(() => calculate('lower(selected_household_member.nickname)', { selected_household_member: { ...member, nickname: null } }), /fallback/);
});
test('expression results preserve Member and Place objects, filtering unknown fields', () => {
  const person = calculate('if(true, selected_household_member, null)', { selected_household_member: { ...member, password_hash: 'secret', token: 'secret' } }, 'household_member');
  assert.equal(person.id, 7);
  assert.equal(person.nickname, 'Gracie');
  assert.equal(person.password_hash, undefined);
  assert.equal(person.token, undefined);
  assert.ok(Object.isFrozen(person));
  const definition = { id: 'destination', type: 'location' };
  const place = { id: 2, name: 'Kitchen', parent: 'Home', address: 'Main Street' };
  assert.equal(calculate('destination.name', { destination: place }, 'text', [definition]), 'Kitchen');
  assert.equal(calculate('coalesce(destination, null)', { destination: place }, 'location', [definition]).id, 2);
});
test('date/time/number/boolean types remain typed across conditional derivation', () => {
  for (const [type, value] of [['date', '2026-09-10'], ['time', '12:30'], ['number', 2.5], ['boolean', false]]) {
    const result = resolveExpressionVariables([{ id: 'input', type }, derived('output', 'if(true, input, null)', type)], { input: value });
    assert.equal(result.values.output, value);
    assert.equal(result.types.output, type);
  }
  assert.throws(() => validateExpression('"2026-09-10"', [], { expectedType: 'date' }), /expects date/);
});
test('missing input is an actionable error and cannot reuse an old derived value', () => {
  const expression = derived('name', 'selected_household_member.first_name');
  assert.throws(() => resolveExpressionVariables([base, expression], { name: 'Old cached name' }, { keys: ['name'] }), error => error.code === 'missing_input' && error.variableKey === base.id);
  assert.throws(() => validateExpression('missing.nickname', [base]), error => error.code === 'unknown_variable');
  assert.throws(() => validateExpression('selected_household_member.password_hash', [base]), error => error.code === 'invalid_property');
});
test('dependencies resolve out of authoring order and update for a different selected member', () => {
  const definitions = [derived('title', 'concat(derived_name, "\'s Laundry")'), derived('derived_name', 'coalesce(selected_household_member.nickname, selected_household_member.first_name)'), base];
  const first = resolveExpressionVariables(definitions, { selected_household_member: member });
  const second = resolveExpressionVariables(definitions, { ...first.values, selected_household_member: { ...member, id: 8, nickname: 'Jamie', first_name: 'James' } });
  assert.equal(first.values.title, "Gracie's Laundry");
  assert.equal(second.values.title, "Jamie's Laundry");
  assert.deepEqual(validateVariableDefinitions(definitions).order, [base.id, 'derived_name', 'title']);
});
test('self references and indirect cycles are rejected even in unselected branches', () => {
  assert.throws(() => validateVariableDefinitions([derived('a', 'a')]), error => error.code === 'cycle');
  assert.throws(() => validateVariableDefinitions([derived('a', 'b'), derived('b', 'if(false, a, "ok")')]), error => error.code === 'cycle');
});
test('ordinary legacy input values stay unchanged; callers choose required roots', () => {
  const definitions = [{ id: 'label', type: 'text' }, { id: 'quantity', type: 'number' }, { id: 'later', type: 'text' }];
  const result = resolveExpressionVariables(definitions, { label: 'Laundry', quantity: 0 }, { keys: ['label', 'quantity'] });
  assert.equal(result.values.label, 'Laundry');
  assert.equal(result.values.quantity, 0);
  assert.equal(Object.hasOwn(result.values, 'later'), false);
});
test('system context has only exact supplied keys plus an allowed metadata property', () => {
  const definitions = [{ id: 'context.household_member', type: 'household_member' }];
  const source = 'context.household_member.nickname';
  assert.deepEqual(expressionDependencies(source, definitions), ['context.household_member']);
  assert.equal(calculate(source, { 'context.household_member': member }, 'text', definitions), 'Gracie');
  assert.throws(() => calculate('context.env.SECRET', {}, 'text', definitions), /not available/);
});
test('renaming updates only variable-reference tokens, preserving literal aliases', () => {
  const expression = { version: 1, source: 'switch(person.id, 7, "person", concat(person.first_name, person_extra))' };
  const renamed = renameExpressionReference(expression, 'person', 'member');
  assert.equal(renamed.source, 'switch(member.id, 7, "person", concat(member.first_name, person_extra))');
  assert.equal(renameExpressionReference(null, 'person', 'member'), null);
  assert.equal(renameExpressionReference('context .household_member .nickname', 'context.household_member', 'person').source, 'person .nickname');
});
for (const source of ['eval("1")', 'Function("return 1")', 'process.env', 'window.document', 'globalThis', 'import("node:fs")', 'member["nickname"]', 'selected_household_member.constructor', 'selected_household_member.__proto__', 'selected_household_member.id.toString()', '{}', '[]', '`text`', 'a = 1', '1 + 2', 'if(true,"a",)', 'coalesce("open)', 'lower()', 'upper("a", "b")', '1; process.exit()', 'Infinity', '1e999']) {
  test(`reject unsupported or malformed expression: ${source}`, () => assert.throws(() => validateExpression(source, [base])));
}
test('source, nesting, output and definition limits prevent unbounded work', () => {
  assert.throws(() => parseExpression('x'.repeat(EXPRESSION_LIMITS.source + 1)), /too long/);
  assert.throws(() => parseExpression('lower('.repeat(40) + '"X"' + ')'.repeat(40)), /deeply/);
  const source = 'concat(' + Array.from({ length: 64 }, () => 'long').join(',') + ')';
  assert.throws(() => calculate(source, { long: 'x'.repeat(1000) }, 'text', [{ id: 'long', type: 'text' }]), /too long/);
  assert.throws(() => validateVariableDefinitions(Array.from({ length: 257 }, (_, index) => ({ id: `v${index}` }))), /Too many/);
  assert.throws(() => normalizeExpression({ version: 2, source: '1' }), /version 1/);
});
