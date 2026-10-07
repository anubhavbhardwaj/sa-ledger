// Heartbeats for the app's "System health" view: each background job or server feature records when it last ran,
// last worked and last failed in health/<job>. Never throws: a failed heartbeat must not break the job itself.
export async function beat(db, job, { ok = true, error, info } = {}) {
  try {
    const at = new Date().toISOString();
    const d = { lastRun: at };
    if (ok) d.lastOk = at; else { d.lastError = String(error || 'failed').slice(0, 300); d.errorAt = at; }
    if (info) d.info = info;
    await db.collection('health').doc(job).set(d, { merge: true });
  } catch (e) { console.error('health beat failed', job, e?.message); }
}
