export const ROLE_LABELS = {
  family_admin: "Administrador familiar",
  family_member: "Miembro de la familia",
  employee_live_in: "Empleada interna",
  helper: "Apoyo del hogar",
  viewer: "Acceso puntual",
};

const MODULE_ROLES = {
  today: ["family_admin", "family_member", "employee_live_in", "helper", "viewer"],
  employment: ["family_admin", "family_member", "employee_live_in"],
  menu: ["family_admin", "family_member", "employee_live_in", "helper"],
  wiki: ["family_admin", "family_member", "employee_live_in", "helper"],
  search: ["family_admin", "family_member", "employee_live_in", "helper"],
  calendar: ["family_admin", "family_member", "employee_live_in", "viewer"],
  contacts: ["family_admin", "family_member", "employee_live_in", "helper", "viewer"],
  emergency: ["family_admin", "family_member", "employee_live_in", "helper", "viewer"],
  routines: ["family_admin", "family_member", "employee_live_in", "helper"],
  more: ["family_admin", "family_member", "employee_live_in", "helper", "viewer"],
  content_edit: ["family_admin", "family_member"],
  admin: ["family_admin"],
};

export function formatCurrency(value, options = {}) {
  const { showSign = false } = options;
  const numericValue = Number(value) || 0;
  const formatted = new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    useGrouping: "always",
  }).format(Math.abs(numericValue));
  if (numericValue < 0) return `−${formatted}`;
  if (showSign && numericValue > 0) return `+${formatted}`;
  return formatted;
}

export function calculateSettlement(lines) {
  const salaryLines = lines.filter((line) => line.section !== "reimbursement");
  const reimbursementLines = lines.filter((line) => line.section === "reimbursement");
  const salaryTotal = roundMoney(salaryLines.reduce((sum, line) => sum + line.amount, 0));
  const reimbursementTotal = roundMoney(reimbursementLines.reduce((sum, line) => sum + line.amount, 0));
  const transferTotal = roundMoney(salaryTotal + reimbursementTotal);
  return { salaryTotal, reimbursementTotal, transferTotal };
}

export function paymentSummary(total, payments = [], employeeConfirmedAt = null) {
  const paid = roundMoney(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
  const pending = Math.max(0, roundMoney(total - paid));
  let state = "closed";
  if (paid >= total && total > 0) state = employeeConfirmedAt ? "confirmed" : "paid";
  return { paid, pending, state };
}

export function roundMoney(value) {
  const numericValue = Number(value) || 0;
  const scaled = Math.abs(numericValue) * 100;
  const tolerance = Number.EPSILON * Math.max(1, scaled) * 2;
  return Math.sign(numericValue) * Math.round(scaled + tolerance) / 100;
}

export function normalizeText(value = "") {
  return String(value)
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const matrix = Array.from({ length: right.length + 1 }, (_, row) => [row]);
  for (let column = 0; column <= left.length; column += 1) matrix[0][column] = column;
  for (let row = 1; row <= right.length; row += 1) {
    for (let column = 1; column <= left.length; column += 1) {
      const cost = right[row - 1] === left[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost,
      );
    }
  }
  return matrix[right.length][left.length];
}

export function scoreSearchItem(query, item) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;
  const title = normalizeText(item.title);
  const aliases = (item.aliases || []).map(normalizeText);
  const tags = (item.tags || []).map(normalizeText);
  const body = normalizeText([
    item.description,
    item.body,
    ...(item.ingredients || []).map((ingredient) => ingredient.food),
    ...(item.steps || []),
  ].filter(Boolean).join(" "));
  let score = 0;

  if (title === normalizedQuery) score += 120;
  if (title.startsWith(normalizedQuery)) score += 85;
  if (title.includes(normalizedQuery)) score += 65;
  if (aliases.some((alias) => alias === normalizedQuery)) score += 105;
  if (aliases.some((alias) => alias.includes(normalizedQuery))) score += 70;
  if (tags.some((tag) => tag.includes(normalizedQuery))) score += 48;
  if (body.includes(normalizedQuery)) score += 25;

  const queryWords = normalizedQuery.split(" ");
  const candidateWords = [title, ...aliases, ...tags, body].flatMap((value) => value.split(" "));
  let exactWordMatches = 0;
  let eligibleQueryWords = 0;
  for (const queryWord of queryWords) {
    if (queryWord.length < 3) continue;
    eligibleQueryWords += 1;
    const closest = Math.min(...candidateWords.map((word) => levenshtein(queryWord, word)));
    if (closest === 0) { score += 32; exactWordMatches += 1; }
    if (closest === 1) score += 56;
    if (closest === 2 && queryWord.length >= 6) score += 32;
  }
  if (eligibleQueryWords && exactWordMatches === eligibleQueryWords) score += 45;

  score += Math.min(Number(item.popularity || 0), 20);
  return score;
}

export function searchItems(query, items) {
  return items
    .map((item) => ({ ...item, score: scoreSearchItem(query, item) }))
    .filter((item) => item.score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

export function groupBy(items, key) {
  return items.reduce((groups, item) => {
    const group = item[key];
    if (!groups[group]) groups[group] = [];
    groups[group].push(item);
    return groups;
  }, {});
}

export function scaleIngredients(recipe, servings) {
  const scale = Number(servings) / Number(recipe.baseServings);
  return recipe.ingredients.map((ingredient) => ({
    ...ingredient,
    scaledAmount: ingredient.linear === false
      ? ingredient.amount
      : Math.round(ingredient.amount * scale * 100) / 100,
  }));
}

export function canAccess(role, moduleName) {
  return Boolean(MODULE_ROLES[moduleName]?.includes(role));
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
