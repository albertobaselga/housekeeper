import {
  agreementVersions,
  calendarEvents,
  contacts,
  docGaps,
  getSearchCorpus,
  profiles,
  recipes,
  routines,
  settlementLines,
  weekMenu,
  wikiPages,
} from "./data.js";
import {
  ROLE_LABELS,
  calculateSettlement,
  canAccess,
  escapeHtml,
  formatCurrency,
  groupBy,
  paymentSummary,
  scaleIngredients,
  searchItems,
} from "./logic.js";
import { listQueuedOperations, queueOperation, saveCriticalSnapshot } from "./offline.js";
import { listDemoAccounts, loginDemoUser, logoutDemoUser, restoreDemoSession } from "./auth.js";

const STORAGE_KEY = "casa-clara-demo-v1";
const defaultState = {
  role: "family_admin",
  activeEmploymentTab: "summary",
  selectedMenuDay: 3,
  menuGroup: "all",
  routineDone: ["routine-sheets"],
  weeklyConfirmed: false,
  weeklyFamilyConfirmed: false,
  payments: [],
  employeeConfirmedAt: null,
  settlementStatus: "closed",
  pendingExtra: { date: "2025-04-06", startTime: "08:00", quantity: "full", note: "La familia volvió tarde del viaje", registeredBy: "Ana" },
  extraResolution: null,
  extraEvents: [],
  agreementChanges: [],
  shoppingDone: [],
  searchQuery: "",
  wikiSpace: "Todos",
  wikiEdits: {},
  customWikiPages: [],
  customContacts: [],
  menuEdits: {},
  expenses: [],
  outbox: [],
  loggedGaps: [],
  duplicatedWeek: false,
  storageWarning: false,
};

let state = loadState();
let authenticatedUser = null;
let applicationStarted = false;
let sessionExpiryTimer = null;
let offlineSession = false;
let lastFocusedElement = null;
let lastPopoverTrigger = null;
let toastTimer = null;

const main = document.querySelector("#main-content");
const modalLayer = document.querySelector("#modal-layer");
const popoverLayer = document.querySelector("#popover-layer");
const toastRegion = document.querySelector("#toast-region");
const authGate = document.querySelector("#auth-gate");
const appShell = document.querySelector(".app-shell");
const bottomNavigation = document.querySelector(".bottom-nav");
const mobileSearchButton = document.querySelector("#mobile-search-fab");
const skipLink = document.querySelector(".skip-link");

const iconPaths = {
  sun: '<circle cx="12" cy="12" r="3.7"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  wallet: '<path d="M4 6.5h14a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h12v4"/><path d="M15 11h7v4h-7a2 2 0 0 1 0-4Z"/>',
  utensils: '<path d="M7 2v8M4 2v5a3 3 0 0 0 6 0V2M7 10v12M16 2c3 2 4 5 4 9h-4V2Zm0 9v11"/>',
  book: '<path d="M4 4.5A3.5 3.5 0 0 1 7.5 1H11v18H7.5A3.5 3.5 0 0 0 4 22.5v-18ZM20 4.5A3.5 3.5 0 0 0 16.5 1H13v18h3.5a3.5 3.5 0 0 1 3.5 3.5v-18Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
  phone: '<path d="M7.2 3.5 9 7.6 6.7 9a15.1 15.1 0 0 0 8.3 8.3l1.4-2.3 4.1 1.8-.2 3a2 2 0 0 1-2 1.8C9.5 21 3 14.5 2.4 5.7a2 2 0 0 1 1.8-2l3-.2Z"/>',
  shield: '<path d="M12 2 20 5v6c0 5.2-3.4 9-8 11-4.6-2-8-5.8-8-11V5l8-3Z"/><path d="M9 12h6M12 9v6"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
  arrowLeft: '<path d="M19 12H5M10 7l-5 5 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  alert: '<path d="M10.3 3.5 2.2 18a2 2 0 0 0 1.8 3h16a2 2 0 0 0 1.8-3L13.7 3.5a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2Z"/><path d="M9 7h6M9 11h6M9 15h3"/>',
  camera: '<path d="M4 7h3l1.5-2h7L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/>',
  school: '<path d="m3 9 9-5 9 5-9 5-9-5Z"/><path d="M6 11.5V17c3.5 2.5 8.5 2.5 12 0v-5.5M21 9v7"/>',
  swim: '<path d="M2 16c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2M2 20c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2M9 14l3-6 4 2M13 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>',
  tools: '<path d="m14 6 4-4 4 4-4 4M14 6 3 17a2.1 2.1 0 0 0 3 3l11-11M4 4l5 5"/>',
  washer: '<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="14" r="5"/><path d="M7 6h.01M11 6h5"/>',
  stove: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="9" r="2.5"/><circle cx="16" cy="9" r="2.5"/><path d="M6 17h12"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z"/>',
  flame: '<path d="M12 22c4 0 7-3 7-7 0-3-1.5-5.5-4-8 .1 2-1 3.3-2 4-1-4-3-6-3-9-3 2.5-5 6.5-5 10.5C5 18 8 22 12 22Z"/><path d="M9 18c0-2 1-3 3-5 0 2 2 2.5 2 4a2.5 2.5 0 0 1-5 1Z"/>',
  moon: '<path d="M21 14.5A9 9 0 0 1 9.5 3 9 9 0 1 0 21 14.5Z"/>',
  room: '<path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M15 12h.01"/>',
  pin: '<path d="m15 4 5 5-3 1-4 4 1 4-1 1-4-4-4 4M4 20l5-5"/>',
  leaf: '<path d="M20 3C10 3 4 8 4 15c0 3 2 5 5 5 7 0 11-7 11-17Z"/><path d="M5 19c3-5 7-8 12-11"/>',
  breakfast: '<path d="M4 10h13v3a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6v-3ZM17 12h2a2 2 0 0 1 0 4h-3M3 22h16M8 6c-1-1-1-2 0-3M13 6c-1-1-1-2 0-3"/>',
  food: '<path d="M5 3h14l-1 17H6L5 3ZM8 7h8M9 11h6"/>',
  child: '<circle cx="12" cy="7" r="4"/><path d="M5 22a7 7 0 0 1 14 0M9 14l3 3 3-3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  edit: '<path d="m14 4 6 6L8 22H2v-6L14 4ZM12 6l6 6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6ZM9 3v15M15 6v15"/>',
  medical: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z"/>',
  home: '<path d="m3 11 9-8 9 8v10h-6v-6H9v6H3V11Z"/>',
  car: '<path d="m5 11 2-5h10l2 5M3 11h18v7H3v-7ZM6 18v3M18 18v3M7 14h.01M17 14h.01"/>',
  offline: '<path d="M3 3l18 18M8.5 8.5A7.5 7.5 0 0 1 20 10M4 10a11.5 11.5 0 0 1 1.5-2.5M7 14a7.5 7.5 0 0 1 6.5-1.5M10 18a3.5 3.5 0 0 1 4 0"/>',
  rotate: '<path d="M20 7v5h-5M4 17v-5h5M18.5 9A7 7 0 0 0 6.3 6.3L4 8M5.5 15A7 7 0 0 0 17.7 17.7L20 16"/>',
  cart: '<path d="M3 3h2l2.5 12h10L21 7H6M9 21h.01M18 21h.01"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
};

function icon(name, className = "") {
  const body = iconPaths[name] || iconPaths.info;
  return `<span class="nav-icon ${className}" data-icon="${name}"><svg aria-hidden="true" viewBox="0 0 24 24">${body}</svg></span>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]:not([data-hydrated])").forEach((node) => {
    const name = node.dataset.icon;
    node.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24">${iconPaths[name] || iconPaths.info}</svg>`;
    node.dataset.hydrated = "true";
  });
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const candidate = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    const normalized = { ...defaultState, ...candidate };
    ["routineDone", "payments", "extraEvents", "agreementChanges", "shoppingDone", "customWikiPages", "customContacts", "expenses", "outbox", "loggedGaps"].forEach((key) => {
      if (!Array.isArray(normalized[key])) normalized[key] = [...defaultState[key]];
    });
    ["wikiEdits", "menuEdits"].forEach((key) => {
      if (!normalized[key] || typeof normalized[key] !== "object" || Array.isArray(normalized[key])) normalized[key] = { ...defaultState[key] };
    });
    return normalized;
  } catch {
    return { ...defaultState };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    state.storageWarning = true;
  }
  updateSyncState();
}

function enqueueOffline(operation) {
  if (!state.outbox.some((item) => item.id === operation.id)) state.outbox.push(operation);
  queueOperation(operation).catch(() => {
    markStorageWarning();
    showToast("No se pudo asegurar el guardado", "El cambio sigue en memoria local, pero IndexedDB no está disponible en este navegador.");
  });
}

function markStorageWarning() {
  state.storageWarning = true;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* El estado visual sigue avisando. */ }
  updateSyncState();
}

function currentProfile() {
  const profile = profiles[state.role] || profiles.viewer;
  if (authenticatedUser?.role !== profile.role) return profile;
  return { ...profile, id: authenticatedUser.id, name: authenticatedUser.name };
}

function isEffectivelyOnline() {
  return navigator.onLine && !offlineSession;
}

function isFamilyRole(role = state.role) {
  return role === "family_admin" || role === "family_member";
}

function canEditContent(role = state.role) {
  return canAccess(role, "content_edit");
}

function routeName() {
  try {
    return decodeURIComponent(location.hash.replace(/^#\/?/, "") || "today");
  } catch {
    return "today";
  }
}

function navigate(route) {
  const target = `#${route}`;
  if (location.hash === target) renderRoute({ focusHeading: true });
  else location.hash = target;
}

function routeModule(route) {
  if (route.startsWith("employment")) return "employment";
  if (route.startsWith("wiki")) return "wiki";
  return ["today", "menu", "search", "emergency", "contacts", "calendar", "more"].includes(route) ? route : null;
}

function renderRoute({ focusHeading = false } = {}) {
  closePopover();
  const route = routeName();
  const moduleName = routeModule(route);
  const accessDenied = Boolean(moduleName && !canAccess(state.role, moduleName));
  if (accessDenied) {
    renderAccessDenied("La cuenta con la que has entrado no incluye esta sección.");
  } else if (route === "today") renderToday();
  else if (route === "employment") renderEmployment();
  else if (route === "menu") renderMenu();
  else if (route === "wiki") renderWiki();
  else if (route.startsWith("wiki/")) renderWikiArticle(route.split("/")[1]);
  else if (route === "search") renderSearch();
  else if (route === "emergency") renderEmergency();
  else if (route === "contacts") renderContacts();
  else if (route === "calendar") renderCalendar();
  else if (route === "more") renderMore();
  else renderNotFound();

  setActiveNavigation(accessDenied ? "today" : route);
  hydrateIcons(main);
  window.scrollTo({ top: 0, behavior: "auto" });
  updatePendingIndicators();
  document.title = `${accessDenied ? "Acceso restringido" : pageTitleFor(route)} · Casa Clara`;
  if (focusHeading) {
    const heading = main.querySelector("h1");
    if (heading) {
      heading.tabIndex = -1;
      requestAnimationFrame(() => heading.focus({ preventScroll: true }));
    } else {
      main.focus({ preventScroll: true });
    }
  }
}

function pageTitleFor(route) {
  if (route.startsWith("wiki/")) return "Wiki de la casa";
  return ({ today: "Hoy", employment: "Acuerdos y pagos", menu: "Menú", wiki: "Wiki", search: "Buscar", emergency: "Emergencias", contacts: "Contactos", calendar: "Calendario", more: "Más" })[route] || "Casa Clara";
}

function setActiveNavigation(route) {
  const base = route.startsWith("wiki/") ? "wiki" : route;
  document.querySelectorAll("[data-route]").forEach((button) => {
    const buttonRoute = button.dataset.route;
    const mobileActive = ["emergency", "contacts", "calendar"].includes(base) && buttonRoute === "more";
    button.classList.toggle("is-active", buttonRoute === base || mobileActive);
    if (button.classList.contains("nav-item") || button.closest(".bottom-nav")) {
      if (buttonRoute === base || mobileActive) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
}

function updateProfileUI() {
  const profile = currentProfile();
  document.querySelector("#profile-avatar").textContent = profile.initials;
  document.querySelector("#mobile-avatar").textContent = profile.initials;
  document.querySelector("#profile-name").textContent = profile.name;
  document.querySelector("#profile-role").textContent = ROLE_LABELS[profile.role];
  document.querySelectorAll("[data-module]").forEach((item) => {
    item.hidden = !canAccess(profile.role, item.dataset.module);
  });
}

function updatePendingIndicators() {
  document.querySelectorAll(".nav-dot").forEach((dot) => { dot.hidden = Boolean(state.extraResolution); });
}

function friendlyToday() {
  const value = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function currentMenuDayIndex() {
  const weekday = new Date().getDay();
  return weekday === 0 ? 6 : weekday - 1;
}

function effectiveMenuDay(dayIndex) {
  const base = weekMenu[dayIndex] || weekMenu[0];
  return {
    ...base,
    slots: base.slots.map((slot, slotIndex) => ({ ...slot, ...(state.menuEdits[`${dayIndex}-${slotIndex}`] || {}) })),
  };
}

function visibleCalendarEvents() {
  if (!canAccess(state.role, "calendar")) return [];
  const familyRole = state.role === "family_admin" || state.role === "family_member";
  return calendarEvents.filter((event) => !event.future && (familyRole || event.audience === "Ana" || event.audience === "Todos"));
}

function getMenuSearchCorpus() {
  const dayIndexes = state.role === "helper" ? [currentMenuDayIndex()] : weekMenu.map((_, index) => index);
  return dayIndexes.flatMap((dayIndex) => {
    const day = effectiveMenuDay(dayIndex);
    return day.slots.map((slot, slotIndex) => ({
      id: `menu-${dayIndex}-${slotIndex}`,
      type: "menu",
      title: slot.dish,
      description: `${slot.label} del ${day.day.toLocaleLowerCase("es")} · ${slot.time}`,
      aliases: [],
      tags: [slot.label, slot.group, day.day],
      popularity: 4,
      dayIndex,
    }));
  });
}

function renderToday() {
  if (state.role === "viewer") {
    renderViewerToday();
    return;
  }
  const profile = currentProfile();
  const totals = calculateSettlement(settlementLines);
  const isEmployee = state.role === "employee_live_in";
  const isHelper = state.role === "helper";
  const menuDay = effectiveMenuDay(currentMenuDayIndex());
  const agenda = visibleCalendarEvents().slice(0, 3);

  main.innerHTML = `
    <div class="page">
      <section class="home-intro">
        <div>
          <div class="eyebrow"><span class="eyebrow-dot"></span>${isHelper ? "Vista de apoyo" : isEmployee ? "Tu día en Casa Roble" : "Casa Roble"}</div>
          <h1>Buenos días, ${escapeHtml(profile.name)}</h1>
          <p class="home-date">${friendlyToday()}</p>
        </div>
        <div class="trust-note">${icon("shield")}<span>${isEmployee ? "Todo lo registrado sobre ti está aquí y puedes consultarlo." : "Información compartida para cuidarnos y evitar malentendidos."}</span></div>
      </section>

      <div class="home-grid">
        <div class="home-stack">
          ${isHelper ? renderHelperWelcome() : renderSettlementHero(totals, isEmployee)}
          ${isHelper ? "" : `<section class="card">
            <div class="card-header no-line">
              <div><h2 class="card-title">Lo próximo</h2><p class="card-kicker">Agenda compartida de hoy</p></div>
              <button class="text-link" data-route="calendar">Ver semana ${icon("arrow")}</button>
            </div>
            <div class="today-agenda-list">
              ${agenda.map(renderAgendaRow).join("")}
            </div>
          </section>`}
          <section class="card">
            <div class="card-header">
              <div><h2 class="card-title">Rutinas de hoy</h2><p class="card-kicker">Una ayuda para que nada se olvide</p></div>
              <span class="chip">${routines.filter((item) => !state.routineDone.includes(item.id)).length} por hacer</span>
            </div>
            <div class="routine-list">${routines.map(renderRoutineRow).join("")}</div>
            <div class="routine-footnote">${icon("info")}<span>El marcado solo sirve como recordatorio. No se generan porcentajes ni informes de cumplimiento.</span></div>
          </section>
        </div>

        <div class="home-stack">
          ${renderPrimaryAction(isEmployee, isHelper)}
          <section class="card">
            <div class="card-header no-line">
              <div><h2 class="card-title">Menú de hoy</h2><p class="card-kicker">Cinco momentos, todo a mano</p></div>
              <button class="text-link" data-route="menu">Ver menú ${icon("arrow")}</button>
            </div>
            <div class="meal-preview">
              ${menuDay.slots.map((slot, index) => renderMealPreview(slot, index)).join("")}
            </div>
            <div class="card-body" style="padding-top:0">
              <div class="allergy-strip">${icon("alert")}<div><strong>Alergias y preparación segura</strong><p>Marta · proteína de leche y pescado &nbsp;·&nbsp; Leo · huevo bien cocinado</p></div></div>
            </div>
          </section>
        </div>
      </div>
    </div>`;
}

function renderViewerToday() {
  const profile = currentProfile();
  const agenda = visibleCalendarEvents().slice(0, 3);
  main.innerHTML = `
    <div class="page">
      <section class="home-intro">
        <div><div class="eyebrow"><span class="eyebrow-dot"></span>Acceso puntual</div><h1>Hola, ${escapeHtml(profile.name)}</h1><p class="home-date">${friendlyToday()}</p></div>
        <div class="trust-note">${icon("clock")}<span>Tu cuenta solo incluye emergencias, contactos y la agenda operativa de hoy.</span></div>
      </section>
      <div class="home-grid">
        <section class="card">
          <div class="card-header no-line"><div><h2 class="card-title">Agenda de hoy</h2><p class="card-kicker">Solo eventos necesarios para el cuidado</p></div><button class="text-link" data-route="calendar">Ver agenda ${icon("arrow")}</button></div>
          <div class="today-agenda-list">${agenda.map(renderAgendaRow).join("") || '<div class="empty-state"><p>No hay eventos operativos visibles.</p></div>'}</div>
        </section>
        <section class="card action-card">
          <div class="action-card-top"><span class="action-icon">${icon("shield")}</span><div><h3>Emergencias sin rodeos</h3><p>Dirección, alergias, teléfonos y personas autorizadas.</p></div></div>
          <button class="button soft-danger full" data-route="emergency">Abrir emergencias</button>
          <button class="button secondary full" data-route="contacts">Ver contactos</button>
        </section>
      </div>
    </div>`;
}

function renderHelperWelcome() {
  return `
    <section class="card agreement-card">
      <div class="agreement-card-top">
        <div><div class="eyebrow">Tu acceso de hoy</div><h2>Lo necesario para cuidar la casa</h2><p>Menú, rutinas, contactos y emergencias están disponibles. Los datos laborales y la agenda compartida no forman parte de tu acceso.</p></div>
        <div class="action-icon">${icon("home")}</div>
      </div>
      <div class="shared-truth">${icon("clock")}<p>Esta vista representa un acceso temporal. La caducidad y la revocación reales requieren autenticación y backend.</p></div>
    </section>`;
}

function renderSettlementHero(totals, isEmployee) {
  const payment = paymentSummary(totals.transferTotal, state.payments, state.employeeConfirmedAt);
  const statusLabel = payment.state === "confirmed" ? "Cobro confirmado" : payment.state === "paid" ? "Pagada · por confirmar" : "Cerrada · pendiente de pago";
  return `
    <section class="settlement-hero" aria-label="Resumen de la liquidación de marzo">
      <div class="settlement-hero-content">
        <div>
          <div class="hero-top"><span class="hero-label">${isEmployee ? "Tu última liquidación · marzo 2025" : "Última liquidación · marzo 2025"}</span><span class="status-pill hero-status">${statusLabel}</span></div>
          <div class="hero-amount">${formatCurrency(totals.transferTotal)}</div>
          <p class="hero-due">Ejemplo histórico · vencimiento: 31 de marzo de 2025</p>
          <div class="hero-breakdown">
            <span>Base <strong>1.400</strong></span><span>Extras <strong>+106</strong></span><span>Anticipo <strong>−100</strong></span><span>Gastos <strong>+47,30</strong></span>
          </div>
        </div>
        <div class="hero-footer">
          <span class="hero-liability">${icon("clock")}Además: 1 día a devolver</span>
          <button class="hero-link" data-action="open-settlement">Ver el detalle →</button>
        </div>
      </div>
    </section>`;
}

function renderPrimaryAction(isEmployee, isHelper) {
  if (isHelper) {
    return `<section class="card action-card"><div class="action-card-top"><span class="action-icon">${icon("shield")}</span><div><h3>Emergencias, incluso sin conexión</h3><p>Dirección, alergias, teléfonos y personas autorizadas en un toque.</p></div></div><button class="button soft-danger full" data-route="emergency">Abrir emergencias</button></section>`;
  }
  if (isEmployee) {
    return `<section class="card action-card"><div class="action-card-top"><span class="action-icon">${icon(state.weeklyConfirmed ? "check" : "clock")}</span><div><h3>${state.weeklyConfirmed ? "Semana registrada" : "Confirma tu semana"}</h3><p>${state.weeklyConfirmed ? "Enviada hoy. La familia tiene toda la información." : "¿Ha coincidido con tu horario habitual? Se tarda menos de un minuto."}</p></div></div><button class="button ${state.weeklyConfirmed ? "secondary" : "primary"} full" data-action="${state.weeklyConfirmed ? "open-week" : "confirm-week"}">${state.weeklyConfirmed ? "Ver registro" : "Sí, confirmar semana"}</button>${state.weeklyConfirmed ? "" : `<button class="button tertiary full" data-action="add-exception" ${state.pendingExtra && !state.extraResolution ? "disabled" : ""}>${state.pendingExtra && !state.extraResolution ? "Excepción pendiente" : "Añadir una excepción"}</button>`}</section>`;
  }
  if (state.role === "family_member") {
    return `<section class="card action-card"><div class="action-card-top"><span class="action-icon">${icon("eye")}</span><div><h3>Expediente disponible en lectura</h3><p>Puedes revisar acuerdos, jornadas y pagos. Las confirmaciones laborales corresponden a administración.</p></div></div><button class="button secondary full" data-action="open-work-tab">Consultar jornadas</button></section>`;
  }
  if (state.extraResolution) {
    const facts = getPendingExtraFacts();
    return `<section class="card action-card"><div class="action-card-top"><span class="action-icon">${icon("check")}</span><div><h3>Jornada resuelta</h3><p>${state.extraResolution === "pay" ? `Se incluirán ${formatCurrency(facts.rate)} en la próxima liquidación abierta.` : `Se ha creado ${facts.compensationLabel} de descanso con aviso de caducidad.`}</p></div></div><button class="button secondary full" data-action="open-work-tab">Ver jornadas</button></section>`;
  }
  return `<section class="card action-card"><div class="action-card-top"><span class="action-icon">${icon("alert")}</span><div><h3>1 jornada por revisar</h3><p>Ana ha registrado trabajo en una libranza. Confirma cómo debe resolverse.</p></div></div><button class="button primary full" data-action="open-extra-review">Revisar jornada</button></section>`;
}

function renderAgendaRow(event) {
  return `<div class="agenda-row"><time class="agenda-time">${event.time}</time><span class="agenda-marker">${icon(event.icon)}</span><div class="agenda-copy"><h4>${escapeHtml(event.title)}</h4><p>${escapeHtml(event.detail)}</p></div><span class="agenda-audience">${escapeHtml(event.audience)}</span></div>`;
}

function renderMealPreview(slot, index) {
  const icons = ["breakfast", "food", "utensils", "child", "moon"];
  const content = `<span class="meal-symbol">${icon(icons[index])}</span><span class="meal-copy"><span>${escapeHtml(slot.time)} · ${escapeHtml(slot.label)}</span><h4>${escapeHtml(slot.dish)}</h4>${slot.note ? `<p>${escapeHtml(slot.note)}</p>` : ""}</span>${icon("chevron")}`;
  return slot.recipe
    ? `<button class="meal-row meal-row-button" data-action="open-recipe" data-recipe-id="${slot.recipe}" aria-label="Abrir receta: ${escapeHtml(slot.dish)}">${content}</button>`
    : `<div class="meal-row">${content}</div>`;
}

function renderRoutineRow(routine) {
  const done = state.routineDone.includes(routine.id);
  return `<div class="routine-row ${done ? "is-done" : ""}"><button class="check-control ${done ? "is-checked" : ""}" data-action="toggle-routine" data-id="${routine.id}" aria-label="${done ? "Marcar como pendiente" : "Marcar como hecha"}: ${escapeHtml(routine.title)}" aria-pressed="${done}"></button><div class="routine-copy"><h4>${escapeHtml(routine.title)}</h4><p>${escapeHtml(routine.detail)}</p></div><button class="routine-help" data-action="routine-help" data-id="${routine.id}">Ver cómo</button></div>`;
}

function renderEmployment() {
  const isEmployee = state.role === "employee_live_in";
  const isFamilyMember = state.role === "family_member";
  const titles = {
    summary: "Resumen",
    work: "Jornadas",
    settlement: "Liquidación de marzo",
    balances: "Saldos",
  };
  main.innerHTML = `
    <div class="page">
      <header class="page-header">
        <div>
          <div class="eyebrow"><span class="eyebrow-dot"></span>${isEmployee ? "Tu información, completa y visible" : "Expediente laboral compartido"}</div>
          <h1 class="page-title">${isEmployee ? "Mi trabajo y pagos" : "Acuerdos y pagos"}</h1>
          <p class="page-subtitle">${isEmployee ? "Aquí puedes consultar lo acordado, registrar tus jornadas y confirmar cada cobro." : isFamilyMember ? "Consulta completa en modo lectura; los cierres y el salario corresponden a administración." : "Una sola versión de lo acordado, con cada cambio y cada cifra explicados."}</p>
        </div>
        <div class="page-actions">
          <button class="button secondary" data-action="export-history">${icon("download")}Exportar histórico</button>
          ${isEmployee ? `<button class="button primary" data-action="new-expense">${icon("camera")}Registrar gasto</button>` : ""}
        </div>
      </header>
      <nav class="tabs" role="tablist" aria-label="Secciones del expediente">
        ${Object.entries(titles).map(([key, label]) => `<button id="employment-tab-${key}" class="tab ${state.activeEmploymentTab === key ? "is-active" : ""}" role="tab" tabindex="${state.activeEmploymentTab === key ? "0" : "-1"}" data-employment-tab="${key}" aria-controls="employment-tab-content" aria-selected="${state.activeEmploymentTab === key}">${label}${key === "work" && !isEmployee && !state.extraResolution ? '<span class="nav-dot" style="display:inline-block;margin-left:8px"></span>' : ""}</button>`).join("")}
      </nav>
      <div id="employment-tab-content" role="tabpanel" aria-labelledby="employment-tab-${state.activeEmploymentTab}">${renderEmploymentTab()}</div>
    </div>`;
}

function renderEmploymentTab() {
  if (state.activeEmploymentTab === "work") return renderWorkTab();
  if (state.activeEmploymentTab === "settlement") return renderSettlementTab();
  if (state.activeEmploymentTab === "balances") return renderBalancesTab();
  return renderEmploymentSummary();
}

function renderEmploymentSummary() {
  const isEmployee = state.role === "employee_live_in";
  const isAdmin = state.role === "family_admin";
  const activeChange = getActiveAgreementChange();
  const nextChange = getLocalAgreementChanges().find((change) => change.validFrom > todayCivil());
  const activeVersion = activeChange?.version || 3;
  const activeSalary = activeChange?.salary || 1400;
  const activeSince = activeChange ? formatCivilDate(activeChange.validFrom) : "1 ene 2026";
  const versionNote = nextChange ? ` · versión ${nextChange.version} programada para ${formatCivilDate(nextChange.validFrom)}` : "";
  const weekTitle = isEmployee
    ? (state.weeklyConfirmed ? "Semana enviada a la familia" : "Esta semana coincide con el horario habitual")
    : (!state.weeklyConfirmed ? "Esperando el registro de Ana" : state.weeklyFamilyConfirmed ? "Semana confirmada por ambas partes" : "Ana ha enviado su semana");
  const weekCopy = isEmployee
    ? (state.weeklyConfirmed ? "El registro queda visible para ambas partes. Cualquier corrección creará una revisión nueva." : "No es un fichaje: solo hace falta anotar aquello que fue diferente.")
    : (!state.weeklyConfirmed ? "La familia no registra jornadas por Ana. Cuando ella la envíe, podrás revisarla." : state.weeklyFamilyConfirmed ? "El registro confirmado es inmutable; una corrección creará una revisión nueva." : "Revisa las excepciones y confirma sin modificar lo que Ana registró.");
  const weekAction = isEmployee
    ? `<button class="button ${state.weeklyConfirmed ? "secondary" : "primary"}" data-action="${state.weeklyConfirmed ? "open-week" : "confirm-week"}">${state.weeklyConfirmed ? "Ver registro" : "Confirmar semana"}</button><button class="button tertiary" data-action="add-exception" ${state.pendingExtra && !state.extraResolution ? "disabled" : ""}>${state.pendingExtra && !state.extraResolution ? "Excepción pendiente" : "Añadir excepción"}</button>`
    : isAdmin
      ? `<button class="button ${state.weeklyFamilyConfirmed ? "secondary" : "primary"}" data-action="${state.weeklyConfirmed ? (state.weeklyFamilyConfirmed ? "open-week" : "family-confirm-week") : "open-week"}" ${!state.weeklyConfirmed ? "disabled" : ""}>${!state.weeklyConfirmed ? "Pendiente de Ana" : state.weeklyFamilyConfirmed ? "Ver confirmación" : "Confirmar registro"}</button><button class="button tertiary" data-action="open-extra-review">${state.extraResolution ? "Ver resolución" : "Revisar excepción"}</button>`
      : '<span class="chip info">Consulta en modo lectura</span>';
  return `
    <div class="employment-summary">
      <div class="stack-16">
        <section class="card agreement-card">
          <div class="agreement-card-top">
            <div>
              <div class="eyebrow">Acuerdo vigente</div>
              <h2>Relación laboral interna</h2>
              <p>Desde el 3 de febrero de 2025 · versión ${activeVersion} vigente desde ${activeSince}${versionNote}</p>
            </div>
            <div class="version-badge"><strong>Versión ${activeVersion}</strong><span>${versionNote ? "Hay un cambio programado" : "Sin cambios pendientes"}</span></div>
          </div>
          <dl class="detail-grid">
            <div class="detail-item"><dt>Salario acordado</dt><dd>${formatCurrency(activeSalary)}<small>+ alojamiento y manutención</small></dd></div>
            <div class="detail-item"><dt>Horario habitual</dt><dd>L–V · 08:00–17:00<small>2 h de presencia</small></dd></div>
            <div class="detail-item"><dt>Libranza</dt><dd>Sáb 14:00 – lun 08:00<small>Patrón fijo semanal</small></dd></div>
            <div class="detail-item"><dt>Jornada extra</dt><dd>70,00 €<small>Media jornada · 38,00 €</small></dd></div>
            <div class="detail-item"><dt>Hora extra</dt><dd>12,00 €/h<small>Tarifa vigente</small></dd></div>
            <div class="detail-item"><dt>Día de pago</dt><dd>Último laborable<small>Recordatorio 3 días antes</small></dd></div>
          </dl>
          <div class="flex-between mt-20">
            <button class="text-link" data-action="agreement-history">${icon("history")}Ver versiones y cambios</button>
            ${isEmployee ? '<span class="chip success">Leído el 4 mar</span>' : isAdmin ? '<button class="button small secondary" data-action="edit-agreement">Editar creando versión</button>' : '<span class="chip info">Solo lectura</span>'}
          </div>
        </section>
        <section class="card week-confirm">
          <div>
            <div class="eyebrow">Registro semanal demo · 31 mar–6 abr 2025</div>
            <h2>${weekTitle}</h2>
            <p>${weekCopy}</p>
            <div class="schedule-strip">
              ${["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"].map(renderScheduleDay).join("")}
            </div>
          </div>
          <div class="stack-8">${weekAction}</div>
        </section>
        ${renderLocalExpenses()}
      </div>
      <aside class="stack-16">
        <div class="balance-grid">
          ${renderBalanceCards()}
        </div>
        <section class="card action-card">
          <div class="action-card-top"><span class="action-icon">${icon("receipt")}</span><div><h3>Marzo · ${formatCurrency(calculateSettlement(settlementLines).transferTotal)}</h3><p>Liquidación cerrada. Cada importe conserva su origen.</p></div></div>
          <button class="button secondary full" data-action="open-settlement">Abrir liquidación</button>
        </section>
        <div class="shared-truth">${icon("shield")}<p>${isEmployee ? "Esta vista demo reúne todos los datos laborales semilla de Ana." : "La demo muestra versiones separadas; un histórico append-only real requiere el backend previsto."}</p></div>
      </aside>
    </div>`;
}

function renderLocalExpenses() {
  if (!state.expenses.length) return "";
  return `<section class="card"><div class="card-header"><div><h2 class="card-title">Gastos registrados en esta demo</h2><p class="card-kicker">Pendientes de un backend que los valide y reembolse</p></div><span class="chip warning">${state.expenses.length}</span></div>${state.expenses.map((expense) => `<div class="history-row"><span class="history-marker">${icon("receipt")}</span><div class="history-copy"><strong>${escapeHtml(expense.concept)}</strong><span>${escapeHtml(formatCivilDate(expense.date))} · ${expense.status === "queued" ? "guardado sin conexión" : "guardado localmente"}</span></div><span class="history-amount">${formatCurrency(expense.amount)}</span></div>`).join("")}</section>`;
}

function renderBalanceCards() {
  return `
    <article class="card balance-card"><span class="balance-icon">${icon("sun")}</span><div class="balance-label">Vacaciones</div><div class="balance-value">18 días</div><div class="balance-meta">2 planificados · 4 disfrutados</div></article>
    <article class="card balance-card warning"><span class="balance-icon">${icon("clock")}</span><div class="balance-label">Días a devolver</div><div class="balance-value">1 día</div><div class="balance-meta">Caducidad semilla · 23 jun 2025</div></article>
    <article class="card balance-card"><span class="balance-icon">${icon("history")}</span><div class="balance-label">Banco de horas</div><div class="balance-value">0 h</div><div class="balance-meta">Sin movimientos pendientes</div></article>
    <article class="card balance-card"><span class="balance-icon">${icon("wallet")}</span><div class="balance-label">Anticipo pendiente</div><div class="balance-value">200 €</div><div class="balance-meta">Plan de 100 € al mes</div></article>`;
}

function renderScheduleDay(day, index) {
  const label = index < 5 ? "Habitual" : index === 5 ? "Cambio" : "Libranza";
  const detail = index < 5 ? "08–17 h" : index === 5 ? "desde 14 h" : "todo el día";
  return `<div class="schedule-day ${index === 6 ? "off" : ""}"><span>${day}</span><strong>${label}</strong><small>${detail}</small></div>`;
}

function renderWorkTab() {
  const isEmployee = state.role === "employee_live_in";
  const isAdmin = state.role === "family_admin";
  const title = isEmployee
    ? (state.weeklyConfirmed ? "Tu semana está registrada" : "¿Ha sido tu horario habitual?")
    : (!state.weeklyConfirmed ? "Ana todavía no ha enviado la semana" : state.weeklyFamilyConfirmed ? "Semana confirmada" : "Registro de Ana listo para revisar");
  const copy = isEmployee
    ? (state.weeklyConfirmed ? "Enviada hoy. Si algo cambia, crea una corrección; el registro original se conserva." : "Confirma en un toque o anota una excepción. La familia confirmará después.")
    : (!state.weeklyConfirmed ? "El silencio no se interpreta como una confirmación: el plazo empieza cuando Ana envía su registro." : state.weeklyFamilyConfirmed ? "Ambas partes ven el mismo registro y su sello temporal." : "Confirma el registro tal como fue enviado o anota un conflicto para que Ana lo revise.");
  const action = isEmployee
    ? `<button class="button primary" data-action="confirm-week" ${state.weeklyConfirmed ? "disabled" : ""}>${state.weeklyConfirmed ? `${icon("check")}Enviada` : "Confirmar horario habitual"}</button><button class="button secondary" data-action="add-exception" ${state.pendingExtra && !state.extraResolution ? "disabled" : ""}>${state.pendingExtra && !state.extraResolution ? `${icon("clock")}Excepción pendiente` : `${icon("plus")}Añadir excepción`}</button>`
    : isAdmin
      ? `<button class="button primary" data-action="family-confirm-week" ${!state.weeklyConfirmed || state.weeklyFamilyConfirmed ? "disabled" : ""}>${state.weeklyFamilyConfirmed ? `${icon("check")}Confirmada` : !state.weeklyConfirmed ? "Pendiente de Ana" : "Confirmar registro"}</button><button class="button secondary" data-action="open-extra-review">${state.extraResolution ? "Ver resolución" : "Revisar jornada extra"}</button>`
      : '<span class="chip info">Consulta en modo lectura</span>';
  return `
    <div class="stack-16">
      <section class="card week-confirm">
        <div>
          <div class="eyebrow">Semana actual</div>
          <h2>${title}</h2>
          <p>${copy}</p>
          <div class="schedule-strip">
            ${["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"].map(renderScheduleDay).join("")}
          </div>
        </div>
        <div class="stack-8">${action}</div>
      </section>

      ${state.pendingExtra ? renderPendingExtraCard(isEmployee) : ""}

      ${renderLocalExtraHistory()}

      <section class="card">
        <div class="card-header"><div><h2 class="card-title">Jornadas extra de marzo</h2><p class="card-kicker">Clasificadas según el acuerdo vigente en cada fecha</p></div><span class="chip success">3 resueltas</span></div>
        <div class="history-row"><span class="history-marker">${icon("check")}</span><div class="history-copy"><strong>Domingo 9 de marzo · libranza trabajada</strong><span>Registrada por Ana · aprobada por Alberto · resuelta como pago</span></div><span class="history-amount">+70,00 €</span></div>
        <div class="history-row"><span class="history-marker">${icon("sun")}</span><div class="history-copy"><strong>Domingo 23 de marzo · libranza trabajada</strong><span>Compensada con 1 día libre · caduca el 23 de junio</span></div><span class="history-amount">+1 día</span></div>
        <div class="history-row"><span class="history-marker">${icon("clock")}</span><div class="history-copy"><strong>Horas extraordinarias · 12 y 18 de marzo</strong><span>3 horas confirmadas · tarifa congelada de 12,00 €/h</span></div><span class="history-amount">+36,00 €</span></div>
      </section>
      <div class="alert info">${icon("info")}<div><strong>Confirmación semanal, no fichaje</strong><p>Ana registra lo que ocurrió y la familia confirma. La auto-confirmación por silencio y sus avisos formarían parte del backend de producción.</p></div></div>
    </div>`;
}

function renderLocalExtraHistory() {
  const currentId = state.pendingExtra?.id;
  const resolved = (state.extraEvents || []).filter((event) => event.id !== currentId);
  if (!resolved.length) return "";
  return `<section class="card"><div class="card-header"><div><h2 class="card-title">Excepciones resueltas en esta demo</h2><p class="card-kicker">Snapshots locales conservados al registrar una nueva excepción</p></div><span class="chip success">${resolved.length}</span></div>${resolved.map((event) => {
    const facts = getPendingExtraFacts(event);
    const result = event.resolution === "pay" ? formatCurrency(event.frozenRate ?? facts.rate, { showSign: true }) : `+${facts.compensationLabel}`;
    return `<div class="history-row"><span class="history-marker">${icon(event.resolution === "pay" ? "wallet" : "sun")}</span><div class="history-copy"><strong>${facts.dateLabel} · ${facts.classificationLabel.toLocaleLowerCase("es")}</strong><span>${event.resolution === "pay" ? "Resuelta como pago" : "Resuelta como descanso"} · acuerdo ${escapeHtml(event.agreementVersionId || facts.agreementVersionId)}</span></div><span class="history-amount">${escapeHtml(result)}</span></div>`;
  }).join("")}</section>`;
}

function renderPendingExtraCard(isEmployee) {
  const resolution = state.extraResolution;
  const facts = getPendingExtraFacts();
  return `
    <section class="card action-card">
      <div class="action-card-top"><span class="action-icon">${icon(resolution ? "check" : "alert")}</span><div><h3>${resolution ? "Jornada resuelta" : `${facts.dateLabel} · pendiente de resolución`}</h3><p>${resolution ? `La familia ha confirmado: ${resolution === "pay" ? `pago de ${formatCurrency(facts.rate)}` : `compensación con ${facts.compensationLabel}`}. Tarifa congelada al resolver.` : `${escapeHtml(state.pendingExtra?.registeredBy || "Ana")} registró ${facts.quantityLabel.toLocaleLowerCase("es")} a las ${facts.timeLabel}, clasificada como ${facts.classificationLabel.toLocaleLowerCase("es")}. El registro no desaparecerá.`}</p></div></div>
      ${!resolution && state.role === "family_admin" ? '<button class="button primary" data-action="resolve-pending-extra">Resolver ahora</button>' : !resolution ? '<span class="chip warning mt-16">Pendiente de confirmación de administración</span>' : '<span class="chip success mt-16">Queda registrado para ambas partes</span>'}
    </section>`;
}

function renderSettlementTab() {
  const totals = calculateSettlement(settlementLines);
  const payments = paymentSummary(totals.transferTotal, state.payments, state.employeeConfirmedAt);
  const isEmployee = state.role === "employee_live_in";
  const progress = Math.min(100, totals.transferTotal ? (payments.paid / totals.transferTotal) * 100 : 100);
  return `
    <div class="settlement-layout">
      <section class="card">
        <div class="settlement-summary-head">
          <div class="settlement-summary-head-top">
            <div><div class="eyebrow">Liquidación cerrada · marzo 2025</div><h2>Total a transferir</h2><p>Cerrada el 28 de marzo · vence el 31 de marzo</p></div>
            <span class="status-pill ${payments.state === "confirmed" ? "success" : payments.state === "paid" ? "info" : "warning"}">${payments.state === "confirmed" ? "Cobro confirmado" : payments.state === "paid" ? "Pagada" : "Pendiente de pago"}</span>
          </div>
          <div class="settlement-total">${formatCurrency(totals.transferTotal)}</div>
        </div>
        <div class="settlement-lines">
          ${settlementLines.filter((line) => line.section === "salary").map(renderSettlementLine).join("")}
        </div>
        <div class="settlement-subtotal"><span>Salario del mes</span><strong>${formatCurrency(totals.salaryTotal)}</strong></div>
        <div class="settlement-lines">${settlementLines.filter((line) => line.section === "reimbursement").map(renderSettlementLine).join("")}</div>
        <div class="settlement-subtotal grand"><span>Total a transferir</span><strong>${formatCurrency(totals.transferTotal)}</strong></div>
      </section>

      <aside class="stack-16">
        <section class="card state-card">
          <h3>Estado de la liquidación</h3>
          <div class="state-stepper">${renderSettlementSteps(payments.state)}</div>
          <div class="payment-progress">
            <div class="progress-label"><span>Pagado</span><strong>${formatCurrency(payments.paid)} de ${formatCurrency(totals.transferTotal)}</strong></div>
            <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
          </div>
          ${renderSettlementAction(isEmployee, payments, totals)}
        </section>
        <div class="alert info">${icon("lock")}<div><strong>Snapshot local de demostración</strong><p>Estas cifras semilla no se editan en esta vista. El PDF determinista, el hash y los ajustes del periodo siguiente requieren backend.</p></div></div>
        <button class="button secondary full" data-action="print-receipt">${icon("receipt")}Ver recibo imprimible</button>
      </aside>
    </div>
    ${state.payments.length ? renderPaymentHistory() : ""}`;
}

function renderSettlementLine(line) {
  const amountText = line.amount === 0 ? "0,00 €" : formatCurrency(line.amount, { showSign: line.amount > 0 });
  return `<button class="settlement-line" data-action="line-origin" data-line-id="${line.id}"><span class="line-concept"><strong>${escapeHtml(line.concept)}</strong><span>${escapeHtml(line.detail)}</span></span><span class="line-amount ${line.tone}">${amountText}</span>${icon("chevron")}</button>`;
}

function renderSettlementSteps(paymentState) {
  const steps = [
    { key: "open", label: "Abierta", meta: "Devengo calculado" },
    { key: "review", label: "En revisión", meta: "Visible para Ana" },
    { key: "closed", label: "Cerrada", meta: "Snapshot demo · 28 mar" },
    { key: "paid", label: "Pagada", meta: paymentState === "closed" ? "Pendiente" : "Importe cubierto" },
    { key: "confirmed", label: "Cobro confirmado", meta: state.employeeConfirmedAt ? formatDateTime(state.employeeConfirmedAt) : "Pendiente de Ana" },
  ];
  const index = paymentState === "confirmed" ? 4 : paymentState === "paid" ? 3 : 2;
  return steps.map((step, stepIndex) => `<div class="state-step ${stepIndex < index ? "is-done" : stepIndex === index ? "is-current" : ""}"><span class="state-dot">${stepIndex < index ? icon("check") : ""}</span><span class="state-copy"><strong>${step.label}</strong><span>${step.meta}</span></span></div>`).join("");
}

function renderSettlementAction(isEmployee, payments, totals) {
  if (payments.state === "confirmed") return `<div class="alert success">${icon("check")}<div><strong>Ciclo completado</strong><p>${formatDateTime(state.employeeConfirmedAt)}</p></div></div>`;
  if (isEmployee && payments.state === "paid") return `<button class="button primary full" data-action="confirm-receipt">${icon("check")}Confirmar que lo recibí</button><p class="muted mt-12" style="font-size:.7rem">Solo tú puedes confirmar que el dinero ha llegado.</p>`;
  if (isEmployee) return `<div class="alert warning">${icon("clock")}<div><strong>Pendiente de pago</strong><p>La familia registrará cada entrega. Podrás confirmar el cobro cuando la suma llegue a ${formatCurrency(totals.transferTotal)}.</p></div></div>`;
  if (state.role === "family_member") return `<div class="alert info">${icon("eye")}<div><strong>Consulta en modo lectura</strong><p>Solo una cuenta administradora puede registrar pagos o cerrar liquidaciones.</p></div></div>`;
  if (payments.state === "paid") return `<div class="alert info">${icon("check")}<div><strong>Total cubierto</strong><p>Pendiente de que Ana confirme el cobro. No se pueden registrar más pagos.</p></div></div>`;
  return `<button class="button primary full" data-action="register-payment">${icon("plus")}Registrar ${payments.paid ? "otro " : ""}pago</button>${payments.pending < totals.transferTotal ? `<p class="muted mt-12" style="font-size:.7rem">Quedan ${formatCurrency(payments.pending)}. Los pagos parciales no cierran el ciclo.</p>` : ""}`;
}

function renderPaymentHistory() {
  return `<section class="card ledger-history"><div class="card-header"><div><h2 class="card-title">Pagos registrados</h2><p class="card-kicker">Una liquidación puede cubrirse con varias entregas</p></div><span class="chip">${state.payments.length} ${state.payments.length === 1 ? "pago" : "pagos"}</span></div>${state.payments.map((payment) => `<div class="history-row"><span class="history-marker">${icon("wallet")}</span><div class="history-copy"><strong>${escapeHtml(payment.method)} · ${escapeHtml(payment.reference || "Sin referencia")}</strong><span>Fecha valor ${escapeHtml(formatCivilDate(payment.date))} · registrado por Alberto</span></div><span class="history-amount">${formatCurrency(payment.amount)}</span></div>`).join("")}</section>`;
}

function renderBalancesTab() {
  return `
    <div class="ledger-cards">${renderBalanceCards()}</div>
    <section class="card ledger-history">
      <div class="card-header"><div><h2 class="card-title">Movimientos de saldos</h2><p class="card-kicker">Libro semilla de marzo; las tarjetas no se recalculan en esta demo</p></div><button class="button small secondary" data-action="export-balances">${icon("download")}CSV</button></div>
      <div class="history-row"><span class="history-marker">${icon("sun")}</span><div class="history-copy"><strong>Devengo de vacaciones · marzo</strong><span>Asiento automático · 31 mar 2025</span></div><span class="history-amount">+2,5 días</span></div>
      <div class="history-row"><span class="history-marker">${icon("calendar")}</span><div class="history-copy"><strong>Vacaciones disfrutadas</strong><span>Solicitud aprobada · 3–4 mar 2025</span></div><span class="history-amount">−2 días</span></div>
      <div class="history-row"><span class="history-marker">${icon("clock")}</span><div class="history-copy"><strong>Libranza trabajada · compensación</strong><span>Evento EW-109 · caduca el 23 jun 2025</span></div><span class="history-amount">+1 día</span></div>
      <div class="history-row"><span class="history-marker">${icon("wallet")}</span><div class="history-copy"><strong>Cuota de anticipo · marzo</strong><span>Plan AD-12 · saldo anterior 300,00 €</span></div><span class="history-amount">−100,00 €</span></div>
    </section>
    <div class="alert warning mt-16">${icon("alert")}<div><strong>Dato semilla: este día caducaba el 23 de junio de 2025</strong><p>En producción se avisaría con 30 días de antelación y cada cambio generaría un asiento append-only.</p></div></div>`;
}

function renderMenu() {
  const isHelper = state.role === "helper";
  const selectedDayIndex = isHelper ? currentMenuDayIndex() : state.selectedMenuDay;
  const selected = effectiveMenuDay(selectedDayIndex);
  const canEdit = canEditContent();
  main.innerHTML = `
    <div class="page">
      <header class="page-header">
        <div><div class="eyebrow"><span class="eyebrow-dot"></span>Comidas de la casa</div><h1 class="page-title">${isHelper ? "Menú de hoy" : "Menú semanal"}</h1><p class="page-subtitle">Platos, notas de preparación y alergias siempre en el mismo sitio.</p></div>
        <div class="page-actions">
          ${isHelper ? "" : `<button class="button secondary" data-action="shopping-list">${icon("cart")}Lista de la compra</button>`}
          ${canEdit ? `<button class="button primary" data-action="duplicate-week">${icon("rotate")}${state.duplicatedWeek ? "Semana duplicada" : "Duplicar semana anterior"}</button>` : ""}
        </div>
      </header>
      <div class="allergy-strip menu-allergy-strip">${icon("alert")}<div><strong>Atención: alergias e intolerancias</strong><p>Marta · proteína de leche y pescado &nbsp;·&nbsp; Leo · huevo poco cocinado</p></div></div>
      <div class="week-toolbar">
        ${isHelper ? `<strong>${selected.day}, ${selected.date} de agosto de 2026</strong>` : `<div class="week-picker"><button class="button small secondary" data-action="previous-menu-week" aria-label="Semana anterior">${icon("arrowLeft")}</button><strong>3–9 de agosto de 2026</strong><button class="button small secondary" data-action="next-menu-week" aria-label="Semana siguiente">${icon("arrow")}</button></div>`}
        <span class="offline-ready">Cacheado tras la primera carga</span>
      </div>
      ${isHelper ? "" : `<div class="day-tabs" role="tablist" aria-label="Días de la semana">${weekMenu.map((day, index) => `<button id="menu-day-tab-${index}" class="day-tab ${selectedDayIndex === index ? "is-active" : ""}" data-menu-day="${index}" role="tab" tabindex="${selectedDayIndex === index ? "0" : "-1"}" aria-controls="menu-day-panel" aria-selected="${selectedDayIndex === index}"><span>${day.short}</span><strong>${day.date}</strong></button>`).join("")}</div>`}
      <div class="menu-layout ${isHelper ? "single-column" : ""}">
        <section id="menu-day-panel" class="card menu-day-card" ${isHelper ? "" : `role="tabpanel" aria-labelledby="menu-day-tab-${selectedDayIndex}"`}>
          <div class="menu-day-head">
            <div><h2>${selected.day}, ${selected.date} de agosto</h2><p>Cinco franjas · notas y recetas enlazadas</p></div>
            <div class="group-toggle" aria-label="Filtrar comensales"><button class="${state.menuGroup === "all" ? "is-active" : ""}" data-menu-group="all">Todos</button><button class="${state.menuGroup === "children" ? "is-active" : ""}" data-menu-group="children">Niños</button><button class="${state.menuGroup === "adults" ? "is-active" : ""}" data-menu-group="adults">Adultos</button></div>
          </div>
          ${selected.slots.map((slot, index) => renderMenuSlot(slot, index, canEdit)).join("")}
        </section>
        ${isHelper ? "" : `<aside class="stack-16">
          <section class="card shopping-card">
            <div class="card-header no-line"><div><h2 class="card-title">Lista de la compra</h2><p class="card-kicker">Lista semilla de demostración</p></div>${icon("cart")}</div>
            <div class="shopping-summary"><div class="shopping-summary-number">14</div><p>productos semilla · agrupados en 6 secciones</p><div class="shopping-sections"><span class="chip">Fruta y verdura</span><span class="chip">Despensa</span><span class="chip">Pescadería</span></div><div class="shopping-checks"><div class="mini-check"><span></span>Calabaza · 800 g</div><div class="mini-check"><span></span>Lenteja pardina · 500 g</div><div class="mini-check"><span></span>Lomos de merluza · 4 ud</div></div><button class="button secondary full mt-16" data-action="shopping-list">Abrir lista completa</button></div>
          </section>
          <div class="alert info">${icon("info")}<div><strong>Recetas semilla enlazadas</strong><p>El versionado que conservará la receta utilizada cada semana forma parte del backend futuro.</p></div></div>
        </aside>`}
      </div>
    </div>`;
}

function renderMenuSlot(slot, index, canEdit) {
  const icons = ["breakfast", "food", "utensils", "child", "moon"];
  const groupVisible = state.menuGroup === "all" || (state.menuGroup === "children" && slot.group !== "Adultos") || (state.menuGroup === "adults" && slot.group !== "Niños");
  if (!groupVisible) return "";
  return `<div class="menu-slot"><time class="slot-time">${escapeHtml(slot.time)}</time><span class="slot-icon">${icon(icons[index])}</span><div class="slot-copy"><span>${escapeHtml(slot.label)} · ${escapeHtml(slot.group)}</span><h3>${escapeHtml(slot.dish)}</h3>${slot.note ? `<p>${escapeHtml(slot.note)}</p>` : ""}${slot.recipe ? `<button class="recipe-link" data-action="open-recipe" data-recipe-id="${slot.recipe}">${icon("book")}Ver receta</button>` : ""}</div>${canEdit ? `<button class="icon-button" data-action="edit-menu-slot" data-slot="${index}" aria-label="Editar ${escapeHtml(slot.label)}">${icon("edit")}</button>` : icon("chevron")}</div>`;
}

function renderWiki() {
  const familyRole = isFamilyRole();
  const canEdit = canEditContent();
  const recipePages = recipes.map((recipe) => ({
    ...recipe,
    type: "recipe",
    space: "Recetas",
    description: recipe.description,
    icon: "utensils",
    popularity: recipe.popularity || 0,
    updated: "Datos semilla",
  }));
  const visiblePages = [...getAllWikiPages().filter((page) => !page.visibility || familyRole), ...recipePages];
  const spaces = [
    { name: "Estancias", icon: "room", copy: "Habitaciones, objetos y particularidades" },
    { name: "Equipamiento", icon: "washer", copy: "Electrodomésticos y sistemas" },
    { name: "Incidencias", icon: "bolt", copy: "Qué hacer cuando algo falla" },
    { name: "Convivencia", icon: "home", copy: "Acuerdos y vida compartida" },
    { name: "Crianza", icon: "child", copy: "Rutinas y cuidados de los niños" },
    { name: "Recetas", icon: "utensils", copy: "Platos, ingredientes y trucos" },
    { name: "Mantenimiento", icon: "tools", copy: "Procedimientos de la casa" },
  ];
  const filtered = state.wikiSpace === "Todos" ? visiblePages : visiblePages.filter((page) => page.space === state.wikiSpace);
  main.innerHTML = `
    <div class="page">
      <header class="page-header">
        <div><div class="eyebrow"><span class="eyebrow-dot"></span>El conocimiento de Casa Roble</div><h1 class="page-title">Wiki de la casa</h1><p class="page-subtitle">Lo que sabemos, escrito para encontrarlo justo cuando hace falta.</p></div>
        <div class="page-actions"><button class="button secondary" data-route="search">${icon("search")}Buscar</button>${canEdit ? `<button class="button primary" data-action="new-wiki-page">${icon("plus")}Nueva página</button>` : ""}</div>
      </header>
      <section class="wiki-hero">
        <div class="wiki-welcome"><div class="eyebrow">Empieza por una pregunta</div><h2>¿Qué necesitas saber de la casa?</h2><p>Busca como lo dirías normalmente. “Vitro”, “lavadra” o “se han ido los plomos” también funcionan.</p><button class="button primary" data-route="search">${icon("search")}Buscar en toda la casa</button></div>
        ${canEdit ? `<aside class="card doc-gap-card"><h3>Algo falta por documentar</h3><p>Los ejemplos semilla y las altas manuales ayudan a decidir qué página escribir.</p><div class="gap-query"><strong>“${docGaps[0].query}”</strong><span>Conteo semilla: ${docGaps[0].count} · 2 variantes</span></div><button class="button secondary small mt-16" data-action="open-doc-gaps">Ver ${docGaps.length} pendientes</button></aside>` : `<aside class="card doc-gap-card"><h3>¿No encuentras algo?</h3><p>Prueba con tus propias palabras o pide a la familia que cree una página.</p><div class="gap-query"><strong>La búsqueda local no identifica a nadie</strong><span>Esta demo no registra consultas automáticamente</span></div></aside>`}
      </section>
      <div class="section-heading"><div><h2>Explorar por espacio</h2><p>El “cómo” vive aquí; el “cuándo” aparece en Hoy.</p></div>${state.wikiSpace !== "Todos" ? '<button class="text-link" data-wiki-space="Todos">Ver todos</button>' : ""}</div>
      <div class="space-grid">${spaces.map((space) => `<button class="card space-card" data-wiki-space="${space.name}"><span class="space-icon">${icon(space.icon)}</span><h3>${space.name}</h3><p>${space.copy}</p></button>`).join("")}</div>
      <div class="section-heading"><div><h2>${state.wikiSpace === "Todos" ? "Fijadas y ejemplos destacados" : state.wikiSpace}</h2><p>${filtered.length} páginas accesibles con tu perfil</p></div><span class="chip">Datos semilla</span></div>
      <div class="page-card-grid">${filtered.map(renderWikiPageCard).join("") || '<div class="card empty-state"><h2>Todavía no hay páginas aquí</h2><p>Cuando surja una necesidad real, se podrá documentar en dos minutos.</p></div>'}</div>
    </div>`;
}

function renderWikiPageCard(page) {
  const action = page.type === "recipe" ? `data-action="open-recipe" data-recipe-id="${page.id}"` : `data-route="wiki/${page.slug}"`;
  return `<button class="card wiki-page-card" ${action}>${page.pinned ? `<span class="pin-icon">${icon("pin")}</span>` : ""}<div><span class="space-icon">${icon(page.icon)}</span><h3>${escapeHtml(page.title)}</h3><p>${escapeHtml(page.description)}</p></div><div class="page-card-meta"><span>${escapeHtml(page.space)}</span><span>${page.popularity} lecturas demo · ${escapeHtml(page.updated)}</span></div></button>`;
}

function renderWikiArticle(slug) {
  const page = getAllWikiPages().find((item) => item.slug === slug);
  const canView = page && (!page.visibility || isFamilyRole());
  if (!canView) {
    renderAccessDenied(page ? "Esta página es interna de la familia." : "La página que buscas no existe.");
    return;
  }
  const body = state.wikiEdits[slug] || page.body;
  main.innerHTML = `
    <div class="page narrow">
      <article class="article-shell">
        <nav class="article-breadcrumb" aria-label="Migas de pan"><button class="text-link" data-route="wiki">Wiki</button><span>›</span><button class="text-link" data-action="wiki-filter-and-return" data-space="${page.space}">${page.space}</button><span>›</span><span>${escapeHtml(page.title)}</span></nav>
        <header class="article-header">
          <div class="flex-between"><span class="chip success">${icon("offline")}Disponible sin conexión</span>${canEditContent() ? `<button class="button small secondary" data-action="edit-wiki-page" data-slug="${slug}">${icon("edit")}Editar</button>` : ""}</div>
          <div class="eyebrow mt-20">${escapeHtml(page.space)}</div>
          <h1>${escapeHtml(page.title)}</h1>
          <p>${escapeHtml(page.description)}</p>
          <div class="article-meta"><span>Fecha semilla: ${page.updated}</span><span>Versión de muestra</span><span>${page.popularity} lecturas demo</span><span>Español original</span></div>
        </header>
        <div class="article-body">${renderMarkdown(body)}</div>
        <div class="alert info">${icon("info")}<div><strong>¿Falta algo o ha cambiado?</strong><p>Los comentarios anclados y su histórico forman parte del editor de producción; esta demo solo permite una edición local.</p></div></div>
      </article>
    </div>`;
}

function renderMarkdown(markdown) {
  const lines = String(markdown).split("\n");
  let html = "";
  let listType = null;
  const closeList = () => {
    if (listType) html += `</${listType}>`;
    listType = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (line.startsWith("## ")) { closeList(); html += `<h2>${inlineMarkdown(line.slice(3))}</h2>`; continue; }
    if (line.startsWith("> ")) { closeList(); html += `<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`; continue; }
    if (/^\d+\.\s/.test(line)) {
      if (listType !== "ol") { closeList(); listType = "ol"; html += "<ol>"; }
      html += `<li>${inlineMarkdown(line.replace(/^\d+\.\s/, ""))}</li>`;
      continue;
    }
    if (line.startsWith("- ")) {
      if (listType !== "ul") { closeList(); listType = "ul"; html += "<ul>"; }
      html += `<li>${inlineMarkdown(line.slice(2))}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inlineMarkdown(line)}</p>`;
  }
  closeList();
  return html;
}

function inlineMarkdown(text) {
  let value = escapeHtml(text);
  value = value.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/\[\[([a-z0-9-]+)\]\]/g, (_, slug) => {
    const linked = getAllWikiPages().find((page) => page.slug === slug && (!page.visibility || isFamilyRole()));
    return linked ? `<a href="#wiki/${slug}">${escapeHtml(linked.title)}</a>` : `<span title="Enlace pendiente">${escapeHtml(slug.replaceAll("-", " "))} ⚠</span>`;
  });
  return value;
}

function renderSearch() {
  main.innerHTML = `
    <div class="page search-page">
      <header class="page-header"><div><div class="eyebrow"><span class="eyebrow-dot"></span>Buscador global</div><h1 class="page-title">Buscar en toda la casa</h1><p class="page-subtitle">Wiki, recetas, contactos y platos del menú, juntos y ordenados por tipo.</p></div><span class="offline-ready">Títulos y alias disponibles offline</span></header>
      <section class="search-hero">
        <div class="search-input-wrap">${icon("search")}<label class="sr-only" for="search-input">Qué quieres encontrar</label><input id="search-input" class="search-input" type="search" placeholder="Prueba con “lavadra” o “vitro”…" value="${escapeHtml(state.searchQuery)}" autocomplete="off" spellcheck="false" /><button class="search-clear ${state.searchQuery ? "" : "hidden"}" data-action="clear-search" aria-label="Borrar búsqueda">${icon("close")}</button></div>
        <p class="search-hint">Tolera erratas y acentos · los resultados respetan los permisos de tu perfil</p>
        ${state.searchQuery ? "" : '<div class="suggestion-chips"><button class="suggestion-chip" data-search-suggestion="lavadra">lavadra</button><button class="suggestion-chip" data-search-suggestion="vitro">vitro</button><button class="suggestion-chip" data-search-suggestion="pediatra">pediatra</button><button class="suggestion-chip" data-search-suggestion="caldera">caldera</button></div>'}
      </section>
      <div id="search-results">${renderSearchResults(state.searchQuery)}</div>
    </div>`;
  requestAnimationFrame(() => document.querySelector("#search-input")?.focus());
}

function renderSearchResults(query) {
  if (!query.trim()) {
    const recent = getAllWikiPages().filter((page) => page.pinned && (!page.visibility || isFamilyRole())).slice(0, 3);
    return `<div class="section-heading"><div><h2>Útiles ahora</h2><p>Páginas fijadas y consultas habituales</p></div></div><div class="result-list card">${recent.map(renderSearchResult).join("")}</div>`;
  }
  const staticCorpus = getSearchCorpus().filter((item) => item.type !== "menu" && item.type !== "wiki");
  let corpus = [...getAllWikiPages(), ...staticCorpus, ...getMenuSearchCorpus(), ...state.customContacts];
  if (!isFamilyRole()) corpus = corpus.filter((item) => !item.visibility);
  const results = searchItems(query, corpus);
  if (!results.length) {
    const alreadyLogged = state.loggedGaps.some((item) => item.toLocaleLowerCase("es") === query.toLocaleLowerCase("es"));
    return `<section class="card empty-state"><span class="empty-icon">${icon("search")}</span><h2>No encontramos nada para “${escapeHtml(query)}”</h2><p>${canEditContent() ? "Puedes añadirlo a documentación pendiente para convertir esta necesidad en una nueva página." : "Prueba con otras palabras o pide a la familia que documente esta necesidad."}</p>${canEditContent() ? `<button class="button ${alreadyLogged ? "secondary" : "primary"}" data-action="log-doc-gap" ${alreadyLogged ? "disabled" : ""}>${alreadyLogged ? `${icon("check")}Añadido a pendientes` : `${icon("plus")}Añadir a documentación pendiente`}</button>` : ""}</section>`;
  }
  const groups = groupBy(results, "type");
  const labels = { wiki: "Wiki", recipe: "Recetas", contact: "Contactos", menu: "Menú" };
  return Object.entries(groups).map(([type, items]) => `<section class="search-group"><div class="search-group-title"><span>${labels[type] || type}</span><span>${items.length} ${items.length === 1 ? "resultado" : "resultados"}</span></div><div class="result-list card">${items.map(renderSearchResult).join("")}</div></section>`).join("");
}

function renderSearchResult(item) {
  const iconName = item.type === "recipe" ? "utensils" : item.type === "contact" ? "phone" : item.type === "menu" ? "calendar" : item.icon || "book";
  const action = item.type === "wiki" ? `data-route="wiki/${item.slug}"` : item.type === "recipe" ? `data-action="open-recipe" data-recipe-id="${item.id}"` : item.type === "contact" ? `data-action="open-contact" data-contact-id="${item.id}"` : `data-action="open-menu-result" data-menu-day="${item.dayIndex ?? 0}"`;
  return `<div class="result-row"><button class="result-icon ${item.type}" ${action} aria-label="Abrir ${escapeHtml(item.title)}">${icon(iconName)}</button><button class="result-copy" ${action}><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description || item.role || "")}</p></button><div class="result-actions">${item.type === "contact" ? `<a class="button small secondary icon-only" href="tel:${item.phone}" aria-label="Llamar a ${escapeHtml(item.title)}">${icon("phone")}</a>` : `<button class="icon-button" ${action} aria-label="Abrir">${icon("arrow")}</button>`}</div></div>`;
}

function renderEmergency() {
  main.innerHTML = `
    <div class="page emergency-page">
      <header class="emergency-header">
        <div><div class="eyebrow"><span class="eyebrow-dot"></span>Información crítica</div><h1 class="page-title">Emergencias</h1><p class="page-subtitle">Todo lo necesario para actuar, incluso sin conexión.</p></div>
        <span class="offline-ready">Cacheada tras la primera carga</span>
      </header>
      <a class="emergency-call" href="tel:112"><span class="emergency-call-icon">${icon("phone")}</span><span><strong>Si hay peligro inmediato, llama al 112</strong><p>Emergencias sanitarias, policía y bomberos</p></span><span class="emergency-call-number">112</span></a>
      <div class="emergency-grid">
        <section class="card emergency-card"><div class="emergency-card-head">${icon("home")}<h2>Dirección de la casa</h2></div><dl class="info-list"><div class="info-row"><dt>Dirección</dt><dd>C/ del Olmo, 24 · 3º A</dd></div><div class="info-row"><dt>Acceso</dt><dd>Portal 24 · timbre “Roble”</dd></div><div class="info-row"><dt>Indicaciones</dt><dd>Ascensor a la derecha; puerta al fondo</dd></div><div class="info-row"><dt>Ubicación</dt><dd><a class="text-link" href="https://maps.google.com/?q=Calle+del+Olmo+24+Madrid" target="_blank" rel="noreferrer">Abrir en el mapa</a></dd></div></dl></section>
        <section class="card emergency-card"><div class="emergency-card-head">${icon("medical")}<h2>Niños · salud</h2></div><dl class="info-list"><div class="info-row"><dt>Marta Roble</dt><dd>14/05/2018 · <span class="medical-warning">alergia a proteína de leche y pescado</span></dd></div><div class="info-row"><dt>Leo Roble</dt><dd>02/11/2021 · huevo siempre bien cocinado</dd></div><div class="info-row"><dt>Medicación</dt><dd>Autoinyector de Marta en el armario alto de la cocina</dd></div><div class="info-row"><dt>Tarjetas</dt><dd>Carpeta azul del recibidor</dd></div></dl></section>
        <section class="card emergency-card"><div class="emergency-card-head">${icon("phone")}<h2>Contactos prioritarios</h2></div>${contacts.filter((contact) => contact.emergency).slice(1).map((contact) => `<div class="contact-call-row"><span><strong>${escapeHtml(contact.title)}</strong><span>${escapeHtml(contact.role)} · ${escapeHtml(contact.displayPhone || contact.phone)}</span></span><a class="button small secondary icon-only" href="tel:${contact.phone}" aria-label="Llamar a ${escapeHtml(contact.title)}">${icon("phone")}</a></div>`).join("")}</section>
        <section class="card emergency-card"><div class="emergency-card-head">${icon("users")}<h2>Familia y autorizaciones</h2></div><dl class="info-list"><div class="info-row"><dt>Alberto</dt><dd><a href="tel:+34600000555">600 000 555</a> · padre</dd></div><div class="info-row"><dt>Marta</dt><dd><a href="tel:+34600000666">600 000 666</a> · madre</dd></div><div class="info-row"><dt>Recogida</dt><dd>Ana, abuela Julia y vecina Carmen</dd></div><div class="info-row"><dt>Seguro</dt><dd>SaludUno · póliza SAL-28491</dd></div></dl></section>
      </div>
      <div class="emergency-footer"><button class="button primary" data-action="print-emergency">${icon("download")}Imprimir hoja para la nevera</button><button class="button secondary" data-action="medical-authorization">${icon("receipt")}Autorización médica</button><button class="button tertiary" data-route="contacts">Ver todos los contactos</button></div>
    </div>`;
}

function renderContacts() {
  const allContacts = [...contacts, ...state.customContacts];
  main.innerHTML = `
    <div class="page">
      <header class="page-header"><div><div class="eyebrow"><span class="eyebrow-dot"></span>Directorio de la casa</div><h1 class="page-title">Contactos</h1><p class="page-subtitle">Familia, salud, colegio y profesionales de confianza.</p></div><div class="page-actions">${canAccess(state.role, "search") ? `<button class="button secondary" data-route="search">${icon("search")}Buscar contacto</button>` : ""}${state.role === "family_admin" ? `<button class="button primary" data-action="new-contact">${icon("plus")}Añadir</button>` : ""}</div></header>
      <div class="contact-grid">${allContacts.map((contact) => `<article class="card contact-card"><div class="contact-card-head"><span class="contact-avatar">${contact.title.split(" ")[0].slice(0,2).toUpperCase()}</span><div><h3>${escapeHtml(contact.title)}</h3><span class="contact-role">${escapeHtml(contact.role)}</span></div></div><p>${escapeHtml(contact.description)}</p><div class="contact-actions"><a class="button small secondary" href="tel:${contact.phone}">${icon("phone")}Llamar</a>${/^\+\d{8,15}$/.test(contact.phone) ? `<a class="button small tertiary" href="https://wa.me/${contact.phone.replace(/\D/g, "")}" target="_blank" rel="noreferrer">WhatsApp</a>` : ""}</div></article>`).join("")}</div>
    </div>`;
}

function renderCalendar() {
  const visibleEvents = visibleCalendarEvents();
  main.innerHTML = `
    <div class="page">
      <header class="page-header"><div><div class="eyebrow"><span class="eyebrow-dot"></span>Agenda de la casa</div><h1 class="page-title">Esta semana</h1><p class="page-subtitle">Lista operativa con datos ICS simulados; el calendario personal queda fuera.</p></div><span class="offline-ready">Datos de demostración</span></header>
      <div class="calendar-layout">
        <section class="card calendar-day"><div class="calendar-day-head"><div class="eyebrow">Próximos eventos</div><h2>${friendlyToday()}</h2></div><div class="calendar-day-list">${visibleEvents.map(renderAgendaRow).join("")}${state.role === "family_admin" ? `<div class="agenda-row"><time class="agenda-time">31 ago</time><span class="agenda-marker">${icon("wallet")}</span><div class="agenda-copy"><h4>Recordatorio demo de cierre mensual</h4><p>El importe se calcularía al cerrar la liquidación real</p></div><span class="agenda-audience">Familia</span></div>` : ""}</div></section>
      </div>
      <div class="alert info mt-16">${icon("info")}<div><strong>Integración pendiente</strong><p>En producción se importaría únicamente un calendario dedicado a la casa, con filtrado por rol y sin copiar eventos personales.</p></div></div>
    </div>`;
}

function renderMore() {
  const items = [
    { route: "calendar", icon: "calendar", title: "Calendario", copy: "Hoy y esta semana" },
    { route: "contacts", icon: "phone", title: "Contactos", copy: "Familia, salud y servicios" },
    { route: "emergency", icon: "shield", title: "Emergencias", copy: "Cacheada tras la primera carga" },
    { route: "search", icon: "search", title: "Buscar", copy: "En toda la casa" },
  ].filter((item) => canAccess(state.role, item.route));
  main.innerHTML = `<div class="page"><header class="page-header"><div><div class="eyebrow"><span class="eyebrow-dot"></span>Más herramientas</div><h1 class="page-title">Todo lo demás</h1><p class="page-subtitle">Accesos rápidos a la información compartida.</p></div></header><div class="more-grid">${items.map((item) => `<button class="card more-card" data-route="${item.route}"><span class="space-icon">${icon(item.icon)}</span><span><h2>${item.title}</h2><p>${item.copy}</p></span>${icon("chevron")}</button>`).join("")}</div><div class="section-heading"><div><h2>Cuenta de demostración</h2><p>El rol se obtiene de la sesión local autenticada.</p></div></div><button class="card more-card full" data-action="open-role-switcher"><span class="avatar">${currentProfile().initials}</span><span><h2>${escapeHtml(currentProfile().name)}</h2><p>${escapeHtml(ROLE_LABELS[state.role])} · ${escapeHtml(authenticatedUser?.email || "")}</p></span>${icon("chevron")}</button></div>`;
}

function renderAccessDenied(message = "Tu perfil no tiene acceso al módulo laboral.") {
  main.innerHTML = `<div class="page access-denied"><div class="access-denied-inner"><span class="empty-icon">${icon("shield")}</span><h1>Esta información no forma parte de tu acceso</h1><p>${escapeHtml(message)} Esta demo aplica la restricción en la interfaz; producción deberá reforzarla con autenticación y RLS en el backend.</p><button class="button primary" data-route="today">Volver a Hoy</button></div></div>`;
  hydrateIcons(main);
}

function renderNotFound() {
  main.innerHTML = `<div class="page access-denied"><div class="access-denied-inner"><span class="empty-icon">${icon("search")}</span><h1>No encontramos esta pantalla</h1><p>Puede que el enlace haya cambiado o que no forme parte de tu acceso.</p><button class="button primary" data-route="today">Ir a Hoy</button></div></div>`;
}

function getAllWikiPages() {
  return [...wikiPages, ...state.customWikiPages].map((page) => state.wikiEdits[page.slug]
    ? { ...page, body: state.wikiEdits[page.slug], updated: "Editada localmente" }
    : page);
}

function showModal({ title, subtitle = "", body = "", footer = "", wide = false, labelledBy = "modal-title" }) {
  if (!modalLayer.firstElementChild) lastFocusedElement = document.activeElement;
  modalLayer.innerHTML = `
    <div class="modal-backdrop" data-action="backdrop-close">
      <section class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="${labelledBy}" data-modal-panel>
        <header class="modal-header"><div><h2 id="${labelledBy}">${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div><button class="modal-close" data-action="close-modal" aria-label="Cerrar">${icon("close")}</button></header>
        <div class="modal-body">${body}</div>
        ${footer ? `<footer class="modal-footer">${footer}</footer>` : ""}
      </section>
    </div>`;
  document.body.classList.add("modal-open");
  hydrateIcons(modalLayer);
  requestAnimationFrame(() => modalLayer.querySelector("[autofocus], .modal-close, button, input")?.focus());
}

function closeModal() {
  if (!modalLayer.firstElementChild) return;
  modalLayer.innerHTML = "";
  document.body.classList.remove("modal-open");
  lastFocusedElement?.focus?.();
  lastFocusedElement = null;
}

function showRolePopover(trigger) {
  closePopover();
  const active = currentProfile();
  lastPopoverTrigger = trigger;
  popoverLayer.innerHTML = `<div class="role-popover" role="menu" aria-label="Cuenta demo"><div class="popover-head">Cuenta demo activa</div><div class="role-option account-summary"><span class="avatar">${active.initials}</span><span><strong>${escapeHtml(active.name)}</strong><span>${escapeHtml(ROLE_LABELS[active.role])}</span><small>${escapeHtml(authenticatedUser?.email || "")}</small></span><span class="selected-mark">${icon("check")}</span></div><button class="role-option" role="menuitem" data-action="logout"><span class="avatar">${icon("arrowLeft")}</span><span><strong>Cerrar sesión</strong><span>Entrar con otra cuenta demo</span></span></button><div class="popover-note">Los permisos de esta sesión vienen de la cuenta autenticada. Para cambiar de rol, cierra sesión.</div></div>`;
  positionPopover(trigger, popoverLayer.firstElementChild, "up");
  hydrateIcons(popoverLayer);
  trigger?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => popoverLayer.querySelector('[role="menuitem"]')?.focus());
}

function showNotifications(trigger) {
  closePopover();
  lastPopoverTrigger = trigger;
  const totals = calculateSettlement(settlementLines);
  const payment = paymentSummary(totals.transferTotal, state.payments, state.employeeConfirmedAt);
  let items = "";
  if (isFamilyRole()) {
    const extraItem = state.role === "family_admin"
      ? (state.extraResolution ? `<button class="notification-item" data-action="open-work-tab"><span class="notification-symbol">${icon("check")}</span><span><strong>Jornada extra resuelta en la demo</strong><p>La tarifa quedó congelada al resolver.</p><time>Estado local</time></span></button>` : `<button class="notification-item" data-action="notification-extra"><span class="notification-symbol">${icon("alert")}</span><span><strong>Ana registró una libranza trabajada</strong><p>Confirma si se pagará o se compensará con descanso.</p><time>Dato de demostración</time></span></button>`)
      : `<button class="notification-item" data-action="open-work-tab"><span class="notification-symbol">${icon("eye")}</span><span><strong>Expediente disponible en lectura</strong><p>Los cambios laborales requieren una cuenta administradora.</p><time>Cuenta familiar</time></span></button>`;
    items = `${extraItem}<button class="notification-item" data-action="open-settlement"><span class="notification-symbol">${icon("wallet")}</span><span><strong>Liquidación histórica de marzo 2025</strong><p>${payment.state === "confirmed" ? "Cobro confirmado por ambas partes." : payment.state === "paid" ? "Pagada; falta la confirmación de Ana." : `Pendiente local: ${formatCurrency(payment.pending)}.`}</p><time>Dato de demostración</time></span></button>`;
  } else if (state.role === "employee_live_in") {
    items = `<button class="notification-item" data-action="open-settlement"><span class="notification-symbol">${icon("receipt")}</span><span><strong>Liquidación histórica de marzo 2025</strong><p>${payment.state === "paid" ? "Puedes confirmar el cobro." : payment.state === "confirmed" ? "Cobro confirmado." : "Puedes revisar cada línea y su origen."}</p><time>Dato de demostración</time></span></button><button class="notification-item" data-route="menu"><span class="notification-symbol">${icon("utensils")}</span><span><strong>Menú del jueves</strong><p>Pollo y verduras al horno para todos.</p><time>Semana demo · agosto</time></span></button>`;
  } else if (state.role === "viewer") {
    items = `<button class="notification-item" data-route="calendar"><span class="notification-symbol">${icon("calendar")}</span><span><strong>Agenda operativa de hoy</strong><p>Solo se muestran eventos necesarios para el cuidado.</p><time>Acceso puntual</time></span></button><button class="notification-item" data-route="emergency"><span class="notification-symbol">${icon("shield")}</span><span><strong>Emergencias disponibles</strong><p>Teléfonos e información crítica en un toque.</p><time>Acceso puntual</time></span></button>`;
  } else {
    items = `<button class="notification-item" data-route="menu"><span class="notification-symbol">${icon("utensils")}</span><span><strong>Consulta el menú de hoy</strong><p>Platos, notas y alergias están disponibles offline.</p><time>Datos de demostración</time></span></button><button class="notification-item" data-route="emergency"><span class="notification-symbol">${icon("shield")}</span><span><strong>Emergencias disponibles</strong><p>Teléfonos e información crítica en un toque.</p><time>Acceso operativo</time></span></button>`;
  }
  popoverLayer.innerHTML = `<section class="notification-popover" role="dialog" aria-label="Notificaciones de demostración"><div class="notification-head"><h3>Notificaciones</h3><span class="chip">Demo</span></div>${items}</section>`;
  positionPopover(trigger, popoverLayer.firstElementChild, "down");
  hydrateIcons(popoverLayer);
  trigger?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => popoverLayer.querySelector("button, a[href]")?.focus());
}

function positionPopover(trigger, popover, direction = "down") {
  if (!trigger || !popover) return;
  const rect = trigger.getBoundingClientRect();
  const width = direction === "up" ? 310 : 370;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
  popover.style.left = `${left}px`;
  popover.style.top = direction === "up" ? `${Math.max(12, rect.top - 240)}px` : `${Math.min(window.innerHeight - 320, rect.bottom + 8)}px`;
}

function closePopover() {
  const restoreTarget = lastPopoverTrigger;
  popoverLayer.innerHTML = "";
  document.querySelectorAll('[aria-expanded="true"]').forEach((node) => node.setAttribute("aria-expanded", "false"));
  lastPopoverTrigger = null;
  restoreTarget?.focus?.();
}

function showToast(title, message = "", actionLabel = "") {
  clearTimeout(toastTimer);
  toastRegion.innerHTML = `<div class="toast" role="status">${icon("check")}<span><strong>${escapeHtml(title)}</strong>${message ? `<p>${escapeHtml(message)}</p>` : ""}</span>${actionLabel ? `<button data-action="dismiss-toast">${escapeHtml(actionLabel)}</button>` : ""}</div>`;
  hydrateIcons(toastRegion);
  toastTimer = window.setTimeout(() => dismissToast(), 4300);
}

function dismissToast() {
  const toast = toastRegion.querySelector(".toast");
  if (!toast) return;
  toast.classList.add("is-leaving");
  window.setTimeout(() => { toastRegion.innerHTML = ""; }, 230);
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatCivilDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" }).format(new Date(year, month - 1, day));
}

function formatCivilDateLong(value) {
  if (!value) return "Fecha sin indicar";
  const [year, month, day] = value.split("-").map(Number);
  const formatted = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(year, month - 1, day, 12));
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function getPendingExtraFacts(source = state.pendingExtra) {
  const extra = source || { date: "2025-04-06", startTime: "08:00", quantity: "full", registeredBy: "Ana" };
  const [year, month, day] = String(extra.date).split("-").map(Number);
  const weekday = new Date(year, month - 1, day, 12).getDay();
  const startTime = extra.startTime || "08:00";
  const isLeave = weekday === 0 || (weekday === 6 && startTime >= "14:00");
  const isHalf = extra.quantity === "half";
  const localAgreement = getActiveAgreementChange(extra.date);
  const agreementVersionId = localAgreement
    ? `agreement-v${localAgreement.version}`
    : extra.date >= "2026-01-01" ? "agreement-v3" : extra.date >= "2025-09-01" ? "agreement-v2" : "agreement-v1";
  return {
    dateLabel: formatCivilDateLong(extra.date),
    timeLabel: startTime,
    classificationLabel: isLeave ? "Libranza trabajada" : "Jornada extra ordinaria",
    quantityLabel: isHalf ? "Media jornada" : "Jornada completa",
    compensationLabel: isHalf ? "medio día libre" : "1 día libre",
    rate: isHalf ? 38 : 70,
    agreementVersionId,
  };
}

function todayCivil() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addCivilDays(value, amount) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day + amount, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getLocalAgreementChanges() {
  const stored = Array.isArray(state.agreementChanges) ? [...state.agreementChanges] : [];
  if (!stored.length && state.agreementVersion4) stored.push({ version: 4, ...state.agreementVersion4 });
  return stored
    .map((change, index) => ({ ...change, version: Number(change.version || index + 4) }))
    .sort((left, right) => left.validFrom.localeCompare(right.validFrom) || left.version - right.version);
}

function getActiveAgreementChange(referenceDate = todayCivil()) {
  return getLocalAgreementChanges().filter((change) => change.validFrom <= referenceDate).at(-1) || null;
}

const FAMILY_ADMIN_ACTIONS = new Set([
  "edit-agreement", "family-confirm-week", "open-extra-review", "resolve-pending-extra", "notification-extra",
  "choose-extra-resolution", "register-payment", "new-contact",
]);
const CONTENT_EDITOR_ACTIONS = new Set([
  "duplicate-week", "complete-duplicate-week", "edit-menu-slot", "new-wiki-page", "edit-wiki-page",
  "open-doc-gaps", "log-doc-gap",
]);
const EMPLOYEE_ACTIONS = new Set(["confirm-week", "add-exception", "confirm-receipt", "complete-receipt", "new-expense"]);
const EMPLOYMENT_ACTIONS = new Set([
  "open-settlement", "open-work-tab", "line-origin", "agreement-history", "open-week", "export-history",
  "export-balances", "print-receipt",
]);
const FULL_MENU_ACTIONS = new Set(["shopping-list", "toggle-shopping", "share-shopping"]);
const ROUTINE_ACTIONS = new Set(["routine-help", "toggle-routine"]);
const WIKI_ACTIONS = new Set(["open-recipe", "confirm-allergen", "recipe-scale", "wiki-filter-and-return"]);

function actionAllowedForRole(action) {
  if (FAMILY_ADMIN_ACTIONS.has(action)) return state.role === "family_admin";
  if (CONTENT_EDITOR_ACTIONS.has(action)) return canEditContent();
  if (EMPLOYEE_ACTIONS.has(action)) return state.role === "employee_live_in";
  if (EMPLOYMENT_ACTIONS.has(action)) return canAccess(state.role, "employment");
  if (FULL_MENU_ACTIONS.has(action)) return canAccess(state.role, "menu") && state.role !== "helper";
  if (ROUTINE_ACTIONS.has(action)) return canAccess(state.role, "routines");
  if (WIKI_ACTIONS.has(action)) return canAccess(state.role, "wiki");
  return true;
}

function rejectUnauthorizedAction() {
  showToast("Acción no disponible", "Cambia al perfil autorizado para probar este flujo de demostración.");
}

function downloadText(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function printDocument(title, content) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("El navegador bloqueó la ventana", "Permite ventanas emergentes para imprimir el documento.");
    return;
  }
  printWindow.opener = null;
  printWindow.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;color:#26302b;max-width:760px;margin:36px auto;padding:0 24px;line-height:1.5}header{border-bottom:3px solid #21483a;padding-bottom:18px;margin-bottom:22px}h1{margin:0;color:#21483a}h2{font-size:17px;margin:25px 0 8px}p{margin:6px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #ddd}th:last-child,td:last-child{text-align:right}.total{font-size:19px;font-weight:700;color:#21483a}.note{margin-top:28px;padding:13px;background:#f1f5f2;font-size:13px}@media print{body{margin:0;max-width:none}.no-print{display:none}}</style></head><body>${content}</body></html>`);
  printWindow.document.close();
  printWindow.setTimeout(() => printWindow.print(), 250);
}

function updateSyncState() {
  const sync = document.querySelector("#sync-state");
  if (!sync) return;
  const pending = state.outbox.length;
  sync.classList.toggle("is-pending", pending > 0 || !isEffectivelyOnline());
  sync.classList.toggle("is-error", state.storageWarning);
  sync.querySelector("span").textContent = state.storageWarning
    ? "Guardado durable no disponible"
    : pending ? `${pending} pendiente${pending === 1 ? "" : "s"}` : isEffectivelyOnline() ? "Sin cambios pendientes" : "Sin conexión";
}

function openLineOrigin(lineId) {
  const line = settlementLines.find((item) => item.id === lineId);
  if (!line) return;
  showModal({
    title: line.concept,
    subtitle: `${line.detail} · ${formatCurrency(line.amount, { showSign: line.amount > 0 })}`,
    body: `<div class="origin-intro"><div class="eyebrow">${escapeHtml(line.origin.eyebrow)}</div><h3>${escapeHtml(line.origin.title)}</h3><p>${escapeHtml(line.origin.body)}</p></div><div class="origin-meta">${line.origin.meta.map((meta) => `<div class="origin-meta-row">${icon("check")}<span>${escapeHtml(meta)}</span></div>`).join("")}</div><div class="alert info mt-20">${icon("lock")}<div><strong>Origen trazable</strong><p>La versión del acuerdo y la tarifa quedaron guardadas con esta línea al cerrar la liquidación.</p></div></div>`,
    footer: '<button class="button primary" data-action="close-modal">Entendido</button>',
  });
}

function openAgreementHistory() {
  const localChanges = getLocalAgreementChanges();
  const activeChange = getActiveAgreementChange();
  const localVersions = localChanges.map((change, index) => {
    const nextChange = localChanges[index + 1];
    return {
      version: change.version,
      status: change.validFrom > todayCivil() ? "Programada" : change.version === activeChange?.version ? "Vigente" : "Anterior",
      from: formatCivilDate(change.validFrom),
      to: nextChange ? `antes del ${formatCivilDate(nextChange.validFrom)}` : undefined,
      author: change.author || "Alberto",
      changes: [`Salario base: ${formatCurrency(change.salary)}`, `Motivo: ${change.reason || "Sin motivo indicado"}`],
    };
  }).reverse();
  const firstLocalChange = localChanges[0];
  const versions = [
    ...localVersions,
    ...agreementVersions.map((version) => version.version === 3 ? { ...version, status: activeChange ? "Anterior" : "Vigente", to: firstLocalChange ? `antes del ${formatCivilDate(firstLocalChange.validFrom)}` : undefined } : version),
  ];
  showModal({
    title: "Versiones del acuerdo",
    subtitle: "Nada se sobrescribe: cada cambio conserva vigencia y autoría.",
    wide: true,
    body: `<div class="version-list">${versions.map((version) => `<article class="version-row"><div class="version-row-head"><div><h3>Versión ${version.version} · ${version.status}</h3><p>${version.from}${version.to ? ` – ${version.to}` : version.status === "Programada" ? "" : " – hoy"} · creada por ${version.author}</p></div><span class="chip ${version.status === "Vigente" ? "success" : version.status === "Programada" ? "warning" : ""}">${version.status}</span></div><div class="diff-list">${version.changes.map((change) => `<div class="diff-item">${escapeHtml(change)}</div>`).join("")}</div></article>`).join("")}</div>`,
    footer: '<button class="button secondary" data-action="close-modal">Cerrar</button>',
  });
}

function openAgreementEditor() {
  const existing = getLocalAgreementChanges();
  const nextVersion = Math.max(3, ...existing.map((change) => change.version)) + 1;
  const latestDate = existing.at(-1)?.validFrom;
  const minimumDate = latestDate && latestDate >= todayCivil() ? addCivilDays(latestDate, 1) : todayCivil();
  showModal({
    title: "Crear una nueva versión",
    subtitle: "La versión actual seguirá disponible para todas las consultas históricas.",
    body: `<form id="agreement-form" class="form-grid"><div class="alert warning">${icon("info")}<div><strong>El cambio no es retroactivo</strong><p>Solo afectará a eventos a partir de la fecha de vigencia.</p></div></div><div class="form-row two"><label class="field"><span>Vigente desde</span><input class="input" name="validFrom" type="date" min="${minimumDate}" value="${minimumDate}" required></label><label class="field"><span>Salario base</span><span class="input-prefix"><input class="input" name="salary" type="number" min="0.01" step="0.01" value="1450.00" required><span>€</span></span></label></div><label class="field"><span>Motivo del cambio</span><textarea class="textarea" name="reason" placeholder="Explica qué se ha acordado y por qué" required></textarea></label></form>`,
    footer: `<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary" type="submit" form="agreement-form">Crear versión ${nextVersion}</button>`,
  });
}

function openWeekSummary() {
  const facts = getPendingExtraFacts();
  showModal({
    title: "Registro semanal · 31 mar–6 abr 2025",
    subtitle: state.weeklyConfirmed ? "Enviado por Ana y visible para la familia." : "Todavía no se ha enviado.",
    body: `<div class="origin-intro"><div class="eyebrow">Horario habitual</div><h3>Lunes a viernes · 08:00–17:00</h3><p>${state.pendingExtra ? `Excepción: ${facts.quantityLabel.toLocaleLowerCase("es")} el ${facts.dateLabel.toLocaleLowerCase("es")} a las ${facts.timeLabel}, clasificada como ${facts.classificationLabel.toLocaleLowerCase("es")}.` : "Sin excepciones registradas. La libranza empieza el sábado a las 14:00 y termina el lunes a las 08:00."}</p></div><div class="origin-meta"><div class="origin-meta-row">${icon(state.weeklyConfirmed ? "check" : "clock")}<span>${state.weeklyConfirmed && state.weeklySubmittedAt ? `Enviado ${formatDateTime(state.weeklySubmittedAt)}` : "Pendiente de envío por Ana"}</span></div><div class="origin-meta-row">${icon(state.weeklyFamilyConfirmed ? "check" : "shield")}<span>${state.weeklyFamilyConfirmed ? `Confirmado por la familia ${formatDateTime(state.weeklyFamilyConfirmedAt)}` : "La familia confirma sin modificar el registro de Ana."}</span></div></div>`,
    footer: '<button class="button primary" data-action="close-modal">Cerrar</button>',
  });
}

function openExceptionForm() {
  if (state.pendingExtra && !state.extraResolution) {
    showToast("Ya hay una excepción pendiente", "La familia debe resolverla antes de registrar otra en este prototipo.");
    return;
  }
  showModal({
    title: "Añadir una excepción",
    subtitle: "Cuenta qué fue distinto; la app clasifica el tipo automáticamente.",
    body: `<form id="exception-form" class="form-grid"><div class="form-row two"><label class="field"><span>Fecha trabajada</span><input class="input" name="date" type="date" value="2025-04-06" required></label><label class="field"><span>Hora de inicio</span><input class="input" name="startTime" type="time" value="08:00" required><small>El sábado la libranza empieza a las 14:00.</small></label></div><fieldset class="field" style="border:0;padding:0"><span>Cantidad</span><div class="segmented"><label><input type="radio" name="quantity" value="full" checked><span>Jornada completa</span></label><label><input type="radio" name="quantity" value="half"><span>Media jornada</span></label></div></fieldset><label class="field"><span>Nota opcional</span><textarea class="textarea" name="note" placeholder="Por ejemplo: la familia volvió tarde del viaje"></textarea></label><div class="alert info">${icon("shield")}<div><strong>El registro no desaparecerá</strong><p>Si trabajaste, queda anotado. La familia confirmará después si se paga o se compensa.</p></div></div></form>`,
    footer: '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary" type="submit" form="exception-form">Guardar excepción</button>',
  });
}

function openExtraReview() {
  if (!state.pendingExtra) state.pendingExtra = { date: "2025-04-06", startTime: "08:00", quantity: "full", note: "La familia volvió tarde del viaje", registeredBy: "Ana" };
  const facts = getPendingExtraFacts();
  saveState();
  if (state.extraResolution) {
    showModal({
      title: "Jornada resuelta",
      subtitle: `${facts.dateLabel} · ${facts.timeLabel}`,
      body: `<div class="origin-intro"><div class="eyebrow">Resolución congelada</div><h3>${state.extraResolution === "pay" ? `Pago de ${formatCurrency(state.pendingExtra.frozenRate ?? facts.rate)}` : `Compensación con ${facts.compensationLabel}`}</h3><p>Registrada con ${escapeHtml(state.pendingExtra.agreementVersionId || facts.agreementVersionId)}. Para cambiarla, producción necesitaría un ajuste explícito que conserve esta resolución.</p></div>`,
      footer: '<button class="button primary" data-action="close-modal">Cerrar</button>',
    });
    return;
  }
  showModal({
    title: facts.classificationLabel,
    subtitle: `${facts.dateLabel} · ${facts.timeLabel} · registrada por ${escapeHtml(state.pendingExtra.registeredBy || "Ana")}`,
    body: `<div class="origin-intro"><div class="eyebrow">Clasificación automática de demostración</div><h3>${facts.quantityLabel} · ${facts.classificationLabel.toLocaleLowerCase("es")}</h3><p>El prototipo cruza la fecha con el patrón semanal del acuerdo vigente. Nota registrada: ${escapeHtml(state.pendingExtra.note || "sin nota")}</p></div><div class="section-heading"><div><h2>¿Cómo debe resolverse?</h2><p>La tarifa se congelará ahora y quedará vinculada a este evento.</p></div></div><div class="stack-8"><button class="card more-card" data-action="choose-extra-resolution" data-resolution="pay"><span class="space-icon">${icon("wallet")}</span><span><h2>Pagar ${formatCurrency(facts.rate)}</h2><p>Quedará preparado para la próxima liquidación abierta</p></span>${icon("chevron")}</button><button class="card more-card" data-action="choose-extra-resolution" data-resolution="compensation"><span class="space-icon">${icon("sun")}</span><span><h2>Compensar con ${facts.compensationLabel}</h2><p>Creará un apunte local con caducidad y aviso previo</p></span>${icon("chevron")}</button></div>`,
    footer: '<button class="button secondary" data-action="close-modal">Resolver más tarde</button>',
  });
}

function openPaymentForm() {
  const totals = calculateSettlement(settlementLines);
  const payment = paymentSummary(totals.transferTotal, state.payments, state.employeeConfirmedAt);
  showModal({
    title: "Registrar un pago",
    subtitle: `Quedan ${formatCurrency(payment.pending)} por cubrir. Se admiten pagos parciales.`,
    body: `<form id="payment-form" class="form-grid"><div class="form-row two"><label class="field"><span>Importe</span><span class="input-prefix"><input class="input" name="amount" type="number" min="0.01" max="${payment.pending}" step="0.01" value="${payment.pending.toFixed(2)}" required autofocus><span>€</span></span></label><label class="field"><span>Fecha valor</span><input class="input" name="date" type="date" value="${todayCivil()}" required></label></div><label class="field"><span>Método</span><select class="select" name="method" required><option>Transferencia</option><option>Efectivo</option><option>Bizum</option><option>Mixto</option></select></label><label class="field"><span>Concepto o referencia</span><input class="input" name="reference" placeholder="Nómina marzo 2025" value="Nómina marzo 2025"></label><label class="upload-zone"><input class="sr-only" name="proof" type="file" accept="image/*,.pdf">${icon("camera")}<strong>Añadir justificante (opcional)</strong><span>Captura de transferencia, foto o PDF · no se persiste en esta demo</span></label><div class="alert info">${icon("info")}<div><strong>Dos confirmaciones distintas</strong><p>Tú registras que pagaste. Ana confirmará después que el dinero llegó.</p></div></div></form>`,
    footer: '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary" type="submit" form="payment-form">Registrar pago</button>',
  });
}

function openReceiptConfirmation() {
  const total = calculateSettlement(settlementLines).transferTotal;
  showModal({
    title: "Confirmar el cobro",
    subtitle: "Esta confirmación deja constancia de que el dinero ha llegado.",
    body: `<div class="origin-intro"><div class="eyebrow">Liquidación de marzo</div><h3>${formatCurrency(total)} recibidos</h3><p>La familia ha registrado pagos que cubren el total. Revisa el desglose antes de confirmar.</p></div><div class="alert warning mt-16">${icon("info")}<div><strong>Confirma solo cuando lo hayas recibido</strong><p>Si falta alguna parte, no confirmes todavía y coméntalo en la línea correspondiente.</p></div></div>`,
    footer: '<button class="button secondary" data-action="close-modal">Todavía no</button><button class="button primary" data-action="complete-receipt">Sí, he recibido el total</button>',
  });
}

function openExpenseForm() {
  showModal({
    title: "Registrar un gasto",
    subtitle: "Haz una foto primero; puedes completar los datos incluso sin conexión.",
    body: `<form id="expense-form" class="form-grid"><label class="upload-zone"><input class="sr-only" name="ticket" type="file" accept="image/*" capture="environment">${icon("camera")}<strong>Elegir foto del ticket</strong><span>El OCR es solo copy de demostración; la foto no se persiste</span></label><div class="form-row two"><label class="field"><span>Importe</span><span class="input-prefix"><input class="input" name="amount" type="number" min="0.01" step="0.01" placeholder="0,00" required><span>€</span></span></label><label class="field"><span>Fecha</span><input class="input" name="date" type="date" value="${todayCivil()}" required></label></div><label class="field"><span>Concepto</span><input class="input" name="concept" placeholder="Farmacia, supermercado…" required></label><div class="alert info">${icon("offline")}<div><strong>Estado local, también sin conexión</strong><p>Los campos quedan en este dispositivo y en la outbox. Esta demo no los envía a un servidor ni conserva el adjunto.</p></div></div></form>`,
    footer: '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary" type="submit" form="expense-form">Guardar gasto</button>',
  });
}

let activeRecipeId = null;
let activeRecipeServings = 4;

function requestRecipe(recipeId, skipWarning = false) {
  const recipe = recipes.find((item) => item.id === recipeId);
  if (!recipe) return;
  if (recipe.allergens.length && !skipWarning) {
    showModal({
      title: "Revisa una alergia antes de continuar",
      subtitle: "La seguridad alimentaria tiene prioridad.",
      body: `<div class="alert danger">${icon("alert")}<div><strong>Contiene ${recipe.allergens.join(", ").toLocaleLowerCase("es")}</strong><p>Marta tiene una alergia registrada a ${recipe.allergens.join(", ").toLocaleLowerCase("es")}. Si el plato se prepara para ella o en una zona compartida, evita servirlo y controla la contaminación cruzada.</p></div></div><div class="origin-intro mt-16"><div class="eyebrow">Aviso de la receta</div><h3>${escapeHtml(recipe.title)}</h3><p>La confirmación abre la ficha para revisar ingredientes; no certifica que el plato sea seguro para Marta.</p></div>`,
      footer: `<button class="button secondary" data-action="close-modal">Volver al menú</button><button class="button danger" data-action="confirm-allergen" data-recipe-id="${recipe.id}">Entiendo, revisar receta</button>`,
    });
    return;
  }
  openRecipe(recipeId, recipe.baseServings);
}

function openRecipe(recipeId, servings) {
  const recipe = recipes.find((item) => item.id === recipeId);
  if (!recipe) return;
  activeRecipeId = recipe.id;
  activeRecipeServings = servings;
  const ingredients = scaleIngredients(recipe, servings);
  showModal({
    title: recipe.title,
    subtitle: recipe.description,
    wide: true,
    body: `<div class="recipe-visual ${recipe.imageClass}" role="img" aria-label="Ilustración de ${escapeHtml(recipe.title)}"></div><div class="recipe-modal-head"><div class="flex-between"><div><h3>${escapeHtml(recipe.title)}</h3><div class="recipe-meta"><span>${icon("clock")} ${recipe.prep + recipe.cook} min</span><span>${icon("utensils")} ${servings} raciones</span>${recipe.allergens.length ? `<span class="chip danger">${recipe.allergens.join(", ")}</span>` : '<span class="chip success">Sin alérgenos registrados</span>'}</div></div><div class="servings-control" aria-label="Número de raciones"><button data-action="recipe-scale" data-direction="down" aria-label="Reducir raciones">−</button><strong>${servings}</strong><button data-action="recipe-scale" data-direction="up" aria-label="Aumentar raciones">+</button></div></div></div><div class="section-heading"><div><h2>Ingredientes</h2><p>Escalados desde ${recipe.baseServings} raciones</p></div></div><ul class="ingredient-list">${ingredients.map((ingredient) => `<li><span>${escapeHtml(ingredient.food)}</span><span>${String(ingredient.scaledAmount).replace(".", ",")} ${escapeHtml(ingredient.unit)}</span></li>`).join("")}</ul><div class="section-heading"><div><h2>Preparación</h2></div></div><ol class="step-list">${recipe.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`,
    footer: `<button class="button secondary" data-action="close-modal">Cerrar</button>${state.role === "helper" ? "" : '<button class="button primary" data-action="shopping-list">Ver lista de compra demo</button>'}`,
  });
}

const shoppingItems = [
  ["Calabaza", "800 g", "Fruta y verdura"], ["Patata", "1,4 kg", "Fruta y verdura"], ["Puerro", "2 ud", "Fruta y verdura"],
  ["Zanahoria", "3 ud", "Fruta y verdura"], ["Limón", "1 ud", "Fruta y verdura"], ["Lenteja pardina", "500 g", "Despensa"],
  ["Aceite de oliva", "1 botella", "Despensa"], ["Arroz", "500 g", "Despensa"], ["Tomate triturado", "500 ml", "Conservas"],
  ["Lomos de merluza", "4 ud", "Pescadería"], ["Pollo", "1,2 kg", "Carnicería"], ["Yogur vegetal", "6 ud", "Refrigerados"],
  ["Bebida de avena certificada sin leche", "2 l", "Refrigerados"], ["Huevos", "12 ud", "Refrigerados"],
].map(([name, quantity, section], index) => ({ id: `shop-${index}`, name, quantity, section }));

function openShoppingList() {
  const groups = groupBy(shoppingItems, "section");
  showModal({
    title: "Lista de la compra",
    subtitle: `${shoppingItems.length} productos de una lista semilla · disponible offline`,
    wide: true,
    body: Object.entries(groups).map(([section, items]) => `<section class="search-group"><div class="search-group-title"><span>${escapeHtml(section)}</span><span>${items.length}</span></div><div class="card">${items.map((item) => { const done = state.shoppingDone.includes(item.id); return `<button class="routine-row ${done ? "is-done" : ""}" style="width:100%;padding-inline:16px;text-align:left" data-action="toggle-shopping" data-id="${item.id}"><span class="check-control ${done ? "is-checked" : ""}"></span><span class="routine-copy"><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.quantity)}</p></span><span class="chip">${done ? "En cesta" : "Pendiente"}</span></button>`; }).join("")}</div></section>`).join(""),
    footer: '<button class="button secondary" data-action="close-modal">Cerrar</button><button class="button primary" data-action="share-shopping">Compartir lista</button>',
  });
}

function openDuplicateWeek() {
  showModal({
    title: "Duplicar la semana anterior",
    subtitle: "Se copiarán platos, notas de preparación y recetas enlazadas.",
    body: `<div class="origin-intro"><div class="eyebrow">27 jul–2 ago → 3–9 ago</div><h3>35 franjas de comida</h3><p>Esta demo conserva los platos semilla y marca la semana como duplicada para que puedas editarla.</p></div><div class="alert info mt-16">${icon("info")}<div><strong>No se copian marcas de la compra</strong><p>La lista empieza limpia para evitar arrastrar productos ya comprados.</p></div></div>`,
    footer: '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary" data-action="complete-duplicate-week">Duplicar semana</button>',
  });
}

function openMenuSlotEditor(slotIndex) {
  const base = weekMenu[state.selectedMenuDay].slots[slotIndex];
  const slot = { ...base, ...(state.menuEdits[`${state.selectedMenuDay}-${slotIndex}`] || {}) };
  showModal({
    title: `Editar ${slot.label.toLocaleLowerCase("es")}`,
    subtitle: `${weekMenu[state.selectedMenuDay].day}, ${weekMenu[state.selectedMenuDay].date} de agosto · ${slot.group}`,
    body: `<form id="menu-slot-form" class="form-grid"><input type="hidden" name="slot" value="${slotIndex}"><label class="field"><span>Plato o texto libre</span><input class="input" name="dish" value="${escapeHtml(slot.dish)}" required></label><label class="field"><span>Nota de preparación</span><textarea class="textarea" name="note" placeholder="Sin sal, dejar descongelando…">${escapeHtml(slot.note || "")}</textarea></label><label class="field"><span>Grupo de comensales</span><select class="select" name="group"><option ${slot.group === "Todos" ? "selected" : ""}>Todos</option><option ${slot.group === "Niños" ? "selected" : ""}>Niños</option><option ${slot.group === "Adultos" ? "selected" : ""}>Adultos</option></select></label></form>`,
    footer: '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary" type="submit" form="menu-slot-form">Guardar cambio</button>',
  });
}

function openWikiEditor(slug) {
  const page = getAllWikiPages().find((item) => item.slug === slug);
  if (!page) return;
  const content = state.wikiEdits[slug] || page.body;
  showModal({
    title: `Editar “${page.title}”`,
    subtitle: "En esta demo se guarda una edición local. El histórico completo requiere backend.",
    wide: true,
    body: `<form id="wiki-edit-form" class="form-grid"><input type="hidden" name="slug" value="${slug}"><label class="field"><span>Contenido</span><textarea class="textarea" name="content" style="min-height:330px" required>${escapeHtml(content)}</textarea><small>Puedes usar títulos, listas, negrita y enlaces [[por-slug]].</small></label><div class="alert info">${icon("history")}<div><strong>Edición local de prototipo</strong><p>La arquitectura prevista conservará revisión, autoría y diff en el backend.</p></div></div></form>`,
    footer: '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary" type="submit" form="wiki-edit-form">Guardar edición local</button>',
  });
}

function openNewWikiPage() {
  showModal({
    title: "Nueva página de la wiki",
    subtitle: "Empieza con lo necesario; el contenido crecerá con el uso.",
    body: `<form id="new-wiki-form" class="form-grid"><label class="field"><span>Título</span><input class="input" name="title" placeholder="Por ejemplo: Programa corto del lavavajillas" required autofocus></label><label class="field"><span>Espacio</span><select class="select" name="space"><option>Equipamiento</option><option>Estancias</option><option>Incidencias</option><option>Convivencia</option><option>Crianza</option><option>Mantenimiento</option></select></label><label class="field"><span>Alias domésticos</span><input class="input" name="aliases" placeholder="lavaplatos, programa rápido"><small>Separados por comas; ayudan a encontrarla con las palabras de casa.</small></label><label class="field"><span>Contenido</span><textarea class="textarea" name="content" placeholder="## Cómo hacerlo\nEscribe aquí los pasos…" required></textarea></label></form>`,
    footer: '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary" type="submit" form="new-wiki-form">Crear y publicar</button>',
  });
}

function openDocGaps() {
  const extra = state.loggedGaps.map((query, index) => ({ id: `local-${index}`, query, count: 1, variants: [], status: "Pendiente" }));
  const gaps = [...docGaps, ...extra];
  showModal({
    title: "Documentación pendiente",
    subtitle: "Ejemplos semilla y consultas exactas añadidas manualmente, sin identidad.",
    wide: true,
    body: `<div class="version-list">${gaps.map((gap) => `<article class="version-row"><div class="version-row-head"><div><h3>“${escapeHtml(gap.query)}”</h3><p>${gap.count} ${gap.count === 1 ? "búsqueda" : "búsquedas"}${gap.variants.length ? ` · variantes semilla: ${gap.variants.map(escapeHtml).join(", ")}` : ""}</p></div><span class="chip warning">${gap.status}</span></div><button class="button small secondary mt-12" data-action="new-wiki-page">${icon("plus")}Escribir página</button></article>`).join("")}</div><div class="alert info mt-16">${icon("shield")}<div><strong>Estado local de demostración</strong><p>Las nuevas entradas se guardan como texto exacto, sin identidad. El agrupado de variantes y la medición de clics requieren backend.</p></div></div>`,
    footer: '<button class="button secondary" data-action="close-modal">Cerrar</button>',
  });
}

function openNewContact() {
  showModal({
    title: "Añadir contacto",
    subtitle: "Los contactos pueden aparecer en la búsqueda y enlazarse desde la wiki.",
    body: `<form id="contact-form" class="form-grid"><label class="field"><span>Nombre</span><input class="input" name="title" required autofocus></label><label class="field"><span>Rol o servicio</span><input class="input" name="role" placeholder="Electricista, pediatra…" required></label><label class="field"><span>Teléfono</span><input class="input" name="phone" type="tel" required></label><label class="field"><span>Notas</span><textarea class="textarea" name="description" placeholder="Horario, póliza o instrucciones útiles"></textarea></label></form>`,
    footer: '<button class="button secondary" data-action="close-modal">Cancelar</button><button class="button primary" type="submit" form="contact-form">Guardar contacto</button>',
  });
}

function openContact(contactId) {
  const contact = [...contacts, ...state.customContacts].find((item) => item.id === contactId);
  if (!contact) return;
  showModal({
    title: contact.title,
    subtitle: contact.role,
    body: `<div class="origin-intro"><div class="eyebrow">Contacto de Casa Roble</div><h3>${escapeHtml(contact.displayPhone || contact.phone)}</h3><p>${escapeHtml(contact.description || "Sin notas adicionales")}</p></div><div class="shared-truth">${icon("book")}<p>Puede enlazarse desde páginas de equipamiento, incidencias o mantenimiento para encontrarlo en contexto.</p></div>`,
    footer: `<button class="button secondary" data-action="close-modal">Cerrar</button><a class="button primary" href="tel:${contact.phone}">${icon("phone")}Llamar</a>`,
  });
}

function openRoutineHelp(routineId) {
  const routine = routines.find((item) => item.id === routineId);
  if (!routine) return;
  const page = getAllWikiPages().find((item) => item.slug === routine.wiki);
  if (page) { navigate(`wiki/${page.slug}`); return; }
  showModal({
    title: routine.title,
    subtitle: `${routine.room} · ${routine.detail}`,
    body: `<div class="origin-intro"><div class="eyebrow">Cómo hacerlo</div><h3>Procedimiento enlazado a la wiki</h3><p>Esta rutina guarda únicamente cuándo toca. Las instrucciones viven en una página de la wiki para no duplicarlas.</p></div><div class="alert warning mt-16">${icon("alert")}<div><strong>La página todavía está pendiente</strong><p>Esta necesidad aparecerá en la cola de documentación para que la familia pueda completarla.</p></div></div>`,
    footer: '<button class="button primary" data-action="close-modal">Entendido</button>',
  });
}

function exportHistory() {
  const totals = calculateSettlement(settlementLines);
  const settlementState = paymentSummary(totals.transferTotal, state.payments, state.employeeConfirmedAt).state;
  const rows = [
    ["periodo", "tipo", "concepto", "importe_eur", "estado"],
    ...settlementLines.map((line) => ["2025-03", line.section, line.concept, line.amount.toFixed(2), settlementState]),
    ["2025-03", "total", "Total a transferir", totals.transferTotal.toFixed(2), settlementState],
    ...state.payments.map((payment) => ["2025-03", "pago", payment.method, Number(payment.amount).toFixed(2), "registrado"]),
  ];
  downloadText("casa-clara-historico-ana.csv", rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n"), "text/csv;charset=utf-8");
  showToast("Histórico exportado", "CSV descargado con liquidación, líneas y pagos.");
}

function printReceipt() {
  const totals = calculateSettlement(settlementLines);
  printDocument("Recibo de marzo 2025", `<header><h1>Casa Clara · Recibo de marzo 2025</h1><p>Ana · Casa Roble</p></header><table><thead><tr><th>Concepto</th><th>Detalle</th><th>Importe</th></tr></thead><tbody>${settlementLines.map((line) => `<tr><td>${escapeHtml(line.concept)}</td><td>${escapeHtml(line.detail)}</td><td>${formatCurrency(line.amount)}</td></tr>`).join("")}<tr class="total"><td colspan="2">Total a transferir</td><td>${formatCurrency(totals.transferTotal)}</td></tr></tbody></table><h2>Saldos resultantes</h2><p>1 día a devolver · anticipo pendiente 200,00 € · vacaciones pendientes 18 días</p><p class="note">Documento demostrativo generado desde el snapshot local de una liquidación cerrada. Referencia demo: CC-2025-03-A4F8.</p>`);
}

function printAuthorization() {
  printDocument("Autorización para asistencia médica", `<header><h1>Autorización para asistencia médica de menores</h1><p>Casa Roble · documento para situaciones en las que no se localice a los progenitores</p></header><p>Nosotros, Alberto Roble y Marta Roble, autorizamos a <strong>Ana</strong> a acompañar y consentir la atención médica urgente necesaria para:</p><h2>Menores autorizados</h2><p><strong>Marta Roble</strong> · nacida el 14/05/2018</p><p><strong>Leo Roble</strong> · nacido el 02/11/2021</p><h2>Información de seguridad</h2><p>Marta: alergia a proteína de leche y pescado. Autoinyector en el armario alto de la cocina.</p><p>Seguro SaludUno · póliza SAL-28491</p><h2>Contacto</h2><p>Alberto: 600 000 555 · Marta: 600 000 666</p><div style="display:flex;gap:80px;margin-top:70px"><div>Firma de Alberto<br><br>____________________</div><div>Firma de Marta<br><br>____________________</div></div><p class="note">Plantilla de demostración. La validez y redacción definitiva deben revisarse con asesoría jurídica y sanitaria.</p>`);
}

function handleDocumentClick(event) {
  const demoAccount = event.target.closest("[data-demo-email]");
  if (demoAccount) {
    event.preventDefault();
    const emailInput = document.querySelector('#demo-login-form [name="email"]');
    const passwordInput = document.querySelector('#demo-login-form [name="password"]');
    if (emailInput) emailInput.value = demoAccount.dataset.demoEmail;
    passwordInput?.focus();
    return;
  }
  const roleTrigger = event.target.closest("#role-switcher, #mobile-role-switcher, [data-action='open-role-switcher']");
  if (roleTrigger) {
    event.preventDefault();
    showRolePopover(roleTrigger);
    return;
  }
  const notificationTrigger = event.target.closest("#notifications-button");
  if (notificationTrigger) {
    event.preventDefault();
    showNotifications(notificationTrigger);
    return;
  }
  const searchTrigger = event.target.closest("#global-search-trigger, #mobile-search-fab");
  if (searchTrigger) {
    event.preventDefault();
    navigate("search");
    return;
  }

  const routeButton = event.target.closest("[data-route]");
  if (routeButton) {
    event.preventDefault();
    closeModal();
    navigate(routeButton.dataset.route);
    return;
  }

  const tab = event.target.closest("[data-employment-tab]");
  if (tab) {
    state.activeEmploymentTab = tab.dataset.employmentTab;
    saveState();
    renderEmployment();
    hydrateIcons(main);
    requestAnimationFrame(() => document.querySelector(`#employment-tab-${tab.dataset.employmentTab}`)?.focus());
    return;
  }

  const menuDay = event.target.closest("[data-menu-day]");
  if (menuDay) {
    state.selectedMenuDay = state.role === "helper" ? currentMenuDayIndex() : Number(menuDay.dataset.menuDay);
    saveState();
    renderMenu(); hydrateIcons(main);
    requestAnimationFrame(() => document.querySelector(`#menu-day-tab-${state.selectedMenuDay}`)?.focus());
    return;
  }
  const menuGroup = event.target.closest("[data-menu-group]");
  if (menuGroup) {
    state.menuGroup = menuGroup.dataset.menuGroup;
    saveState();
    renderMenu(); hydrateIcons(main);
    return;
  }
  const wikiSpace = event.target.closest("[data-wiki-space]");
  if (wikiSpace) {
    state.wikiSpace = wikiSpace.dataset.wikiSpace;
    saveState();
    renderWiki(); hydrateIcons(main);
    document.querySelector(".page-card-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const suggestion = event.target.closest("[data-search-suggestion]");
  if (suggestion) {
    state.searchQuery = suggestion.dataset.searchSuggestion;
    saveState();
    renderSearch(); hydrateIcons(main);
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) {
    if (popoverLayer.firstElementChild && !event.target.closest("#popover-layer")) closePopover();
    return;
  }
  const action = actionButton.dataset.action;
  if (action === "backdrop-close") {
    if (event.target === actionButton) closeModal();
    return;
  }
  event.preventDefault();

  if (!actionAllowedForRole(action)) {
    rejectUnauthorizedAction();
    return;
  }

  switch (action) {
    case "close-modal": closeModal(); break;
    case "dismiss-toast": dismissToast(); break;
    case "open-settlement":
      closeModal(); closePopover(); state.activeEmploymentTab = "settlement"; saveState(); navigate("employment"); break;
    case "open-work-tab":
      closeModal(); state.activeEmploymentTab = "work"; saveState(); navigate("employment"); break;
    case "line-origin": openLineOrigin(actionButton.dataset.lineId); break;
    case "agreement-history": openAgreementHistory(); break;
    case "edit-agreement": openAgreementEditor(); break;
    case "confirm-week": confirmWeek(); break;
    case "family-confirm-week": confirmFamilyWeek(); break;
    case "open-week": openWeekSummary(); break;
    case "add-exception": openExceptionForm(); break;
    case "open-extra-review":
    case "resolve-pending-extra":
    case "notification-extra": closePopover(); openExtraReview(); break;
    case "choose-extra-resolution": completeExtraResolution(actionButton.dataset.resolution); break;
    case "register-payment": openPaymentForm(); break;
    case "confirm-receipt": openReceiptConfirmation(); break;
    case "complete-receipt": completeReceiptConfirmation(); break;
    case "new-expense": openExpenseForm(); break;
    case "export-history": exportHistory(); break;
    case "export-balances": exportBalances(); break;
    case "print-receipt": printReceipt(); break;
    case "open-recipe": requestRecipe(actionButton.dataset.recipeId); break;
    case "confirm-allergen": openRecipe(actionButton.dataset.recipeId, recipes.find((item) => item.id === actionButton.dataset.recipeId)?.baseServings || 4); break;
    case "recipe-scale": scaleActiveRecipe(actionButton.dataset.direction); break;
    case "shopping-list": openShoppingList(); break;
    case "open-menu-result": state.selectedMenuDay = state.role === "helper" ? currentMenuDayIndex() : Number(actionButton.dataset.menuDay || 0); saveState(); navigate("menu"); break;
    case "toggle-shopping": toggleShopping(actionButton.dataset.id); break;
    case "share-shopping": shareShopping(); break;
    case "duplicate-week": openDuplicateWeek(); break;
    case "complete-duplicate-week": completeDuplicateWeek(); break;
    case "previous-menu-week":
    case "next-menu-week": showToast("Semana de demostración", "Este prototipo local solo incluye la semana del 3 al 9 de agosto."); break;
    case "edit-menu-slot": openMenuSlotEditor(Number(actionButton.dataset.slot)); break;
    case "new-wiki-page": openNewWikiPage(); break;
    case "edit-wiki-page": openWikiEditor(actionButton.dataset.slug); break;
    case "open-doc-gaps": openDocGaps(); break;
    case "log-doc-gap": logDocumentationGap(); break;
    case "wiki-filter-and-return": state.wikiSpace = actionButton.dataset.space; saveState(); navigate("wiki"); break;
    case "new-contact": openNewContact(); break;
    case "open-contact": openContact(actionButton.dataset.contactId); break;
    case "routine-help": openRoutineHelp(actionButton.dataset.id); break;
    case "toggle-routine": toggleRoutine(actionButton.dataset.id); break;
    case "clear-search": clearSearch(); break;
    case "print-emergency": window.print(); break;
    case "medical-authorization": printAuthorization(); break;
    case "logout": void signOutDemo(); break;
    default: break;
  }
}

function confirmWeek() {
  if (state.role !== "employee_live_in") { rejectUnauthorizedAction(); return; }
  if (state.weeklyConfirmed) { openWeekSummary(); return; }
  state.weeklyConfirmed = true;
  state.weeklySubmittedAt = new Date().toISOString();
  enqueueOffline({ id: `weekly-${Date.now()}`, type: "weekly_report", createdAt: state.weeklySubmittedAt });
  saveState();
  renderRoute();
  showToast("Semana registrada", isEffectivelyOnline() ? "La familia ya puede confirmarla en esta demo local." : "Guardada en este móvil y pendiente de un backend de sincronización.");
}

function confirmFamilyWeek() {
  if (!state.weeklyConfirmed || state.weeklyFamilyConfirmed || state.role !== "family_admin") return;
  state.weeklyFamilyConfirmed = true;
  state.weeklyFamilyConfirmedAt = new Date().toISOString();
  saveState();
  renderRoute();
  showToast("Semana confirmada", "Ana y la familia ven ahora el mismo registro.");
}

function completeExtraResolution(resolution) {
  if (state.role !== "family_admin" || !["pay", "compensation"].includes(resolution)) { rejectUnauthorizedAction(); return; }
  if (state.extraResolution) {
    showToast("Resolución ya congelada", "Este prototipo no permite sobrescribirla; haría falta un ajuste separado.");
    return;
  }
  const facts = getPendingExtraFacts();
  const eventId = state.pendingExtra?.id || `extra-${state.pendingExtra?.date || Date.now()}-${Date.now()}`;
  const resolvedEvent = { ...state.pendingExtra, id: eventId, resolution, frozenRate: facts.rate, resolvedAt: new Date().toISOString(), agreementVersionId: facts.agreementVersionId };
  state.extraResolution = resolution;
  state.pendingExtra = resolvedEvent;
  state.extraEvents = [...(state.extraEvents || []).filter((event) => event.id !== eventId), resolvedEvent];
  saveState();
  closeModal();
  renderRoute();
  showToast(resolution === "pay" ? "Resuelta como pago" : "Resuelta como descanso", resolution === "pay" ? `${formatCurrency(facts.rate)} quedan preparados para la próxima liquidación abierta.` : `Se ha creado ${facts.compensationLabel} local con aviso de caducidad.`);
}

function completeReceiptConfirmation() {
  const totals = calculateSettlement(settlementLines);
  const payment = paymentSummary(totals.transferTotal, state.payments, state.employeeConfirmedAt);
  if (state.role !== "employee_live_in" || payment.state !== "paid") { rejectUnauthorizedAction(); return; }
  state.employeeConfirmedAt = new Date().toISOString();
  saveState();
  closeModal();
  renderRoute();
  showToast("Cobro confirmado", "El ciclo de marzo queda completo para ambas partes.");
}

function toggleRoutine(id) {
  const wasDone = state.routineDone.includes(id);
  state.routineDone = wasDone ? state.routineDone.filter((item) => item !== id) : [...state.routineDone, id];
  enqueueOffline({ id: `routine-${id}-${Date.now()}`, type: "routine_completion", routineId: id, done: !wasDone, createdAt: new Date().toISOString() });
  saveState();
  renderRoute();
  showToast(wasDone ? "Rutina marcada como pendiente" : "Rutina marcada como hecha", isEffectivelyOnline() ? "Solo sirve como recordatorio." : "Cambio guardado en este móvil.");
}

function toggleShopping(id) {
  state.shoppingDone = state.shoppingDone.includes(id) ? state.shoppingDone.filter((item) => item !== id) : [...state.shoppingDone, id];
  saveState();
  openShoppingList();
}

async function shareShopping() {
  const pending = shoppingItems.filter((item) => !state.shoppingDone.includes(item.id));
  const text = pending.map((item) => `• ${item.name} · ${item.quantity}`).join("\n");
  if (navigator.share) {
    try { await navigator.share({ title: "Lista de la compra · Casa Clara", text }); return; } catch (error) { if (error?.name === "AbortError") return; }
  }
  downloadText("lista-de-la-compra.txt", text);
  showToast("Lista preparada", "Se ha descargado como texto para compartirla.");
}

function completeDuplicateWeek() {
  if (!canEditContent()) { rejectUnauthorizedAction(); return; }
  state.duplicatedWeek = true;
  state.shoppingDone = [];
  saveState();
  closeModal();
  renderRoute();
  showToast("Duplicado simulado", "La semana semilla queda lista para editar en este prototipo local.");
}

function scaleActiveRecipe(direction) {
  const next = Math.max(1, Math.min(12, activeRecipeServings + (direction === "up" ? 1 : -1)));
  openRecipe(activeRecipeId, next);
}

function logDocumentationGap() {
  const query = state.searchQuery.trim();
  if (!query || state.loggedGaps.includes(query)) return;
  state.loggedGaps.push(query);
  saveState();
  const results = document.querySelector("#search-results");
  if (results) { results.innerHTML = renderSearchResults(query); hydrateIcons(results); }
  showToast("Añadido a documentación pendiente", "La consulta exacta queda guardada localmente, sin identificar a la persona.");
}

function clearSearch() {
  state.searchQuery = "";
  saveState();
  renderSearch();
  hydrateIcons(main);
}

function exportBalances() {
  const csv = "fecha,tipo,concepto,cantidad\n2025-03-31,vacaciones,Devengo marzo,2.5 días\n2025-03-04,vacaciones,Disfrutadas,-2 días\n2025-03-23,compensación,Libranza trabajada,1 día\n2025-03-31,anticipo,Cuota marzo,-100.00 EUR";
  downloadText("casa-clara-saldos-marzo.csv", csv, "text/csv;charset=utf-8");
  showToast("Saldos exportados", "CSV generado desde el libro de movimientos.");
}

function handleFormSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.id === "demo-login-form") {
    void submitDemoLogin(form);
    return;
  }
  const values = Object.fromEntries(new FormData(form).entries());

  if (form.id === "agreement-form") {
    if (state.role !== "family_admin") { rejectUnauthorizedAction(); return; }
    if (!values.validFrom || values.validFrom < todayCivil()) {
      form.querySelector("[name='validFrom']")?.focus();
      showToast("Revisa la fecha de vigencia", "Una nueva versión no puede aplicarse de forma retroactiva.");
      return;
    }
    const salary = Number(values.salary);
    if (!Number.isFinite(salary) || salary <= 0) {
      form.querySelector("[name='salary']")?.focus();
      showToast("Revisa el salario", "Debe ser un importe mayor que cero.");
      return;
    }
    const reason = String(values.reason || "").trim();
    if (!reason) {
      form.querySelector("[name='reason']")?.focus();
      showToast("Añade el motivo", "La nueva versión debe explicar qué se ha acordado.");
      return;
    }
    const existing = getLocalAgreementChanges();
    if (existing.at(-1)?.validFrom && values.validFrom <= existing.at(-1).validFrom) {
      form.querySelector("[name='validFrom']")?.focus();
      showToast("La fecha debe ser posterior", "Una nueva versión debe empezar después de todas las versiones ya creadas.");
      return;
    }
    const version = Math.max(3, ...existing.map((change) => change.version)) + 1;
    const agreementChange = { version, validFrom: values.validFrom, salary, reason, author: currentProfile().name, createdAt: new Date().toISOString() };
    state.agreementChanges = [...existing, agreementChange];
    state.agreementVersion4 = agreementChange;
    saveState(); closeModal(); renderRoute();
    showToast(`Versión ${version} creada`, `${agreementChange.validFrom <= todayCivil() ? "Ya está vigente" : "Queda programada"} desde ${formatCivilDate(values.validFrom)}; marzo sigue intacto.`);
    return;
  }
  if (form.id === "exception-form") {
    if (state.role !== "employee_live_in") return;
    if (state.pendingExtra && !state.extraResolution) {
      showToast("Ya hay una excepción pendiente", "Debe resolverse antes de registrar otra.");
      return;
    }
    if (state.pendingExtra && state.extraResolution) {
      const archivedId = state.pendingExtra.id || `extra-archive-${Date.now()}`;
      const archived = { ...state.pendingExtra, id: archivedId, resolution: state.extraResolution };
      state.extraEvents = [...(state.extraEvents || []).filter((item) => item.id !== archivedId), archived];
    }
    const eventId = `extra-${Date.now()}`;
    state.pendingExtra = { id: eventId, date: values.date, startTime: values.startTime, quantity: values.quantity, note: values.note, registeredBy: currentProfile().name, createdAt: new Date().toISOString() };
    state.extraResolution = null;
    state.weeklyConfirmed = true;
    state.weeklySubmittedAt = new Date().toISOString();
    state.weeklyFamilyConfirmed = false;
    state.weeklyFamilyConfirmedAt = null;
    enqueueOffline({ id: eventId, type: "extra_work_event", ...state.pendingExtra });
    saveState(); closeModal(); renderRoute();
    showToast("Excepción registrada", isEffectivelyOnline() ? "La familia confirmará cómo debe resolverse en esta demo." : "Guardada localmente y pendiente de un backend de sincronización.");
    return;
  }
  if (form.id === "payment-form") {
    if (state.role !== "family_admin") { rejectUnauthorizedAction(); return; }
    const totals = calculateSettlement(settlementLines);
    const summary = paymentSummary(totals.transferTotal, state.payments, state.employeeConfirmedAt);
    const amount = Number(values.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > summary.pending + 0.001) {
      form.querySelector("[name='amount']")?.focus();
      showToast("Revisa el importe", `Debe estar entre 0,01 € y ${formatCurrency(summary.pending)}.`);
      return;
    }
    const payment = { id: `payment-${Date.now()}`, amount, date: values.date, method: values.method, reference: values.reference, registeredAt: new Date().toISOString() };
    state.payments.push(payment);
    enqueueOffline({ id: `outbox-${payment.id}`, type: "payment", payment, createdAt: payment.registeredAt });
    saveState(); closeModal(); renderRoute();
    const next = paymentSummary(totals.transferTotal, state.payments, state.employeeConfirmedAt);
    showToast(next.state === "paid" ? "Total pagado" : "Pago parcial registrado", next.state === "paid" ? "Ahora Ana puede confirmar que lo ha recibido." : `Quedan ${formatCurrency(next.pending)} por cubrir.`);
    return;
  }
  if (form.id === "expense-form") {
    if (state.role !== "employee_live_in") { rejectUnauthorizedAction(); return; }
    const expense = { id: `expense-${Date.now()}`, amount: Number(values.amount), date: values.date, concept: values.concept, status: isEffectivelyOnline() ? "pending" : "queued" };
    state.expenses.push(expense);
    enqueueOffline({ id: `outbox-${expense.id}`, type: "expense", expense, createdAt: new Date().toISOString() });
    saveState(); closeModal(); renderRoute();
    showToast("Gasto guardado en la demo", isEffectivelyOnline() ? "Queda en el estado local; no se ha enviado a un servidor." : "Queda en este móvil y no incluye la foto seleccionada.");
    return;
  }
  if (form.id === "menu-slot-form") {
    if (!canEditContent()) { rejectUnauthorizedAction(); return; }
    const key = `${state.selectedMenuDay}-${values.slot}`;
    state.menuEdits[key] = { dish: values.dish, note: values.note, group: values.group };
    saveState(); closeModal(); renderRoute();
    showToast("Menú actualizado", "El cambio queda visible para todos los perfiles con acceso.");
    return;
  }
  if (form.id === "wiki-edit-form") {
    if (!canEditContent()) { rejectUnauthorizedAction(); return; }
    state.wikiEdits[values.slug] = values.content;
    saveState(); closeModal(); renderRoute();
    showToast("Edición local guardada", "El histórico de revisiones completo requiere el backend previsto.");
    return;
  }
  if (form.id === "new-wiki-form") {
    if (!canEditContent()) { rejectUnauthorizedAction(); return; }
    const title = String(values.title || "").trim();
    const slug = slugify(title);
    if (!slug) {
      form.querySelector("[name='title']")?.focus();
      showToast("Añade un título válido", "Debe contener al menos una letra o un número.");
      return;
    }
    if (getAllWikiPages().some((item) => item.slug === slug) || recipes.some((item) => item.id === slug)) {
      form.querySelector("[name='title']")?.focus();
      showToast("Ese título ya existe", "Usa un título más específico para crear una URL distinta.");
      return;
    }
    const page = { id: `wiki-custom-${Date.now()}`, type: "wiki", slug, title, space: values.space, description: firstSentence(values.content), aliases: String(values.aliases || "").split(",").map((item) => item.trim()).filter(Boolean), tags: [values.space], popularity: 0, updated: "Ahora", icon: values.space === "Incidencias" ? "bolt" : "book", pinned: false, body: values.content };
    state.customWikiPages.push(page);
    saveState(); closeModal(); navigate(`wiki/${slug}`);
    showToast("Página publicada", "Ya forma parte de la búsqueda y de su espacio.");
    return;
  }
  if (form.id === "contact-form") {
    if (state.role !== "family_admin") { rejectUnauthorizedAction(); return; }
    const phone = normalizePhone(values.phone);
    if (!phone) {
      form.querySelector("[name='phone']")?.focus();
      showToast("Revisa el teléfono", "Usa solo cifras, espacios y un prefijo internacional opcional.");
      return;
    }
    const contact = { id: `contact-custom-${Date.now()}`, type: "contact", title: values.title, role: values.role, phone, displayPhone: values.phone, description: values.description, aliases: [values.role], tags: ["contacto"], popularity: 0 };
    state.customContacts.push(contact);
    saveState(); closeModal(); renderRoute();
    showToast("Contacto guardado", "Ya está disponible en el directorio y en la búsqueda.");
  }
}

function slugify(value) {
  return String(value).toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizePhone(value) {
  const compact = String(value || "").trim().replace(/[\s().-]/g, "");
  if (/^[6789]\d{8}$/.test(compact)) return `+34${compact}`;
  return /^(?:\+\d{8,15}|\d{3})$/.test(compact) ? compact : "";
}

function firstSentence(value) {
  return String(value).replace(/^#+\s*/gm, "").split(/[.!?\n]/)[0].trim().slice(0, 130) || "Nueva página de la casa";
}

function handleInput(event) {
  if (event.target.id !== "search-input") return;
  state.searchQuery = event.target.value;
  const clearButton = document.querySelector(".search-clear");
  clearButton?.classList.toggle("hidden", !state.searchQuery);
  const results = document.querySelector("#search-results");
  if (results) {
    const started = performance.now();
    results.innerHTML = renderSearchResults(state.searchQuery);
    results.dataset.latency = `${Math.round(performance.now() - started)}ms`;
    hydrateIcons(results);
  }
}

function handleKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("es") === "k") {
    event.preventDefault();
    if (!authenticatedUser || !canAccess(state.role, "search")) {
      if (authenticatedUser) rejectUnauthorizedAction();
      return;
    }
    closeModal();
    closePopover();
    navigate("search");
    return;
  }
  if (popoverLayer.firstElementChild && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    const items = [...popoverLayer.querySelectorAll('button:not([disabled]), a[href]')];
    if (items.length) {
      event.preventDefault();
      const current = Math.max(0, items.indexOf(document.activeElement));
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
      items[next].focus();
      return;
    }
  }
  const activeTab = event.target.closest?.('[role="tab"]');
  if (activeTab && ["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
    const tabs = [...activeTab.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]') || []];
    if (tabs.length) {
      event.preventDefault();
      const current = Math.max(0, tabs.indexOf(activeTab));
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
      return;
    }
  }
  if (event.key === "Escape") {
    if (modalLayer.firstElementChild) closeModal();
    else closePopover();
    return;
  }
  if (event.key === "Tab" && modalLayer.firstElementChild) {
    const focusable = [...modalLayer.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}

let lastOnlineState = null;
function handleNetworkChange(event) {
  if (event?.type === "online") offlineSession = false;
  if (event?.type === "offline") offlineSession = true;
  const online = isEffectivelyOnline();
  const banner = document.querySelector("#offline-banner");
  banner.hidden = online;
  document.body.classList.toggle("is-offline", !online);
  updateSyncState();
  if (online && lastOnlineState === false && state.outbox.length) {
    const count = state.outbox.length;
    showToast("Conexión recuperada", `${count} ${count === 1 ? "cambio local sigue" : "cambios locales siguen"} pendiente${count === 1 ? "" : "s"}; hace falta un backend para enviarlos y confirmar el ACK.`);
  }
  lastOnlineState = online;
}

async function rehydrateOutbox() {
  try {
    const records = await listQueuedOperations();
    const byId = new Map(state.outbox.map((operation) => [operation.id, operation]));
    records.forEach((operation) => byId.set(operation.id, operation));
    state.outbox = [...byId.values()].sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
    saveState();
  } catch {
    markStorageWarning();
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const register = () => navigator.serviceWorker.register("./sw.js").catch(() => {
    console.info("El service worker se activará al servir la app desde localhost o HTTPS.");
  });
  if (document.readyState === "complete") void register();
  else window.addEventListener("load", register, { once: true });
}

function showAuthError(message = "") {
  const error = document.querySelector("#auth-error");
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

async function populateDemoAccounts() {
  const container = document.querySelector("#demo-account-list");
  if (!container) return;
  try {
    const accounts = await listDemoAccounts();
    container.innerHTML = accounts.map((account) => `<button class="auth-account" type="button" data-demo-email="${escapeHtml(account.email)}"><strong>${escapeHtml(account.name)} · ${escapeHtml(ROLE_LABELS[account.role] || account.role)}</strong><span>${escapeHtml(account.email)}</span></button>`).join("");
  } catch {
    container.innerHTML = '<span class="auth-error">Inicia la demo con <code>npm run serve</code> para cargar las cuentas.</span>';
  }
}

function showAuthGate(message = "") {
  window.clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = null;
  authenticatedUser = null;
  offlineSession = false;
  authGate.hidden = false;
  appShell.hidden = true;
  bottomNavigation.hidden = true;
  mobileSearchButton.hidden = true;
  skipLink.hidden = true;
  document.querySelector("#offline-banner").hidden = true;
  document.title = "Entrar · Casa Clara";
  showAuthError(message);
  void populateDemoAccounts();
  requestAnimationFrame(() => document.querySelector('#demo-login-form [name="email"]')?.focus());
}

function saveCurrentCriticalSnapshot() {
  return saveCriticalSnapshot(`critical-v1-${currentProfile().id}`, {
    emergency: {
      number: "112",
      address: "C/ del Olmo, 24 · 3º A",
      allergies: ["Marta · proteína de leche y pescado", "Leo · huevo siempre bien cocinado"],
    },
    contacts,
    menu: canAccess(state.role, "menu") ? weekMenu : [],
    calendar: canAccess(state.role, "calendar") ? visibleCalendarEvents() : [],
    routines: canAccess(state.role, "routines") ? routines : [],
    wiki: canAccess(state.role, "wiki") ? getAllWikiPages().filter((page) => page.pinned && (!page.visibility || isFamilyRole())) : [],
    savedFor: currentProfile().id,
    role: state.role,
  });
}

function scheduleSessionExpiry(expiresAt) {
  window.clearTimeout(sessionExpiryTimer);
  const delay = Number(expiresAt) - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) {
    showAuthGate("La sesión demo ha caducado. Vuelve a entrar.");
    return false;
  }
  sessionExpiryTimer = window.setTimeout(() => {
    void logoutDemoUser().catch(() => undefined);
    showAuthGate("La sesión demo ha caducado. Vuelve a entrar.");
  }, Math.min(delay, 2_147_000_000));
  return true;
}

function startAuthenticatedApplication(user, { offline = false, expiresAt } = {}) {
  if (!profiles[user?.role]) throw new Error("La cuenta demo tiene un rol desconocido");
  authenticatedUser = user;
  offlineSession = offline;
  state.role = user.role;
  authGate.hidden = true;
  appShell.hidden = false;
  bottomNavigation.hidden = false;
  mobileSearchButton.hidden = !canAccess(state.role, "search");
  skipLink.hidden = false;
  saveState();
  updateProfileUI();
  if (!scheduleSessionExpiry(expiresAt)) return;

  const requestedModule = routeModule(routeName());
  if (!location.hash || (requestedModule && !canAccess(state.role, requestedModule))) {
    history.replaceState(null, "", "#today");
  }
  renderRoute();
  handleNetworkChange();
  void saveCurrentCriticalSnapshot().catch(() => markStorageWarning());

  if (!applicationStarted) {
    applicationStarted = true;
    void rehydrateOutbox();
    registerServiceWorker();
  }
  if (offline) showToast("Sesión demo sin conexión", "Se usa la última cuenta validada en esta pestaña; las escrituras quedarán pendientes.");
}

async function submitDemoLogin(form) {
  const submit = form.querySelector("#auth-submit");
  const values = Object.fromEntries(new FormData(form).entries());
  showAuthError();
  submit.disabled = true;
  submit.textContent = "Comprobando…";
  try {
    const session = await loginDemoUser(values.email, values.password);
    form.reset();
    startAuthenticatedApplication(session.user, { expiresAt: session.expiresAt });
  } catch (error) {
    showAuthError(error.status === 404 ? "El servidor de autenticación no está activo. Ejecuta npm run serve." : error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = "Entrar";
  }
}

async function signOutDemo() {
  closePopover();
  closeModal();
  try {
    await logoutDemoUser();
    showAuthGate();
  } catch {
    showAuthGate("La sesión se cerró en esta pestaña; el servidor no estaba disponible para invalidar la cookie.");
  }
}

async function init() {
  hydrateIcons(document);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("submit", handleFormSubmit);
  document.addEventListener("input", handleInput);
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("hashchange", () => {
    closeModal();
    if (authenticatedUser) renderRoute({ focusHeading: true });
  });
  window.addEventListener("online", handleNetworkChange);
  window.addEventListener("offline", handleNetworkChange);
  document.querySelector(".skip-link")?.addEventListener("click", (event) => {
    event.preventDefault();
    main.focus();
    main.scrollIntoView({ block: "start" });
  });
  try {
    const session = await restoreDemoSession();
    if (session.user) startAuthenticatedApplication(session.user, { offline: session.offline, expiresAt: session.expiresAt });
    else showAuthGate();
  } catch {
    showAuthGate("No se pudo contactar con el servidor demo. Ejecuta npm run serve y recarga la página.");
  }
}

void init();
