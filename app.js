import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, onSnapshot, setDoc, deleteDoc, writeBatch,
  query, orderBy, limit, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, USERS } from "./firebase-config.js";

const $ = id => document.getElementById(id);

/* ---------- Dados fixos ---------- */
// Os índices ficam gravados no banco: só ACRESCENTE categorias no final.
const categories = [
  "Mercearia", "Bebidas e lanche", "Refrigerados e frios",
  "Congelados", "Limpeza e lavanderia",
  "Hortifrúti", "Carnes", "Padaria", "Higiene pessoal"
];
// Ordem em que aparecem na tela (mais ou menos o caminho do mercado).
const categoryOrder = [5, 7, 0, 6, 2, 3, 1, 4, 8];
const units = {un:"un.", kg:"kg", L:"L", pct:"pct", cx:"cx", dz:"dz"};
const unitNames = {un:"Unidade", kg:"Quilo (kg)", L:"Litro (L)", pct:"Pacote", cx:"Caixa", dz:"Dúzia"};
const unitOf = item => units[item.unit] ? item.unit : "un";
const qtyText = item => `${number(item.quantity)} ${units[unitOf(item)]}`;
const priceText = item => money(item.price) + (unitOf(item) === "un" ? "" : "/" + units[unitOf(item)]);
const initial = [
  ["Feijão","Arroz","Farinha de rosca","Sal","Açúcar","Tapioca",
   "Óleo","Leite condensado","Creme de leite"],
  ["Coca-Cola Zero","Sucos para o lanche da escola","Biscoitos dos meninos",
   "Nescau","Cappuccino","Pão de forma"],
  ["Iogurte","Queijo","Presunto","Requeijão"],
  ["Anéis de cebola","Nuggets"],
  ["Água sanitária","Sabão em pó","Amaciante",
   "Desinfetante para casa — laranja","Veja","Sapólio"]
];

/* ---------- Utilitários ---------- */
const money = cents => (cents / 100).toLocaleString("pt-BR", {style:"currency", currency:"BRL"});
const number = value => value.toLocaleString("pt-BR", {maximumFractionDigits:3});
const normalize = text => text.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase();
const itemTotal = item => item.price === null ? 0 : Math.round(item.quantity * item.price);
const date = d => d.toLocaleDateString("pt-BR", {day:"2-digit", month:"2-digit", year:"numeric"});
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* ---------- Firebase ---------- */
const configured = !String(firebaseConfig.apiKey || "").startsWith("COLE");
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
let db;
try {
  // Cache local: funciona sem internet no mercado e sincroniza depois.
  db = initializeFirestore(fbApp, {
    localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})
  });
} catch {
  db = getFirestore(fbApp);
}
const itemsCol = collection(db, "itens");
const purchasesCol = collection(db, "compras");

/* ---------- Abrir sem internet ---------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(error => console.warn("SW:", error));
}

/* ---------- Estado ---------- */
let items = [], rawItems = [], purchases = [], filter = "all", editing = null, opener = null;
let user = null, stops = [], seeded = false, pendingTimer = null;

/* ---------- Mercado atual (fica salvo em cada aparelho) ---------- */
let store = "";
try { store = localStorage.getItem("mercado") || ""; } catch {}
const storeKey = name => normalize(String(name || "")).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Preço que vale agora: o do mercado escolhido, se existir; senão o último preço geral.
function applyStore(item) {
  const own = store ? item.prices[storeKey(store)] : null;
  return {
    ...item,
    price: own ? own.price : item.basePrice,
    priceFrom: own ? store : item.priceStore,
    priceIsOwn: !!own
  };
}
function refreshItems() {
  items = rawItems.map(applyStore);
  render();
}
function knownStores() {
  const map = new Map();
  const add = name => {
    const clean = String(name || "").trim();
    if (clean && !map.has(storeKey(clean))) map.set(storeKey(clean), clean);
  };
  add(store);
  purchases.forEach(p => add(p.store));
  rawItems.forEach(item => Object.values(item.prices).forEach(p => add(p.name)));
  return [...map.values()].sort((a,b) => a.localeCompare(b, "pt-BR"));
}
function setStore(name) {
  store = String(name || "").trim();
  try { store ? localStorage.setItem("mercado", store) : localStorage.removeItem("mercado"); } catch {}
  updateStoreButton();
  refreshItems();
}
function updateStoreButton() {
  $("store-name").textContent = store || "Escolher mercado";
  $("store-hint").textContent = store ? "Preços deste mercado" : "Para ver os preços de cada mercado";
}

const who = email => {
  const key = String(email || "").toLowerCase();
  return USERS[key] || key.split("@")[0] || "—";
};
const me = () => who(user?.email);

function setSync(text) { $("sync").textContent = text; }

function failed(error) {
  console.error(error);
  setSync(error?.code === "permission-denied"
    ? "Sem permissão para acessar os dados. Confira as regras do Firestore."
    : "Erro ao sincronizar (" + (error?.code || "desconhecido") + ").");
}

function itemFromDoc(snapshot) {
  const x = snapshot.data({serverTimestamps:"estimate"});
  return {
    id: snapshot.id,
    name: String(x.name || "").trim(),
    category: Number.isInteger(x.category) && x.category >= 0 && x.category < categories.length ? x.category : 0,
    quantity: Number.isFinite(x.quantity) && x.quantity > 0 ? x.quantity : 1,
    unit: units[x.unit] ? x.unit : "un",
    basePrice: Number.isSafeInteger(x.price) && x.price >= 0 ? x.price : null,
    priceStore: String(x.priceStore || ""),
    prices: Object.fromEntries(Object.entries(x.prices && typeof x.prices === "object" ? x.prices : {})
      .filter(([, p]) => Number.isSafeInteger(p?.price) && p.price >= 0)
      .map(([key, p]) => [key, {price: p.price, name: String(p.name || key), at: p.at?.toDate?.() || null}])),
    checked: x.checked === true,
    order: Number.isFinite(x.order) ? x.order : 0,
    lastPrice: Number.isSafeInteger(x.lastPrice) ? x.lastPrice : null,
    lastBoughtAt: x.lastBoughtAt?.toDate?.() || null,
    updatedBy: x.updatedBy || null
  };
}

function purchaseFromDoc(snapshot) {
  const x = snapshot.data({serverTimestamps:"estimate"});
  return {
    id: snapshot.id,
    date: x.date?.toDate?.() || new Date(),
    store: String(x.store || ""),
    total: Number.isSafeInteger(x.total) ? x.total : 0,
    by: x.by || "—",
    items: Array.isArray(x.items) ? x.items : []
  };
}

// Primeira vez: cria a lista inicial no Firestore (apenas uma vez).
async function seed(force = false) {
  if (seeded && !force) return;
  seeded = true;
  try {
    const meta = doc(db, "config", "lista");
    if (!force && (await getDoc(meta)).exists()) return;
    const batch = writeBatch(db);
    let order = 0;
    initial.forEach((names, category) => names.forEach(name => {
      batch.set(doc(itemsCol), {
        name, category, quantity:1, unit:"un", price:null, checked:false, order: order++,
        updatedBy: me(), updatedAt: serverTimestamp()
      });
    }));
    batch.set(meta, {seeded:true, at: serverTimestamp()});
    await batch.commit();
  } catch (error) { failed(error); }
}

function subscribe() {
  stops.push(onSnapshot(itemsCol, {includeMetadataChanges:true}, snap => {
    rawItems = snap.docs.map(itemFromDoc).filter(item => item.name)
      .sort((a,b) => a.order - b.order || a.name.localeCompare(b.name, "pt-BR"));
    items = rawItems.map(applyStore);
    if (snap.empty && !snap.metadata.fromCache) seed();
    clearTimeout(pendingTimer);
    if (snap.metadata.hasPendingWrites) {
      setSync("Salvando…");
      pendingTimer = setTimeout(() => setSync(
        "⚠ Ainda não confirmado na nuvem. Verifique a internet; os dados estão guardados neste aparelho."), 15000);
    } else {
      setSync(snap.metadata.fromCache
        ? "Sem conexão · as alterações serão enviadas quando voltar"
        : "✓ Salvo na nuvem");
    }
    render();
  }, failed));

  stops.push(onSnapshot(query(purchasesCol, orderBy("date","desc"), limit(200)), snap => {
    purchases = snap.docs.map(purchaseFromDoc);
    if ($("history-dialog").open) renderHistory();
  }, failed));
}

// Grava o preço também na tabela do mercado atual.
function withStorePrice(data, storeName, at = Timestamp.now()) {
  if (data.price === undefined) return data;
  const name = String(storeName || "").trim();
  const out = {...data, priceStore: name};
  if (name && data.price !== null) {
    out.prices = {[storeKey(name)]: {price: data.price, name, at}};
  }
  return out;
}
function saveItem(id, data) {
  setDoc(doc(itemsCol, id), {...withStorePrice(data, store), updatedBy: me(), updatedAt: serverTimestamp()}, {merge:true})
    .catch(failed);
}

/* ---------- Login ---------- */
onAuthStateChanged(auth, current => {
  stops.forEach(stop => stop());
  stops = [];
  user = current;
  $("login").hidden = !!user;
  $("main").hidden = !user;
  $("footer").hidden = !user;
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  if (!user) {
    items = []; rawItems = []; purchases = []; seeded = false;
    if (!configured) {
      $("login-error").textContent = "Configure o arquivo firebase-config.js antes de entrar.";
    }
    return;
  }
  $("hello").textContent = "Olá, " + me() + "!";
  updateStoreButton();
  setSync("Conectando…");
  render();
  subscribe();
});

const loginErrors = {
  "auth/invalid-credential": "E-mail ou senha incorretos.",
  "auth/invalid-email": "E-mail inválido.",
  "auth/user-disabled": "Este usuário está desativado.",
  "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos.",
  "auth/network-request-failed": "Sem conexão com a internet."
};
$("login-form").onsubmit = async event => {
  event.preventDefault();
  if (!configured) {
    $("login-error").textContent = "Configure o arquivo firebase-config.js antes de entrar.";
    return;
  }
  $("login-error").textContent = "";
  $("login-submit").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("login-email").value.trim(), $("login-password").value);
    $("login-password").value = "";
  } catch (error) {
    $("login-error").textContent = loginErrors[error.code] || "Não foi possível entrar (" + error.code + ").";
  } finally {
    $("login-submit").disabled = false;
  }
};
$("toggle-password").onclick = () => {
  const input = $("login-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggle-password").setAttribute("aria-pressed", String(show));
  $("toggle-password").setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
  $("eye-open").toggleAttribute("hidden", show);
  $("eye-closed").toggleAttribute("hidden", !show);
};
$("logout").onclick = () => {
  if (confirm("Sair da conta neste aparelho?")) signOut(auth);
};

/* ---------- Lista ---------- */
function render() {
  const focusedId = document.activeElement?.dataset?.id;
  const cart = items.filter(item => item.checked);
  const missing = cart.filter(item => item.price === null).length;
  const percentage = items.length ? Math.round(cart.length / items.length * 100) : 0;
  $("count").textContent = `${cart.length} de ${items.length} no carrinho`;
  $("percent").textContent = percentage + "%";
  $("progress").value = percentage;
  $("cart-total").textContent = money(cart.reduce((sum,item) => sum + itemTotal(item), 0));
  $("cart-info").textContent = missing
    ? `Total parcial · ${missing} sem preço`
    : `${cart.length} produto${cart.length === 1 ? "" : "s"} marcado${cart.length === 1 ? "" : "s"}`;
  $("finish").hidden = cart.length === 0;
  const unpriced = items.filter(item => item.price === null).length;
  $("estimate").textContent = `Lista inteira: ${money(items.reduce((sum,item) => sum + itemTotal(item),0))}` +
    (unpriced ? ` · ${unpriced} sem preço` : "");

  const queryText = normalize($("search").value.trim());
  const visible = items.filter(item =>
    normalize(item.name).includes(queryText) &&
    (filter === "all" || (filter === "cart" ? item.checked : !item.checked))
  );
  $("list").replaceChildren();

  categoryOrder.forEach(index => {
    const group = visible.filter(item => item.category === index);
    if (!group.length) return;
    const section = el("section", "category");
    const title = el("h2", "", categories[index]);
    title.append(el("span", "", group.length + (group.length === 1 ? " item" : " itens")));
    section.append(title);

    group.forEach(item => {
      const row = el("div", "row" + (item.checked ? " checked" : ""));
      const check = el("button", "check");
      check.type = "button";
      check.dataset.id = item.id;
      check.setAttribute("aria-label", `${item.checked ? "Desmarcar" : "Marcar"} ${item.name}`);
      check.setAttribute("aria-pressed", String(item.checked));
      const circle = el("span", "", "✓");
      circle.setAttribute("aria-hidden","true");
      check.append(circle);
      check.onclick = () => {
        saveItem(item.id, {checked: !item.checked});
        // Marcou um item sem preço: já pergunta quanto custou.
        // Com mercado escolhido, também pergunta se ainda não há preço deste mercado.
        if (!item.checked && (item.price === null || (store && !item.priceIsOwn))) openQuickPrice(item);
      };

      const edit = el("button", "edit");
      edit.type = "button";
      edit.setAttribute("aria-label", "Editar " + item.name);
      edit.onclick = () => openEditor(item.id);
      const text = el("span", "item-text");
      text.append(
        el("b", "", item.name),
        el("small", "", item.price === null
          ? `${qtyText(item)} · Adicionar preço`
          : `${qtyText(item)} × ${priceText(item)}` +
            (store && !item.priceIsOwn ? ` · preço ${item.priceFrom ? "do " + item.priceFrom : "de outro mercado"}` : ""))
      );
      edit.append(text, el("span",
        item.price === null ? "pencil" : "amount",
        item.price === null ? "✎" : money(itemTotal(item))));
      row.append(check, edit);
      section.append(row);
    });
    $("list").append(section);
  });

  if (!items.length) {
    const load = el("button", "add", "Carregar minha lista padrão");
    load.type = "button";
    load.onclick = () => {
      load.disabled = true;
      load.textContent = "Carregando…";
      seed(true);
    };
    $("list").append(load);
  }
  if (!visible.length) {
    $("list").append(el("p", "empty",
      !items.length ? "Sua lista está vazia. Acrescente o primeiro produto."
      : queryText ? "Nenhum produto encontrado."
      : filter === "cart" ? "Marque os produtos conforme colocar no carrinho."
      : "Tudo pronto! Não há produtos pendentes."));
  }
  if (focusedId) {
    $("list").querySelector(`.check[data-id="${CSS.escape(focusedId)}"]`)?.focus({preventScroll:true});
  }
}

/* ---------- Editor ---------- */
categoryOrder.forEach(index => {
  const option = el("option", "", categories[index]);
  option.value = index;
  $("category").append(option);
});
Object.entries(unitNames).forEach(([value, name]) => {
  const option = el("option", "", name);
  option.value = value;
  $("unit").append(option);
});
const stepFor = unit => unit === "kg" ? 0.1 : 1;
const priceLabel = unit => unit === "un" ? "Preço unitário (R$)" : `Preço por ${units[unit]} (R$)`;

function parsePrice(input = $("price")) {
  const value = input.value.trim();
  if (!value) return null;
  if (!/^\d{1,7}([,.]\d{1,2})?$/.test(value)) return NaN;
  return Math.round(Number(value.replace(",",".")) * 100);
}
function updateSubtotal() {
  $("price").setCustomValidity("");
  $("price-label").textContent = priceLabel($("unit").value);
  const price = parsePrice(), quantity = Number($("quantity").value);
  $("subtotal").textContent = price !== null && Number.isFinite(price) && quantity > 0
    ? money(Math.round(price * quantity)) : "—";
  updateLastPrice(price);
}
function updateLastPrice(price) {
  const item = items.find(item => item.id === editing);
  const parts = [];
  if (item?.lastPrice != null) {
    let line = `Última compra: ${money(item.lastPrice)}`;
    if (item.lastBoughtAt) line += ` em ${date(item.lastBoughtAt)}`;
    if (price !== null && Number.isFinite(price) && price !== item.lastPrice && item.lastPrice > 0) {
      const diff = (price - item.lastPrice) / item.lastPrice * 100;
      line += ` · ${diff > 0 ? "▲" : "▼"} ${Math.abs(diff).toLocaleString("pt-BR",{maximumFractionDigits:1})}%`;
    }
    parts.push(line);
  }
  if (item?.updatedBy) parts.push(`Alterado por ${item.updatedBy}`);
  $("last-price").textContent = parts.join(" · ");
  renderStorePrices(item, $("store-prices"));
}
// Comparativo do produto em cada mercado, do mais barato para o mais caro.
function renderStorePrices(item, target) {
  target.replaceChildren();
  const list = Object.values(item?.prices || {}).sort((a,b) => a.price - b.price);
  if (!list.length) return;
  target.append(el("span", "store-prices-title", "Preço por mercado"));
  list.forEach((p, index) => {
    const row = el("span", "store-price" + (index === 0 && list.length > 1 ? " best" : ""));
    row.append(
      el("span", "", p.name + (storeKey(p.name) === storeKey(store) ? " (aqui)" : "")),
      el("strong", "", money(p.price) + (index === 0 && list.length > 1 ? " ★" : ""))
    );
    target.append(row);
  });
}
function openEditor(id = null) {
  opener = document.activeElement;
  editing = id;
  const item = items.find(item => item.id === id);
  $("form").reset();
  $("price").setCustomValidity("");
  $("name").setCustomValidity("");
  $("dialog-title").textContent = item ? "Editar produto" : "Novo produto";
  $("name").value = item?.name || "";
  $("category").value = item?.category ?? 0;
  $("quantity").value = item?.quantity ?? 1;
  $("unit").value = item ? unitOf(item) : "un";
  $("price").value = item?.price != null ? (item.price / 100).toFixed(2).replace(".",",") : "";
  $("checked").checked = item?.checked || false;
  $("remove").hidden = !item;
  updateSubtotal();
  $("dialog").showModal();
}
$("dialog").addEventListener("close", () => {
  if (opener?.isConnected) opener.focus({preventScroll:true});
  else $("add").focus({preventScroll:true});
});
document.querySelectorAll("[data-close]").forEach(button => {
  button.onclick = () => button.closest("dialog").close();
});
$("add").onclick = () => openEditor();
$("search").oninput = render;
$("name").oninput = () => $("name").setCustomValidity("");
$("price").oninput = updateSubtotal;
$("quantity").oninput = updateSubtotal;
$("unit").onchange = updateSubtotal;
$("minus").onclick = () => {
  const step = stepFor($("unit").value);
  const value = Number($("quantity").value) || step;
  $("quantity").value = Math.max(.001, Math.round((value - step) * 1000) / 1000);
  updateSubtotal();
};
$("plus").onclick = () => {
  const step = stepFor($("unit").value);
  $("quantity").value = Math.min(99999, Math.round(((Number($("quantity").value) || 0) + step) * 1000) / 1000);
  updateSubtotal();
};
document.querySelectorAll("[data-filter]").forEach(button => {
  button.onclick = () => {
    filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(other => {
      const active = other === button;
      other.classList.toggle("active",active);
      other.setAttribute("aria-pressed",String(active));
    });
    render();
  };
});

$("form").onsubmit = event => {
  event.preventDefault();
  const name = $("name").value.trim();
  if (!name) {
    $("name").setCustomValidity("Informe o nome do produto.");
    $("name").reportValidity();
    return;
  }
  const price = parsePrice();
  if (Number.isNaN(price)) {
    $("price").setCustomValidity("Use um valor como 25,90, sem separador de milhar.");
    $("price").reportValidity();
    return;
  }
  if (!$("form").reportValidity()) return;
  const data = {
    name, category: Number($("category").value),
    quantity: Number($("quantity").value), unit: $("unit").value, price,
    checked: $("checked").checked
  };
  // Abriu e salvou sem mexer num preço que veio de outro mercado: não grava como preço deste.
  const current = items.find(item => item.id === editing);
  if (current && store && !current.priceIsOwn && price === current.price) delete data.price;
  if (editing) saveItem(editing, data);
  else saveItem(doc(itemsCol).id, {...data, order: Date.now()});
  $("dialog").close();
};

$("remove").onclick = () => {
  const item = items.find(item => item.id === editing);
  if (item && confirm(`Excluir "${item.name}" da lista?`)) {
    deleteDoc(doc(itemsCol, item.id)).catch(failed);
    $("dialog").close();
  }
};

/* ---------- Escolher mercado ---------- */
$("store-button").onclick = () => {
  const list = $("store-list");
  list.replaceChildren();
  const option = (label, value) => {
    const button = el("button", "store-option" + (storeKey(value) === storeKey(store) ? " active" : ""), label);
    button.type = "button";
    button.onclick = () => { setStore(value); $("store-dialog").close(); };
    list.append(button);
  };
  knownStores().forEach(name => option(name, name));
  option("Nenhum (usar o último preço)", "");
  $("new-store").value = "";
  $("store-dialog").showModal();
};
$("store-form").onsubmit = event => {
  event.preventDefault();
  const name = $("new-store").value.trim();
  if (!name) return;
  setStore(name);
  $("store-dialog").close();
};

/* ---------- Preço rápido (ao marcar item sem preço) ---------- */
let quickId = null;
function openQuickPrice(item) {
  quickId = item.id;
  $("price-form").reset();
  $("quick-price").setCustomValidity("");
  $("price-item").textContent = item.name;
  $("quick-qty").value = item.quantity;
  $("quick-qty").step = "any";
  $("quick-qty-label").textContent = `Quantidade (${units[unitOf(item)]})`;
  $("quick-price-label").textContent = priceLabel(unitOf(item));
  $("quick-price").value = item.price != null ? (item.price / 100).toFixed(2).replace(".",",") : "";
  $("quick-price").placeholder = item.lastPrice != null
    ? (item.lastPrice / 100).toFixed(2).replace(".",",") : "0,00";
  $("quick-last").textContent = (store ? `Mercado: ${store}. ` : "") + (item.lastPrice != null
    ? `Última compra: ${money(item.lastPrice)}` + (item.lastBoughtAt ? ` em ${date(item.lastBoughtAt)}` : "") : "");
  renderStorePrices(item, $("quick-store-prices"));
  updateQuickSubtotal();
  $("price-dialog").showModal();
  $("quick-price").focus();
}
function updateQuickSubtotal() {
  $("quick-price").setCustomValidity("");
  const price = parsePrice($("quick-price")), quantity = Number($("quick-qty").value);
  $("quick-subtotal").textContent = price !== null && Number.isFinite(price) && quantity > 0
    ? money(Math.round(price * quantity)) : "—";
}
$("quick-price").oninput = updateQuickSubtotal;
$("quick-qty").oninput = updateQuickSubtotal;
$("price-form").onsubmit = event => {
  event.preventDefault();
  const price = parsePrice($("quick-price"));
  if (Number.isNaN(price)) {
    $("quick-price").setCustomValidity("Use um valor como 25,90, sem separador de milhar.");
    $("quick-price").reportValidity();
    return;
  }
  if (!$("price-form").reportValidity()) return;
  const data = {quantity: Number($("quick-qty").value)};
  if (price !== null) data.price = price;
  if (quickId) saveItem(quickId, data);
  $("price-dialog").close();
};

/* ---------- Finalizar compra ---------- */
$("finish").onclick = () => {
  const cart = items.filter(item => item.checked);
  if (!cart.length) return;
  const total = cart.reduce((sum,item) => sum + itemTotal(item), 0);
  const missing = cart.filter(item => item.price === null).length;
  $("finish-summary").replaceChildren(
    `${cart.length} produto${cart.length === 1 ? "" : "s"} · total `,
    el("strong", "", money(total))
  );
  $("finish-warning").hidden = !missing;
  $("finish-warning").textContent = missing
    ? `${missing} produto${missing === 1 ? " está" : "s estão"} sem preço e entra${missing === 1 ? "" : "m"} como R$ 0,00.` : "";
  const stores = [...new Set(purchases.map(p => p.store).filter(Boolean))];
  $("stores").replaceChildren(...stores.map(store => { const o = el("option"); o.value = store; return o; }));
  $("store").value = store || purchases[0]?.store || "";
  $("finish-dialog").showModal();
};

$("finish-form").onsubmit = event => {
  event.preventDefault();
  const cart = items.filter(item => item.checked);
  if (!cart.length) { $("finish-dialog").close(); return; }
  const now = Timestamp.now();
  const storeName = $("store").value.trim();
  const batch = writeBatch(db);
  batch.set(doc(purchasesCol), {
    date: now,
    store: storeName,
    by: me(),
    total: cart.reduce((sum,item) => sum + itemTotal(item), 0),
    items: cart.map(item => ({
      name: item.name, category: categories[item.category],
      quantity: item.quantity, unit: unitOf(item), price: item.price, subtotal: itemTotal(item)
    }))
  });
  cart.forEach(item => {
    let update = {checked:false, updatedBy: me(), updatedAt: serverTimestamp()};
    if (item.price !== null) {
      update = withStorePrice({...update, price: item.price, lastPrice: item.price, lastBoughtAt: now}, storeName, now);
    }
    batch.set(doc(itemsCol, item.id), update, {merge:true});
  });
  batch.commit().catch(failed);   // offline: fica na fila e envia depois
  if (storeName && storeKey(storeName) !== storeKey(store)) setStore(storeName);
  $("finish-dialog").close();
};

/* ---------- Histórico ---------- */
$("open-history").onclick = () => {
  renderHistory();
  $("history-dialog").showModal();
};

function renderHistory() {
  const monthKey = d => d.getFullYear() * 12 + d.getMonth();
  const current = monthKey(new Date());
  const sum = key => purchases.filter(p => monthKey(p.date) === key).reduce((s,p) => s + p.total, 0);
  $("month-total").textContent = money(sum(current));
  $("last-month-total").textContent = money(sum(current - 1));

  const list = $("history-list");
  list.replaceChildren();
  if (!purchases.length) {
    list.append(el("p", "empty", "Nenhuma compra finalizada ainda. Marque os itens no carrinho e toque em “Finalizar compra”."));
    return;
  }
  purchases.forEach(purchase => {
    const details = el("details", "purchase");
    const summary = el("summary");
    const products = purchase.items.length;
    // Itens pesados (kg/L) contam como 1 volume.
    const pieces = purchase.items.reduce((sum, item) =>
      sum + (["kg","L"].includes(item.unit) || !Number.isFinite(item.quantity) ? 1 : item.quantity), 0);
    const left = el("div");
    left.append(
      el("b", "", date(purchase.date) + (purchase.store ? " · " + purchase.store : "")),
      el("small", "", `${products} produto${products === 1 ? "" : "s"} · ${number(pieces)} volume${pieces === 1 ? "" : "s"} · por ${purchase.by}`)
    );
    const right = el("div", "purchase-total");
    right.append(el("strong", "", money(purchase.total)), el("span", "chevron", "›"));
    summary.append(left, right);

    const ul = el("ul");
    purchase.items.forEach(item => {
      const li = el("li");
      const entry = {
        quantity: Number.isFinite(item.quantity) ? item.quantity : 1,
        unit: item.unit, price: item.price ?? null
      };
      const info = el("div");
      info.append(
        el("b", "", item.name),
        el("small", "", entry.price === null
          ? `${qtyText(entry)} · sem preço`
          : `${qtyText(entry)} × ${priceText(entry)}`)
      );
      li.append(info, el("strong", "", item.price == null ? "—" : money(item.subtotal || 0)));
      ul.append(li);
    });
    const totalRow = el("li", "purchase-sum");
    totalRow.append(el("b", "", "Total"), el("strong", "", money(purchase.total)));
    ul.append(totalRow);
    const remove = el("button", "remove", "Excluir este registro");
    remove.type = "button";
    remove.onclick = () => {
      if (confirm(`Excluir a compra de ${date(purchase.date)} (${money(purchase.total)}) do histórico?`)) {
        deleteDoc(doc(purchasesCol, purchase.id)).catch(failed);
      }
    };
    details.append(summary, ul, remove);
    list.append(details);
  });
}
