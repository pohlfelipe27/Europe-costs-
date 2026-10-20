(function () {
  // Cores das categorias: ordem fixa, validada para daltonismo sobre o fundo escuro.
  const CATEGORIES = [
    { id: "hospedagem", label: "Hospedagem", color: "#3987e5" },
    { id: "transporte", label: "Transporte", color: "#d95926" },
    { id: "alimentacao", label: "Alimentação", color: "#199e70" },
    { id: "passeios", label: "Passeios e atrações", color: "#c98500" },
    { id: "compras", label: "Compras", color: "#d55181" },
    { id: "outros", label: "Outros", color: "#008300" },
  ];
  const PAYMENTS = ["Cartão de crédito", "Cartão de débito", "Dinheiro", "Cartão pré-pago / Wise", "Pix", "Outro"];
  const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  const PEOPLE = Object.fromEntries(
    Object.entries((window.APP_CONFIG || {}).PEOPLE || {}).map(([email, name]) => [email.toLowerCase(), name])
  );
  const FX_KEY = "europe-costs:last-gbp-rate";

  const $ = (sel) => document.querySelector(sel);
  const state = { trips: [], trip: null, expenses: [], charts: {} };

  // ---------- Utilidades ----------
  const fmtMoney = (v, cur) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: cur || "EUR" }).format(v || 0);
  const money = (v) => fmtMoney(v, state.trip && state.trip.currency);
  const brl = (v) => fmtMoney(v, "BRL");
  const curSymbol = (cur) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: cur }).formatToParts(0).find((p) => p.type === "currency").value;
  const personName = (email) => {
    if (!email) return "—";
    return PEOPLE[email.toLowerCase()] || email.split("@")[0];
  };
  const parseISO = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };
  const toISO = (d) => d.toISOString().slice(0, 10);
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const fmtDay = (s, opts = { day: "2-digit", month: "2-digit" }) =>
    parseISO(s).toLocaleDateString("pt-BR", { ...opts, timeZone: "UTC" });
  function tripDays(trip) {
    const days = [];
    for (let d = parseISO(trip.start_date); d <= parseISO(trip.end_date); d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(toISO(d));
    }
    return days;
  }
  const sum = (arr) => arr.reduce((a, e) => a + Number(e.amount || 0), 0);
  const round2 = (v) => Math.round(v * 100) / 100;
  const num = (v) => Number(String(v).replace(",", "."));
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children) n.append(c instanceof Node ? c : document.createTextNode(c ?? ""));
    return n;
  }
  function toast(msg, ms = 2600) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), ms);
  }
  const errMsg = (e) => (e && e.message) || String(e);
  function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

  // ---------- Autenticação ----------
  async function boot() {
    fillStaticSelects();
    bindEvents();
    if (Store.mode === "local") $("#local-banner").classList.remove("hidden");
    Store.onAuthChange((user) => (user ? showApp(user) : showLogin()));
    Store.onQueueChange(onQueueChange);
    updateConnectivity();
    const user = await Store.getUser();
    user ? showApp(user) : showLogin();
  }

  function showLogin() {
    $("#app-view").classList.add("hidden");
    $("#login-view").classList.remove("hidden");
  }

  let appStarted = false;
  async function showApp(user) {
    $("#login-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
    $("#user-email").textContent = Store.mode === "cloud" ? personName(user.email) : "modo local";
    $("#logout-btn").classList.toggle("hidden", Store.mode === "local");
    if (appStarted) return;
    appStarted = true;
    Store.subscribe(debounce(() => loadTrips(state.trip && state.trip.id), 400));
    await loadTrips();
    Store.flush();
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ---------- Offline / sincronização ----------
  function updateConnectivity() {
    $("#offline-banner").classList.toggle("hidden", Store.mode === "local" || navigator.onLine);
    updateSyncBadge(Store.pendingCount());
  }

  function updateSyncBadge(pending) {
    const b = $("#sync-badge");
    b.classList.toggle("hidden", !pending);
    b.textContent = `⏳ ${pending} não enviado${pending > 1 ? "s" : ""}`;
  }

  function onQueueChange({ pending, sent }) {
    updateSyncBadge(pending);
    if (sent && state.trip) {
      toast(`${sent} lançamento${sent > 1 ? "s" : ""} pendente${sent > 1 ? "s" : ""} enviado${sent > 1 ? "s" : ""} ✓`);
      reloadExpenses();
    }
  }

  async function reloadExpenses() {
    try {
      state.expenses = await Store.listExpenses(state.trip.id);
      render();
    } catch {}
  }

  // ---------- Carregamento ----------
  async function loadTrips(selectId) {
    try {
      state.trips = await Store.listTrips();
    } catch (e) {
      toast("Erro ao carregar viagens: " + errMsg(e));
      return;
    }
    const sel = $("#trip-select");
    sel.replaceChildren(...state.trips.map((t) => el("option", { value: t.id }, t.name)));
    const saved = selectId || safeGet("europe-costs:trip");
    const trip = state.trips.find((t) => t.id === saved) || state.trips[state.trips.length - 1];
    const hasTrips = Boolean(trip);
    $("#empty-state").classList.toggle("hidden", hasTrips);
    $("#dashboard").classList.toggle("hidden", !hasTrips);
    sel.classList.toggle("hidden", !hasTrips);
    $("#edit-trip-btn").classList.toggle("hidden", !hasTrips);
    if (hasTrips) {
      sel.value = trip.id;
      await selectTrip(trip.id);
    }
  }

  async function selectTrip(id) {
    const changed = !state.trip || state.trip.id !== id;
    state.trip = state.trips.find((t) => t.id === id);
    safeSet("europe-costs:trip", id);
    try {
      state.expenses = await Store.listExpenses(id);
    } catch (e) {
      toast("Erro ao carregar gastos: " + errMsg(e));
      state.expenses = [];
    }
    // Não apaga o formulário se alguém estava no meio de um lançamento.
    if (changed || !$("#expense-form").amount.value) resetExpenseForm();
    render();
  }

  // ---------- Renderização ----------
  function render() {
    const trip = state.trip;
    const days = tripDays(trip);
    const total = sum(state.expenses);
    const budget = Number(trip.budget) || 0;

    $("#trip-name").textContent = trip.name;
    $("#trip-dates").textContent =
      `${fmtDay(trip.start_date, { day: "2-digit", month: "long", year: "numeric" })} → ` +
      `${fmtDay(trip.end_date, { day: "2-digit", month: "long", year: "numeric" })} · ${days.length} dias`;
    document.querySelectorAll(".cur-label").forEach((n) => (n.textContent = curSymbol(trip.currency)));

    // Barra de orçamento
    $("#budget-progress-wrap").classList.toggle("hidden", !budget);
    if (budget) {
      const pct = (total / budget) * 100;
      $("#budget-pct").textContent = `${pct.toFixed(0)}% do orçamento usado`;
      $("#budget-of").textContent = `${money(total)} de ${money(budget)}`;
      $("#budget-bar").style.width = Math.min(pct, 100) + "%";
      $("#budget-bar").classList.toggle("over", pct > 100);
    }

    renderKpis(days, total, budget);
    renderCharts(days, budget);
    renderCategoryTable(total);
    renderPeople(total);
    renderFilters(days);
    renderExpenseTable();
  }

  function renderKpis(days, total, budget) {
    const trip = state.trip;
    const today = todayISO();
    // O primeiro e o último dia (dias de voo) ficam fora da média por dia;
    // na projeção entram pelo valor real lançado neles.
    const avgDays = days.length >= 3 ? days.slice(1, -1) : days;
    const edgeTotal = sum(state.expenses.filter((e) => !avgDays.includes(e.date)));
    const avgTotal = total - edgeTotal;
    // Dias decorridos: até hoje (se a viagem está em andamento) ou os dias que já têm gasto.
    let elapsed = avgDays.filter((d) => d <= today).length;
    if (elapsed === 0) elapsed = new Set(state.expenses.filter((e) => avgDays.includes(e.date)).map((e) => e.date)).size;
    const avg = elapsed ? avgTotal / elapsed : null;
    const projection = avg == null ? null : edgeTotal + avg * avgDays.length;
    const remainingDays = days.filter((d) => d > today).length;
    const dailyGoal = budget ? (budget - edgeTotal) / avgDays.length : 0;
    const excludedNote = avgDays.length < days.length ? `sem ${fmtDay(days[0])} e ${fmtDay(days[days.length - 1])}` : "";
    const biggest = state.expenses.reduce((m, e) => (Number(e.amount) > Number(m?.amount || -1) ? e : m), null);
    const rate = Number(trip.brl_rate) || 0;
    const gbp = state.expenses.filter((e) => e.original_currency === "GBP");

    const tiles = [
      { label: "Total gasto", value: money(total), sub: rate ? `≈ ${brl(total * rate)}` : `${state.expenses.length} lançamentos` },
      budget
        ? {
            label: "Orçamento restante",
            value: money(budget - total),
            sub: budget - total < 0 ? "Acima do orçamento" : `${money((budget - total) / Math.max(remainingDays, 1))} por dia restante`,
            cls: budget - total < 0 ? "bad" : "ok",
          }
        : { label: "Orçamento", value: "—", sub: "Defina em Editar viagem" },
      {
        label: "Média por dia",
        value: avg == null ? "—" : money(avg),
        sub: [budget ? `Meta: ${money(dailyGoal)}/dia` : `${elapsed} dia(s) considerados`, excludedNote].filter(Boolean).join(" · "),
      },
      projection == null
        ? { label: "Projeção da viagem", value: "—", sub: `Aparece quando houver gastos de ${fmtDay(avgDays[0])} a ${fmtDay(avgDays[avgDays.length - 1])}` }
        : {
            label: "Projeção da viagem",
            value: money(projection),
            sub: budget ? (projection > budget ? `${money(projection - budget)} acima` : `${money(budget - projection)} abaixo`) : "Mantendo a média atual",
            cls: budget ? (projection > budget ? "bad" : "ok") : "",
          },
      { label: "Maior gasto", value: biggest ? money(biggest.amount) : "—", sub: biggest ? biggest.description : "" },
      { label: "Lançamentos", value: String(state.expenses.length), sub: total ? `Ticket médio ${money(total / state.expenses.length)}` : "" },
    ];
    if (gbp.length && trip.currency !== "GBP") {
      tiles.push({
        label: "Gasto em libras",
        value: fmtMoney(gbp.reduce((a, e) => a + Number(e.original_amount || 0), 0), "GBP"),
        sub: `≈ ${money(sum(gbp))} · ${gbp.length} lançamento(s)`,
      });
    }
    $("#kpis").replaceChildren(
      ...tiles.map((t) =>
        el("div", { class: "card kpi" },
          el("div", { class: "label" }, t.label),
          el("div", { class: "value" }, t.value),
          el("div", { class: "sub " + (t.cls || "") }, t.sub || "")
        )
      )
    );
  }

  // ---------- Gráficos ----------
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function chartDefaults() {
    Chart.defaults.color = css("--muted");
    Chart.defaults.font.family = css("--font");
    Chart.defaults.borderColor = css("--grid");
    Chart.defaults.plugins.tooltip.backgroundColor = "#0a0f17";
    Chart.defaults.plugins.tooltip.borderColor = css("--border");
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.titleColor = css("--text");
    Chart.defaults.plugins.tooltip.bodyColor = css("--text-2");
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.legend.labels.color = css("--text-2");
    Chart.defaults.maintainAspectRatio = false;
  }
  const moneyTick = (v) => money(v).replace(/,00$/, "");
  const tooltipMoney = (ctx) => ` ${ctx.dataset.label || ctx.label}: ${money(ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed)}`;

  function upsertChart(key, canvasId, config) {
    if (state.charts[key]) state.charts[key].destroy();
    state.charts[key] = new Chart(document.getElementById(canvasId), config);
  }

  function renderCharts(days, budget) {
    if (!window.Chart) return;
    const ex = state.expenses;
    const labels = days.map((d) => fmtDay(d));
    const used = CATEGORIES.filter((c) => ex.some((e) => e.category === c.id));

    // 1) Por dia, empilhado por categoria
    const dailyDatasets = used.map((c) => ({
      type: "bar",
      label: c.label,
      data: days.map((d) => sum(ex.filter((e) => e.date === d && e.category === c.id))),
      backgroundColor: c.color,
      borderColor: css("--surface"),
      borderWidth: { top: 2 },
      borderRadius: 4,
      borderSkipped: "bottom",
      stack: "s",
      maxBarThickness: 40,
    }));
    if (budget) {
      dailyDatasets.push({
        type: "line",
        label: "Orçamento diário",
        data: days.map(() => budget / days.length),
        borderColor: css("--text-2"),
        borderDash: [6, 4],
        borderWidth: 2,
        pointRadius: 0,
        pointHitRadius: 0,
      });
    }
    upsertChart("daily", "chart-daily", {
      data: { labels, datasets: dailyDatasets },
      options: {
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              label: (c) => (c.parsed.y ? tooltipMoney(c) : null),
              footer: (items) => "Total: " + money(items.filter((i) => i.dataset.type === "bar").reduce((a, i) => a + i.parsed.y, 0)),
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, ticks: { callback: moneyTick } },
        },
      },
    });

    // 2) Acumulado vs orçamento
    let acc = 0;
    const today = todayISO();
    const cumulative = days.map((d) => {
      acc += sum(ex.filter((e) => e.date === d));
      return d <= today || ex.some((e) => e.date >= d) ? acc : null;
    });
    const cumDatasets = [
      {
        label: "Gasto acumulado",
        data: cumulative,
        borderColor: css("--blue"),
        backgroundColor: "rgba(57,135,229,0.12)",
        fill: true,
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 4,
        pointBackgroundColor: css("--blue"),
        pointBorderColor: css("--surface"),
        pointBorderWidth: 2,
      },
    ];
    if (budget) {
      cumDatasets.push({
        label: "Orçamento ideal",
        data: days.map((_, i) => (budget / days.length) * (i + 1)),
        borderColor: css("--text-2"),
        borderDash: [6, 4],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
      });
    }
    upsertChart("cumulative", "chart-cumulative", {
      type: "line",
      data: { labels, datasets: cumDatasets },
      options: {
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: cumDatasets.length > 1, position: "bottom" },
          tooltip: { callbacks: { label: tooltipMoney } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { callback: moneyTick } },
        },
      },
    });

    // 3) Por categoria (barras horizontais, ordenadas)
    const catRows = used
      .map((c) => ({ c, v: sum(ex.filter((e) => e.category === c.id)) }))
      .sort((a, b) => b.v - a.v);
    horizontalBar("category", "chart-category", catRows.map((r) => r.c.label), catRows.map((r) => r.v), catRows.map((r) => r.c.color));

    // 4) Por forma de pagamento
    const payRows = PAYMENTS.map((p) => ({ p, v: sum(ex.filter((e) => (e.payment_method || "Outro") === p)) }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v);
    horizontalBar("payment", "chart-payment", payRows.map((r) => r.p), payRows.map((r) => r.v), css("--blue"));
  }

  function horizontalBar(key, canvasId, labels, data, colors) {
    const total = data.reduce((a, b) => a + b, 0);
    upsertChart(key, canvasId, {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Total", data, backgroundColor: colors, borderRadius: 4, borderSkipped: "start", maxBarThickness: 28 }],
      },
      options: {
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: (c) => ` ${money(c.parsed.x)} · ${total ? ((c.parsed.x / total) * 100).toFixed(1) : 0}%` },
          },
        },
        scales: {
          x: { beginAtZero: true, ticks: { callback: moneyTick } },
          y: { grid: { display: false }, ticks: { color: css("--text-2") } },
        },
      },
    });
  }

  // ---------- Tabelas ----------
  function renderCategoryTable(total) {
    const rows = CATEGORIES.map((c) => {
      const items = state.expenses.filter((e) => e.category === c.id);
      return { c, v: sum(items), n: items.length };
    })
      .filter((r) => r.n)
      .sort((a, b) => b.v - a.v);
    const tbody = rows.length
      ? rows.map((r) =>
          el("tr", {},
            el("td", {}, el("span", { class: "dot", style: `background:${r.c.color}` }), r.c.label),
            el("td", { class: "num" }, String(r.n)),
            el("td", { class: "num" }, money(r.v)),
            el("td", { class: "num" }, total ? ((r.v / total) * 100).toFixed(1) + "%" : "—")
          )
        )
      : [el("tr", {}, el("td", { colspan: "4", class: "empty-row" }, "Sem gastos ainda"))];
    $("#category-table").replaceChildren(
      el("thead", {}, el("tr", {}, el("th", {}, "Categoria"), el("th", { class: "num" }, "Qtd."), el("th", { class: "num" }, "Total"), el("th", { class: "num" }, "%"))),
      el("tbody", {}, ...tbody),
      el("tfoot", {}, el("tr", {}, el("td", {}, "Total"), el("td", { class: "num" }, String(state.expenses.length)), el("td", { class: "num" }, money(total)), el("td", { class: "num" }, total ? "100%" : "")))
    );
  }

  // Quem lançou o quê, e o saldo se a conta for dividida igualmente.
  function renderPeople(total) {
    const section = $("#people-section");
    section.classList.toggle("hidden", Store.mode === "local");
    if (Store.mode === "local") return;

    const emails = new Set(Object.keys(PEOPLE));
    state.expenses.forEach((e) => e.created_by && emails.add(e.created_by.toLowerCase()));
    const participants = Object.keys(PEOPLE).length || emails.size || 1;
    const share = total / participants;
    const rows = [...emails]
      .map((email) => {
        const items = state.expenses.filter((e) => (e.created_by || "").toLowerCase() === email);
        return { email, name: personName(email), n: items.length, v: sum(items) };
      })
      .sort((a, b) => b.v - a.v);

    const balanceCell = (b) => {
      if (Math.abs(b) < 0.005) return el("td", { class: "num" }, "quite");
      return el("td", { class: "num " + (b > 0 ? "pos" : "neg") }, (b > 0 ? "recebe " : "deve ") + money(Math.abs(b)));
    };
    $("#people-table").replaceChildren(
      el("thead", {}, el("tr", {},
        el("th", {}, "Pessoa"), el("th", { class: "num" }, "Qtd."), el("th", { class: "num" }, "Total"),
        el("th", { class: "num" }, "%"), el("th", { class: "num" }, "Divisão igual")
      )),
      el("tbody", {}, ...rows.map((r) =>
        el("tr", {},
          el("td", {}, r.name),
          el("td", { class: "num" }, String(r.n)),
          el("td", { class: "num" }, money(r.v)),
          el("td", { class: "num" }, total ? ((r.v / total) * 100).toFixed(1) + "%" : "—"),
          balanceCell(r.v - share)
        )
      ))
    );
    $("#people-note").textContent = total
      ? `Dividindo ${money(total)} igualmente entre ${participants} pessoas, a parte de cada um é ${money(share)}. ` +
        `O saldo considera que quem lançou o gasto foi quem pagou.`
      : "";

    if (!window.Chart) return;
    const withValue = rows.filter((r) => r.v > 0);
    horizontalBar("people", "chart-people", withValue.map((r) => r.name), withValue.map((r) => r.v), css("--blue"));
  }

  function renderFilters(days) {
    const fc = $("#filter-category");
    const fd = $("#filter-day");
    const fp = $("#filter-person");
    const keepC = fc.value, keepD = fd.value, keepP = fp.value;
    fc.replaceChildren(el("option", { value: "" }, "Todas categorias"), ...CATEGORIES.map((c) => el("option", { value: c.id }, c.label)));
    fd.replaceChildren(el("option", { value: "" }, "Todos os dias"), ...days.map((d, i) => el("option", { value: d }, `Dia ${i + 1} · ${fmtDay(d)}`)));
    const people = [...new Set(state.expenses.map((e) => (e.created_by || "").toLowerCase()).filter(Boolean))];
    fp.replaceChildren(el("option", { value: "" }, "Todas as pessoas"), ...people.map((p) => el("option", { value: p }, personName(p))));
    fp.classList.toggle("hidden", Store.mode === "local");
    fc.value = keepC;
    fd.value = days.includes(keepD) ? keepD : "";
    fp.value = people.includes(keepP) ? keepP : "";
  }

  function filteredExpenses() {
    const q = $("#filter-text").value.trim().toLowerCase();
    const c = $("#filter-category").value;
    const d = $("#filter-day").value;
    const p = $("#filter-person").value;
    return state.expenses
      .filter((e) => (!c || e.category === c) && (!d || e.date === d) && (!p || (e.created_by || "").toLowerCase() === p))
      .filter((e) => !q || `${e.description} ${e.notes || ""} ${e.payment_method || ""} ${personName(e.created_by)}`.toLowerCase().includes(q))
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
  }

  function amountCell(e) {
    const td = el("td", { class: "num" }, money(e.amount));
    if (e.original_currency === "GBP" && e.original_amount != null) {
      td.append(el("span", { class: "orig" }, `${fmtMoney(e.original_amount, "GBP")} × ${Number(e.fx_rate).toLocaleString("pt-BR", { maximumFractionDigits: 4 })}`));
    }
    return td;
  }

  function renderExpenseTable() {
    const list = filteredExpenses();
    const showWho = Store.mode === "cloud";
    const head = ["Data", "Descrição", "Categoria", "Pagamento"].concat(showWho ? ["Lançado por"] : []);
    const rows = list.length
      ? list.map((e) => {
          const c = CAT[e.category] || CAT.outros;
          return el("tr", {},
            el("td", {}, fmtDay(e.date)),
            el("td", {},
              e.description,
              e._pending ? el("span", { class: "pending-tag", title: "Ainda não enviado — sem internet" }, "não enviado") : "",
              e.notes ? el("div", { class: "small muted" }, e.notes) : ""
            ),
            el("td", {}, el("span", { class: "dot", style: `background:${c.color}` }), c.label),
            el("td", {}, e.payment_method || "—"),
            ...(showWho ? [el("td", {}, personName(e.created_by))] : []),
            amountCell(e),
            el("td", { class: "actions" },
              el("button", { class: "btn ghost icon", title: "Editar", onclick: () => editExpense(e) }, "Editar"),
              " ",
              el("button", { class: "btn danger icon", title: "Excluir", onclick: () => removeExpense(e) }, "Excluir")
            )
          );
        })
      : [el("tr", {}, el("td", { colspan: String(head.length + 2), class: "empty-row" }, "Nenhum gasto encontrado"))];
    $("#expense-table").replaceChildren(
      el("thead", {}, el("tr", {}, ...head.map((h) => el("th", {}, h)), el("th", { class: "num" }, "Valor"), el("th", {}, ""))),
      el("tbody", {}, ...rows),
      el("tfoot", {}, el("tr", {}, el("td", { colspan: String(head.length) }, `${list.length} gasto(s)`), el("td", { class: "num" }, money(sum(list))), el("td", {})))
    );
  }

  // ---------- Formulário de gasto ----------
  function fillStaticSelects() {
    $("#category-select").replaceChildren(...CATEGORIES.map((c) => el("option", { value: c.id }, c.label)));
    $("#payment-select").replaceChildren(...PAYMENTS.map((p) => el("option", { value: p }, p)));
  }

  function defaultDate() {
    const t = todayISO();
    const { start_date, end_date } = state.trip;
    return t < start_date ? start_date : t > end_date ? end_date : t;
  }

  const defaultGbpRate = () => state.trip.gbp_rate || safeGet(FX_KEY) || "";

  function fillCurrencySelect() {
    const cur = state.trip.currency;
    const opts = [cur].concat(cur === "GBP" ? [] : ["GBP"]);
    $("#currency-select").replaceChildren(...opts.map((c) => el("option", { value: c }, curSymbol(c))));
  }

  function updateFx() {
    const f = $("#expense-form");
    const isGbp = f.currency.value === "GBP" && state.trip.currency !== "GBP";
    $("#fx-row").classList.toggle("hidden", !isGbp);
    f.fx_rate.required = isGbp;
    const amount = num(f.amount.value);
    const rate = num(f.fx_rate.value);
    $("#fx-preview").textContent = isGbp && amount > 0 && rate > 0 ? `= ${money(round2(amount * rate))}` : "";
  }

  function resetExpenseForm() {
    const f = $("#expense-form");
    const keepCat = f.category.value, keepPay = f.payment_method.value, keepCur = f.currency.value;
    f.reset();
    f.id.value = "";
    delete f.dataset.createdBy;
    delete f.dataset.createdAt;
    f.date.value = defaultDate();
    f.date.min = state.trip.start_date;
    f.date.max = state.trip.end_date;
    if (keepCat) f.category.value = keepCat;
    if (keepPay) f.payment_method.value = keepPay;
    fillCurrencySelect();
    if ([...f.currency.options].some((o) => o.value === keepCur)) f.currency.value = keepCur;
    f.fx_rate.value = defaultGbpRate();
    updateFx();
    $("#form-title").textContent = "Novo gasto";
    $("#save-expense-btn").textContent = "Adicionar gasto";
    $("#cancel-edit-btn").classList.add("hidden");
  }

  function editExpense(e) {
    const f = $("#expense-form");
    f.id.value = e.id;
    f.dataset.createdBy = e.created_by || "";
    f.dataset.createdAt = e.created_at || "";
    f.date.value = e.date;
    f.description.value = e.description;
    f.category.value = e.category;
    f.payment_method.value = e.payment_method || "Outro";
    f.notes.value = e.notes || "";
    fillCurrencySelect();
    if (e.original_currency === "GBP" && state.trip.currency !== "GBP") {
      f.currency.value = "GBP";
      f.amount.value = e.original_amount;
      f.fx_rate.value = e.fx_rate;
    } else {
      f.currency.value = state.trip.currency;
      f.amount.value = e.amount;
      f.fx_rate.value = defaultGbpRate();
    }
    updateFx();
    $("#form-title").textContent = "Editar gasto";
    $("#save-expense-btn").textContent = "Salvar alterações";
    $("#cancel-edit-btn").classList.remove("hidden");
    f.scrollIntoView({ behavior: "smooth", block: "start" });
    f.amount.focus();
  }

  async function removeExpense(e) {
    if (!confirm(`Excluir "${e.description}" (${money(e.amount)})?`)) return;
    try {
      await Store.deleteExpense(e.id, e.trip_id);
      state.expenses = state.expenses.filter((x) => x.id !== e.id);
      render();
      toast(Store.pendingCount() ? "Excluído neste aparelho — será sincronizado quando houver internet" : "Gasto excluído");
    } catch (err) {
      toast("Erro ao excluir: " + errMsg(err));
    }
  }

  async function submitExpense(ev) {
    ev.preventDefault();
    const f = ev.target;
    const amount = num(f.amount.value);
    if (!(amount >= 0)) return toast("Valor inválido");
    const data = {
      trip_id: state.trip.id,
      date: f.date.value,
      description: f.description.value.trim(),
      category: f.category.value,
      amount: round2(amount),
      original_currency: null,
      original_amount: null,
      fx_rate: null,
      payment_method: f.payment_method.value,
      notes: f.notes.value.trim() || null,
    };
    if (f.currency.value === "GBP" && state.trip.currency !== "GBP") {
      const rate = num(f.fx_rate.value);
      if (!(rate > 0)) return toast("Informe a cotação da libra");
      Object.assign(data, { original_currency: "GBP", original_amount: round2(amount), fx_rate: rate, amount: round2(amount * rate) });
      safeSet(FX_KEY, String(rate));
    }
    if (f.id.value) {
      data.id = f.id.value;
      if (f.dataset.createdBy) data.created_by = f.dataset.createdBy;
      if (f.dataset.createdAt) data.created_at = f.dataset.createdAt;
    }
    const btn = $("#save-expense-btn");
    btn.disabled = true;
    try {
      const saved = await Store.saveExpense(data);
      const i = state.expenses.findIndex((x) => x.id === saved.id);
      if (i >= 0) state.expenses[i] = { ...state.expenses[i], ...saved };
      else state.expenses.push(saved);
      if (saved._pending) toast("Sem internet: gasto guardado no aparelho. Será enviado sozinho quando a conexão voltar.", 4500);
      else toast(data.id ? "Gasto atualizado" : "Gasto salvo ✓");
      resetExpenseForm();
      render();
      f.description.focus();
    } catch (err) {
      toast("Erro ao salvar: " + errMsg(err), 5000);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Viagem ----------
  function openTripDialog(trip) {
    const f = $("#trip-form");
    f.reset();
    f.id.value = trip ? trip.id : "";
    if (trip) {
      f.name.value = trip.name;
      f.start_date.value = trip.start_date;
      f.end_date.value = trip.end_date;
      f.budget.value = trip.budget ?? "";
      f.currency.value = trip.currency || "EUR";
      f.brl_rate.value = trip.brl_rate ?? "";
      f.gbp_rate.value = trip.gbp_rate ?? "";
    } else {
      const s = todayISO();
      const e = parseISO(s);
      e.setUTCDate(e.getUTCDate() + 9);
      f.start_date.value = s;
      f.end_date.value = toISO(e);
    }
    $("#trip-dialog-title").textContent = trip ? "Editar viagem" : "Nova viagem";
    $("#delete-trip-btn").classList.toggle("hidden", !trip);
    $("#trip-dialog").showModal();
  }

  async function submitTrip(ev) {
    const f = ev.target;
    if (ev.submitter && ev.submitter.value === "cancel") return;
    ev.preventDefault();
    if (f.end_date.value < f.start_date.value) return toast("A data final deve ser depois da inicial");
    const data = {
      name: f.name.value.trim(),
      start_date: f.start_date.value,
      end_date: f.end_date.value,
      budget: f.budget.value ? num(f.budget.value) : null,
      currency: f.currency.value,
      brl_rate: f.brl_rate.value ? num(f.brl_rate.value) : null,
      gbp_rate: f.gbp_rate.value ? num(f.gbp_rate.value) : null,
    };
    if (f.id.value) data.id = f.id.value;
    try {
      const saved = await Store.saveTrip(data);
      $("#trip-dialog").close();
      toast(saved._pending ? "Viagem guardada no aparelho — será enviada quando houver internet" : "Viagem salva");
      state.trip = null;
      await loadTrips(saved.id);
    } catch (err) {
      toast("Erro ao salvar viagem: " + errMsg(err), 5000);
    }
  }

  async function deleteTrip() {
    const t = state.trip;
    if (!t || !confirm(`Excluir a viagem "${t.name}" e TODOS os seus gastos? Isso não pode ser desfeito.`)) return;
    try {
      await Store.deleteTrip(t.id);
      $("#trip-dialog").close();
      state.trip = null;
      await loadTrips();
      toast("Viagem excluída");
    } catch (err) {
      toast("Erro ao excluir: " + errMsg(err));
    }
  }

  // ---------- Exportar ----------
  function exportCSV() {
    const dec = (v) => (v == null ? "" : String(v).replace(".", ","));
    const rows = [["Data", "Descrição", "Categoria", "Pagamento", "Valor", "Moeda", "Valor original", "Moeda original", "Cotação", "Observação", "Lançado por"]];
    for (const e of filteredExpenses()) {
      rows.push([
        e.date, e.description, (CAT[e.category] || CAT.outros).label, e.payment_method || "",
        dec(e.amount), state.trip.currency, dec(e.original_amount), e.original_currency || "", dec(e.fx_rate),
        e.notes || "", personName(e.created_by),
      ]);
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${state.trip.name.replace(/\W+/g, "-")}-gastos.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------- Eventos ----------
  function bindEvents() {
    $("#login-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      $("#login-error").textContent = "";
      try {
        await Store.signIn(ev.target.email.value.trim(), ev.target.password.value);
      } catch (e) {
        $("#login-error").textContent = "Não foi possível entrar: " + errMsg(e);
      }
    });
    $("#logout-btn").addEventListener("click", async () => {
      const pending = Store.pendingCount();
      if (pending && !confirm(`Há ${pending} lançamento(s) ainda não enviado(s). Se sair agora, eles serão perdidos. Sair mesmo assim?`)) return;
      await Store.signOut();
      location.reload();
    });
    $("#sync-badge").addEventListener("click", async () => {
      if (!navigator.onLine) return toast("Ainda sem internet. Os lançamentos serão enviados quando a conexão voltar.");
      await Store.flush();
      if (Store.pendingCount()) toast("Ainda não foi possível enviar. Tentando de novo em instantes.");
    });
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    $("#trip-select").addEventListener("change", (e) => selectTrip(e.target.value));
    $("#new-trip-btn").addEventListener("click", () => openTripDialog(null));
    $("#empty-new-trip").addEventListener("click", () => openTripDialog(null));
    $("#edit-trip-btn").addEventListener("click", () => openTripDialog(state.trip));
    $("#trip-form").addEventListener("submit", submitTrip);
    $("#delete-trip-btn").addEventListener("click", deleteTrip);
    $("#expense-form").addEventListener("submit", submitExpense);
    $("#cancel-edit-btn").addEventListener("click", resetExpenseForm);
    $("#currency-select").addEventListener("change", updateFx);
    $("#expense-form").amount.addEventListener("input", updateFx);
    $("#expense-form").fx_rate.addEventListener("input", updateFx);
    $("#filter-text").addEventListener("input", renderExpenseTable);
    $("#filter-category").addEventListener("change", renderExpenseTable);
    $("#filter-day").addEventListener("change", renderExpenseTable);
    $("#filter-person").addEventListener("change", renderExpenseTable);
    $("#export-btn").addEventListener("click", exportCSV);
  }

  // Guarda o site no aparelho para abrir mesmo sem internet.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  if (window.Chart) chartDefaults();
  boot();
})();
