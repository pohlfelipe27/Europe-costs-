// Camada de dados: usa Supabase quando configurado, senão localStorage.
// No modo nuvem, toda gravação passa por uma fila guardada no aparelho:
// sem internet o gasto fica na fila e é enviado sozinho quando a conexão volta.
(function () {
  const cfg = window.APP_CONFIG || {};
  const cloud = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);

  const uid = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
          (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
        );

  const read = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v == null ? d : v;
    } catch {
      return d;
    }
  };
  const write = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  };
  // Campos que só existem na tela (pendente, autor, data de criação) não vão para o banco.
  const clean = (obj) =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith("_") && k !== "created_by" && k !== "created_at"));

  // ---------- Modo local (só neste navegador) ----------
  const LS_KEY = "europe-costs:v1";

  const local = {
    mode: "local",
    async getUser() { return { email: "eu" }; },
    async signIn() {},
    async signOut() {},
    onAuthChange() {},
    async listTrips() {
      return read(LS_KEY, { trips: [] }).trips.sort((a, b) => a.start_date.localeCompare(b.start_date));
    },
    async saveTrip(t) {
      const db = read(LS_KEY, { trips: [], expenses: [] });
      if (t.id) db.trips = db.trips.map((x) => (x.id === t.id ? { ...x, ...t } : x));
      else db.trips.push((t = { ...t, id: uid(), created_at: new Date().toISOString() }));
      write(LS_KEY, db);
      return t;
    },
    async deleteTrip(id) {
      const db = read(LS_KEY, { trips: [], expenses: [] });
      db.trips = db.trips.filter((t) => t.id !== id);
      db.expenses = db.expenses.filter((e) => e.trip_id !== id);
      write(LS_KEY, db);
    },
    async listExpenses(tripId) {
      return read(LS_KEY, { expenses: [] }).expenses.filter((e) => e.trip_id === tripId);
    },
    async saveExpense(e) {
      const db = read(LS_KEY, { trips: [], expenses: [] });
      if (e.id) db.expenses = db.expenses.map((x) => (x.id === e.id ? { ...x, ...e } : x));
      else db.expenses.push((e = { ...e, id: uid(), created_by: "eu", created_at: new Date().toISOString() }));
      write(LS_KEY, db);
      return e;
    },
    async deleteExpense(id) {
      const db = read(LS_KEY, { trips: [], expenses: [] });
      db.expenses = db.expenses.filter((e) => e.id !== id);
      write(LS_KEY, db);
    },
    subscribe() {},
    pendingCount: () => 0,
    onQueueChange() {},
    async flush() {},
  };

  // ---------- Modo nuvem (Supabase + fila offline) ----------
  function makeCloud() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const Q_KEY = "europe-costs:queue";
    const C_KEY = "europe-costs:cache";
    const U_KEY = "europe-costs:user";

    // Erros que valem nova tentativa depois (sem internet, token vencido).
    // Qualquer outro erro é definitivo e é mostrado para quem lançou.
    const retryable = (e) => {
      const msg = String((e && (e.message || e.details)) || e || "");
      return !navigator.onLine || /fetch|network|load failed|timeout|jwt|token/i.test(msg) || (e && e.code === "PGRST301");
    };
    const run = async (q) => {
      const { data, error } = await q;
      if (error) throw error;
      return data;
    };

    // Cópia local da última leitura, usada quando não há internet.
    const cacheGet = (k) => read(C_KEY, {})[k];
    const cacheSet = (k, v) => {
      const c = read(C_KEY, {});
      c[k] = v;
      write(C_KEY, c);
    };
    function cacheApply(op) {
      if (op.table === "trips") {
        const list = (cacheGet("trips") || []).filter((t) => t.id !== (op.id || op.data.id));
        if (op.type === "save") list.push(op.data);
        cacheSet("trips", list);
      } else {
        const tripId = op.type === "save" ? op.data.trip_id : op.trip_id;
        const key = "exp:" + tripId;
        const list = (cacheGet(key) || []).filter((e) => e.id !== (op.id || op.data.id));
        if (op.type === "save") list.push({ ...op.data, created_by: op.data.created_by || op.author });
        cacheSet(key, list);
      }
    }

    const queue = () => read(Q_KEY, []);
    const listeners = new Set();
    const notify = (info = {}) => listeners.forEach((cb) => cb({ pending: queue().length, ...info }));
    const opErrors = {};

    function enqueue(op) {
      op.opId = uid();
      const q = queue();
      q.push(op);
      write(Q_KEY, q);
      notify();
      return op.opId;
    }

    async function exec(op) {
      const t = sb.from(op.table);
      if (op.type === "save") await run(t.upsert(clean(op.data)));
      else await run(t.delete().eq("id", op.id));
    }

    let flushing = null;
    function flush() {
      if (!flushing) flushing = doFlush().finally(() => (flushing = null));
      return flushing;
    }
    async function doFlush() {
      if (!navigator.onLine || !queue().length) return;
      await sb.auth.getSession(); // renova o login se o token venceu enquanto estava offline
      let sent = 0;
      while (queue().length) {
        const [op] = queue();
        try {
          await exec(op);
          cacheApply(op);
          sent++;
        } catch (e) {
          if (retryable(e)) break;
          opErrors[op.opId] = e;
        }
        write(Q_KEY, queue().slice(1));
      }
      notify({ sent });
    }

    // Aplica sobre a lista o que ainda está na fila (aparece marcado como pendente).
    function overlay(list, table, keep) {
      list = list.slice();
      for (const op of queue()) {
        if (op.table !== table) continue;
        if (op.type === "delete") {
          list = list.filter((x) => x.id !== op.id);
        } else if (keep(op.data)) {
          const i = list.findIndex((x) => x.id === op.data.id);
          const item = { ...(i >= 0 ? list[i] : { created_by: op.author }), ...op.data, _pending: true };
          if (i >= 0) list[i] = item;
          else list.push(item);
        }
      }
      return list;
    }

    async function readList(key, query) {
      try {
        const data = await run(query());
        cacheSet(key, data);
        return data;
      } catch (e) {
        if (!retryable(e)) throw e;
        return cacheGet(key) || [];
      }
    }

    // Grava via fila e diz se já chegou ao banco ou ficou pendente.
    async function write_(op, result) {
      const opId = enqueue(op);
      await flush();
      if (opErrors[opId]) {
        const e = opErrors[opId];
        delete opErrors[opId];
        throw e;
      }
      const pending = queue().some((o) => o.opId === opId);
      return result && { ...result, _pending: pending };
    }

    let currentEmail = read(U_KEY, null);

    window.addEventListener("online", () => flush());
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && flush());
    setInterval(() => queue().length && flush(), 20000);

    return {
      mode: "cloud",
      async getUser() {
        const { data } = await sb.auth.getSession();
        if (data.session) {
          currentEmail = data.session.user.email;
          write(U_KEY, currentEmail);
          return data.session.user;
        }
        // Sem internet o login não pode ser renovado: usa o último usuário deste aparelho.
        return !navigator.onLine && currentEmail ? { email: currentEmail } : null;
      },
      async signIn(email, password) {
        await run(sb.auth.signInWithPassword({ email, password }));
      },
      async signOut() {
        await sb.auth.signOut();
        [Q_KEY, C_KEY, U_KEY].forEach((k) => {
          try { localStorage.removeItem(k); } catch {}
        });
      },
      onAuthChange(cb) {
        sb.auth.onAuthStateChange((_evt, session) => {
          if (session) {
            currentEmail = session.user.email;
            write(U_KEY, currentEmail);
            cb(session.user);
          } else if (navigator.onLine || !currentEmail) cb(null);
        });
      },
      async listTrips() {
        const list = await readList("trips", () => sb.from("trips").select("*"));
        return overlay(list, "trips", () => true).sort((a, b) => a.start_date.localeCompare(b.start_date));
      },
      saveTrip(t) {
        const data = { ...clean(t), id: t.id || uid() };
        return write_({ table: "trips", type: "save", data }, data);
      },
      deleteTrip(id) {
        return write_({ table: "trips", type: "delete", id });
      },
      async listExpenses(tripId) {
        const list = await readList("exp:" + tripId, () => sb.from("expenses").select("*").eq("trip_id", tripId));
        return overlay(list, "expenses", (e) => e.trip_id === tripId);
      },
      saveExpense(e) {
        const data = { ...clean(e), id: e.id || uid() };
        return write_(
          { table: "expenses", type: "save", data, author: currentEmail },
          { ...data, created_by: e.created_by || currentEmail, created_at: e.created_at || new Date().toISOString() }
        );
      },
      deleteExpense(id, tripId) {
        return write_({ table: "expenses", type: "delete", id, trip_id: tripId });
      },
      subscribe(onChange) {
        sb.channel("changes")
          .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, onChange)
          .on("postgres_changes", { event: "*", schema: "public", table: "trips" }, onChange)
          .subscribe();
      },
      pendingCount: () => queue().length,
      onQueueChange(cb) { listeners.add(cb); },
      flush,
    };
  }

  window.Store = cloud ? makeCloud() : local;
})();
