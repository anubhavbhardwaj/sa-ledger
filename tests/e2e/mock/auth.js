let cb; export const browserLocalPersistence = {};
export function getAuth(){ return {}; }
export async function setPersistence(){}
export function onAuthStateChanged(a,f){ cb=f; setTimeout(()=>f(null),10); }
export async function signInWithEmailAndPassword(a,e,p){ if(p!=='pw') throw {code:'auth/invalid-credential'}; window.__email=e; setTimeout(()=>cb({email:e, getIdToken: async()=>'tok'}),10); }
export async function signOut(){ cb(null); }
