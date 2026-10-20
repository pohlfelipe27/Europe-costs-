// Camada de dados: usa Supabase quando configurado, senão localStorage.
(function () {
  const cfg = window.APP_CONFIG || {};
  const cloud = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);

  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // ---------- Modo local (só neste navegador) ----------
  const LS_KEY = "europe-costs:v1";
  function lsRead() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY)) || { trips: [], expenses: [] };
    } catch {
      return { trips: [], expenses: [] };
    }
  }
  function lsWrite(db) {
    localStorage.setItem(LS_KEY, JSON.stringify(db));
  }

  const local = {
    mode: "local",
    async getUser() { return { email: "modo local" }; },
    async signIn() {},
    async signOut() {},
    onAuthChange() {},
    async listTrips() {
      return lsRead().trips.sort((a, b) => a.start_date.localeCompare(b.start_date));
    },
    async saveTrip(t) {
      const db = lsRead();
      if (t.id) db.trips = db.trips.map((x) => (x.id === t.id ? { ...x, ...t } : x));
      else db.trips.push((t = { ...t, id: uid(), created_at: new Date().toISOString() }));
      lsWrite(db);
      return t;
    },
    async deleteTrip(id) {
      const db = lsRead();
      db.trips = db.trips.filter((t) => t.id !== id);
      db.expenses = db.expenses.filter((e) => e.trip_id !== id);
      lsWrite(db);
    },
    async listExpenses(tripId) {
      return lsRead().expenses.filter((e) => e.trip_id === tripId);
    },
    async saveExpense(e) {
      const db = lsRead();
      if (e.id) db.expenses = db.expenses.map((x) => (x.id === e.id ? { ...x, ...e } : x));
      else db.expenses.push((e = { ...e, id: uid(), created_by: "eu", created_at: new Date().toISOString() }));
      lsWrite(db);
      return e;
    },
    async deleteExpense(id) {
      const db = lsRead();
      db.expenses = db.expenses.filter((e) => e.id !== id);
      lsWrite(db);
    },
    subscribe() {},
  };

  // ---------- Modo nuvem (Supabase) ----------
  function makeCloud() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const check = ({ data, error }) => {
      if (error) throw error;
      return data;
    };
    return {
      mode: "cloud",
      async getUser() {
        const { data } = await sb.auth.getSession();
        return data.session ? data.session.user : null;
      },
      async signIn(email, password) {
        check(await sb.auth.signInWithPassword({ email, password }));
      },
      async signOut() { await sb.auth.signOut(); },
      onAuthChange(cb) { sb.auth.onAuthStateChange((_evt, session) => cb(session ? session.user : null)); },
      async listTrips() {
        return check(await sb.from("trips").select("*").order("start_date"));
      },
      async saveTrip(t) {
        const { id, ...fields } = t;
        const q = id ? sb.from("trips").update(fields).eq("id", id) : sb.from("trips").insert(fields);
        return check(await q.select().single());
      },
      async deleteTrip(id) {
        check(await sb.from("trips").delete().eq("id", id));
      },
      async listExpenses(tripId) {
        return check(await sb.from("expenses").select("*").eq("trip_id", tripId));
      },
      async saveExpense(e) {
        const { id, created_by, created_at, ...fields } = e;
        const q = id ? sb.from("expenses").update(fields).eq("id", id) : sb.from("expenses").insert(fields);
        return check(await q.select().single());
      },
      async deleteExpense(id) {
        check(await sb.from("expenses").delete().eq("id", id));
      },
      subscribe(onChange) {
        sb.channel("changes")
          .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, onChange)
          .on("postgres_changes", { event: "*", schema: "public", table: "trips" }, onChange)
          .subscribe();
      },
    };
  }

  window.Store = cloud ? makeCloud() : local;
})();
