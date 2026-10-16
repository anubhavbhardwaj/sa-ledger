// Reads firestore.rules: which fields each collection allows (its validX() hasOnly list). The browser tests' fake
// Firestore enforces exactly these, so a field the app writes but the rules don't allow fails the tests, not prod.
import { readFileSync } from 'node:fs';
const RULES = new URL('../../firestore.rules', import.meta.url);

export function allowedFields(src = readFileSync(RULES, 'utf8')){
  const fn = {};
  for (const m of src.matchAll(/function\s+(\w+)\(\)\s*\{([\s\S]*?)\n\s*\}/g)){
    const only = m[2].match(/hasOnly\(\[([^\]]*)\]\)/);
    if (only) fn[m[1]] = [...only[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  }
  const out = {};
  for (const m of src.matchAll(/match\s+\/(\w+)\/\{\w+\}\s*\{([\s\S]*?)\n\s*\}/g)){
    const used = [...m[2].matchAll(/(valid\w+)\(\)/g)].map(x => x[1]).filter(f => fn[f]);
    if (used.length) out[m[1]] = [...new Set(used.flatMap(f => fn[f]))];
  }
  return out;
}
