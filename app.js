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
const categories = [
  "Mercearia", "Bebidas e lanche", "Refrigerados e frios",
  "Congelados", "Limpeza e lavanderia"
];
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

/* ---------- Estado ---------- */
let items = [], purchases = [], filter = "all", editing = null, opener = null;
let user = null, stops = [], seeded = false;

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
    price: Number.isSafeInteger(x.price) && x.price >= 0 ? x.price : null,
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
        name, category, quantity:1, price:null, checked:false, order: order++,
        updatedBy: me(), updatedAt: serverTimestamp()
      });
    }));
    batch.set(meta, {seeded:true, at: serverTimestamp()});
    await batch.commit();
  } catch (error) { failed(error); }
}

function subscribe() {
  stops.push(onSnapshot(itemsCol, {includeMetadataChanges:true}, snap => {
    items = snap.docs.map(itemFromDoc).filter(item => item.name)
      .sort((a,b) => a.order - b.order || a.name.localeCompare(b.name, "pt-BR"));
    if (snap.empty && !snap.metadata.fromCache) seed();
    setSync(snap.metadata.hasPendingWrites ? "Salvando…"
      : snap.metadata.fromCache ? "Sem conexão · as alterações serão enviadas quando voltar"
      : "✓ Salvo na nuvem");
    render();
  }, failed));

  stops.push(onSnapshot(query(purchasesCol, orderBy("date","desc"), limit(200)), snap => {
    purchases = snap.docs.map(purchaseFromDoc);
    if ($("history-dialog").open) renderHistory();
  }, failed));
}

function saveItem(id, data) {
  setDoc(doc(itemsCol, id), {...data, updatedBy: me(), updatedAt: serverTimestamp()}, {merge:true})
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
    items = []; purchases = []; seeded = false;
    if (!configured) {
      $("login-error").textContent = "Configure o arquivo firebase-config.js antes de entrar.";
    }
    return;
  }
  $("hello").textContent = "Olá, " + me() + "!";
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

  categories.forEach((category, index) => {
    const group = visible.filter(item => item.category === index);
    if (!group.length) return;
    const section = el("section", "category");
    const title = el("h2", "", category);
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
      check.onclick = () => saveItem(item.id, {checked: !item.checked});

      const edit = el("button", "edit");
      edit.type = "button";
      edit.setAttribute("aria-label", "Editar " + item.name);
      edit.onclick = () => openEditor(item.id);
      const text = el("span", "item-text");
      text.append(
        el("b", "", item.name),
        el("small", "", item.price === null
          ? `${number(item.quantity)} un. · Adicionar preço`
          : `${number(item.quantity)} × ${money(item.price)}`)
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
categories.forEach((name,index) => {
  const option = el("option", "", name);
  option.value = index;
  $("category").append(option);
});

function parsePrice() {
  const value = $("price").value.trim();
  if (!value) return null;
  if (!/^\d{1,7}([,.]\d{1,2})?$/.test(value)) return NaN;
  return Math.round(Number(value.replace(",",".")) * 100);
}
function updateSubtotal() {
  $("price").setCustomValidity("");
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
$("minus").onclick = () => {
  const value = Number($("quantity").value) || 1;
  $("quantity").value = Math.max(.001, Math.round((value - 1) * 1000) / 1000);
  updateSubtotal();
};
$("plus").onclick = () => {
  $("quantity").value = Math.min(99999, Math.round(((Number($("quantity").value) || 0) + 1) * 1000) / 1000);
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
    quantity: Number($("quantity").value), price,
    checked: $("checked").checked
  };
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
  $("store").value = purchases[0]?.store || "";
  $("finish-dialog").showModal();
};

$("finish-form").onsubmit = event => {
  event.preventDefault();
  const cart = items.filter(item => item.checked);
  if (!cart.length) { $("finish-dialog").close(); return; }
  const now = Timestamp.now();
  const batch = writeBatch(db);
  batch.set(doc(purchasesCol), {
    date: now,
    store: $("store").value.trim(),
    by: me(),
    total: cart.reduce((sum,item) => sum + itemTotal(item), 0),
    items: cart.map(item => ({
      name: item.name, category: categories[item.category],
      quantity: item.quantity, price: item.price, subtotal: itemTotal(item)
    }))
  });
  cart.forEach(item => {
    const update = {checked:false, updatedBy: me(), updatedAt: serverTimestamp()};
    if (item.price !== null) { update.lastPrice = item.price; update.lastBoughtAt = now; }
    batch.set(doc(itemsCol, item.id), update, {merge:true});
  });
  batch.commit().catch(failed);   // offline: fica na fila e envia depois
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
    const left = el("div");
    left.append(
      el("b", "", date(purchase.date) + (purchase.store ? " · " + purchase.store : "")),
      el("small", "", `${purchase.items.length} ite${purchase.items.length === 1 ? "m" : "ns"} · por ${purchase.by}`)
    );
    summary.append(left, el("strong", "", money(purchase.total)));
    const ul = el("ul");
    purchase.items.forEach(item => {
      const li = el("li");
      const qty = Number.isFinite(item.quantity) ? number(item.quantity) : "1";
      li.append(
        el("span", "", `${qty} × ${item.name}`),
        el("span", "", item.price == null ? "sem preço" : money(item.subtotal || 0))
      );
      ul.append(li);
    });
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
