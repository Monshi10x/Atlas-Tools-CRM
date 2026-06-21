import { firebaseConfig, mapsApiKey } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseApp = initializeApp(firebaseConfig);
const firestore = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

let db = {
  version: 1,
  updatedAt: "",
  settings: {
    customerTypes: [
      "Sign Company",
      "Cabinet Maker",
      "Kitchen Maker",
      "Joinery",
      "CNC Shop",
      "Builder",
      "Other"
    ],
    customerStatuses: ["Lead", "Active", "Inactive", "Do Not Contact"],
    wipColumns: ["un-allocated", "samples sent", "lead to be contacted"],
    googleMapsApiKey: mapsApiKey
  },
  customers: []
};

let currentUser = null;
let customersUnsubscribe = null;
let settingsUnsubscribe = null;
let selectedCustomerId = null;
let map = null;
let geocoder = null;
let infoWindow = null;
let markers = [];
let appConsoleEntries = [];
let autocompleteInstances = [];
let mapScriptLoading = false;
let mapReady = false;
let mapInitialising = false;
let settingsSaveTimer = null;
let editorCleanSnapshot = "";
let editorAutosaveTimer = null;
let activeMovePin = null;
let wipSortableInstances = [];

const defaultCenter = { lat: -27.609, lng: 153.111 };

document.addEventListener("DOMContentLoaded", init);

function init() {
  bindConsoleCapture();
  bindEvents();

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;

    if (!user) {
      stopFirestoreListeners();
      document.getElementById("loginScreen").style.display = "grid";
      document.getElementById("appShell").style.display = "none";
      updateUserHeading();
      return;
    }

    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("appShell").style.display = "block";
    document.getElementById("signedInUser").textContent = user.email || user.uid;
    updateUserHeading();

    await ensureDefaultSettings();
    startFirestoreListeners();
    loadGoogleMaps();

    console.info("Atlas Tools CRM Firebase v1.4.0 loaded.");
  });
}

function bindConsoleCapture() {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };

  ["log", "info", "warn", "error"].forEach(method => {
    console[method] = (...args) => {
      original[method](...args);
      addConsoleMessage({
        level: method === "log" ? "info" : method === "warn" ? "warning" : method,
        source: "app",
        message: args.map(formatConsoleArg).join(" "),
        time: new Date().toISOString()
      });
    };
  });

  window.addEventListener("error", (event) => {
    addConsoleMessage({
      level: "error",
      source: "window.onerror",
      message: `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
      time: new Date().toISOString()
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    addConsoleMessage({
      level: "error",
      source: "unhandledrejection",
      message: formatConsoleArg(event.reason),
      time: new Date().toISOString()
    });
  });
}

function formatConsoleArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function addConsoleMessage(entry) {
  appConsoleEntries.push({
    level: entry.level || "info",
    source: entry.source || "app",
    message: entry.message || "",
    time: entry.time || new Date().toISOString()
  });
  if (appConsoleEntries.length > 500) appConsoleEntries = appConsoleEntries.slice(-500);
  renderAppConsole();
}

function renderAppConsole() {
  const el = document.getElementById("appConsole");
  if (!el) return;

  el.innerHTML = appConsoleEntries.map(e => {
    const cls = `console-${esc(e.level)}`;
    return `<span class="${cls}">[${esc(e.time)}] [${esc(e.level)}] [${esc(e.source)}] ${esc(e.message)}</span>`;
  }).join("\n");

  el.scrollTop = el.scrollHeight;
}

function bindIfExists(id, eventName, handler) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`Optional UI element #${id} was not found; skipping ${eventName} binding.`);
    return null;
  }
  el.addEventListener(eventName, handler);
  return el;
}

function bindEvents() {
  bindIfExists("loginForm", "submit", (event) => {
    event.preventDefault();
    login();
  });
  bindIfExists("loginButton", "click", (event) => {
    event.preventDefault();
    login();
  });
  bindIfExists("loginPassword", "keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      login();
    }
  });
  bindIfExists("logoutButton", "click", () => signOut(auth));

  document.querySelectorAll(".tab-button").forEach(btn => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
      closePageMenu();
    });
  });

  bindIfExists("menuToggle", "click", togglePageMenu);
  bindIfExists("menuClose", "click", closePageMenu);
  bindIfExists("menuScrim", "click", closePageMenu);

  document.addEventListener("click", handleDocumentClick);

  ["mapSearch", "mapTypeFilter", "mapStateFilter", "mapSuburbFilter", "mapStatusFilter",
   "customerSearch", "customerTypeFilter", "customerStatusFilter", "wipSearch"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) {
      console.warn(`Filter element #${id} was not found.`);
      return;
    }
    el.addEventListener("input", renderAll);
    el.addEventListener("change", renderAll);
  });

  bindIfExists("newCustomer", "click", newCustomer);
  bindIfExists("fitMap", "click", () => fitMapToMarkers(true));
  bindIfExists("clearFiltersMap", "click", clearFilters);
  bindIfExists("clearFiltersCards", "click", clearFilters);

  bindIfExists("importCsvButton", "click", () => document.getElementById("csvFileInput")?.click());
  bindIfExists("exportCsvButton", "click", exportCsv);
  bindIfExists("importJsonButton", "click", () => document.getElementById("jsonFileInput")?.click());
  bindIfExists("csvFileInput", "change", importCsvFile);
  bindIfExists("jsonFileInput", "change", importJsonFile);

  bindIfExists("toggleConsole", "click", toggleConsole);
  bindIfExists("clearConsole", "click", () => { appConsoleEntries = []; renderAppConsole(); });
  bindIfExists("copyConsole", "click", copyConsole);
  bindWipBoardPanning();
  bindIfExists("addCustomerType", "click", addCustomerType);
  bindIfExists("addCustomerStatus", "click", addCustomerStatus);
  bindIfExists("addWipColumn", "click", addWipColumn);

  bindIfExists("closeModal", "click", closeModal);
  bindIfExists("modal", "click", (e) => {
    if (e.target.id === "modal") closeModal();
  });
}

function togglePageMenu() {
  const nav = document.getElementById("tabsNav");
  const button = document.getElementById("menuToggle");
  const scrim = document.getElementById("menuScrim");
  const isOpen = nav?.classList.toggle("open");
  button?.setAttribute("aria-expanded", String(Boolean(isOpen)));
  if (scrim) scrim.hidden = !isOpen;
}

function closePageMenu() {
  document.getElementById("tabsNav")?.classList.remove("open");
  document.getElementById("menuToggle")?.setAttribute("aria-expanded", "false");
  const scrim = document.getElementById("menuScrim");
  if (scrim) scrim.hidden = true;
}

function handleDocumentClick(event) {
  const target = event.target?.closest?.("[data-action]");
  const action = target?.dataset?.action;
  if (!action) return;

  if (target.tagName === "BUTTON") event.stopPropagation();

  if (action === "new-customer") newCustomer();
  if (action === "edit-customer") editCustomer(target.dataset.id);
  if (action === "delete-customer") deleteCustomer(target.dataset.id);
  if (action === "focus-customer") focusCustomerOnMap(target.dataset.id);
  if (action === "open-customer") openCustomerDetails(target.dataset.id);
  if (action === "remove-contact") removeEditorContact(Number(target.dataset.index));
  if (action === "contact-prev") scrollContactTiles(-1);
  if (action === "contact-next") scrollContactTiles(1);
  if (action === "remove-address") removeEditorAddress(Number(target.dataset.index));
  if (action === "geocode-address") geocodeEditorAddress(Number(target.dataset.index));
  if (action === "move-pin") enablePinMove(target.dataset.customerId, target.dataset.addressId);
  if (action === "remove-type") removeCustomerType(Number(target.dataset.index));
  if (action === "remove-status") removeCustomerStatus(Number(target.dataset.index));
  if (action === "remove-wip-column") removeWipColumn(Number(target.dataset.index));
}

async function login() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const message = document.getElementById("loginMessage");

  try {
    message.textContent = "Signing in...";
    await signInWithEmailAndPassword(auth, email, password);
    message.textContent = "";
  } catch (error) {
    console.error("Login failed:", error);
    message.textContent = error.message;
  }
}

function stopFirestoreListeners() {
  if (customersUnsubscribe) customersUnsubscribe();
  if (settingsUnsubscribe) settingsUnsubscribe();
  customersUnsubscribe = null;
  settingsUnsubscribe = null;
}

async function ensureDefaultSettings() {
  const ref = doc(firestore, "settings", "global");
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      customerTypes: ensureOtherType(db.settings.customerTypes),
      customerStatuses: ensureLeadStatus(db.settings.customerStatuses),
      wipColumns: ensureWipColumns(db.settings.wipColumns),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }
}

function startFirestoreListeners() {
  stopFirestoreListeners();

  settingsUnsubscribe = onSnapshot(doc(firestore, "settings", "global"), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    db.settings = {
      ...db.settings,
      ...data,
      customerTypes: ensureOtherType(data.customerTypes || db.settings.customerTypes),
      customerStatuses: ensureLeadStatus(data.customerStatuses || db.settings.customerStatuses),
      wipColumns: ensureWipColumns(data.wipColumns || db.settings.wipColumns),
      googleMapsApiKey: mapsApiKey
    };
    renderEditor();
    renderAll();
  }, (error) => console.error("Settings listener failed:", error));

  customersUnsubscribe = onSnapshot(query(collection(firestore, "customers"), orderBy("companyName")), (snap) => {
    db.customers = snap.docs.map(d => normalizeCustomer({ id: d.id, ...d.data() }));
    db.updatedAt = new Date().toISOString();
    renderEditor();
    renderAll();
  }, (error) => console.error("Customers listener failed:", error));
}

function normalizeCustomer(c = {}) {
  return {
    id: c.id || uid(),
    companyName: c.companyName || "",
    customerType: c.customerType || db?.settings?.customerTypes?.[0] || "Other",
    status: c.status || db?.settings?.customerStatuses?.[0] || "Lead",
    wipColumn: c.wipColumn || db?.settings?.wipColumns?.[0] || "un-allocated",
    wipOrder: Number.isFinite(Number(c.wipOrder)) ? Number(c.wipOrder) : 0,
    phone: c.phone || "",
    email: c.email || "",
    notes: c.notes || "",
    lastContacted: c.lastContacted || "",
    contacts: Array.isArray(c.contacts) ? c.contacts.map(x => ({
      id: x.id || uid(),
      firstName: x.firstName || splitLegacyName(x.name).firstName,
      lastName: x.lastName || splitLegacyName(x.name).lastName,
      phone: x.phone || "",
      email: x.email || "",
      role: x.role || ""
    })) : [],
    addresses: Array.isArray(c.addresses) ? c.addresses.map(a => ({
      id: a.id || uid(),
      label: a.label || "Main",
      street: a.street || "",
      suburb: a.suburb || "",
      state: a.state || "",
      postcode: a.postcode || "",
      country: a.country || "Australia",
      lat: numOrNull(a.lat),
      lng: numOrNull(a.lng)
    })) : []
  };
}

function getUserDisplayName(user) {
  if (!user) return "User";

  if (user.displayName && user.displayName.trim()) {
    return user.displayName.trim();
  }

  const emailPrefix = (user.email || "").split("@")[0].trim();
  if (!emailPrefix) return "User";

  return emailPrefix
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function updateUserHeading() {
  const el = document.getElementById("displayUserName");
  if (el) el.textContent = getUserDisplayName(currentUser);
}

function uid() {
  return "id_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function splitLegacyName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : ""
  };
}

function contactFullName(contact) {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 3200);
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-button").forEach(b => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === tabId));

  if (tabId === "mapTab" && map && window.google) {
    setTimeout(() => {
      google.maps.event.trigger(map, "resize");
      fitMapToMarkers(false);
    }, 80);
  }

  if (tabId === "editorTab") setTimeout(initAddressAutocompletes, 120);
}

function renderAll() {
  renderTypeSelects();
  renderStatusSelects();
  renderCustomerCards();
  renderCustomerTypes();
  renderWipBoard();
  renderMapMarkers();
  renderStats();
}

function renderStats() {
  const visible = getVisibleCustomers("map");
  const pins = visible.flatMap(c => c.addresses.filter(hasCoords));

  document.getElementById("countCustomers").textContent = db.customers.length;
  document.getElementById("countVisibleCustomers").textContent = visible.length;
  document.getElementById("countVisiblePins").textContent = pins.length;
  document.getElementById("lastUpdated").textContent = db.updatedAt || "-";
  document.getElementById("fileStatus").textContent = currentUser ? "Firestore connected" : "Signed out";
  updateUserHeading();
}

function renderTypeSelects() {
  const selects = ["mapTypeFilter", "customerTypeFilter"];
  for (const id of selects) {
    const el = document.getElementById(id);
    if (!el) continue;
    const current = el.value;
    el.innerHTML = `<option value="">All customer types</option>` +
      db.settings.customerTypes.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    el.value = db.settings.customerTypes.includes(current) ? current : "";
  }
}

function renderStatusSelects() {
  const selects = ["mapStatusFilter", "customerStatusFilter"];
  for (const id of selects) {
    const el = document.getElementById(id);
    if (!el) continue;
    const current = el.value;
    el.innerHTML = `<option value="">All statuses</option>` +
      db.settings.customerStatuses.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    el.value = db.settings.customerStatuses.includes(current) ? current : "";
  }
}

function getFilters(prefix) {
  return {
    search: (document.getElementById(prefix + "Search")?.value || "").toLowerCase().trim(),
    type: document.getElementById(prefix + "TypeFilter")?.value || "",
    status: document.getElementById(prefix + "StatusFilter")?.value || "",
    suburb: (document.getElementById(prefix + "SuburbFilter")?.value || "").toLowerCase().trim(),
    state: (document.getElementById(prefix + "StateFilter")?.value || "").toLowerCase().trim()
  };
}

function getVisibleCustomers(prefix = "customer") {
  const f = getFilters(prefix);

  return db.customers.filter(c => {
    const haystack = [
      c.companyName, c.customerType, c.status, c.phone, c.email, c.notes, c.lastContacted,
      ...c.contacts.flatMap(x => [x.firstName, x.lastName, x.role, x.phone, x.email]),
      ...c.addresses.flatMap(a => [a.label, a.street, a.suburb, a.state, a.postcode, a.country])
    ].join(" ").toLowerCase();

    return (!f.search || haystack.includes(f.search)) &&
      (!f.type || c.customerType === f.type) &&
      (!f.status || c.status === f.status) &&
      (!f.suburb || c.addresses.some(a => String(a.suburb).toLowerCase().includes(f.suburb))) &&
      (!f.state || c.addresses.some(a => String(a.state).toLowerCase().includes(f.state)));
  });
}

function clearFilters() {
  ["mapSearch", "mapTypeFilter", "mapStateFilter", "mapSuburbFilter", "mapStatusFilter",
   "customerSearch", "customerTypeFilter", "customerStatusFilter", "wipSearch"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  renderAll();
}

function renderCustomerCards() {
  const host = document.getElementById("customerCards");
  const customers = getVisibleCustomers("customer");

  if (!customers.length) {
    host.innerHTML = `<div class="empty-state">No customers match the current filters.</div>`;
    return;
  }

  host.innerHTML = customers.map(c => `
    <article class="customer-card clickable-card" data-action="open-customer" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="View ${esc(c.companyName || "customer")} details">
      <div class="customer-card-title">
        <div>
          <h3>${esc(c.companyName || "Unnamed Company")}</h3>
          <div class="muted">${esc(c.status || "Lead")}</div>
        </div>
        <span class="badge"><span class="dot"></span>${esc(c.customerType || "Other")}</span>
      </div>

      <div class="card-line"><strong>Phone:</strong> ${esc(c.phone || "-")}</div>
      <div class="card-line"><strong>Email:</strong> ${esc(c.email || "-")}</div>
      <div class="card-line"><strong>Contacts:</strong> ${esc(c.contacts.map(contactFullName).filter(Boolean).join(", ") || "-")}</div>
      <div class="card-line"><strong>Addresses:</strong> ${esc(c.addresses.map(formatAddress).filter(Boolean).join(" | ") || "-")}</div>
      <div class="card-line"><strong>Notes:</strong> ${esc(c.notes || "-")}</div>

      <div class="card-actions">
        <button class="btn primary small" data-action="edit-customer" data-id="${esc(c.id)}">Edit</button>
        <button class="btn ghost small" data-action="focus-customer" data-id="${esc(c.id)}">Show on Map</button>
        <button class="btn danger small" data-action="delete-customer" data-id="${esc(c.id)}">Delete</button>
      </div>
    </article>
  `).join("");
}

function newCustomer() {
  selectedCustomerId = null;
  renderEditor();
  switchTab("editorTab");
}

function editCustomer(id) {
  closeModal();
  selectedCustomerId = id;
  renderEditor();
  switchTab("editorTab");
}

function getEditorCustomer() {
  if (!selectedCustomerId) {
    return normalizeCustomer({
      contacts: [{ id: uid(), firstName: "", lastName: "", phone: "", email: "", role: "" }],
      addresses: [{ id: uid(), label: "Main", street: "", suburb: "", state: "QLD", postcode: "", country: "Australia", lat: null, lng: null }]
    });
  }

  return structuredClone(db.customers.find(c => c.id === selectedCustomerId) || normalizeCustomer());
}

function renderEditor() {
  const c = getEditorCustomer();

  document.getElementById("editorHost").innerHTML = `
    <div class="form-row three">
      <div>
        <label>Company Name</label>
        <input id="editCompanyName" value="${esc(c.companyName)}" />
      </div>
      <div>
        <label>Customer Type</label>
        <select id="editCustomerType">${db.settings.customerTypes.map(t => `<option ${t === c.customerType ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      </div>
      <div>
        <label>Status</label>
        <select id="editStatus">
          ${db.settings.customerStatuses.map(s => `<option ${s === c.status ? "selected" : ""}>${esc(s)}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="form-row three">
      <div>
        <label>Main Contact Number</label>
        <input id="editPhone" value="${esc(c.phone)}" />
      </div>
      <div>
        <label>Main Email</label>
        <input id="editEmail" value="${esc(c.email)}" />
      </div>
      <div>
        <label>Last Contacted</label>
        <input id="editLastContacted" type="date" value="${esc(c.lastContacted)}" />
      </div>
    </div>

    <div class="form-row">
      <label>Notes</label>
      <textarea id="editNotes">${esc(c.notes)}</textarea>
    </div>

    <div class="panel margin-top">
      <div class="panel-title">
        <h3>Contact People</h3>
        <button class="btn primary small" id="addContactButton">Add Contact</button>
      </div>
      <div class="contact-carousel-controls">
        <button class="btn ghost small" data-action="contact-prev" type="button">Prev</button>
        <button class="btn ghost small" data-action="contact-next" type="button">Next</button>
      </div>
      <div id="editorContacts" class="contact-tiles"></div>
    </div>

    <div class="panel margin-top">
      <div class="panel-title">
        <div>
          <h3>Addresses</h3>
          <div class="muted">Start typing in “Address Search” to use Google Places Autocomplete.</div>
        </div>
        <button class="btn primary small" id="addAddressButton">Add Address</button>
      </div>
      <div id="editorAddresses" class="nested-list"></div>
    </div>
  `;

  window.editorDraft = c;
  document.getElementById("addContactButton").addEventListener("click", addEditorContact);
  document.getElementById("addAddressButton").addEventListener("click", addEditorAddress);
  editorCleanSnapshot = editorSnapshot(c);
  bindEditorDirtyTracking();
  updateSavePulse();
  renderEditorContacts();
  renderEditorAddresses();
}

function readBaseEditorIntoDraft() {
  const c = window.editorDraft || getEditorCustomer();
  c.companyName = document.getElementById("editCompanyName")?.value || "";
  c.customerType = document.getElementById("editCustomerType")?.value || "Other";
  c.status = document.getElementById("editStatus")?.value || "Lead";
  c.phone = document.getElementById("editPhone")?.value || "";
  c.email = document.getElementById("editEmail")?.value || "";
  c.lastContacted = document.getElementById("editLastContacted")?.value || "";
  c.notes = document.getElementById("editNotes")?.value || "";
  window.editorDraft = c;
  return c;
}

function renderEditorContacts() {
  const c = window.editorDraft;
  const host = document.getElementById("editorContacts");

  host.innerHTML = c.contacts.map((x, i) => `
    <div class="contact-card">
      <div class="contact-avatar" aria-hidden="true">👤</div>
      <div class="contact-fields-row">
        <div>
          <label>First Name</label>
          <input value="${esc(x.firstName || "")}" data-contact-index="${i}" data-contact-field="firstName" />
        </div>
        <div>
          <label>Last Name</label>
          <input value="${esc(x.lastName || "")}" data-contact-index="${i}" data-contact-field="lastName" />
        </div>
        <div>
          <label>Phone</label>
          <input value="${esc(x.phone)}" data-contact-index="${i}" data-contact-field="phone" />
        </div>
        <div>
          <label>Email</label>
          <input value="${esc(x.email)}" data-contact-index="${i}" data-contact-field="email" />
        </div>
        <div>
          <label>Role</label>
          <input value="${esc(x.role)}" data-contact-index="${i}" data-contact-field="role" />
        </div>
      </div>
      <button class="btn danger small" data-action="remove-contact" data-index="${i}">Remove Contact</button>
    </div>
  `).join("") || `<div class="empty-state">No contact people added.</div>`;

  host.querySelectorAll("[data-contact-field]").forEach(input => {
    input.addEventListener("input", () => {
      const i = Number(input.dataset.contactIndex);
      const field = input.dataset.contactField;
      window.editorDraft.contacts[i][field] = input.value;
      updateSavePulse();
    });
  });
}

function addEditorContact() {
  readBaseEditorIntoDraft();
  window.editorDraft.contacts.push({ id: uid(), firstName: "", lastName: "", phone: "", email: "", role: "" });
  renderEditorContacts();
  updateSavePulse();
}

function removeEditorContact(index) {
  readBaseEditorIntoDraft();
  window.editorDraft.contacts.splice(index, 1);
  renderEditorContacts();
  updateSavePulse();
}

function renderEditorAddresses() {
  const c = window.editorDraft;
  const host = document.getElementById("editorAddresses");
  autocompleteInstances = [];

  host.innerHTML = c.addresses.map((a, i) => `
    <div class="address-row">
      <div class="form-row">
        <label>Address Search</label>
        <input id="addressSearch_${i}" value="${esc(formatAddress(a))}" placeholder="Start typing address or business name..." />
      </div>

      <div class="form-row three">
        <div>
          <label>Label</label>
          <input value="${esc(a.label)}" data-address-index="${i}" data-address-field="label" />
        </div>
        <div>
          <label>Street</label>
          <input value="${esc(a.street)}" data-address-index="${i}" data-address-field="street" />
        </div>
        <div>
          <label>Suburb</label>
          <input value="${esc(a.suburb)}" data-address-index="${i}" data-address-field="suburb" />
        </div>
      </div>

      <div class="form-row four">
        <div>
          <label>State</label>
          <input value="${esc(a.state)}" data-address-index="${i}" data-address-field="state" />
        </div>
        <div>
          <label>Postcode</label>
          <input value="${esc(a.postcode)}" data-address-index="${i}" data-address-field="postcode" />
        </div>
        <div>
          <label>Country</label>
          <input value="${esc(a.country)}" data-address-index="${i}" data-address-field="country" />
        </div>
        <div>
          <label>Full Address</label>
          <input value="${esc(formatAddress(a))}" readonly />
        </div>
      </div>

      <div class="form-row two">
        <div>
          <label>Latitude</label>
          <input value="${esc(a.lat ?? "")}" data-address-index="${i}" data-address-field="lat" />
        </div>
        <div>
          <label>Longitude</label>
          <input value="${esc(a.lng ?? "")}" data-address-index="${i}" data-address-field="lng" />
        </div>
      </div>

      <div class="toolbar compact">
        <button class="btn ghost small" data-action="geocode-address" data-index="${i}">Geocode Typed Address</button>
        <button class="btn danger small" data-action="remove-address" data-index="${i}">Remove Address</button>
      </div>
    </div>
  `).join("") || `<div class="empty-state">No addresses added.</div>`;

  host.querySelectorAll("[data-address-field]").forEach(input => {
    input.addEventListener("input", () => {
      const i = Number(input.dataset.addressIndex);
      const field = input.dataset.addressField;
      window.editorDraft.addresses[i][field] = field === "lat" || field === "lng" ? numOrNull(input.value) : input.value;
      updateSavePulse();
    });
  });

  setTimeout(initAddressAutocompletes, 100);
}

function initAddressAutocompletes() {
  if (!mapReady || !window.google?.maps?.places?.Autocomplete) {
    if (document.getElementById("editorTab")?.classList.contains("active")) {
      console.warn("Google Places Autocomplete is not ready yet. It should become available after Google Maps finishes loading.");
    }
    return;
  }

  const c = window.editorDraft;
  if (!c || !Array.isArray(c.addresses)) return;

  c.addresses.forEach((address, i) => {
    const input = document.getElementById(`addressSearch_${i}`);
    if (!input || input.dataset.autocompleteReady === "1") return;

    input.dataset.autocompleteReady = "1";

    const autocomplete = new google.maps.places.Autocomplete(input, {
      fields: ["address_components", "formatted_address", "geometry", "name"],
      componentRestrictions: { country: "au" }
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place) return;

      const parsed = parsePlaceAddress(place);
      const target = window.editorDraft.addresses[i];

      target.street = parsed.street || place.formatted_address || target.street;
      target.suburb = parsed.suburb || target.suburb;
      target.state = parsed.state || target.state;
      target.postcode = parsed.postcode || target.postcode;
      target.country = parsed.country || "Australia";

      if (place.geometry?.location) {
        target.lat = Number(place.geometry.location.lat().toFixed(7));
        target.lng = Number(place.geometry.location.lng().toFixed(7));
      }

      renderEditorAddresses();
      updateSavePulse();
      toast("Address selected from autocomplete.");
    });

    autocompleteInstances.push(autocomplete);
  });
}

function parsePlaceAddress(place) {
  const components = place.address_components || [];
  const get = (type, useShort = false) => {
    const c = components.find(x => x.types.includes(type));
    return c ? (useShort ? c.short_name : c.long_name) : "";
  };

  const streetNumber = get("street_number");
  const route = get("route");
  const street = [streetNumber, route].filter(Boolean).join(" ") || place.formatted_address || "";
  const suburb =
    get("locality") ||
    get("postal_town") ||
    get("sublocality") ||
    get("sublocality_level_1") ||
    get("administrative_area_level_2");

  return {
    street,
    suburb,
    state: get("administrative_area_level_1", true),
    postcode: get("postal_code"),
    country: get("country")
  };
}

function addEditorAddress() {
  readBaseEditorIntoDraft();
  window.editorDraft.addresses.push({ id: uid(), label: "Main", street: "", suburb: "", state: "QLD", postcode: "", country: "Australia", lat: null, lng: null });
  renderEditorAddresses();
  updateSavePulse();
}

function removeEditorAddress(index) {
  readBaseEditorIntoDraft();
  window.editorDraft.addresses.splice(index, 1);
  renderEditorAddresses();
  updateSavePulse();
}

async function geocodeEditorAddress(index) {
  readBaseEditorIntoDraft();

  if (!geocoder) {
    toast("Google Maps is not loaded.");
    return;
  }

  const address = formatAddress(window.editorDraft.addresses[index]);
  if (!address) {
    toast("Enter an address before geocoding.");
    return;
  }

  geocoder.geocode({ address }, (results, status) => {
    if (status === "OK" && results[0]) {
      const loc = results[0].geometry.location;
      window.editorDraft.addresses[index].lat = Number(loc.lat().toFixed(7));
      window.editorDraft.addresses[index].lng = Number(loc.lng().toFixed(7));
      renderEditorAddresses();
      updateSavePulse();
      toast("Address geocoded.");
    } else {
      console.error("Geocoding failed:", status, results);
      toast("Geocoding failed: " + status);
    }
  });
}

async function saveEditorCustomer({ silent = false } = {}) {
  const c = readBaseEditorIntoDraft();

  if (!c.companyName.trim()) {
    setEditorAutosaveStatus("Enter a company name to autosave");
    if (!silent) toast("Company name is required.");
    return false;
  }

  const payload = {
    companyName: c.companyName,
    customerType: c.customerType,
    status: c.status,
    phone: c.phone,
    email: c.email,
    notes: c.notes,
    lastContacted: c.lastContacted,
    contacts: c.contacts.map(x => ({
      id: x.id || uid(),
      firstName: x.firstName || "",
      lastName: x.lastName || "",
      phone: x.phone || "",
      email: x.email || "",
      role: x.role || ""
    })),
    wipColumn: c.wipColumn || db.settings.wipColumns[0] || "un-allocated",
    wipOrder: Number.isFinite(Number(c.wipOrder)) ? Number(c.wipOrder) : 0,
    addresses: c.addresses.map(a => ({
      id: a.id || uid(),
      label: a.label || "Main",
      street: a.street || "",
      suburb: a.suburb || "",
      state: a.state || "",
      postcode: a.postcode || "",
      country: a.country || "Australia",
      lat: numOrNull(a.lat),
      lng: numOrNull(a.lng)
    })),
    updatedAt: serverTimestamp()
  };

  try {
    if (selectedCustomerId && db.customers.some(x => x.id === selectedCustomerId)) {
      await setDoc(doc(firestore, "customers", selectedCustomerId), payload, { merge: true });
    } else {
      payload.createdAt = serverTimestamp();
      const ref = await addDoc(collection(firestore, "customers"), payload);
      selectedCustomerId = ref.id;
    }

    editorCleanSnapshot = editorSnapshot(readBaseEditorIntoDraft());
    setEditorAutosaveStatus("Saved");
    if (!silent) toast("Customer saved.");
    return true;
  } catch (error) {
    console.error("Customer save failed:", error);
    setEditorAutosaveStatus("Autosave failed");
    toast("Customer save failed. Check console.");
    return false;
  }
}

async function deleteCustomer(id) {
  const c = db.customers.find(x => x.id === id);
  if (!c) return;
  if (!confirm(`Delete ${c.companyName || "this customer"}?`)) return;

  try {
    await deleteDoc(doc(firestore, "customers", id));
    if (selectedCustomerId === id) selectedCustomerId = null;
    toast("Customer deleted.");
  } catch (error) {
    console.error("Customer delete failed:", error);
    toast("Delete failed. Check console.");
  }
}

function formatAddress(a) {
  return [a.street, a.suburb, a.state, a.postcode, a.country].filter(Boolean).join(", ");
}

function hasCoords(a) {
  return Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lng));
}


function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForGoogleMapsClass(maxWaitMs = 8000) {
  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    if (window.google?.maps?.Map && window.google?.maps?.Geocoder && window.google?.maps?.InfoWindow) {
      return true;
    }

    await delay(100);
  }

  return false;
}

function loadGoogleMaps() {
  const key = mapsApiKey;

  if (!key) {
    document.getElementById("mapMissing").classList.add("show");
    console.warn("Google Maps API key is blank.");
    return;
  }

  if (mapReady && map) {
    console.info("Google Maps already initialised.");
    return;
  }

  if (window.google?.maps?.Map) {
    initMap();
    return;
  }

  if (mapScriptLoading) {
    console.info("Google Maps script is already loading.");
    return;
  }

  mapScriptLoading = true;

  window.gm_authFailure = function() {
    console.error("Google Maps authentication failed. Check API key, billing, enabled APIs and key restrictions.");
    document.getElementById("mapMissing").classList.add("show");
  };

  window.__atlasGoogleMapsLoaded = function() {
    console.info("Google Maps callback fired. Waiting for Maps classes.");
    initMap();
  };

  const existing = document.getElementById("googleMapsScript");
  if (existing) existing.remove();

  const script = document.createElement("script");
  script.id = "googleMapsScript";
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__atlasGoogleMapsLoaded&loading=async&libraries=places&v=weekly`;
  script.async = true;
  script.defer = true;
  script.onerror = () => {
    mapScriptLoading = false;
    document.getElementById("mapMissing").classList.add("show");
    console.error("Google Maps script failed to load.");
    toast("Google Maps failed to load. Check Settings console.");
  };

  document.head.appendChild(script);
}

function reloadMap() {
  map = null;
  geocoder = null;
  infoWindow = null;
  markers = [];
  mapReady = false;
  mapInitialising = false;

  if (window.google?.maps?.Map) {
    initMap();
    return;
  }

  mapScriptLoading = false;
  loadGoogleMaps();
}

async function initMap() {
  if (mapInitialising) {
    console.info("Google Maps initialisation is already running.");
    return;
  }

  if (mapReady && map) {
    console.info("Google Maps is already ready.");
    return;
  }

  mapInitialising = true;

  try {
    const ready = await waitForGoogleMapsClass(10000);

    if (!ready) {
      console.error("Google Maps Map class is unavailable after waiting. This usually means the Maps JavaScript API did not finish bootstrapping or the API key is restricted.");
      document.getElementById("mapMissing").classList.add("show");
      return;
    }

    map = new google.maps.Map(document.getElementById("map"), {
      center: defaultCenter,
      zoom: 9,
      mapTypeControl: true,
      streetViewControl: false,
      fullscreenControl: true
    });

    geocoder = new google.maps.Geocoder();
    infoWindow = new google.maps.InfoWindow();
    mapReady = true;
    mapScriptLoading = false;

    document.getElementById("mapMissing").classList.remove("show");

    renderMapMarkers();
    fitMapToMarkers(false);
    setTimeout(initAddressAutocompletes, 250);

    console.info("Google Maps initialised successfully on startup.");
  } catch (error) {
    console.error("Google Maps initialisation failed:", error);
    document.getElementById("mapMissing").classList.add("show");
    toast("Google Maps initialisation failed. Check Settings console.");
  } finally {
    mapInitialising = false;
  }
}


function scrollContactTiles(direction) {
  const host = document.getElementById("editorContacts");
  if (!host) return;

  const card = host.querySelector(".contact-card");
  const amount = card ? card.getBoundingClientRect().width + 14 : host.clientWidth;
  host.scrollBy({ left: direction * amount, behavior: "smooth" });
}

function disablePinMove() {
  if (!activeMovePin) return;

  clearInterval(activeMovePin.timer);
  activeMovePin.marker.setDraggable(false);
  activeMovePin.marker.setIcon(activeMovePin.baseIcon);
  activeMovePin = null;
}

function enablePinMove(customerId, addressId) {
  const marker = markers.find(m => m.customerId === customerId && m.addressId === addressId);
  if (!marker) {
    toast("Could not find that map pin.");
    return;
  }

  disablePinMove();

  const baseIcon = marker.baseIcon || marker.getIcon();
  let large = false;
  const timer = setInterval(() => {
    large = !large;
    marker.setIcon({
      ...baseIcon,
      scale: large ? 12 : 7,
      fillColor: large ? "#dca101" : baseIcon.fillColor
    });
  }, 520);

  marker.setDraggable(true);
  activeMovePin = { marker, baseIcon, timer };
  infoWindow.close();
  toast("Move mode enabled. Drag the pulsing pin to save its new location.");
}

function renderMapMarkers() {
  if (!map || !window.google?.maps) return;

  disablePinMove();
  markers.forEach(m => m.setMap(null));
  markers = [];

  const customers = getVisibleCustomers("map");

  customers.forEach(customer => {
    customer.addresses.forEach(address => {
      if (!hasCoords(address)) return;

      const marker = new google.maps.Marker({
        position: { lat: Number(address.lat), lng: Number(address.lng) },
        map,
        draggable: false,
        title: `${customer.companyName} - ${address.label || "Address"}`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: "#e12828",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2
        }
      });

      marker.addListener("click", () => {
        infoWindow.setContent(`
          <div class="map-info">
            <h3>${esc(customer.companyName || "Unnamed Company")}</h3>
            <p><strong>Type:</strong> ${esc(customer.customerType || "-")}</p>
            <p><strong>Status:</strong> ${esc(customer.status || "-")}</p>
            <p><strong>Phone:</strong> ${esc(customer.phone || "-")}</p>
            <p><strong>Email:</strong> ${esc(customer.email || "-")}</p>
            <p><strong>Address:</strong> ${esc(formatAddress(address) || "-")}</p>
            <button data-action="open-customer" data-id="${esc(customer.id)}">View / Edit Customer</button>
            <button data-action="move-pin" data-customer-id="${esc(customer.id)}" data-address-id="${esc(address.id)}">Move Pin</button>
          </div>
        `);
        infoWindow.open({ map, anchor: marker });
      });

      marker.customerId = customer.id;
      marker.addressId = address.id;
      marker.baseIcon = marker.getIcon();

      marker.addListener("dragend", async () => {
        const pos = marker.getPosition();
        address.lat = Number(pos.lat().toFixed(7));
        address.lng = Number(pos.lng().toFixed(7));

        try {
          await setDoc(doc(firestore, "customers", customer.id), {
            addresses: customer.addresses,
            updatedAt: serverTimestamp()
          }, { merge: true });
          disablePinMove();
          toast("Marker coordinates saved.");
        } catch (error) {
          console.error("Marker coordinate save failed:", error);
          toast("Coordinate save failed.");
        }
      });

      markers.push(marker);
    });
  });
}

function openCustomerDetails(id) {
  const c = db.customers.find(x => x.id === id);
  if (!c) return;

  document.getElementById("modalTitle").textContent = c.companyName || "Unnamed Company";
  document.getElementById("modalContent").innerHTML = `
    <div class="mini-card">
      <div class="card-line"><strong>Company:</strong> ${esc(c.companyName)}</div>
      <div class="card-line"><strong>Type:</strong> ${esc(c.customerType)}</div>
      <div class="card-line"><strong>Status:</strong> ${esc(c.status)}</div>
      <div class="card-line"><strong>Main Phone:</strong> ${esc(c.phone || "-")}</div>
      <div class="card-line"><strong>Main Email:</strong> ${esc(c.email || "-")}</div>
      <div class="card-line"><strong>Notes:</strong> ${esc(c.notes || "-")}</div>
    </div>

    <div class="panel margin-top">
      <h3>Contacts</h3>
      <div class="nested-list">
        ${c.contacts.map(x => `
          <div class="contact-row">
            <div class="card-line"><strong>First Name:</strong> ${esc(x.firstName || "-")}</div>
            <div class="card-line"><strong>Last Name:</strong> ${esc(x.lastName || "-")}</div>
            <div class="card-line"><strong>Phone:</strong> ${esc(x.phone || "-")}</div>
            <div class="card-line"><strong>Email:</strong> ${esc(x.email || "-")}</div>
            <div class="card-line"><strong>Role:</strong> ${esc(x.role || "-")}</div>
          </div>
        `).join("") || `<div class="empty-state">No contact people.</div>`}
      </div>
    </div>

    <div class="panel margin-top">
      <h3>Addresses</h3>
      <div class="nested-list">
        ${c.addresses.map(a => `
          <div class="address-row">
            <div class="card-line"><strong>${esc(a.label || "Address")}:</strong> ${esc(formatAddress(a) || "-")}</div>
            <div class="card-line"><strong>Lat/Lng:</strong> ${esc(a.lat ?? "-")}, ${esc(a.lng ?? "-")}</div>
          </div>
        `).join("") || `<div class="empty-state">No addresses.</div>`}
      </div>
    </div>

    <div class="card-actions">
      <button class="btn primary" data-action="edit-customer" data-id="${esc(c.id)}">Edit Customer</button>
      <button class="btn ghost" data-action="focus-customer" data-id="${esc(c.id)}">Focus on Map</button>
    </div>
  `;

  document.getElementById("modal").classList.add("show");
}

function closeModal() {
  document.getElementById("modal").classList.remove("show");
}

function focusCustomerOnMap(id) {
  const c = db.customers.find(x => x.id === id);
  const first = c?.addresses?.find(hasCoords);

  if (!first) {
    toast("This customer has no mapped address coordinates.");
    return;
  }

  closeModal();
  switchTab("mapTab");

  setTimeout(() => {
    if (!map) return;
    map.setCenter({ lat: Number(first.lat), lng: Number(first.lng) });
    map.setZoom(15);
    const marker = markers.find(m => m.customerId === id && m.addressId === first.id) || markers.find(m => m.customerId === id);
    pulseMarkerOnce(marker);
  }, 120);
}

function pulseMarkerOnce(marker) {
  if (!marker) return;
  const baseIcon = marker.baseIcon || marker.getIcon();
  marker.setIcon({
    ...baseIcon,
    scale: 13,
    fillColor: "#dca101"
  });
  setTimeout(() => marker.setIcon(baseIcon), 650);
}

function fitMapToMarkers(showToast = true) {
  if (!map || !markers.length) {
    if (showToast) toast("No visible markers to fit.");
    return;
  }

  const bounds = new google.maps.LatLngBounds();
  markers.forEach(m => bounds.extend(m.getPosition()));
  map.fitBounds(bounds);

  if (markers.length === 1) {
    setTimeout(() => map.setZoom(15), 100);
  }
}

function ensureOtherType(types = []) {
  const clean = [...new Set(types.map(x => String(x || "").trim()).filter(Boolean))];
  if (!clean.includes("Other")) clean.push("Other");
  return clean;
}

function ensureLeadStatus(statuses = []) {
  const clean = [...new Set(statuses.map(x => String(x || "").trim()).filter(Boolean))];
  if (!clean.includes("Lead")) clean.unshift("Lead");
  return clean;
}


function ensureWipColumns(columns = []) {
  const clean = [...new Set(columns.map(x => String(x || "").trim()).filter(Boolean))];
  return clean.length ? clean : ["un-allocated", "samples sent", "lead to be contacted"];
}

function scheduleSettingsSave() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(saveSettings, 450);
}

async function saveSettings() {
  db.settings.customerTypes = ensureOtherType(db.settings.customerTypes);
  db.settings.customerStatuses = ensureLeadStatus(db.settings.customerStatuses);
  db.settings.wipColumns = ensureWipColumns(db.settings.wipColumns);

  try {
    await setDoc(doc(firestore, "settings", "global"), {
      customerTypes: db.settings.customerTypes,
      customerStatuses: db.settings.customerStatuses,
      wipColumns: db.settings.wipColumns,
      updatedAt: serverTimestamp()
    }, { merge: true });

    toast("Settings saved automatically.");
  } catch (error) {
    console.error("Settings save failed:", error);
    toast("Settings autosave failed.");
  }
}


function bindWipBoardPanning() {
  const board = document.getElementById("wipBoard");
  if (!board) return;

  let isPanning = false;
  let startX = 0;
  let startScrollLeft = 0;

  board.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".wip-card")) return;

    isPanning = true;
    startX = event.clientX;
    startScrollLeft = board.scrollLeft;
    board.classList.add("is-panning");
    board.setPointerCapture(event.pointerId);
  });

  board.addEventListener("pointermove", (event) => {
    if (!isPanning) return;
    event.preventDefault();
    board.scrollLeft = startScrollLeft - (event.clientX - startX);
  });

  const endPan = (event) => {
    if (!isPanning) return;
    isPanning = false;
    board.classList.remove("is-panning");
    if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
  };

  board.addEventListener("pointerup", endPan);
  board.addEventListener("pointercancel", endPan);
  board.addEventListener("pointerleave", endPan);
}

function renderWipBoard() {
  const host = document.getElementById("wipBoard");
  if (!host) return;

  destroyWipSortables();
  const columns = ensureWipColumns(db.settings.wipColumns);
  db.settings.wipColumns = columns;

  host.innerHTML = columns.map(column => {
    const customers = getCustomersForWipColumn(column);
    return `
      <section class="wip-column">
        <div class="wip-column-header">
          <h3>${esc(column)}</h3>
          <span class="badge">${customers.length}</span>
        </div>
        <div class="wip-column-list" data-wip-column="${esc(column)}">
          ${customers.map(c => `
            <article class="wip-card" data-id="${esc(c.id)}" data-action="open-customer">
              <span class="wip-drag-handle" aria-hidden="true">⋮⋮</span>
              <strong>${esc(c.companyName || "Unnamed Company")}</strong>
            </article>
          `).join("")}
        </div>
      </section>
    `;
  }).join("");

  initWipSortables();
}

function getCustomersForWipColumn(column) {
  const search = (document.getElementById("wipSearch")?.value || "").toLowerCase().trim();

  return db.customers
    .filter(c => (c.wipColumn || db.settings.wipColumns[0]) === column)
    .filter(c => !search || String(c.companyName || "").toLowerCase().includes(search))
    .sort((a, b) => (Number(a.wipOrder) || 0) - (Number(b.wipOrder) || 0) || (a.companyName || "").localeCompare(b.companyName || ""));
}

function destroyWipSortables() {
  wipSortableInstances.forEach(instance => instance.destroy());
  wipSortableInstances = [];
}

function initWipSortables() {
  if (!window.Sortable) {
    console.warn("SortableJS is not loaded yet; WIP drag/drop is disabled until it loads.");
    return;
  }

  document.querySelectorAll(".wip-column-list").forEach(list => {
    wipSortableInstances.push(window.Sortable.create(list, {
      group: "atlas-wip-board",
      animation: 150,
      ghostClass: "wip-card-ghost",
      chosenClass: "wip-card-chosen",
      dragClass: "wip-card-drag",
      onEnd: saveWipBoardOrder
    }));
  });
}

async function saveWipBoardOrder() {
  const batch = writeBatch(firestore);
  let writes = 0;

  document.querySelectorAll(".wip-column-list").forEach(list => {
    const column = list.dataset.wipColumn;
    [...list.querySelectorAll(".wip-card")].forEach((card, index) => {
      const id = card.dataset.id;
      if (!id) return;

      const customer = db.customers.find(c => c.id === id);
      if (customer) {
        customer.wipColumn = column;
        customer.wipOrder = index;
      }

      batch.set(doc(firestore, "customers", id), {
        wipColumn: column,
        wipOrder: index,
        updatedAt: serverTimestamp()
      }, { merge: true });
      writes += 1;
    });
  });

  if (!writes) return;

  try {
    await batch.commit();
    toast("WIP board updated.");
  } catch (error) {
    console.error("WIP board save failed:", error);
    toast("WIP board save failed.");
    renderWipBoard();
  }
}

function renderCustomerTypes() {
  renderSettingsList({
    hostId: "customerTypesHost",
    items: db.settings.customerTypes,
    lockedValue: "Other",
    label: "Customer type",
    inputAttr: "data-type-index",
    removeAction: "remove-type",
    onInput(index, value) {
      db.settings.customerTypes[index] = value;
      db.settings.customerTypes = ensureOtherType(db.settings.customerTypes);
      renderTypeSelects();
      scheduleSettingsSave();
    }
  });
  renderCustomerStatuses();
  renderWipColumnsSettings();
}

function renderCustomerStatuses() {
  renderSettingsList({
    hostId: "customerStatusesHost",
    items: db.settings.customerStatuses,
    lockedValue: "Lead",
    label: "Status",
    inputAttr: "data-status-index",
    removeAction: "remove-status",
    onInput(index, value) {
      db.settings.customerStatuses[index] = value;
      db.settings.customerStatuses = ensureLeadStatus(db.settings.customerStatuses);
      renderStatusSelects();
      scheduleSettingsSave();
    }
  });
}

function renderWipColumnsSettings() {
  renderSettingsList({
    hostId: "wipColumnsHost",
    items: db.settings.wipColumns,
    lockedValue: null,
    label: "WIP column",
    inputAttr: "data-wip-column-index",
    removeAction: "remove-wip-column",
    onInput(index, value) {
      const oldColumn = db.settings.wipColumns[index];
      db.settings.wipColumns[index] = value;
      db.settings.wipColumns = ensureWipColumns(db.settings.wipColumns);
      updateCustomersForRenamedWipColumn(oldColumn, value);
      renderWipBoard();
      scheduleSettingsSave();
    },
    async onBlur(input, index) {
      const oldColumn = input.dataset.originalValue;
      const newColumn = db.settings.wipColumns[index];
      if (oldColumn && newColumn && oldColumn !== newColumn) {
        updateCustomersForRenamedWipColumn(oldColumn, newColumn);
        await reassignCustomers("wipColumn", oldColumn, newColumn);
        input.dataset.originalValue = newColumn;
      }
    }
  });
}

function addWipColumn() {
  db.settings.wipColumns.push("New WIP Column");
  db.settings.wipColumns = ensureWipColumns(db.settings.wipColumns);
  renderAll();
  scheduleSettingsSave();
}

function removeWipColumn(index) {
  const column = db.settings.wipColumns[index];
  if (!column || db.settings.wipColumns.length <= 1) {
    toast("At least one WIP column is required.");
    return;
  }

  const fallback = db.settings.wipColumns.find((_, i) => i !== index) || "un-allocated";
  const affected = db.customers.filter(c => c.wipColumn === column);

  showConfirmModal({
    title: "Remove WIP column?",
    message: `Remove “${column}”? ${affected.length} customer(s) in this column will move to “${fallback}”.`,
    onConfirm: async () => {
      db.settings.wipColumns.splice(index, 1);
      db.settings.wipColumns = ensureWipColumns(db.settings.wipColumns);
      await reassignCustomers("wipColumn", column, fallback);
      await saveSettings();
      renderAll();
    }
  });
}

function updateCustomersForRenamedWipColumn(oldColumn, newColumn) {
  if (!oldColumn || !newColumn || oldColumn === newColumn) return;
  db.customers.forEach(c => {
    if (c.wipColumn === oldColumn) c.wipColumn = newColumn;
  });
}

function renderSettingsList({ hostId, items, lockedValue, label, inputAttr, removeAction, onInput, onBlur }) {
  const host = document.getElementById(hostId);
  if (!host) return;

  host.innerHTML = items.map((item, i) => {
    const locked = item === lockedValue;
    return `
      <div class="settings-list-row ${locked ? "locked" : ""}">
        <div>
          <label>${esc(label)}</label>
          <input value="${esc(item)}" ${inputAttr}="${i}" data-original-value="${esc(item)}" ${locked ? "readonly" : ""} />
        </div>
        <button class="btn danger small" data-action="${removeAction}" data-index="${i}" ${locked ? "disabled" : ""}>Remove</button>
      </div>
    `;
  }).join("");

  host.querySelectorAll(`[${inputAttr}]`).forEach(input => {
    input.addEventListener("input", () => onInput(Number(input.getAttribute(inputAttr)), input.value));
    input.addEventListener("blur", async () => {
      if (onBlur) await onBlur(input, Number(input.getAttribute(inputAttr)));
      const cleaned = items.map(x => String(x || "").trim()).filter(Boolean);
      items.splice(0, items.length, ...[...new Set(cleaned)]);
      if (lockedValue === "Other") db.settings.customerTypes = ensureOtherType(items);
      if (lockedValue === "Lead") db.settings.customerStatuses = ensureLeadStatus(items);
      if (lockedValue === null) db.settings.wipColumns = ensureWipColumns(items);
      renderAll();
      scheduleSettingsSave();
    });
  });
}

function addCustomerType() {
  db.settings.customerTypes.push("New Type");
  db.settings.customerTypes = ensureOtherType(db.settings.customerTypes);
  renderAll();
  scheduleSettingsSave();
}

function addCustomerStatus() {
  db.settings.customerStatuses.push("New Status");
  db.settings.customerStatuses = ensureLeadStatus(db.settings.customerStatuses);
  renderAll();
  scheduleSettingsSave();
}

function showConfirmModal({ title, message, confirmText = "Delete", onConfirm }) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalContent").innerHTML = `
    <div class="mini-card">
      <div class="card-line">${esc(message)}</div>
    </div>
    <div class="confirm-actions">
      <button class="btn ghost" id="cancelConfirm">Cancel</button>
      <button class="btn danger" id="confirmAction">${esc(confirmText)}</button>
    </div>
  `;
  document.getElementById("modal").classList.add("show");
  document.getElementById("cancelConfirm").addEventListener("click", closeModal);
  document.getElementById("confirmAction").addEventListener("click", async () => {
    closeModal();
    await onConfirm();
  });
}

function removeCustomerType(index) {
  const type = db.settings.customerTypes[index];
  if (!type || type === "Other") return;

  const affected = db.customers.filter(c => c.customerType === type);
  showConfirmModal({
    title: "Remove customer type?",
    message: `Remove “${type}”? ${affected.length} existing customer(s) using this type will be changed to “Other”.`,
    onConfirm: async () => {
      db.settings.customerTypes.splice(index, 1);
      db.settings.customerTypes = ensureOtherType(db.settings.customerTypes);
      await reassignCustomers("customerType", type, "Other");
      await saveSettings();
      renderAll();
    }
  });
}

function removeCustomerStatus(index) {
  const status = db.settings.customerStatuses[index];
  if (!status || status === "Lead") return;

  const affected = db.customers.filter(c => c.status === status);
  showConfirmModal({
    title: "Remove status?",
    message: `Remove “${status}”? ${affected.length} existing customer(s) using this status will be changed to “Lead”.`,
    onConfirm: async () => {
      db.settings.customerStatuses.splice(index, 1);
      db.settings.customerStatuses = ensureLeadStatus(db.settings.customerStatuses);
      await reassignCustomers("status", status, "Lead");
      await saveSettings();
      renderAll();
    }
  });
}

async function reassignCustomers(field, oldValue, newValue) {
  const affected = db.customers.filter(c => c[field] === oldValue);
  if (!affected.length) return;

  const batch = writeBatch(firestore);
  affected.forEach(c => {
    batch.set(doc(firestore, "customers", c.id), {
      [field]: newValue,
      updatedAt: serverTimestamp()
    }, { merge: true });
  });
  await batch.commit();
}

function editorSnapshot(customer) {
  return JSON.stringify({
    companyName: customer.companyName || "",
    customerType: customer.customerType || "Other",
    status: customer.status || "Lead",
    phone: customer.phone || "",
    email: customer.email || "",
    notes: customer.notes || "",
    lastContacted: customer.lastContacted || "",
    contacts: customer.contacts || [],
    addresses: customer.addresses || []
  });
}

function bindEditorDirtyTracking() {
  document.querySelectorAll("#editorHost input, #editorHost select, #editorHost textarea").forEach(el => {
    if (el.readOnly) return;
    el.addEventListener("input", () => {
      readBaseEditorIntoDraft();
      updateSavePulse();
    });
    el.addEventListener("change", () => {
      readBaseEditorIntoDraft();
      updateSavePulse();
    });
  });
}

function scheduleEditorAutosave() {
  clearTimeout(editorAutosaveTimer);
  setEditorAutosaveStatus("Saving...");
  editorAutosaveTimer = setTimeout(() => saveEditorCustomer({ silent: true }), 350);
}

function setEditorAutosaveStatus(message) {
  const el = document.getElementById("editorAutosaveStatus");
  if (el) el.textContent = message || "Autosaves changes";
}

function updateSavePulse() {
  if (!window.editorDraft) return;
  const dirty = editorSnapshot(readBaseEditorIntoDraft()) !== editorCleanSnapshot;
  if (dirty) scheduleEditorAutosave();
}



function toggleConsole() {
  const body = document.getElementById("consoleBody");
  const toggle = document.getElementById("toggleConsole");
  const arrow = document.getElementById("consoleArrow");
  const isCollapsed = body.classList.toggle("collapsed");
  toggle.setAttribute("aria-expanded", String(!isCollapsed));
  arrow.textContent = isCollapsed ? "▶" : "▼";
}

async function copyConsole() {
  const text = appConsoleEntries.map(e => `[${e.time}] [${e.level}] [${e.source}] ${e.message}`).join("\n");

  try {
    await navigator.clipboard.writeText(text);
    toast("Console copied.");
  } catch {
    toast("Could not copy console.");
  }
}

function customersToCsv() {
  const rows = [[
    "Company Name",
    "Customer Type",
    "Status",
    "Main Phone",
    "Main Email",
    "Last Contacted",
    "Notes",
    "Contact People",
    "Addresses"
  ]];

  db.customers.forEach(c => {
    rows.push([
      c.companyName,
      c.customerType,
      c.status,
      c.phone,
      c.email,
      c.lastContacted,
      c.notes,
      c.contacts.map(x => [contactFullName(x), x.phone, x.email, x.role].filter(Boolean).join(" / ")).join(" | "),
      c.addresses.map(a => `${a.label || "Address"}: ${formatAddress(a)} (${a.lat ?? ""}, ${a.lng ?? ""})`).join(" | ")
    ]);
  });

  return rows.map(row => row.map(csvEscape).join(",")).join("\n");
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function downloadTextFile(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}

function exportCsv() {
  downloadTextFile("atlas-tools-customers.csv", customersToCsv(), "text/csv;charset=utf-8");
}

async function importCsvFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const customers = parseCustomersFromCsv(text);
    await importCustomersToFirestore(customers);
    toast(`Imported ${customers.length} customers.`);
  } catch (error) {
    console.error("CSV import failed:", error);
    toast("CSV import failed. Check console.");
  } finally {
    event.target.value = "";
  }
}

async function importJsonFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const customers = Array.isArray(parsed) ? parsed : parsed.customers;

    if (!Array.isArray(customers)) {
      throw new Error("JSON must contain an array or a customers array.");
    }

    await importCustomersToFirestore(customers.map(normalizeCustomer));

    if (parsed.settings?.customerTypes || parsed.settings?.customerStatuses || parsed.settings?.wipColumns) {
      await setDoc(doc(firestore, "settings", "global"), {
        customerTypes: ensureOtherType(parsed.settings.customerTypes || db.settings.customerTypes),
        customerStatuses: ensureLeadStatus(parsed.settings.customerStatuses || db.settings.customerStatuses),
        wipColumns: ensureWipColumns(parsed.settings.wipColumns || db.settings.wipColumns),
        updatedAt: serverTimestamp()
      }, { merge: true });
    }

    toast(`Imported ${customers.length} customers from JSON.`);
  } catch (error) {
    console.error("JSON import failed:", error);
    toast("JSON import failed. Check console.");
  } finally {
    event.target.value = "";
  }
}

function parseCustomersFromCsv(csvText) {
  const rows = parseCsv(csvText);

  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.trim().toLowerCase());
  const get = (row, names) => {
    for (const name of names) {
      const idx = headers.indexOf(name.toLowerCase());
      if (idx >= 0) return row[idx] || "";
    }
    return "";
  };

  return rows.slice(1).filter(r => r.some(Boolean)).map(row => normalizeCustomer({
    companyName: get(row, ["Company Name", "company", "companyName"]),
    customerType: get(row, ["Customer Type", "type"]) || "Other",
    status: get(row, ["Status"]) || "Lead",
    phone: get(row, ["Main Phone", "Phone", "Contact Number"]),
    email: get(row, ["Main Email", "Email"]),
    lastContacted: get(row, ["Last Contacted"]),
    notes: get(row, ["Notes"]),
    contacts: [{
      id: uid(),
      firstName: get(row, ["Contact First Name", "First Name"]),
      lastName: get(row, ["Contact Last Name", "Last Name"]),
      phone: get(row, ["Contact Phone"]),
      email: get(row, ["Contact Email"]),
      role: get(row, ["Role"])
    }].map(x => {
      if (!x.firstName && !x.lastName) {
        const split = splitLegacyName(get(row, ["Contact Person", "Contact Name", "Name"]));
        x.firstName = split.firstName;
        x.lastName = split.lastName;
      }
      return x;
    }).filter(x => x.firstName || x.lastName || x.phone || x.email || x.role),
    addresses: [{
      id: uid(),
      label: "Main",
      street: get(row, ["Street", "Address", "Address 1"]),
      suburb: get(row, ["Suburb"]),
      state: get(row, ["State"]),
      postcode: get(row, ["Postcode", "Zip"]),
      country: get(row, ["Country"]) || "Australia",
      lat: numOrNull(get(row, ["Lat", "Latitude"])),
      lng: numOrNull(get(row, ["Lng", "Long", "Longitude"]))
    }]
  }));
}

async function importCustomersToFirestore(customers) {
  const batchSize = 450;
  let batch = writeBatch(firestore);
  let count = 0;

  for (const customer of customers) {
    const c = normalizeCustomer(customer);
    const ref = doc(collection(firestore, "customers"));

    batch.set(ref, {
      companyName: c.companyName,
      customerType: c.customerType,
      status: c.status,
      phone: c.phone,
      email: c.email,
      notes: c.notes,
      lastContacted: c.lastContacted,
      contacts: c.contacts,
      addresses: c.addresses,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    count++;

    if (count % batchSize === 0) {
      await batch.commit();
      batch = writeBatch(firestore);
    }
  }

  if (count % batchSize !== 0) {
    await batch.commit();
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value);
  rows.push(row);
  return rows.filter(r => r.some(v => String(v).trim() !== ""));
}
