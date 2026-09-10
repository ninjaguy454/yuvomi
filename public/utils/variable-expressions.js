/** Bounded, side-effect-free expressions shared by template editing and execution.
 * This module resolves typed values only. Existing template interpolation owns
 * text rendering, and the server supplies authorized entity metadata. */
export const EXPRESSION_LIMITS = Object.freeze({ source: 4096, nodes: 512, depth: 32, variables: 256, output: 16000, work: 16384 });
export const EXPRESSION_PROPERTIES = Object.freeze({
  household_member: Object.freeze({ id: 'number', first_name: 'text', last_name: 'text', display_name: 'text', nickname: 'text' }),
  location: Object.freeze({ id: 'number', name: 'text', parent: 'text', address: 'text' }),
});
export const EXPRESSION_FUNCTIONS = Object.freeze([
  { name: 'coalesce', signature: 'coalesce(value, fallback, ...)', description: 'Use the first value that is not blank. Zero and No still count as values.' },
  { name: 'if', signature: 'if(condition, whenTrue, whenFalse)', description: 'Choose a value using a Yes/No value or comparison.' },
  { name: 'switch', signature: 'switch(value, case, result, ..., default)', description: 'Match cases in order, then use the final default. Use a member’s .id for aliases.' },
  { name: 'concat', signature: 'concat(text, ...)', description: 'Join text values together.' },
  { name: 'lower', signature: 'lower(text)', description: 'Change text to lowercase.' },
  { name: 'upper', signature: 'upper(text)', description: 'Change text to uppercase.' },
  { name: 'title', signature: 'title(text)', description: 'Capitalize each word.' },
].map(Object.freeze));
const FUNCTIONS = new Set(EXPRESSION_FUNCTIONS.map(item => item.name));
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const TYPES = new Set(['text', 'choice', 'number', 'boolean', 'date', 'time', 'household_member', 'location']);
const canonicalType = type => type === 'select' ? 'choice' : type || 'text';
const comparableType = type => type === 'choice' ? 'text' : type;
const keyOf = definition => definition.variable_key ?? definition.key ?? definition.id;
const own = (value, key) => value != null && Object.hasOwn(value, key);

export class ExpressionError extends Error {
  constructor(message, code = 'invalid_expression', details = {}) {
    super(message);
    this.name = 'ExpressionError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function normalizeExpression(expression) {
  if (expression == null || expression === '') return null;
  const document = typeof expression === 'string' ? { version: 1, source: expression } : expression;
  if (!document || Array.isArray(document) || document.version !== 1 || typeof document.source !== 'string') {
    throw new ExpressionError('This calculation must contain a version 1 expression.');
  }
  const source = document.source.trim();
  if (source.length > EXPRESSION_LIMITS.source) throw new ExpressionError('This calculation is too long. Use a few smaller variables.');
  return source ? { version: 1, source } : null;
}

/** Recursive descent over literals, named references, comparisons and calls.
 * No object/array literals, computed property access, methods or executable code. */
export function parseExpression(expression) {
  const source = normalizeExpression(expression)?.source;
  if (!source) throw new ExpressionError('Enter a calculation first.');
  let cursor = 0, count = 0;
  const fail = message => { throw new ExpressionError(`${message} (character ${cursor + 1}).`, 'invalid_expression', { position: cursor }); };
  const skip = () => { while (/\s/u.test(source[cursor] || '') && cursor < source.length) cursor++; };
  const node = value => { if (++count > EXPRESSION_LIMITS.nodes) fail('This calculation has too many parts'); return value; };
  const identifier = () => {
    const match = /^[A-Za-z][A-Za-z0-9_-]*/.exec(source.slice(cursor));
    if (!match) fail('Use a variable, quoted text, number or supported function');
    cursor += match[0].length;
    if (FORBIDDEN.has(match[0])) fail('That name is not available');
    return match[0];
  };
  function primary(depth) {
    if (depth > EXPRESSION_LIMITS.depth) fail('This calculation is nested too deeply');
    skip();
    const start = cursor, ch = source[cursor];
    if (ch === '(') {
      cursor++; const value = comparison(depth + 1); skip();
      if (source[cursor++] !== ')') fail('Expected a closing parenthesis');
      return value;
    }
    if (ch === '"' || ch === "'") {
      cursor++; let value = '', closed = false;
      while (cursor < source.length) {
        const current = source[cursor++];
        if (current === ch) { closed = true; break; }
        if (current === '\\') {
          const escaped = source[cursor++];
          const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" };
          if (!own(escapes, escaped)) fail('Use a supported text escape');
          value += escapes[escaped];
        } else {
          if (current < ' ') fail('Use an escaped line break inside quoted text');
          value += current;
        }
      }
      if (!closed) fail('Close the quoted text');
      return node({ kind: 'literal', type: 'text', value, start, end: cursor });
    }
    const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(cursor));
    if (numeric) {
      cursor += numeric[0].length; const value = Number(numeric[0]);
      if (!Number.isFinite(value)) fail('Use a finite number');
      return node({ kind: 'literal', type: 'number', value, start, end: cursor });
    }
    const name = identifier(), nameEnd = cursor; skip();
    if (['true', 'false', 'null'].includes(name)) return node({ kind: 'literal', type: name === 'null' ? 'null' : 'boolean', value: name === 'null' ? null : name === 'true', start, end: cursor });
    if (source[cursor] === '(') {
      if (!FUNCTIONS.has(name)) fail(`“${name}” is not a supported function`);
      cursor++; skip(); const args = [];
      if (source[cursor] !== ')') {
        while (true) {
          args.push(comparison(depth + 1)); skip();
          if (source[cursor] !== ',') break;
          cursor++;
        }
      }
      if (source[cursor++] !== ')') fail('Separate function arguments with commas and close the parenthesis');
      return node({ kind: 'call', name, args, start, end: cursor });
    }
    const parts = [name], segments = [{ start, end: nameEnd }];
    while (source[cursor] === '.') {
      cursor++; const partStart = cursor; parts.push(identifier());
      segments.push({ start: partStart, end: cursor }); skip();
      if (parts.length > 3) fail('Only listed metadata properties are available');
    }
    return node({ kind: 'reference', name: parts.join('.'), segments, start, end: cursor });
  }
  function comparison(depth) {
    const left = primary(depth); skip();
    const operator = /^(==|!=|<=|>=|<|>)/.exec(source.slice(cursor))?.[0];
    if (!operator) return left;
    cursor += operator.length;
    return node({ kind: 'comparison', operator, left, right: primary(depth + 1) });
  }
  const ast = comparison(0); skip();
  if (cursor !== source.length) fail('Unexpected text after the calculation');
  return ast;
}

function definitionMap(definitions) {
  if (!Array.isArray(definitions) || definitions.length > EXPRESSION_LIMITS.variables) throw new ExpressionError('Too many variables in this calculation.');
  const map = new Map();
  for (const definition of definitions) {
    const key = keyOf(definition);
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)?$/.test(key) || key.split('.').some(part => FORBIDDEN.has(part))) throw new ExpressionError('A variable has an invalid ID.');
    if (map.has(key)) throw new ExpressionError(`The variable “${key}” is listed twice.`);
    const type = canonicalType(definition.type);
    if (!TYPES.has(type)) throw new ExpressionError(`The type of “${key}” is not supported.`);
    map.set(key, { ...definition, type, expression: normalizeExpression(definition.expression) });
  }
  return map;
}

function referenceInfo(reference, definitions) {
  if (definitions.has(reference.name)) return { key: reference.name, type: definitions.get(reference.name).type };
  const separator = reference.name.lastIndexOf('.');
  const key = reference.name.slice(0, separator), property = reference.name.slice(separator + 1);
  if (separator > 0 && definitions.has(key)) {
    const fields = EXPRESSION_PROPERTIES[definitions.get(key).type];
    if (!fields || !own(fields, property)) throw new ExpressionError(`“${property}” is not available on “${key}”. Choose one of its listed properties.`, 'invalid_property', { variableKey: key, key });
    return { key, property, type: fields[property] };
  }
  throw new ExpressionError(`The variable “${reference.name}” is not available. Add it or choose an existing variable.`, 'unknown_variable', { variableKey: reference.name, key: reference.name });
}

function unifiedType(types, label) {
  const populated = types.filter(type => type !== 'null').map(comparableType);
  if (new Set(populated).size > 1) throw new ExpressionError(`${label} must return the same kind of value in each case.`, 'type_mismatch');
  return populated[0] || 'null';
}
function checkComparison(left, right, operator) {
  if (left !== 'null' && right !== 'null' && comparableType(left) !== comparableType(right)) throw new ExpressionError('Compare values of the same type. For a member alias, compare the member’s .id with a numeric ID.', 'type_mismatch');
  if (!['==', '!='].includes(operator) && (!['text', 'choice', 'number', 'date', 'time'].includes(left) || right === 'null')) throw new ExpressionError('Ordering comparisons need two numbers, text values, dates or times.', 'type_mismatch');
}
function analyze(ast, definitions, dependencies) {
  if (ast.kind === 'literal') return ast.type;
  if (ast.kind === 'reference') {
    const info = referenceInfo(ast, definitions); dependencies.add(info.key); return info.type;
  }
  if (ast.kind === 'comparison') {
    checkComparison(analyze(ast.left, definitions, dependencies), analyze(ast.right, definitions, dependencies), ast.operator);
    return 'boolean';
  }
  const types = ast.args.map(argument => analyze(argument, definitions, dependencies));
  const arity = (min, max = min) => {
    if (types.length < min || types.length > max) throw new ExpressionError(`Check the arguments for ${ast.name}(). ${EXPRESSION_FUNCTIONS.find(item => item.name === ast.name).signature}`);
  };
  if (ast.name === 'coalesce') { arity(1, 64); return unifiedType(types, 'coalesce()'); }
  if (ast.name === 'if') {
    arity(3);
    if (types[0] !== 'boolean') throw new ExpressionError('The first argument of if() must be a Yes/No value or comparison.', 'type_mismatch');
    return unifiedType(types.slice(1), 'if()');
  }
  if (ast.name === 'switch') {
    arity(4, 64);
    if (types.length % 2 !== 0) throw new ExpressionError('switch() needs case/result pairs followed by one default value.');
    for (let index = 1; index < types.length - 1; index += 2) checkComparison(types[0], types[index], '==');
    return unifiedType([...types.filter((_, index) => index > 0 && index % 2 === 0), types.at(-1)], 'switch()');
  }
  arity(1, ast.name === 'concat' ? 64 : 1);
  if (types.some(type => !['text', 'choice'].includes(type))) throw new ExpressionError(`${ast.name}() needs text. Choose a name property instead of a whole member or Place.`, 'type_mismatch');
  return 'text';
}

export function validateExpression(expression, definitions, { expectedType } = {}) {
  const ast = parseExpression(expression), dependencies = new Set();
  const type = analyze(ast, definitionMap(definitions), dependencies);
  if (expectedType && type !== 'null' && comparableType(canonicalType(expectedType)) !== comparableType(type)) throw new ExpressionError(`This calculation returns ${type}, but the variable expects ${expectedType}.`, 'type_mismatch');
  return { ast, dependencies: [...dependencies], type };
}
export function expressionDependencies(expression, definitions) {
  return validateExpression(expression, definitions).dependencies;
}

export function validateVariableDefinitions(definitions) {
  const map = definitionMap(definitions), dependencies = Object.create(null), order = [], active = new Set(), complete = new Set();
  for (const [key, definition] of map) dependencies[key] = definition.expression ? validateExpression(definition.expression, definitions, { expectedType: definition.type }).dependencies : [];
  const visit = (key, trail) => {
    if (active.has(key)) throw new ExpressionError(`These calculations depend on each other: ${[...trail, key].join(' → ')}. Remove one of those references.`, 'cycle', { variableKey: key, key });
    if (complete.has(key)) return;
    active.add(key);
    for (const dependency of dependencies[key]) visit(dependency, [...trail, key]);
    active.delete(key); complete.add(key); order.push(key);
  };
  for (const key of map.keys()) visit(key, []);
  return { order, dependencies };
}

function checkedValue(value, type, label) {
  if (value == null) return null;
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return value;
  if (type === 'boolean' && typeof value === 'boolean') return value;
  if (['text', 'choice', 'date', 'time'].includes(type) && typeof value === 'string' && value.length <= EXPRESSION_LIMITS.output) return value;
  if (own(EXPRESSION_PROPERTIES, type) && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) throw new ExpressionError(`Choose a valid ${type === 'household_member' ? 'household member' : 'Place'} for “${label}”.`, 'type_mismatch');
    const sanitized = Object.create(null);
    for (const [property, propertyType] of Object.entries(EXPRESSION_PROPERTIES[type])) sanitized[property] = checkedValue(own(value, property) ? value[property] : null, propertyType, `${label}.${property}`);
    return Object.freeze(sanitized);
  }
  throw new ExpressionError(`The value of “${label}” does not match its ${type} type.`, 'type_mismatch');
}
const equal = (left, right) => left != null && right != null && typeof left === 'object' && typeof right === 'object' ? left.id === right.id : left === right;
const isBlank = value => value == null || (typeof value === 'string' && value.trim() === '');

export function resolveExpressionVariables(definitions, inputs = {}, { keys } = {}) {
  const map = definitionMap(definitions);
  validateVariableDefinitions(definitions);
  const values = Object.create(null), types = Object.create(null);
  let work = 0;
  const budget = () => { if (++work > EXPRESSION_LIMITS.work) throw new ExpressionError('This calculation does too much work. Split it into smaller variables.'); };
  const resolve = key => {
    budget();
    if (own(values, key)) return values[key];
    const definition = map.get(key);
    if (!definition) throw new ExpressionError(`The variable “${key}” is not available.`, 'unknown_variable', { key, variableKey: key });
    let value;
    if (definition.expression) value = evaluate(parseExpression(definition.expression));
    else if (own(inputs, key) && inputs[key] !== undefined) value = inputs[key];
    else throw new ExpressionError(`Choose or enter a value for “${definition.label || key}”.`, 'missing_input', { key, variableKey: key });
    values[key] = checkedValue(value, definition.type, definition.label || key);
    if (definition.type === 'choice' && values[key] != null && Array.isArray(definition.options) && !definition.options.includes(values[key])) throw new ExpressionError(`Choose one of the configured options for “${definition.label || key}”.`, 'type_mismatch');
    types[key] = definition.type;
    return values[key];
  };
  const evaluate = ast => {
    budget();
    if (ast.kind === 'literal') return ast.value;
    if (ast.kind === 'reference') {
      const info = referenceInfo(ast, map), value = resolve(info.key);
      return info.property ? value?.[info.property] ?? null : value;
    }
    if (ast.kind === 'comparison') {
      const left = evaluate(ast.left), right = evaluate(ast.right);
      if (ast.operator === '==') return equal(left, right);
      if (ast.operator === '!=') return !equal(left, right);
      if (left == null || right == null) throw new ExpressionError('A comparison is missing a value.', 'missing_input');
      if (ast.operator === '<') return left < right;
      if (ast.operator === '<=') return left <= right;
      if (ast.operator === '>') return left > right;
      return left >= right;
    }
    if (ast.name === 'if') {
      const condition = evaluate(ast.args[0]);
      if (typeof condition !== 'boolean') throw new ExpressionError('Choose Yes or No for the condition.', 'missing_input');
      return evaluate(ast.args[condition ? 1 : 2]);
    }
    if (ast.name === 'coalesce') {
      for (const argument of ast.args) { const value = evaluate(argument); if (!isBlank(value)) return value; }
      return null;
    }
    if (ast.name === 'switch') {
      const value = evaluate(ast.args[0]);
      for (let index = 1; index < ast.args.length - 1; index += 2) if (equal(value, evaluate(ast.args[index]))) return evaluate(ast.args[index + 1]);
      return evaluate(ast.args.at(-1));
    }
    const arguments_ = ast.args.map(evaluate);
    if (arguments_.some(value => typeof value !== 'string')) throw new ExpressionError(`${ast.name}() needs text. Supply a fallback with coalesce() if a name is blank.`, 'missing_input');
    let result;
    if (ast.name === 'concat') result = arguments_.join('');
    else if (ast.name === 'lower') result = arguments_[0].toLowerCase();
    else if (ast.name === 'upper') result = arguments_[0].toUpperCase();
    else result = arguments_[0].toLowerCase().replace(/\p{L}[\p{L}\p{M}]*(?:['’][\p{L}\p{M}]+)*/gu, word => word.replace(/^\p{L}/u, first => first.toUpperCase()));
    if (result.length > EXPRESSION_LIMITS.output) throw new ExpressionError('The calculated text is too long.');
    return result;
  };
  for (const key of keys ?? map.keys()) resolve(key);
  return { values, types };
}

/** Rename reference tokens, leaving quoted text and similarly named IDs alone. */
export function renameExpressionReference(expression, oldKey, newKey) {
  const document = normalizeExpression(expression);
  if (!document) return null;
  const ast = parseExpression(document), spans = [];
  const visit = node => {
    if (node.kind === 'reference' && (node.name === oldKey || node.name.startsWith(`${oldKey}.`))) spans.push({ start: node.start, end: node.segments[oldKey.split('.').length - 1].end });
    if (node.kind === 'comparison') { visit(node.left); visit(node.right); }
    if (node.kind === 'call') node.args.forEach(visit);
  };
  visit(ast);
  let source = document.source;
  for (const span of spans.sort((a, b) => b.start - a.start)) source = source.slice(0, span.start) + newKey + source.slice(span.end);
  return { version: 1, source };
}
