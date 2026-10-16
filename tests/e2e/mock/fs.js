// Fake Firestore for the browser tests. In memory; writes are checked against the fields firestore.rules allows
// (filled in by the test runner from the real rules file), and refused ones are recorded in window.__ruleErrors.
const stores = {}; const subs = {}; let n=0;
const ALLOWED = /*ALLOWED*/{};
function check(c, d){ const bad = Object.keys(d).filter(k => !(ALLOWED[c] || []).includes(k)); if (bad.length){ window.__ruleErrors = (window.__ruleErrors||[]).concat(c+':'+bad.join(',')); throw {code:'permission-denied'}; } }
const st = c => (stores[c] ||= new Map());
const emit = c => { const docs=[...st(c)].map(([id,d])=>({id,data:()=>d})); (subs[c]||[]).forEach(f=>f({docs})); };
export function initializeFirestore(){ return {}; }
export function persistentLocalCache(){ return {}; } export function persistentMultipleTabManager(){ return {}; }
export function collection(fs, p){ return {col:p}; }
export function doc(a, p, id){ if (a.col) return {col:a.col, id:'a'+(n++)}; return {col:p, id}; }
export function __seed(c, id, d){ st(c).set(id, d); emit(c); }
export function onSnapshot(c, f){ (subs[c.col] ||= []).push(f); setTimeout(()=>emit(c.col),5); return ()=>{}; }
export async function addDoc(c, d){ check(c.col,d); const id='a'+(n++); st(c.col).set(id, d); emit(c.col); return {id}; }
export async function setDoc(r, d){ check(r.col,d); st(r.col).set(r.id, d); emit(r.col); }
export async function deleteDoc(r){ st(r.col).delete(r.id); emit(r.col); }
export function writeBatch(){ const ops=[]; return { set(r,d){check(r.col,d); ops.push(r,d)}, delete(r){ops.push(r,null)}, async commit(){ for(let i=0;i<ops.length;i+=2){ if(ops[i+1]===null) st(ops[i].col).delete(ops[i].id); else st(ops[i].col).set(ops[i].id, ops[i+1]); } Object.keys(stores).forEach(emit); } }; }
