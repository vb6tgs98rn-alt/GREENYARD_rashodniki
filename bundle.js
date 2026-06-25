// state.js
var STORAGE_VERSION = 2;
var AUTO_STORAGE_KEY = "green-yard-refactor-v2";
var MAX_HISTORY = 40;
var ALL_APARTMENTS_FILTER = "all";
var UNTITLED_LABEL = "\u0411\u0435\u0437 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u044F";
var baseItems = [
  { id: "towels", name: "\u041F\u043E\u043B\u043E\u0442\u0435\u043D\u0446\u0430", unit: "\u0448\u0442", stock: 24, par: 36, category: "linen", perCheckin: 0, setAmount: 2 },
  { id: "linen", name: "\u041F\u043E\u0441\u0442\u0435\u043B\u044C\u043D\u043E\u0435 \u0431\u0435\u043B\u044C\u0451", unit: "\u043A\u043E\u043C\u043F\u043B", stock: 12, par: 18, category: "linen", perCheckin: 0, setAmount: 1 },
  { id: "slippers", name: "\u0422\u0430\u043F\u043E\u0447\u043A\u0438", unit: "\u043F\u0430\u0440\u0430", stock: 28, par: 40, category: "guest", perCheckin: 2, setAmount: 0 },
  { id: "toothbrush", name: "\u0417\u0443\u0431\u043D\u044B\u0435 \u0449\u0451\u0442\u043A\u0438", unit: "\u0448\u0442", stock: 22, par: 30, category: "guest", perCheckin: 2, setAmount: 0 },
  { id: "soap", name: "\u041C\u044B\u043B\u043E", unit: "\u0448\u0442", stock: 20, par: 30, category: "guest", perCheckin: 2, setAmount: 0 },
  { id: "shampoo", name: "\u0428\u0430\u043C\u043F\u0443\u043D\u044C", unit: "\u0431\u0443\u0442", stock: 18, par: 28, category: "guest", perCheckin: 2, setAmount: 0 }
];
function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}
function getDisplayApartmentName(name) {
  return typeof name === "string" && name.trim() ? name.trim() : UNTITLED_LABEL;
}
function createDefaultState() {
  const firstApartmentId = crypto.randomUUID();
  return {
    version: STORAGE_VERSION,
    activeApartmentId: firstApartmentId,
    history: [],
    purchaseRequests: [],
    autoRequest: false,
    apartments: [{ id: firstApartmentId, name: "\u041A\u0432\u0430\u0440\u0442\u0438\u0440\u0430 1", items: structuredCloneSafe(baseItems), externalIds: { realtyCalendarUnitId: "" } }],
    finance: {
      entries: [],
      recurringRules: [],
      bookingSync: { provider: "realtycalendar", lastSyncedAt: "", endpointUrl: "/api/realtycalendar/bookings", importMode: "merge" }
    },
    ui: {
      historyFilterApartmentId: ALL_APARTMENTS_FILTER,
      theme: "light",
      apartmentSearch: "",
      activeSection: "inventory",
      finance: { apartmentFilter: "all", typeFilter: "all", month: "", showOnlyPending: false }
    }
  };
}
var state = createDefaultState();
function ensureStateShape(rawState) {
  const next = rawState && typeof rawState === "object" ? rawState : createDefaultState();
  if (!Array.isArray(next.history)) next.history = [];
  if (!Array.isArray(next.purchaseRequests)) next.purchaseRequests = [];
  if (!Array.isArray(next.apartments)) next.apartments = createDefaultState().apartments;
  if (!next.finance || typeof next.finance !== "object") next.finance = {};
  if (!Array.isArray(next.finance.entries)) next.finance.entries = [];
  if (!Array.isArray(next.finance.recurringRules)) next.finance.recurringRules = [];
  if (!next.finance.bookingSync || typeof next.finance.bookingSync !== "object") next.finance.bookingSync = { provider: "realtycalendar", lastSyncedAt: "", endpointUrl: "/api/realtycalendar/bookings", importMode: "merge" };
  if (!next.ui || typeof next.ui !== "object") next.ui = {};
  if (!next.ui.historyFilterApartmentId) next.ui.historyFilterApartmentId = ALL_APARTMENTS_FILTER;
  if (!next.ui.theme) next.ui.theme = "light";
  if (typeof next.ui.apartmentSearch !== "string") next.ui.apartmentSearch = "";
  if (!next.ui.activeSection) next.ui.activeSection = "inventory";
  if (!next.ui.finance || typeof next.ui.finance !== "object") next.ui.finance = {};
  if (!next.ui.finance.apartmentFilter) next.ui.finance.apartmentFilter = "all";
  if (!next.ui.finance.typeFilter) next.ui.finance.typeFilter = "all";
  if (typeof next.ui.finance.month !== "string") next.ui.finance.month = "";
  if (typeof next.ui.finance.showOnlyPending !== "boolean") next.ui.finance.showOnlyPending = false;
  next.apartments = next.apartments.map((apartment, index) => ({ ...apartment, name: apartment?.name || `\u041A\u0432\u0430\u0440\u0442\u0438\u0440\u0430 ${index + 1}`, items: Array.isArray(apartment?.items) ? apartment.items : [], externalIds: { realtyCalendarUnitId: apartment?.externalIds?.realtyCalendarUnitId || "" } }));
  return next;
}
function getState() {
  return state;
}
function setState(nextState) {
  state = nextState;
  return state;
}
function updateState(mutator) {
  mutator(state);
  return state;
}
function currentApartment() {
  return state.apartments.find((a) => a.id === state.activeApartmentId) || state.apartments[0] || null;
}
function findApartmentById(id) {
  return state.apartments.find((a) => a.id === id) || null;
}
function roundSmart(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(1);
}
function statusBy(item) {
  const ratio = item.par <= 0 ? 0 : item.stock / item.par;
  if (ratio <= 0.35) return { label: "\u041D\u0438\u0437\u043A\u0438\u0439", cls: "low" };
  if (ratio <= 0.65) return { label: "\u0421\u0440\u0435\u0434\u043D\u0438\u0439", cls: "warn" };
  return { label: "\u041D\u043E\u0440\u043C\u0430", cls: "ok" };
}

// storage.js
function normalizeImportedState(raw) {
  if (!raw || !Array.isArray(raw.apartments) || raw.apartments.length === 0) {
    throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 JSON");
  }
  const apartments = raw.apartments.map((apartment, index) => ({
    id: apartment.id || crypto.randomUUID(),
    name: typeof apartment.name === "string" ? apartment.name : `\u041A\u0432\u0430\u0440\u0442\u0438\u0440\u0430 ${index + 1}`,
    items: Array.isArray(apartment.items) && apartment.items.length ? apartment.items.map((item) => ({
      id: item.id || crypto.randomUUID(),
      name: item.name || "\u0411\u0435\u0437 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u044F",
      unit: item.unit || "\u0448\u0442",
      stock: Math.max(0, Number(item.stock || 0)),
      par: Math.max(0, Number(item.par || 0)),
      category: item.category === "linen" ? "linen" : "guest",
      perCheckin: Math.max(0, Number(item.perCheckin || 0)),
      setAmount: Math.max(0, Number(item.setAmount || 0))
    })) : structuredCloneSafe(baseItems)
  }));
  return {
    version: STORAGE_VERSION,
    activeApartmentId: apartments.some((a) => a.id === raw.activeApartmentId) ? raw.activeApartmentId : apartments[0].id,
    history: Array.isArray(raw.history) ? raw.history.slice(0, MAX_HISTORY) : [],
    purchaseRequests: Array.isArray(raw.purchaseRequests) ? raw.purchaseRequests : [],
    autoRequest: raw.autoRequest === true,
    apartments,
    ui: {
      historyFilterApartmentId: raw?.ui?.historyFilterApartmentId || "all",
      theme: raw?.ui?.theme === "dark" ? "dark" : "light",
      apartmentSearch: typeof raw?.ui?.apartmentSearch === "string" ? raw.ui.apartmentSearch : ""
    }
  };
}
async function tryLoadFromApi() {
  return false;
}
function saveToBrowser(setStatus2, silent = false) {
  const notify = typeof setStatus2 === "function" ? setStatus2 : () => {
  };
  try {
    localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(getState()));
    if (!silent) notify(`\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u0432 ${(/* @__PURE__ */ new Date()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`);
  } catch {
    notify("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435.");
  }
}
async function loadFromBrowser(setStatus2) {
  const loadedFromApi = await tryLoadFromApi();
  if (loadedFromApi) {
    setStatus2(`\u0417\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E \u0447\u0435\u0440\u0435\u0437 API \u0432 ${(/* @__PURE__ */ new Date()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`);
    return true;
  }
  try {
    const raw = localStorage.getItem(AUTO_STORAGE_KEY);
    if (!raw) return false;
    setState(normalizeImportedState(JSON.parse(raw)));
    setStatus2(`\u0417\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E \u0432 ${(/* @__PURE__ */ new Date()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`);
    return true;
  } catch {
    setStatus2("\u041E\u0448\u0438\u0431\u043A\u0430 \u0447\u0442\u0435\u043D\u0438\u044F \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445.");
    return false;
  }
}
function exportJson() {
  const blob = new Blob([JSON.stringify(getState(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `green-yard-backup-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1e3);
}
async function importJson(file) {
  const text = await file.text();
  setState(normalizeImportedState(JSON.parse(text)));
}

// dom.js
var byId = (id) => document.getElementById(id);
var dom = {
  drawerMenu: byId("drawerMenu"),
  drawerBackdrop: byId("drawerBackdrop"),
  openDrawerSidebar: byId("openDrawerSidebar"),
  closeDrawer: byId("closeDrawer"),
  saveStatus: byId("saveStatus"),
  drawerThemeToggle: byId("drawerThemeToggle"),
  themeLabel: byId("themeLabel"),
  sidebarNavButtons: [...document.querySelectorAll(".sidebar [data-section]")],
  financeDrawerButton: byId("openFinanceSection"),
  inventorySection: byId("inventorySection"),
  // financeSection removed — now it's a modal
  financeModal: byId("financeModal"),
  closeFinanceModal: byId("closeFinanceModal"),
  financeTabsNav: byId("financeTabsNav"),
  financeTabEntries: byId("financeTabEntries"),
  financeTabRecurring: byId("financeTabRecurring"),
  financeTabSummary: byId("financeTabSummary"),
  financeTabApi: byId("financeTabApi"),
  apartmentSearch: byId("apartmentSearch"),
  apartmentName: byId("apartmentName"),
  apartmentsList: byId("apartmentsList"),
  pageTitle: byId("pageTitle"),
  linenList: byId("linenList"),
  guestList: byId("guestList"),
  statsGrid: byId("statsGrid"),
  dailyUsage: byId("dailyUsage"),
  setUsage: byId("setUsage"),
  coverageList: byId("coverageList"),
  historyApartmentFilter: byId("historyApartmentFilter"),
  historyModalList: byId("historyModalList"),
  purchaseRequestsList: byId("purchaseRequestsList"),
  autoRequestToggle: byId("autoRequestToggle"),
  purchaseApartmentSelect: byId("purchaseApartmentSelect"),
  purchaseApartmentHint: byId("purchaseApartmentHint"),
  purchaseItemsWrap: byId("purchaseItemsWrap"),
  deductionSettings: byId("deductionSettings"),
  setSettings: byId("setSettings"),
  financeApartmentFilter: byId("financeApartmentFilter"),
  financeTypeFilter: byId("financeTypeFilter"),
  financeMonthFilter: byId("financeMonthFilter"),
  financeOnlyPending: byId("financeOnlyPending"),
  financeSummary: byId("financeSummary"),
  financeByApartment: byId("financeByApartment"),
  financeEntriesList: byId("financeEntriesList"),
  recurringExpensesList: byId("recurringExpensesList"),
  financeWebhookEndpoint: byId("financeWebhookEndpoint"),
  financeLastSync: byId("financeLastSync"),
  financeAddEntryBtn: byId("financeAddEntryBtn"),
  financeAddRecurringBtn: byId("financeAddRecurringBtn"),
  financePullBookingsBtn: byId("financePullBookingsBtn"),
  financeOpenWebhookHelpBtn: byId("financeOpenWebhookHelpBtn"),
  financeEntryApartment: byId("financeEntryApartment"),
  financeEntryType: byId("financeEntryType"),
  financeEntryCategory: byId("financeEntryCategory"),
  financeEntryTitle: byId("financeEntryTitle"),
  financeEntryAmount: byId("financeEntryAmount"),
  financeEntryDate: byId("financeEntryDate"),
  financeEntryNotes: byId("financeEntryNotes"),
  financeEntrySource: byId("financeEntrySource"),
  saveFinanceEntry: byId("saveFinanceEntry"),
  cancelFinanceEntry: byId("cancelFinanceEntry"),
  recurringApartment: byId("recurringApartment"),
  recurringTitle: byId("recurringTitle"),
  recurringCategory: byId("recurringCategory"),
  recurringAmount: byId("recurringAmount"),
  recurringDayOfMonth: byId("recurringDayOfMonth"),
  recurringStartDate: byId("recurringStartDate"),
  recurringEndDate: byId("recurringEndDate"),
  recurringNotes: byId("recurringNotes"),
  saveRecurringExpense: byId("saveRecurringExpense"),
  cancelRecurringExpense: byId("cancelRecurringExpense"),
  financeWebhookExample: byId("financeWebhookExample"),
  closeFinanceWebhookModal: byId("closeFinanceWebhookModal")
};
var dom_default = dom;

// api.js
var API_CONFIG = {
  realtyCalendarWebhookPath: "/api/realtycalendar/bookings",
  realtyCalendarPullPath: "/api/realtycalendar/bookings/sync"
};
async function safeJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}
async function syncRealtyCalendarBookings(params = {}, endpoint = API_CONFIG.realtyCalendarPullPath) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(query ? `${endpoint}?${query}` : endpoint);
  if (!response.ok) throw new Error(`Sync error: ${response.status}`);
  return safeJson(response);
}
function normalizeRealtyCalendarBooking(raw) {
  return {
    externalBookingId: String(raw.externalBookingId || raw.id || crypto.randomUUID()),
    apartmentExternalId: String(raw.apartmentExternalId || raw.unitId || ""),
    apartmentId: String(raw.apartmentId || ""),
    guestName: raw.guestName || raw.guest || "\u0413\u043E\u0441\u0442\u044C",
    checkIn: raw.checkIn || raw.arrivalDate || raw.startDate || "",
    checkOut: raw.checkOut || raw.departureDate || raw.endDate || "",
    amount: Number(raw.amount || raw.total || raw.payout || 0),
    currency: raw.currency || "RUB",
    channel: raw.channel || raw.source || "RealtyCalendar",
    status: raw.status || "confirmed",
    importedAt: (/* @__PURE__ */ new Date()).toISOString(),
    raw
  };
}
function buildFinanceWebhookExample() {
  return {
    event: "booking.created",
    bookings: [{ externalBookingId: "rc-1001", apartmentExternalId: "unit-101", guestName: "\u0418\u0432\u0430\u043D \u041F\u0435\u0442\u0440\u043E\u0432", checkIn: "2026-06-28", checkOut: "2026-07-02", amount: 18500, currency: "RUB", channel: "Airbnb", status: "confirmed" }]
  };
}

// finance.js
var FINANCE_TYPES = { income: "income", expense: "expense" };
var STATUS_LABELS = {
  planned: { label: "\u0417\u0430\u043F\u043B\u0430\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u043E", cls: "planned" },
  confirmed: { label: "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u043E", cls: "confirmed" },
  pending: { label: "\u0412 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0438", cls: "pending" },
  cancelled: { label: "\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E", cls: "cancelled" }
};
function monthKey(dateLike) {
  if (!dateLike) return "";
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function ensureFinanceGeneratedForCurrentMonth() {
  const state2 = getState();
  const month = state2.ui?.finance?.month || monthKey(/* @__PURE__ */ new Date());
  generateRecurringEntriesForMonth(month);
}
function createFinanceEntryDraft(data = {}) {
  const apartment = findApartmentById(data.apartmentId) || currentApartment();
  return {
    id: crypto.randomUUID(),
    apartmentId: apartment?.id || "",
    apartmentName: getDisplayApartmentName(apartment?.name || "\u2014"),
    type: data.type || FINANCE_TYPES.expense,
    category: data.category || "",
    title: data.title || "",
    amount: Number(data.amount || 0),
    currency: data.currency || "RUB",
    date: data.date || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    source: data.source || "manual",
    status: data.status || "planned",
    notes: data.notes || "",
    externalBookingId: data.externalBookingId || "",
    meta: data.meta || {}
  };
}
function createRecurringRuleDraft(data = {}) {
  const apartment = findApartmentById(data.apartmentId) || currentApartment();
  return {
    id: crypto.randomUUID(),
    apartmentId: apartment?.id || "",
    apartmentName: getDisplayApartmentName(apartment?.name || "\u2014"),
    title: data.title || "",
    category: data.category || "",
    amount: Number(data.amount || 0),
    currency: data.currency || "RUB",
    type: data.type || FINANCE_TYPES.expense,
    dayOfMonth: Number(data.dayOfMonth || 1),
    startDate: data.startDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    endDate: data.endDate || "",
    notes: data.notes || "",
    active: data.active ?? true
  };
}
function addFinanceEntry(entry) {
  const normalized = createFinanceEntryDraft(entry);
  updateState((state2) => {
    state2.finance.entries.unshift(normalized);
  });
  return normalized;
}
function deleteFinanceEntry(id) {
  updateState((state2) => {
    state2.finance.entries = state2.finance.entries.filter((e) => e.id !== id);
  });
}
function updateFinanceEntryStatus(id, status) {
  updateState((state2) => {
    const entry = state2.finance.entries.find((e) => e.id === id);
    if (entry) entry.status = status;
  });
}
function addRecurringRule(rule) {
  const normalized = createRecurringRuleDraft(rule);
  updateState((state2) => {
    state2.finance.recurringRules.unshift(normalized);
  });
  return normalized;
}
function deleteRecurringRule(id) {
  updateState((state2) => {
    state2.finance.recurringRules = state2.finance.recurringRules.filter((r) => r.id !== id);
    state2.finance.entries = state2.finance.entries.filter(
      (e) => !(e.source === "recurring" && e.meta?.ruleId === id && e.status === "planned")
    );
  });
}
function toggleRecurringRule(id) {
  updateState((state2) => {
    const rule = state2.finance.recurringRules.find((r) => r.id === id);
    if (rule) rule.active = !rule.active;
  });
}
function generateRecurringEntriesForMonth(month) {
  if (!month) return [];
  const created = [];
  updateState((state2) => {
    const existingKeys = new Set(
      state2.finance.entries.filter((entry) => entry.source === "recurring").map((entry) => `${entry.meta?.ruleId || ""}:${entry.date}`)
    );
    state2.finance.recurringRules.forEach((rule) => {
      if (!rule.active) return;
      const dueDate = `${month}-${String(Math.min(Math.max(rule.dayOfMonth || 1, 1), 28)).padStart(2, "0")}`;
      if (rule.startDate && dueDate < rule.startDate) return;
      if (rule.endDate && dueDate > rule.endDate) return;
      const key = `${rule.id}:${dueDate}`;
      if (existingKeys.has(key)) return;
      const entry = createFinanceEntryDraft({
        apartmentId: rule.apartmentId,
        type: rule.type,
        category: rule.category,
        title: rule.title,
        amount: rule.amount,
        currency: rule.currency,
        date: dueDate,
        source: "recurring",
        status: "planned",
        notes: rule.notes,
        meta: { ruleId: rule.id }
      });
      state2.finance.entries.push(entry);
      created.push(entry);
      existingKeys.add(key);
    });
  });
  return created;
}
function importBookingsToFinance(bookings = []) {
  const added = [];
  updateState((state2) => {
    const existing = new Set(
      state2.finance.entries.filter((entry) => entry.externalBookingId).map((entry) => entry.externalBookingId)
    );
    bookings.forEach((booking) => {
      if (!booking.externalBookingId || existing.has(booking.externalBookingId)) return;
      let apartment = state2.apartments.find(
        (item) => item.externalIds?.realtyCalendarUnitId && item.externalIds.realtyCalendarUnitId === booking.apartmentExternalId
      );
      if (!apartment && booking.apartmentId) apartment = state2.apartments.find((item) => item.id === booking.apartmentId);
      if (!apartment) return;
      const entry = createFinanceEntryDraft({
        apartmentId: apartment.id,
        type: FINANCE_TYPES.income,
        category: "\u0411\u0440\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435",
        title: `${booking.channel || "RealtyCalendar"} \xB7 ${booking.guestName || "\u0413\u043E\u0441\u0442\u044C"}`,
        amount: booking.amount,
        currency: booking.currency || "RUB",
        date: booking.checkIn || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
        source: "realtycalendar",
        status: booking.status === "cancelled" ? "cancelled" : "confirmed",
        notes: `${booking.checkIn || "\u2014"} \u2192 ${booking.checkOut || "\u2014"}`,
        externalBookingId: booking.externalBookingId,
        meta: booking
      });
      state2.finance.entries.unshift(entry);
      added.push(entry);
      existing.add(booking.externalBookingId);
    });
    state2.finance.bookingSync.lastSyncedAt = (/* @__PURE__ */ new Date()).toISOString();
  });
  return added;
}
function getFilteredFinanceEntries() {
  const state2 = getState();
  const filter = state2.ui.finance || {};
  return state2.finance.entries.filter((entry) => {
    if (filter.apartmentFilter && filter.apartmentFilter !== "all" && entry.apartmentId !== filter.apartmentFilter) return false;
    if (filter.typeFilter && filter.typeFilter !== "all" && entry.type !== filter.typeFilter) return false;
    if (filter.month && monthKey(entry.date) !== filter.month) return false;
    if (filter.showOnlyPending && !["planned", "pending"].includes(entry.status)) return false;
    return true;
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
function getFinanceSummary() {
  const entries = getFilteredFinanceEntries();
  const totals = entries.reduce(
    (acc, entry) => {
      if (entry.type === FINANCE_TYPES.income) acc.income += Number(entry.amount || 0);
      if (entry.type === FINANCE_TYPES.expense) acc.expense += Number(entry.amount || 0);
      return acc;
    },
    { income: 0, expense: 0 }
  );
  const state2 = getState();
  const byApartment = {};
  state2.finance.entries.forEach((entry) => {
    if (!byApartment[entry.apartmentId]) {
      byApartment[entry.apartmentId] = { name: entry.apartmentName, income: 0, expense: 0 };
    }
    if (entry.type === "income") byApartment[entry.apartmentId].income += Number(entry.amount || 0);
    if (entry.type === "expense") byApartment[entry.apartmentId].expense += Number(entry.amount || 0);
  });
  return {
    income: totals.income,
    expense: totals.expense,
    profit: totals.income - totals.expense,
    entries,
    recurring: state2.finance.recurringRules,
    byApartment
  };
}

// render.js
function setStatus(text = "\u0413\u043E\u0442\u043E\u0432\u043E") {
  if (dom_default.saveStatus) dom_default.saveStatus.textContent = text;
}
function fmt(n) {
  return Number(n || 0).toLocaleString("ru-RU", { maximumFractionDigits: 0 });
}
function apartmentButton(apartment, activeApartmentId) {
  const low = apartment.items.filter((item) => statusBy(item).cls === "low").length;
  return `<div class="apartment-row"><button class="apartment-btn ${apartment.id === activeApartmentId ? "active" : ""}" data-apartment-id="${apartment.id}"><div class="apartment-meta"><strong>${getDisplayApartmentName(apartment.name)}</strong><span class="small">${low ? `\u041D\u0438\u0437\u043A\u0438\u0439 \u043E\u0441\u0442\u0430\u0442\u043E\u043A: ${low}` : "\u0411\u0435\u0437 \u043A\u0440\u0438\u0442\u0438\u0447\u043D\u044B\u0445 \u043F\u043E\u0437\u0438\u0446\u0438\u0439"}</span></div><span class="small">${apartment.items.length} \u043F\u043E\u0437.</span></button></div>`;
}
function itemCard(item) {
  const status = statusBy(item);
  const percent = item.par > 0 ? Math.max(0, Math.min(100, item.stock / item.par * 100)) : 0;
  return `<article class="item-card ${status.cls === "low" ? "highlight" : ""}">
    <div class="item-head">
      <div><div class="item-name">${item.name}</div><div class="small">${roundSmart(item.stock)} / ${roundSmart(item.par)} ${item.unit}</div></div>
      <span class="badge ${status.cls}">${status.label}</span>
    </div>
    <div class="row">
      <div><div class="small">\u041E\u0441\u0442\u0430\u0442\u043E\u043A</div><div class="qty">${roundSmart(item.stock)}</div></div>
      <div><div class="small">\u041F\u043E\u043A\u0440\u044B\u0442\u0438\u0435</div><div class="progress"><span style="width:${percent}%"></span></div></div>
    </div>
    <div style="display:flex;gap:.45rem;margin-top:.6rem">
      <button class="mini-btn" style="flex:1;background:color-mix(in oklab,var(--color-error) 10%,var(--color-surface-2));border-color:color-mix(in oklab,var(--color-error) 20%,transparent);color:var(--color-error)"
        data-action="open-writeoff" data-id="${item.id}" data-name="${item.name}" data-unit="${item.unit}" data-category="${item.category}">\u0421\u043F\u0438\u0441\u0430\u0442\u044C</button>
      <button class="mini-btn" style="flex:1;background:color-mix(in oklab,var(--color-success) 10%,var(--color-surface-2));border-color:color-mix(in oklab,var(--color-success) 20%,transparent);color:var(--color-success)"
        data-action="open-restock" data-id="${item.id}" data-name="${item.name}" data-unit="${item.unit}" data-category="${item.category}">\u041F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u044C</button>
    </div>
  </article>`;
}
function renderInventory(state2) {
  const apartment = currentApartment();
  if (!apartment || !dom_default.pageTitle) return;
  dom_default.pageTitle.textContent = getDisplayApartmentName(apartment.name);
  dom_default.apartmentName.value = apartment.name;
  dom_default.apartmentSearch.value = state2.ui.apartmentSearch || "";
  const filteredApartments = state2.apartments.filter(
    (a) => getDisplayApartmentName(a.name).toLowerCase().includes((state2.ui.apartmentSearch || "").toLowerCase())
  );
  dom_default.apartmentsList.innerHTML = filteredApartments.length ? filteredApartments.map((a) => apartmentButton(a, state2.activeApartmentId)).join("") : '<div class="empty">\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E.</div>';
  const linenItems = apartment.items.filter((i) => i.category === "linen");
  const guestItems = apartment.items.filter((i) => i.category === "guest");
  dom_default.linenList.innerHTML = linenItems.length ? `<div class="grid">${linenItems.map(itemCard).join("")}</div>` : '<div class="empty">\u041D\u0435\u0442 \u043F\u043E\u0437\u0438\u0446\u0438\u0439.</div>';
  dom_default.guestList.innerHTML = guestItems.length ? `<div class="grid">${guestItems.map(itemCard).join("")}</div>` : '<div class="empty">\u041D\u0435\u0442 \u043F\u043E\u0437\u0438\u0446\u0438\u0439.</div>';
  const total = apartment.items.length;
  const low = apartment.items.filter((i) => statusBy(i).cls === "low").length;
  const warn = apartment.items.filter((i) => statusBy(i).cls === "warn").length;
  const ok = apartment.items.filter((i) => statusBy(i).cls === "ok").length;
  dom_default.statsGrid.innerHTML = `<article class="stat"><span>\u0412\u0441\u0435\u0433\u043E \u043F\u043E\u0437\u0438\u0446\u0438\u0439</span><strong>${total}</strong></article><article class="stat"><span>\u041D\u0438\u0437\u043A\u0438\u0439 \u043E\u0441\u0442\u0430\u0442\u043E\u043A</span><strong>${low}</strong></article><article class="stat"><span>\u0412 \u0437\u043E\u043D\u0435 \u0432\u043D\u0438\u043C\u0430\u043D\u0438\u044F</span><strong>${warn}</strong></article><article class="stat"><span>\u0412 \u043D\u043E\u0440\u043C\u0435</span><strong>${ok}</strong></article>`;
  dom_default.dailyUsage.innerHTML = guestItems.length ? guestItems.map((item) => `<div class="line"><span>${item.name}</span><strong>${roundSmart(item.perCheckin)} ${item.unit}</strong></div>`).join("") : '<div class="empty">\u041D\u0435\u0442 \u0433\u043E\u0441\u0442\u0435\u0432\u044B\u0445 \u043F\u043E\u0437\u0438\u0446\u0438\u0439.</div>';
  dom_default.setUsage.innerHTML = linenItems.length ? linenItems.map((item) => `<div class="line"><span>${item.name}</span><strong>${roundSmart(item.setAmount)} ${item.unit}</strong></div>`).join("") : '<div class="empty">\u041D\u0435\u0442 \u0431\u0435\u043B\u044C\u044F.</div>';
  dom_default.coverageList.innerHTML = apartment.items.map((item) => `<div class="line"><span>${item.name}</span><strong>${item.perCheckin > 0 ? Math.floor(item.stock / item.perCheckin) : item.setAmount > 0 ? Math.floor(item.stock / item.setAmount) : "\u2014"}</strong></div>`).join("");
}
function sourceIcon(source) {
  if (source === "realtycalendar") return "\u{1F517}";
  if (source === "recurring") return "\u{1F504}";
  return "\u270F\uFE0F";
}
function sourceLabel(source) {
  if (source === "realtycalendar") return "RealtyCalendar";
  if (source === "recurring") return "\u0420\u0435\u0433\u0443\u043B\u044F\u0440\u043D\u044B\u0439";
  return "\u0412\u0440\u0443\u0447\u043D\u0443\u044E";
}
function financeEntryCard(entry) {
  const isIncome = entry.type === "income";
  const st = STATUS_LABELS[entry.status] || { label: entry.status, cls: "planned" };
  const canConfirm = entry.status === "planned" || entry.status === "pending";
  return `<article class="finance-card ${entry.type}" data-entry-id="${entry.id}">
    <div class="finance-card-top">
      <div class="finance-card-left">
        <div class="finance-card-title">${entry.title || entry.category || (isIncome ? "\u0414\u043E\u0445\u043E\u0434" : "\u0420\u0430\u0441\u0445\u043E\u0434")}</div>
        <div class="finance-card-meta">
          <span>${entry.apartmentName}</span>
          <span class="sep">\xB7</span>
          <span>${entry.date}</span>
          <span class="sep">\xB7</span>
          <span>${sourceIcon(entry.source)} ${sourceLabel(entry.source)}</span>
        </div>
        ${entry.category ? `<div class="finance-card-cat">${entry.category}</div>` : ""}
        ${entry.notes ? `<div class="finance-card-notes">${entry.notes}</div>` : ""}
      </div>
      <div class="finance-card-right">
        <div class="finance-amount ${entry.type}">${isIncome ? "+" : "\u2212"}${fmt(entry.amount)} \u20BD</div>
        <span class="finance-status ${st.cls}">${st.label}</span>
      </div>
    </div>
    <div class="finance-card-actions">
      ${canConfirm ? `<button class="btn-chip btn-confirm" data-action="confirm-entry" data-id="${entry.id}" title="\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C">\u2713 \u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C</button>` : ""}
      <button class="btn-chip btn-del" data-action="delete-entry" data-id="${entry.id}" title="\u0423\u0434\u0430\u043B\u0438\u0442\u044C">\u2715</button>
    </div>
  </article>`;
}
function recurringRuleCard(rule) {
  const typeLabel = rule.type === "income" ? "\u0414\u043E\u0445\u043E\u0434" : "\u0420\u0430\u0441\u0445\u043E\u0434";
  const typeClass = rule.type === "income" ? "income" : "expense";
  return `<article class="recurring-card ${rule.active ? "" : "inactive"}" data-rule-id="${rule.id}">
    <div class="recurring-card-top">
      <div>
        <div class="recurring-title">${rule.title || "\u041F\u0440\u0430\u0432\u0438\u043B\u043E"}</div>
        <div class="finance-card-meta">
          <span>${rule.apartmentName}</span>
          <span class="sep">\xB7</span>
          <span>${rule.dayOfMonth} \u0447\u0438\u0441\u043B\u043E</span>
          ${rule.category ? `<span class="sep">\xB7</span><span>${rule.category}</span>` : ""}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div class="finance-amount ${typeClass}" style="font-size:var(--text-base)">${typeLabel === "\u0414\u043E\u0445\u043E\u0434" ? "+" : "\u2212"}${fmt(rule.amount)} \u20BD</div>
        <div class="small" style="margin-top:.2rem">${rule.active ? "\u25CF \u0410\u043A\u0442\u0438\u0432\u043D\u043E" : "\u25CB \u041E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u043E"}</div>
      </div>
    </div>
    <div class="finance-card-actions">
      <button class="btn-chip" data-action="toggle-recurring" data-id="${rule.id}">${rule.active ? "\u041E\u0442\u043A\u043B\u044E\u0447\u0438\u0442\u044C" : "\u0412\u043A\u043B\u044E\u0447\u0438\u0442\u044C"}</button>
      <button class="btn-chip btn-del" data-action="delete-recurring" data-id="${rule.id}">\u2715 \u0423\u0434\u0430\u043B\u0438\u0442\u044C</button>
    </div>
  </article>`;
}
function renderFinance(state2) {
  if (!dom_default.financeApartmentFilter) return;
  const filter = state2.ui?.finance || {};
  const summary = getFinanceSummary();
  const entries = summary.entries;
  const apartmentOptions = [
    `<option value="all">\u0412\u0441\u0435 \u043A\u0432\u0430\u0440\u0442\u0438\u0440\u044B</option>`,
    ...state2.apartments.map((a) => `<option value="${a.id}">${getDisplayApartmentName(a.name)}</option>`)
  ].join("");
  dom_default.financeApartmentFilter.innerHTML = apartmentOptions;
  dom_default.financeApartmentFilter.value = filter.apartmentFilter || "all";
  dom_default.financeTypeFilter.value = filter.typeFilter || "all";
  dom_default.financeMonthFilter.value = filter.month || monthKey(/* @__PURE__ */ new Date());
  dom_default.financeOnlyPending.checked = !!filter.showOnlyPending;
  const profitColor = summary.profit >= 0 ? "var(--color-success)" : "var(--color-error)";
  dom_default.financeSummary.innerHTML = `
    <article class="stat">
      <span>\u0414\u043E\u0445\u043E\u0434\u044B</span>
      <strong style="color:var(--color-success)">${fmt(summary.income)} \u20BD</strong>
    </article>
    <article class="stat">
      <span>\u0420\u0430\u0441\u0445\u043E\u0434\u044B</span>
      <strong style="color:var(--color-error)">${fmt(summary.expense)} \u20BD</strong>
    </article>
    <article class="stat">
      <span>\u041F\u0440\u0438\u0431\u044B\u043B\u044C</span>
      <strong style="color:${profitColor}">${summary.profit >= 0 ? "+" : ""}${fmt(summary.profit)} \u20BD</strong>
    </article>
    <article class="stat">
      <span>\u041F\u0440\u043E\u0432\u043E\u0434\u043E\u043A</span>
      <strong>${entries.length}</strong>
    </article>`;
  const aptEntries = Object.values(summary.byApartment);
  if (dom_default.financeByApartment) {
    dom_default.financeByApartment.innerHTML = aptEntries.length ? aptEntries.map((apt) => {
      const profit = apt.income - apt.expense;
      const pc = profit >= 0 ? "var(--color-success)" : "var(--color-error)";
      return `<div class="apt-finance-row">
            <div class="apt-finance-name">${apt.name}</div>
            <div class="apt-finance-nums">
              <span style="color:var(--color-success)">+${fmt(apt.income)}</span>
              <span style="color:var(--color-error)">\u2212${fmt(apt.expense)}</span>
              <span style="color:${pc};font-weight:700">${profit >= 0 ? "+" : ""}${fmt(profit)} \u20BD</span>
            </div>
          </div>`;
    }).join("") : '<div class="empty">\u041D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445.</div>';
  }
  dom_default.financeEntriesList.innerHTML = entries.length ? entries.map(financeEntryCard).join("") : '<div class="empty">\u041D\u0435\u0442 \u0437\u0430\u043F\u0438\u0441\u0435\u0439 \u043F\u043E \u0444\u0438\u043B\u044C\u0442\u0440\u0430\u043C.</div>';
  dom_default.recurringExpensesList.innerHTML = state2.finance.recurringRules.length ? state2.finance.recurringRules.map(recurringRuleCard).join("") : '<div class="empty">\u0420\u0435\u0433\u0443\u043B\u044F\u0440\u043D\u044B\u0435 \u0440\u0430\u0441\u0445\u043E\u0434\u044B \u0435\u0449\u0451 \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u044B.</div>';
  if (dom_default.financeWebhookEndpoint) dom_default.financeWebhookEndpoint.textContent = state2.finance.bookingSync.endpointUrl;
  if (dom_default.financeLastSync) dom_default.financeLastSync.textContent = state2.finance.bookingSync.lastSyncedAt ? new Date(state2.finance.bookingSync.lastSyncedAt).toLocaleString("ru-RU") : "\u0415\u0449\u0451 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u043B\u0430\u0441\u044C";
  if (dom_default.financeWebhookExample) dom_default.financeWebhookExample.textContent = JSON.stringify(buildFinanceWebhookExample(), null, 2);
  [dom_default.financeEntryApartment, dom_default.recurringApartment].forEach((el) => {
    if (!el) return;
    el.innerHTML = state2.apartments.map((a) => `<option value="${a.id}">${getDisplayApartmentName(a.name)}</option>`).join("");
    if (!el.value) el.value = state2.activeApartmentId;
  });
  if (dom_default.financeEntryDate && !dom_default.financeEntryDate.value) dom_default.financeEntryDate.value = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  if (dom_default.recurringStartDate && !dom_default.recurringStartDate.value) dom_default.recurringStartDate.value = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
function openModal(id) {
  document.getElementById(id)?.classList.add("open");
}
function closeModal(id) {
  document.getElementById(id)?.classList.remove("open");
}
function openDrawer() {
  dom_default.drawerMenu?.classList.add("open");
  dom_default.drawerBackdrop?.classList.add("open");
}
function closeDrawer() {
  dom_default.drawerMenu?.classList.remove("open");
  dom_default.drawerBackdrop?.classList.remove("open");
}
function render() {
  const state2 = getState();
  document.documentElement.setAttribute("data-theme", state2.ui.theme || "light");
  if (dom_default.drawerThemeToggle) dom_default.drawerThemeToggle.classList.toggle("active", state2.ui.theme === "dark");
  if (dom_default.themeLabel) dom_default.themeLabel.textContent = state2.ui.theme === "dark" ? "\u0422\u0435\u043C\u043D\u0430\u044F \u0442\u0435\u043C\u0430" : "\u0421\u0432\u0435\u0442\u043B\u0430\u044F \u0442\u0435\u043C\u0430";
  dom_default.sidebarNavButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.section === state2.ui.activeSection));
  if (dom_default.inventorySection) dom_default.inventorySection.hidden = false;
  renderInventory(state2);
  renderFinance(state2);
}

// actions.js
function addHistory(action, details = "", type = "info") {
  const state2 = getState();
  const apartment = currentApartment();
  state2.history.unshift({
    id: crypto.randomUUID(),
    apartmentId: apartment?.id || "",
    apartmentName: getDisplayApartmentName(apartment?.name),
    action,
    details,
    type,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  state2.history = state2.history.slice(0, 40);
}
function addApartment() {
  updateState((state2) => {
    const id = crypto.randomUUID();
    state2.apartments.push({ id, name: `\u041A\u0432\u0430\u0440\u0442\u0438\u0440\u0430 ${state2.apartments.length + 1}`, items: JSON.parse(JSON.stringify(state2.apartments[0].items)) });
    state2.activeApartmentId = id;
  });
  addHistory("\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0430 \u043A\u0432\u0430\u0440\u0442\u0438\u0440\u0430", "", "create");
}
function renameCurrentApartment(name) {
  const apartment = currentApartment();
  if (!apartment) return;
  apartment.name = name;
}
function deleteApartment(id) {
  updateState((state2) => {
    if (state2.apartments.length <= 1) return;
    const target = state2.apartments.find((a) => a.id === id);
    state2.apartments = state2.apartments.filter((a) => a.id !== id);
    state2.purchaseRequests = state2.purchaseRequests.filter((r) => r.apartmentId !== id);
    if (state2.activeApartmentId === id) state2.activeApartmentId = state2.apartments[0].id;
    if (target) addHistory("\u0423\u0434\u0430\u043B\u0435\u043D\u0430 \u043A\u0432\u0430\u0440\u0442\u0438\u0440\u0430", getDisplayApartmentName(target.name), "delete");
  });
}
function addCustomItem(payload) {
  const apartment = currentApartment();
  if (!apartment || !payload.name.trim()) return false;
  const item = {
    id: `${payload.category}-${Date.now()}`,
    name: payload.name.trim(),
    unit: payload.unit,
    stock: Math.max(0, Number(payload.stock || 0)),
    par: Math.max(0, Number(payload.par || 0)),
    category: payload.category === "linen" ? "linen" : "guest",
    perCheckin: 0,
    setAmount: 0
  };
  apartment.items.push(item);
  addHistory("\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D \u0440\u0430\u0441\u0445\u043E\u0434\u043D\u0438\u043A", `${item.name}, ${roundSmart(item.stock)} ${item.unit}`, "create");
  return true;
}
function deleteItem(itemId) {
  const apartment = currentApartment();
  if (!apartment) return;
  const item = apartment.items.find((i) => i.id === itemId);
  apartment.items = apartment.items.filter((i) => i.id !== itemId);
  if (item) addHistory("\u0423\u0434\u0430\u043B\u0451\u043D \u0440\u0430\u0441\u0445\u043E\u0434\u043D\u0438\u043A", item.name, "delete");
}
function updateItemField(itemId, field, value) {
  const apartment = currentApartment();
  if (!apartment) return;
  const item = apartment.items.find((i) => i.id === itemId);
  if (!item) return;
  if (["stock", "par", "perCheckin", "setAmount"].includes(field)) item[field] = Math.max(0, Number(value || 0));
  if (field === "name" || field === "unit") item[field] = value;
}
function applyWriteoff(itemId, qty, mode) {
  const apartment = currentApartment();
  if (!apartment) return;
  const item = apartment.items.find((i) => i.id === itemId);
  if (!item) return;
  const amount = Math.max(0.1, Number(qty || 1));
  if (mode === "writeoff") {
    item.stock = Math.max(0, Number(item.stock) - amount);
    addHistory("\u0421\u043F\u0438\u0441\u0430\u043D\u0438\u0435", `${item.name}: -${roundSmart(amount)} ${item.unit}`, "writeoff");
    if (getState().autoRequest && item.category === "linen") {
      getState().purchaseRequests.unshift({
        id: crypto.randomUUID(),
        apartmentId: apartment.id,
        apartmentName: getDisplayApartmentName(apartment.name),
        auto: true,
        done: false,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        items: [{ itemId: item.id, name: item.name, unit: item.unit, qty: amount, cost: "" }]
      });
      addHistory("\u0410\u0432\u0442\u043E-\u0437\u0430\u044F\u0432\u043A\u0430 \u043D\u0430 \u0437\u0430\u043A\u0443\u043F\u043A\u0443", `${item.name}: ${roundSmart(amount)} ${item.unit}`, "auto");
    }
  } else {
    item.stock = Number(item.stock) + amount;
    addHistory("\u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435", `${item.name}: +${roundSmart(amount)} ${item.unit}`, "restock");
  }
}
function newCheckin() {
  const apartment = currentApartment();
  if (!apartment) return;
  apartment.items.forEach((item) => {
    if (item.category === "guest" && item.perCheckin > 0) {
      item.stock = Math.max(0, Number(item.stock) - Number(item.perCheckin));
    }
  });
  addHistory("\u041D\u043E\u0432\u044B\u0439 \u0437\u0430\u0435\u0437\u0434", "\u0410\u0432\u0442\u043E\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043E\u0434\u043D\u043E\u0440\u0430\u0437\u043E\u0432\u044B\u0445 \u0440\u0430\u0441\u0445\u043E\u0434\u043D\u0438\u043A\u043E\u0432", "checkin");
}
function restockDefaults() {
  const apartment = currentApartment();
  if (!apartment) return;
  apartment.items.forEach((item) => {
    item.stock = Math.max(item.stock, item.par);
  });
  addHistory("\u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0434\u043E \u043D\u043E\u0440\u043C\u044B", "", "restock");
}
function resetAll() {
  const apartment = currentApartment();
  if (!apartment) return;
  apartment.items.forEach((item) => {
    item.stock = item.par;
  });
  addHistory("\u0421\u0431\u0440\u043E\u0441 \u043E\u0441\u0442\u0430\u0442\u043A\u043E\u0432", "\u0412\u0441\u0435 \u043F\u043E\u0437\u0438\u0446\u0438\u0438 \u043F\u0440\u0438\u0432\u0435\u0434\u0435\u043D\u044B \u043A \u043D\u043E\u0440\u043C\u0435", "reset");
}
function toggleAutoRequest() {
  updateState((state2) => {
    state2.autoRequest = !state2.autoRequest;
  });
}
function createPurchaseRequest(apartmentId, items) {
  const apartment = getState().apartments.find((a) => a.id === apartmentId);
  if (!apartment) return false;
  const normalized = items.filter((i) => Number(i.qty) > 0).map((i) => ({ ...i, qty: Number(i.qty), cost: "" }));
  if (!normalized.length) return false;
  getState().purchaseRequests.unshift({
    id: crypto.randomUUID(),
    apartmentId,
    apartmentName: getDisplayApartmentName(apartment.name),
    auto: false,
    done: false,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    items: normalized
  });
  addHistory("\u0421\u043E\u0437\u0434\u0430\u043D\u0430 \u0437\u0430\u044F\u0432\u043A\u0430 \u043D\u0430 \u0437\u0430\u043A\u0443\u043F\u043A\u0443", `${normalized.length} \u043F\u043E\u0437.`, "request");
  return true;
}

// events.js
async function rerender(statusText = "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E") {
  ensureFinanceGeneratedForCurrentMonth();
  render();
  saveToBrowser(setStatus, true);
  setStatus(statusText);
}
function bindDrawers() {
  dom_default.openDrawerSidebar?.addEventListener("click", openDrawer);
  dom_default.closeDrawer?.addEventListener("click", closeDrawer);
  dom_default.drawerBackdrop?.addEventListener("click", closeDrawer);
}
function bindTheme() {
  dom_default.drawerThemeToggle?.addEventListener("click", async () => {
    updateState((state2) => {
      state2.ui.theme = state2.ui.theme === "dark" ? "light" : "dark";
    });
    await rerender("\u0422\u0435\u043C\u0430 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0430");
  });
}
function bindSectionNav() {
  dom_default.sidebarNavButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      updateState((state2) => {
        state2.ui.activeSection = button.dataset.section;
      });
      await rerender();
      closeDrawer();
    });
  });
  dom_default.financeDrawerButton?.addEventListener("click", async () => {
    ensureFinanceGeneratedForCurrentMonth();
    render();
    openModal("financeModal");
    closeDrawer();
  });
}
function bindDrawerModals() {
  byId("openHistoryModal")?.addEventListener("click", () => {
    renderHistoryModal();
    openModal("historyModal");
    closeDrawer();
  });
  byId("closeHistoryModal")?.addEventListener("click", () => closeModal("historyModal"));
  byId("openPurchaseRequestsModal")?.addEventListener("click", () => {
    renderPurchaseModal();
    openModal("purchaseRequestsModal");
    closeDrawer();
  });
  byId("closePurchaseRequestsModal")?.addEventListener("click", () => closeModal("purchaseRequestsModal"));
  byId("closeFinanceModal")?.addEventListener("click", () => closeModal("financeModal"));
  byId("financeModal")?.addEventListener("click", (e) => {
    if (e.target === byId("financeModal")) closeModal("financeModal");
  });
  byId("financeTabsNav")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-finance-tab]");
    if (!chip) return;
    const tab = chip.dataset.financeTab;
    ["entries", "recurring", "summary", "api"].forEach((t) => {
      const el = byId(`financeTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
      if (el) el.hidden = t !== tab;
    });
    document.querySelectorAll("#financeTabsNav [data-finance-tab]").forEach((b) => b.classList.toggle("active", b === chip));
  });
  byId("openKnowledgeBase")?.addEventListener("click", () => {
    openModal("kbModal");
    closeDrawer();
  });
  byId("kbClose")?.addEventListener("click", () => closeModal("kbModal"));
  byId("openGuestBotChats")?.addEventListener("click", () => {
    window.open("https://n8n.example.com", "_blank");
    closeDrawer();
  });
}
function renderHistoryModal() {
  const state2 = getState();
  const filter = state2.ui.historyFilterApartmentId || "all";
  if (!dom_default.historyApartmentFilter || !dom_default.historyModalList) return;
  dom_default.historyApartmentFilter.innerHTML = [
    `<button class="history-chip ${filter === "all" ? "active" : ""}" data-history-filter="all">\u0412\u0441\u0435</button>`,
    ...state2.apartments.map((a) => `<button class="history-chip ${filter === a.id ? "active" : ""}" data-history-filter="${a.id}">${getDisplayApartmentName(a.name)}</button>`)
  ].join("");
  const entries = filter === "all" ? state2.history : state2.history.filter((e) => e.apartmentId === filter);
  dom_default.historyModalList.innerHTML = entries.length ? entries.map((e) => `<div class="history-row"><div><strong>${e.action}</strong>${e.details ? `<div class="small">${e.details}</div>` : ""}</div><div class="small">${e.apartmentName ? `<span>${e.apartmentName}</span> \xB7 ` : ""}${new Date(e.createdAt).toLocaleString("ru-RU")}</div></div>`).join("") : '<div class="empty">\u041D\u0435\u0442 \u0437\u0430\u043F\u0438\u0441\u0435\u0439.</div>';
}
function bindHistory() {
  dom_default.historyApartmentFilter?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-history-filter]");
    if (!btn) return;
    updateState((s) => {
      s.ui.historyFilterApartmentId = btn.dataset.historyFilter;
    });
    renderHistoryModal();
  });
}
function bindApartmentSearch() {
  dom_default.apartmentSearch?.addEventListener("input", () => {
    updateState((s) => {
      s.ui.apartmentSearch = dom_default.apartmentSearch.value;
    });
    render();
  });
  dom_default.apartmentsList?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-apartment-id]");
    if (!btn) return;
    updateState((s) => {
      s.activeApartmentId = btn.dataset.apartmentId;
    });
    await rerender("\u041A\u0432\u0430\u0440\u0442\u0438\u0440\u0430 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0430");
  });
}
function bindApartmentParams() {
  byId("addApartment")?.addEventListener("click", async () => {
    addApartment();
    await rerender("\u041A\u0432\u0430\u0440\u0442\u0438\u0440\u0430 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0430");
  });
  dom_default.apartmentName?.addEventListener("input", () => {
    renameCurrentApartment(dom_default.apartmentName.value);
    render();
  });
  dom_default.apartmentName?.addEventListener("change", async () => {
    await rerender("\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E");
  });
  byId("addCustomItem")?.addEventListener("click", async () => {
    const ok = addCustomItem({
      name: byId("newItemName")?.value || "",
      unit: byId("newItemUnit")?.value || "\u0448\u0442",
      category: byId("newItemCategory")?.value || "guest",
      stock: byId("newItemStock")?.value || 0,
      par: byId("newItemPar")?.value || 0
    });
    if (ok) {
      ["newItemName", "newItemStock", "newItemPar"].forEach((id) => {
        const el = byId(id);
        if (el) el.value = id === "newItemName" ? "" : "0";
      });
      await rerender("\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0430");
    }
  });
}
function bindQuickActions() {
  byId("newCheckin")?.addEventListener("click", async () => {
    newCheckin();
    await rerender("\u041D\u043E\u0432\u044B\u0439 \u0437\u0430\u0435\u0437\u0434 \u0437\u0430\u0444\u0438\u043A\u0441\u0438\u0440\u043E\u0432\u0430\u043D");
  });
  byId("restockDefaults")?.addEventListener("click", async () => {
    restockDefaults();
    await rerender("\u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u043E \u0434\u043E \u043D\u043E\u0440\u043C\u044B");
  });
  byId("resetAll")?.addEventListener("click", async () => {
    if (confirm("\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u0432\u0441\u0435 \u043E\u0441\u0442\u0430\u0442\u043A\u0438 \u043A \u043D\u043E\u0440\u043C\u0435? \u042D\u0442\u043E \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u043D\u0435\u043B\u044C\u0437\u044F \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C.")) {
      resetAll();
      await rerender("\u041E\u0441\u0442\u0430\u0442\u043A\u0438 \u0441\u0431\u0440\u043E\u0448\u0435\u043D\u044B");
    }
  });
  byId("openSettings")?.addEventListener("click", () => {
    renderSettingsModal();
    openModal("settingsModal");
  });
  byId("closeSettings")?.addEventListener("click", () => closeModal("settingsModal"));
}
function renderSettingsModal() {
  const apartment = currentApartment();
  if (!apartment || !dom_default.deductionSettings || !dom_default.setSettings) return;
  const guestItems = apartment.items.filter((i) => i.category === "guest");
  const linenItems = apartment.items.filter((i) => i.category === "linen");
  dom_default.deductionSettings.innerHTML = guestItems.length ? guestItems.map((item) => `<label><span class="small">${item.name}</span><input type="number" min="0" step="0.1" value="${item.perCheckin}" data-setting-item="${item.id}" data-setting-field="perCheckin" /></label>`).join("") : '<div class="empty">\u041D\u0435\u0442 \u043E\u0434\u043D\u043E\u0440\u0430\u0437\u043E\u0432\u044B\u0445 \u043F\u043E\u0437\u0438\u0446\u0438\u0439.</div>';
  dom_default.setSettings.innerHTML = linenItems.length ? linenItems.map((item) => `<label><span class="small">${item.name}</span><input type="number" min="0" step="0.1" value="${item.setAmount}" data-setting-item="${item.id}" data-setting-field="setAmount" /></label>`).join("") : '<div class="empty">\u041D\u0435\u0442 \u043F\u043E\u0437\u0438\u0446\u0438\u0439.</div>';
}
function bindSettings() {
  [dom_default.deductionSettings, dom_default.setSettings].forEach((container) => {
    container?.addEventListener("input", async (e) => {
      const input = e.target.closest("[data-setting-item]");
      if (!input) return;
      updateItemField(input.dataset.settingItem, input.dataset.settingField, input.value);
      await rerender("\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u044B");
    });
  });
}
var writeoffContext = null;
function bindItemCards() {
  document.addEventListener("click", (e) => {
    const wo = e.target.closest('[data-action="open-writeoff"]');
    if (wo) {
      writeoffContext = { itemId: wo.dataset.id, mode: "writeoff", isLinen: wo.dataset.category === "linen", name: wo.dataset.name, unit: wo.dataset.unit };
      byId("writeoffModalTitle").textContent = "\u0421\u043F\u0438\u0441\u0430\u0442\u044C";
      byId("writeoffModalSub").textContent = wo.dataset.name;
      byId("writeoffModalLabel").textContent = `\u0421\u043A\u043E\u043B\u044C\u043A\u043E \u0441\u043F\u0438\u0441\u0430\u0442\u044C (${wo.dataset.unit})`;
      byId("writeoffModalQty").value = "1";
      openModal("writeoffModal");
      setTimeout(() => byId("writeoffModalQty")?.select(), 80);
      return;
    }
    const rs = e.target.closest('[data-action="open-restock"]');
    if (rs) {
      writeoffContext = { itemId: rs.dataset.id, mode: "restock", isLinen: false, name: rs.dataset.name, unit: rs.dataset.unit };
      byId("writeoffModalTitle").textContent = "\u041F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u044C";
      byId("writeoffModalSub").textContent = rs.dataset.name;
      byId("writeoffModalLabel").textContent = `\u0421\u043A\u043E\u043B\u044C\u043A\u043E \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C (${rs.dataset.unit})`;
      byId("writeoffModalQty").value = "1";
      openModal("writeoffModal");
      setTimeout(() => byId("writeoffModalQty")?.select(), 80);
      return;
    }
    const del = e.target.closest("[data-delete-item]");
    if (del && confirm(`\u0423\u0434\u0430\u043B\u0438\u0442\u044C \xAB${del.dataset.deleteItem}\xBB?`)) {
      deleteItem(del.dataset.deleteItem);
      rerender("\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u0443\u0434\u0430\u043B\u0435\u043D\u0430");
      return;
    }
    const delApt = e.target.closest("[data-delete-apartment]");
    if (delApt) {
      updateState((s) => {
        s._pendingDeleteId = delApt.dataset.deleteApartment;
      });
      byId("confirmDeleteText").textContent = `\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043A\u0432\u0430\u0440\u0442\u0438\u0440\u0443 \xAB${getDisplayApartmentName(delApt.dataset.deleteApartmentName)}\xBB? \u042D\u0442\u043E \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u043D\u0435\u043B\u044C\u0437\u044F \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C.`;
      openModal("confirmDeleteModal");
      return;
    }
    const doneBtn = e.target.closest("[data-done-request]");
    if (doneBtn) {
      const req = getState().purchaseRequests.find((r) => r.id === doneBtn.dataset.doneRequest);
      if (!req) return;
      if (req.done) {
        req.done = false;
        req.pendingCost = false;
        req.items.forEach((i) => delete i.cost);
      } else {
        req.pendingCost = true;
      }
      renderPurchaseModal();
      saveToBrowser(setStatus, true);
      return;
    }
    const cancelCost = e.target.closest("[data-cancel-cost]");
    if (cancelCost) {
      const req = getState().purchaseRequests.find((r) => r.id === cancelCost.dataset.cancelCost);
      if (req) {
        req.pendingCost = false;
        req.items.forEach((i) => delete i.cost);
        renderPurchaseModal();
        saveToBrowser(setStatus, true);
      }
      return;
    }
    const confirmCost = e.target.closest("[data-confirm-cost]");
    if (confirmCost) {
      const req = getState().purchaseRequests.find((r) => r.id === confirmCost.dataset.confirmCost);
      if (!req) return;
      const inputs = document.querySelectorAll(`[data-cost-item="${req.id}"]`);
      let allFilled = true;
      inputs.forEach((input) => {
        const val = parseFloat(input.value);
        if (isNaN(val) || val < 0) {
          allFilled = false;
          input.style.borderColor = "var(--color-error)";
          return;
        }
        input.style.borderColor = "";
        const item = req.items.find((i) => (i.itemId || i.name) === input.dataset.costItemId);
        if (item) item.cost = val;
      });
      if (!allFilled) return;
      req.done = true;
      req.pendingCost = false;
      renderPurchaseModal();
      saveToBrowser(setStatus, true);
      return;
    }
    const kbBtn = e.target.closest("[data-kb-target]");
    if (kbBtn) {
      document.querySelectorAll(".kb-section").forEach((s) => s.classList.remove("active"));
      document.querySelectorAll("[data-kb-target]").forEach((b) => b.classList.remove("active"));
      const target = byId(kbBtn.dataset.kbTarget);
      if (target) target.classList.add("active");
      kbBtn.classList.add("active");
      return;
    }
  });
}
function bindWriteoffModal() {
  byId("writeoffModalClose")?.addEventListener("click", () => closeModal("writeoffModal"));
  byId("writeoffModalCancel")?.addEventListener("click", () => closeModal("writeoffModal"));
  byId("writeoffModal")?.addEventListener("click", (e) => {
    if (e.target === byId("writeoffModal")) closeModal("writeoffModal");
  });
  byId("writeoffModalConfirm")?.addEventListener("click", async () => {
    if (!writeoffContext) return;
    const qty = Math.max(0.1, Number(byId("writeoffModalQty")?.value) || 1);
    applyWriteoff(writeoffContext.itemId, qty, writeoffContext.mode);
    closeModal("writeoffModal");
    writeoffContext = null;
    await rerender(writeoffContext?.mode === "restock" ? "\u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u043E" : "\u0421\u043F\u0438\u0441\u0430\u043D\u043E");
  });
  byId("writeoffModalQty")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") byId("writeoffModalConfirm")?.click();
  });
}
function bindDeleteApartment() {
  byId("cancelDeleteApartment")?.addEventListener("click", () => closeModal("confirmDeleteModal"));
  byId("confirmDeleteApartment")?.addEventListener("click", async () => {
    const id = getState()._pendingDeleteId;
    if (id) {
      deleteApartment(id);
      updateState((s) => {
        delete s._pendingDeleteId;
      });
    }
    closeModal("confirmDeleteModal");
    await rerender("\u041A\u0432\u0430\u0440\u0442\u0438\u0440\u0430 \u0443\u0434\u0430\u043B\u0435\u043D\u0430");
  });
}
function bindJsonIo() {
  byId("exportJsonBtn")?.addEventListener("click", () => {
    exportJson();
    setStatus("JSON \u044D\u043A\u0441\u043F\u043E\u0440\u0442\u0438\u0440\u043E\u0432\u0430\u043D");
  });
  byId("importJsonBtn")?.addEventListener("click", () => byId("importJsonInput")?.click());
  byId("importJsonInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importJson(file);
      await rerender("\u0414\u0430\u043D\u043D\u044B\u0435 \u0438\u043C\u043F\u043E\u0440\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u044B");
    } catch (err) {
      setStatus(`\u041E\u0448\u0438\u0431\u043A\u0430 \u0438\u043C\u043F\u043E\u0440\u0442\u0430: ${err.message}`);
    }
    e.target.value = "";
  });
}
function bindAutoRequest() {
  document.addEventListener("click", (e) => {
    if (e.target.closest("#autoRequestToggle")) {
      toggleAutoRequest();
      const on = getState().autoRequest;
      const btn = byId("autoRequestToggle");
      const lbl = byId("autoRequestLabel");
      btn?.classList.toggle("active", on);
      if (lbl) lbl.textContent = on ? "\u0412\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u2014 \u0430\u0432\u0442\u043E-\u0437\u0430\u044F\u0432\u043A\u0430 \u043F\u0440\u0438 \u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0438 \u043D\u0435 \u043E\u0434\u043D\u043E\u0440\u0430\u0437\u043E\u0432\u044B\u0445" : "\u0422\u043E\u043B\u044C\u043A\u043E \u043D\u0435 \u043E\u0434\u043D\u043E\u0440\u0430\u0437\u043E\u0432\u044B\u0435 \u0440\u0430\u0441\u0445\u043E\u0434\u043D\u0438\u043A\u0438";
      saveToBrowser(setStatus, true);
    }
  });
}
function renderPurchaseModal() {
  const state2 = getState();
  if (!dom_default.purchaseRequestsList) return;
  const on = state2.autoRequest;
  byId("autoRequestToggle")?.classList.toggle("active", on);
  const lbl = byId("autoRequestLabel");
  if (lbl) lbl.textContent = on ? "\u0412\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u2014 \u0430\u0432\u0442\u043E-\u0437\u0430\u044F\u0432\u043A\u0430 \u043F\u0440\u0438 \u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0438 \u043D\u0435 \u043E\u0434\u043D\u043E\u0440\u0430\u0437\u043E\u0432\u044B\u0445" : "\u0422\u043E\u043B\u044C\u043A\u043E \u043D\u0435 \u043E\u0434\u043D\u043E\u0440\u0430\u0437\u043E\u0432\u044B\u0435 \u0440\u0430\u0441\u0445\u043E\u0434\u043D\u0438\u043A\u0438";
  dom_default.purchaseRequestsList.innerHTML = state2.purchaseRequests.length ? state2.purchaseRequests.map(purchaseRequestCard).join("") : '<div class="empty">\u041D\u0435\u0442 \u0437\u0430\u044F\u0432\u043E\u043A.</div>';
}
function purchaseRequestCard(request) {
  const done = request.done === true;
  const pending = request.pendingCost === true;
  const badgeStyle = done ? "background:color-mix(in oklab,var(--color-success) 15%,transparent);color:var(--color-success)" : "background:color-mix(in oklab,var(--color-error) 15%,transparent);color:var(--color-error)";
  const itemsList = request.items.map((item) => {
    if (done) {
      const costStr = item.cost != null && item.cost !== "" ? `${item.cost} \u20BD` : "\u2014";
      return `<div class="line"><div><strong>${item.name}</strong><div class="small">${roundSmart(item.qty)} ${item.unit}</div></div><strong style="color:var(--color-success)">${costStr}</strong></div>`;
    }
    if (pending) {
      return `<div class="line" style="gap:.6rem;align-items:center">
        <div style="flex:1"><strong>${item.name}</strong><div class="small">${roundSmart(item.qty)} ${item.unit}</div></div>
        <div style="display:flex;align-items:center;gap:.4rem;flex-shrink:0">
          <input type="number" min="0" step="1" placeholder="\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C" value="${item.cost || ""}"
            style="width:110px;padding:.35rem .5rem;font-size:var(--text-sm);border:1px solid color-mix(in oklab,var(--color-text) 18%,transparent);border-radius:var(--radius-md);background:var(--color-surface);color:var(--color-text)"
            data-cost-item="${request.id}" data-cost-item-id="${item.itemId || item.name}" />
          <span class="small">\u20BD</span>
        </div>
      </div>`;
    }
    return `<div class="line"><div><strong>${item.name}</strong><div class="small">\u041A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E</div></div><strong>${roundSmart(item.qty)} ${item.unit}</strong></div>`;
  }).join("");
  const totalBlock = done ? (() => {
    const total = request.items.reduce((s, i) => s + (Number(i.cost) || 0), 0);
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:.6rem;padding-top:.6rem;border-top:1px solid color-mix(in oklab,var(--color-text) 8%,transparent)"><span class="small">\u0418\u0442\u043E\u0433\u043E</span><strong style="color:var(--color-success)">${total} \u20BD</strong></div>`;
  })() : "";
  let actionBlock;
  if (done) {
    actionBlock = `<button class="btn" style="width:100%;min-height:40px;background:color-mix(in oklab,var(--color-success) 12%,var(--color-surface));border:1px solid color-mix(in oklab,var(--color-success) 30%,transparent);color:var(--color-success);font-weight:700" data-done-request="${request.id}">\u2713 \u0417\u0430\u043A\u0430\u0437 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D</button>`;
  } else if (pending) {
    actionBlock = `<div style="display:flex;gap:.6rem;margin-top:.75rem">
      <button class="btn btn-secondary" style="flex:1" data-cancel-cost="${request.id}">\u041E\u0442\u043C\u0435\u043D\u0430</button>
      <button class="btn btn-primary" style="flex:1;display:flex;align-items:center;justify-content:center;gap:.5rem" data-confirm-cost="${request.id}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
        \u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C
      </button>
    </div>`;
  } else {
    actionBlock = `<button class="btn" style="width:100%;min-height:40px;background:var(--color-surface);border:1px solid color-mix(in oklab,var(--color-text) 10%,transparent);font-weight:700" data-done-request="${request.id}">\u0417\u0430\u043A\u0430\u0437 \u0441\u0434\u0435\u043B\u0430\u043D</button>`;
  }
  return `<article class="request-card">
    <div class="request-card-header">
      <div><div class="request-kind" style="${badgeStyle}">${done ? "\u2713 \u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E" : pending ? "\u0412\u0432\u043E\u0434 \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u0438" : "\u0417\u0430\u044F\u0432\u043A\u0430"}</div><strong style="display:block;margin-top:.45rem">${getDisplayApartmentName(request.apartmentName)}</strong></div>
      <span class="small">${new Date(request.createdAt).toLocaleString("ru-RU")}</span>
    </div>
    <div class="small" style="margin-bottom:.5rem">\u041F\u043E\u0437\u0438\u0446\u0438\u0439: ${request.items.length}</div>
    <div class="list">${itemsList}</div>
    ${totalBlock}
    <div style="margin-top:.75rem">${actionBlock}</div>
  </article>`;
}
function bindPurchaseModal() {
  byId("openNewPurchaseRequest")?.addEventListener("click", () => {
    renderNewPurchaseForm();
    openModal("newPurchaseRequestModal");
  });
  byId("closeNewPurchaseRequestModal")?.addEventListener("click", () => closeModal("newPurchaseRequestModal"));
  byId("cancelNewPurchaseRequest")?.addEventListener("click", () => closeModal("newPurchaseRequestModal"));
  dom_default.purchaseApartmentSelect?.addEventListener("change", () => renderNewPurchaseItems());
  byId("saveNewPurchaseRequest")?.addEventListener("click", async () => {
    const apartmentId = dom_default.purchaseApartmentSelect?.value;
    const checkboxes = document.querySelectorAll(".purchase-item-check:checked");
    const items = [...checkboxes].map((cb) => {
      const qtyInput = document.querySelector(`[data-purchase-qty="${cb.dataset.itemId}"]`);
      return { itemId: cb.dataset.itemId, name: cb.dataset.itemName, unit: cb.dataset.itemUnit, qty: Number(qtyInput?.value || 1) };
    });
    if (createPurchaseRequest(apartmentId, items)) {
      closeModal("newPurchaseRequestModal");
      renderPurchaseModal();
      await rerender("\u0417\u0430\u044F\u0432\u043A\u0430 \u0441\u043E\u0437\u0434\u0430\u043D\u0430");
    }
  });
}
function renderNewPurchaseForm() {
  const state2 = getState();
  if (!dom_default.purchaseApartmentSelect) return;
  dom_default.purchaseApartmentSelect.innerHTML = state2.apartments.map((a) => `<option value="${a.id}">${getDisplayApartmentName(a.name)}</option>`).join("");
  renderNewPurchaseItems();
}
function renderNewPurchaseItems() {
  const apartmentId = dom_default.purchaseApartmentSelect?.value;
  const state2 = getState();
  const apartment = state2.apartments.find((a) => a.id === apartmentId);
  if (!dom_default.purchaseItemsWrap) return;
  if (!apartment) {
    dom_default.purchaseItemsWrap.innerHTML = '<div class="empty">\u0412\u044B\u0431\u0435\u0440\u0438 \u043A\u0432\u0430\u0440\u0442\u0438\u0440\u0443.</div>';
    return;
  }
  dom_default.purchaseItemsWrap.innerHTML = apartment.items.map((item) => {
    const needed = Math.max(0, item.par - item.stock);
    return `<div class="line purchase-item-row">
      <label style="display:flex;align-items:center;gap:.6rem;flex:1;cursor:pointer">
        <input type="checkbox" class="purchase-item-check" data-item-id="${item.id}" data-item-name="${item.name}" data-item-unit="${item.unit}" ${needed > 0 ? "checked" : ""} />
        <span><strong>${item.name}</strong><span class="small"> \xB7 \u041E\u0441\u0442\u0430\u0442\u043E\u043A: ${roundSmart(item.stock)} / ${roundSmart(item.par)} ${item.unit}</span></span>
      </label>
      <input type="number" min="0.1" step="0.1" value="${needed > 0 ? roundSmart(needed) : 1}" data-purchase-qty="${item.id}" style="width:80px" />
    </div>`;
  }).join("");
}
function bindFinanceFilters() {
  const updateFilters = async () => {
    updateState((state2) => {
      state2.ui.finance.apartmentFilter = dom_default.financeApartmentFilter?.value || "all";
      state2.ui.finance.typeFilter = dom_default.financeTypeFilter?.value || "all";
      state2.ui.finance.month = dom_default.financeMonthFilter?.value || monthKey(/* @__PURE__ */ new Date());
      state2.ui.finance.showOnlyPending = dom_default.financeOnlyPending?.checked || false;
    });
    await rerender("\u0424\u0438\u043B\u044C\u0442\u0440\u044B \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u044B");
  };
  [dom_default.financeApartmentFilter, dom_default.financeTypeFilter, dom_default.financeMonthFilter].forEach((el) => el?.addEventListener("input", updateFilters));
  dom_default.financeOnlyPending?.addEventListener("change", updateFilters);
}
function bindFinanceModals() {
  dom_default.financeAddEntryBtn?.addEventListener("click", () => {
    if (dom_default.financeEntryApartment) dom_default.financeEntryApartment.value = currentApartment()?.id || "";
    if (dom_default.financeEntryType) dom_default.financeEntryType.value = "expense";
    if (dom_default.financeEntryDate) dom_default.financeEntryDate.value = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    if (dom_default.financeEntryTitle) dom_default.financeEntryTitle.value = "";
    if (dom_default.financeEntryCategory) dom_default.financeEntryCategory.value = "";
    if (dom_default.financeEntryAmount) dom_default.financeEntryAmount.value = "";
    if (dom_default.financeEntryNotes) dom_default.financeEntryNotes.value = "";
    openModal("financeEntryModal");
  });
  dom_default.cancelFinanceEntry?.addEventListener("click", () => closeModal("financeEntryModal"));
  document.getElementById("cancelFinanceEntry2")?.addEventListener("click", () => closeModal("financeEntryModal"));
  dom_default.saveFinanceEntry?.addEventListener("click", async () => {
    const amount = Number(dom_default.financeEntryAmount?.value || 0);
    if (!amount) {
      setStatus("\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0441\u0443\u043C\u043C\u0443");
      return;
    }
    addFinanceEntry({
      apartmentId: dom_default.financeEntryApartment?.value,
      type: dom_default.financeEntryType?.value,
      category: dom_default.financeEntryCategory?.value,
      title: dom_default.financeEntryTitle?.value,
      amount,
      date: dom_default.financeEntryDate?.value,
      notes: dom_default.financeEntryNotes?.value,
      source: "manual",
      status: dom_default.financeEntryType?.value === "income" ? "confirmed" : "planned"
    });
    closeModal("financeEntryModal");
    await rerender("\u0417\u0430\u043F\u0438\u0441\u044C \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0430");
  });
  dom_default.financeAddRecurringBtn?.addEventListener("click", () => {
    if (dom_default.recurringApartment) dom_default.recurringApartment.value = currentApartment()?.id || "";
    if (dom_default.recurringTitle) dom_default.recurringTitle.value = "";
    if (dom_default.recurringCategory) dom_default.recurringCategory.value = "";
    if (dom_default.recurringAmount) dom_default.recurringAmount.value = "";
    if (dom_default.recurringDayOfMonth) dom_default.recurringDayOfMonth.value = "1";
    if (dom_default.recurringStartDate) dom_default.recurringStartDate.value = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    if (dom_default.recurringEndDate) dom_default.recurringEndDate.value = "";
    if (dom_default.recurringNotes) dom_default.recurringNotes.value = "";
    openModal("recurringExpenseModal");
  });
  dom_default.cancelRecurringExpense?.addEventListener("click", () => closeModal("recurringExpenseModal"));
  document.getElementById("cancelRecurringExpense2")?.addEventListener("click", () => closeModal("recurringExpenseModal"));
  dom_default.saveRecurringExpense?.addEventListener("click", async () => {
    const amount = Number(dom_default.recurringAmount?.value || 0);
    if (!amount) {
      setStatus("\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0441\u0443\u043C\u043C\u0443");
      return;
    }
    if (!dom_default.recurringTitle?.value) {
      setStatus("\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435");
      return;
    }
    addRecurringRule({
      apartmentId: dom_default.recurringApartment?.value,
      title: dom_default.recurringTitle?.value,
      category: dom_default.recurringCategory?.value,
      amount,
      dayOfMonth: Number(dom_default.recurringDayOfMonth?.value || 1),
      startDate: dom_default.recurringStartDate?.value,
      endDate: dom_default.recurringEndDate?.value,
      notes: dom_default.recurringNotes?.value,
      type: dom_default.recurringType?.value || "expense"
    });
    closeModal("recurringExpenseModal");
    await rerender("\u0420\u0435\u0433\u0443\u043B\u044F\u0440\u043D\u043E\u0435 \u043F\u0440\u0430\u0432\u0438\u043B\u043E \u0441\u043E\u0437\u0434\u0430\u043D\u043E");
  });
  dom_default.financeOpenWebhookHelpBtn?.addEventListener("click", () => openModal("financeWebhookModal"));
  dom_default.closeFinanceWebhookModal?.addEventListener("click", () => closeModal("financeWebhookModal"));
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "delete-entry") {
      const id = btn.dataset.id;
      if (!id) return;
      deleteFinanceEntry(id);
      await rerender("\u0417\u0430\u043F\u0438\u0441\u044C \u0443\u0434\u0430\u043B\u0435\u043D\u0430");
    }
    if (action === "confirm-entry") {
      const id = btn.dataset.id;
      if (!id) return;
      updateFinanceEntryStatus(id, "confirmed");
      await rerender("\u0421\u0442\u0430\u0442\u0443\u0441 \u043E\u0431\u043D\u043E\u0432\u043B\u0451\u043D");
    }
    if (action === "delete-recurring") {
      const id = btn.dataset.id;
      if (!id) return;
      deleteRecurringRule(id);
      await rerender("\u041F\u0440\u0430\u0432\u0438\u043B\u043E \u0443\u0434\u0430\u043B\u0435\u043D\u043E");
    }
    if (action === "toggle-recurring") {
      const id = btn.dataset.id;
      if (!id) return;
      toggleRecurringRule(id);
      await rerender("\u041F\u0440\u0430\u0432\u0438\u043B\u043E \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u043E");
    }
  });
}
function bindRealtyCalendarSync() {
  dom_default.financePullBookingsBtn?.addEventListener("click", async () => {
    try {
      setStatus("\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F...");
      const data = await syncRealtyCalendarBookings();
      const bookings = Array.isArray(data?.bookings) ? data.bookings.map(normalizeRealtyCalendarBooking) : [];
      const added = importBookingsToFinance(bookings);
      await rerender(added.length ? `\u0418\u043C\u043F\u043E\u0440\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u043E \u0431\u0440\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0439: ${added.length}` : "\u041D\u043E\u0432\u044B\u0445 \u0431\u0440\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0439 \u043D\u0435\u0442");
    } catch (err) {
      setStatus(`\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u0438: ${err.message}`);
    }
  });
}
function bindAccordions() {
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-toggle-target]");
    if (!trigger) return;
    const targetId = trigger.dataset.toggleTarget;
    const body = byId(targetId);
    if (!body) return;
    const isOpen = body.classList.contains("open");
    body.classList.toggle("open", !isOpen);
    trigger.setAttribute("aria-expanded", String(!isOpen));
    const chevron = trigger.querySelector(".accordion-chevron");
    chevron?.classList.toggle("open", !isOpen);
  });
}
function bindEvents() {
  bindDrawers();
  bindTheme();
  bindSectionNav();
  bindDrawerModals();
  bindHistory();
  bindApartmentSearch();
  bindApartmentParams();
  bindQuickActions();
  bindSettings();
  bindItemCards();
  bindWriteoffModal();
  bindDeleteApartment();
  bindJsonIo();
  bindAutoRequest();
  bindPurchaseModal();
  bindFinanceFilters();
  bindFinanceModals();
  bindRealtyCalendarSync();
  bindAccordions();
  updateState((state2) => {
    if (!state2.ui.finance.month) state2.ui.finance.month = monthKey(/* @__PURE__ */ new Date());
  });
}

// app.js
async function init() {
  if (!await loadFromBrowser(setStatus)) {
    setState(createDefaultState());
    await saveToBrowser(setStatus, true);
  } else {
    setState(ensureStateShape(getState()));
  }
  ensureFinanceGeneratedForCurrentMonth();
  bindEvents();
  render();
}
init();
