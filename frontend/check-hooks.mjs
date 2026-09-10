/**
 * Rules-of-Hooks guard.
 *
 * This project has no ESLint config, so nothing otherwise catches the failure
 * that took the whole app down once already: a hook called after an early
 * `return`. Because the component stays mounted and only a prop changes, the
 * hook count differs between renders and React throws during commit — with no
 * error boundary, the entire tree goes with it.
 *
 * It works on a real AST rather than on indentation and brace counting. The
 * previous line-oriented version was defeated by a braced `if (...) { return; }`,
 * by any indentation other than two spaces, and by a `{` inside a block comment
 * or a regex — all of which made it report success while catching nothing,
 * which is worse than having no guard at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';

const HOOK_NAME = /^use[A-Z]/;
const COMPONENT_OR_HOOK = /^(use[A-Z]|[A-Z])/;

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.jsx?$/.test(full)) files.push(full);
  }
})('src');

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod',
]);

function functionName(node, parent, grandparents) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  // `const X = memo(props => ...)` / `forwardRef(...)`: the arrow's parent is
  // the wrapping call, so walk up past any calls to the declarator.
  if (parent?.type === 'CallExpression') {
    for (let i = grandparents.length - 1; i >= 0; i--) {
      const ancestor = grandparents[i];
      if (ancestor.type === 'VariableDeclarator' && ancestor.id?.name) return ancestor.id.name;
      if (ancestor.type !== 'CallExpression') break;
    }
  }
  if (parent?.type === 'ObjectProperty' && parent.key?.name) return parent.key.name;
  if (node.type === 'ObjectMethod' && node.key?.name) return node.key.name;
  return null;
}

const problems = [];
let scanned = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  } catch (error) {
    problems.push(`${file}: parse error — ${error.message}`);
    continue;
  }

  // Collect candidate functions along with their parent, to recover the name
  // from `const Foo = () => {}`.
  const candidates = [];
  const stack = [];
  (function collect(node, parent) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const c of node) collect(c, parent); return; }
    if (!node.type) return;
    if (FUNCTION_TYPES.has(node.type)) {
      const name = functionName(node, parent, stack);
      if (name && COMPONENT_OR_HOOK.test(name)) candidates.push({ node, name });
    }
    stack.push(node);
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const child = node[key];
      if (child && typeof child === 'object') collect(child, node);
    }
    stack.pop();
  })(ast.program, null);

  for (const { node, name } of candidates) {
    const body = node.body;
    if (!body) continue;
    scanned++;

    // An expression-bodied arrow (`const Icon = (props) => (<svg .../>)`) has
    // no statement list and no early return, but it can still hold a hook
    // inside a conditional — so scan the expression as a single statement.
    const statements = body.type === 'BlockStatement' ? body.body : [body];

    let returnedAt = null;

    for (const statement of statements) {
      let hasReturn = null;
      const hooksHere = [];

      // Tracks conditional nesting too, so a hook inside an `if` or a loop is
      // flagged even when no early return precedes it.
      (function traverse(n, insideConditional) {
        if (n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const c of n) {
            // A function passed as an argument (a useEffect callback, say) has
            // its own hook scope — its `return` is not this component's early
            // return. Array children need this guard as much as named ones do;
            // omitting it here made every effect cleanup look like one.
            if (c && typeof c === 'object' && FUNCTION_TYPES.has(c.type)) continue;
            traverse(c, insideConditional);
          }
          return;
        }
        if (!n.type) return;

        if (n.type === 'ReturnStatement' && hasReturn === null) hasReturn = n.loc.start.line;

        if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
          const callee = n.callee;
          // Both `useX()` and `React.useX()`; optional calls parse as a
          // separate node type and would otherwise be invisible.
          const hookName =
            callee.type === 'Identifier' && HOOK_NAME.test(callee.name)
              ? callee.name
              : (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') &&
                !callee.computed && callee.property?.name && HOOK_NAME.test(callee.property.name)
                ? callee.property.name
                : null;
          if (hookName) hooksHere.push({ name: hookName, line: n.loc.start.line, insideConditional });
        }

        const branching =
          n.type === 'IfStatement' || n.type === 'ConditionalExpression' ||
          n.type === 'SwitchStatement' || n.type === 'LogicalExpression' ||
          n.type.endsWith('Loop') || n.type === 'ForStatement' ||
          n.type === 'WhileStatement' || n.type === 'DoWhileStatement' ||
          n.type === 'ForOfStatement' || n.type === 'ForInStatement' ||
          n.type === 'TryStatement';

        for (const key of Object.keys(n)) {
          if (key === 'loc') continue;
          const child = n[key];
          if (!child || typeof child !== 'object') continue;
          if (!Array.isArray(child) && FUNCTION_TYPES.has(child.type)) continue;

          // The test of an `if` is not itself conditional; its branches are.
          const childConditional =
            insideConditional ||
            (branching && !(n.type === 'IfStatement' && key === 'test') &&
                          !(n.type === 'ConditionalExpression' && key === 'test') &&
                          !(n.type === 'LogicalExpression' && key === 'left'));
          traverse(child, childConditional);
        }
      })(statement, false);

      for (const hook of hooksHere) {
        // A hook on the return line itself is the returned value
        // (`return useCallback(...)`), not a conditionally-executed call.
        if (returnedAt !== null && hook.line > returnedAt) {
          problems.push(
            `${file}:${hook.line}  ${hook.name}() in ${name}() runs after the early return on line ${returnedAt}`
          );
        } else if (hook.insideConditional) {
          problems.push(
            `${file}:${hook.line}  ${hook.name}() in ${name}() is inside a conditional or loop`
          );
        }
      }

      if (hasReturn !== null && returnedAt === null) returnedAt = hasReturn;
    }
  }
}

if (problems.length === 0) {
  console.log(`  ${files.length} files, ${scanned} components/hooks scanned — no conditional hook calls`);
  process.exit(0);
}
for (const problem of problems) console.log(`  ${problem}`);
console.log(`  ${problems.length} Rules-of-Hooks violation(s)`);
process.exit(1);
