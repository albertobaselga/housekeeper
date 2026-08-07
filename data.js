export const profiles = {
  family_admin: {
    id: "alberto",
    name: "Alberto",
    shortName: "Familia",
    initials: "A",
    role: "family_admin",
  },
  family_member: {
    id: "marta-family",
    name: "Marta",
    shortName: "Familia",
    initials: "M",
    role: "family_member",
  },
  employee_live_in: {
    id: "ana",
    name: "Ana",
    shortName: "Ana",
    initials: "AN",
    role: "employee_live_in",
  },
  helper: {
    id: "lucia",
    name: "Lucía",
    shortName: "Apoyo",
    initials: "L",
    role: "helper",
  },
  viewer: {
    id: "diego",
    name: "Diego",
    shortName: "Canguro",
    initials: "D",
    role: "viewer",
  },
};

export const settlementLines = [
  {
    id: "base-march",
    concept: "Salario acordado marzo",
    detail: "1 × 1.400,00 €",
    quantity: 1,
    unit: "mes",
    unitPrice: 1400,
    amount: 1400,
    section: "salary",
    tone: "neutral",
    origin: {
      eyebrow: "Ficha laboral · versión 1",
      title: "Salario base",
      body: "Tarifa vigente durante todo el periodo de marzo. Un cambio posterior no modifica esta línea.",
      meta: ["Vigente desde 03/02/2025", "Creado por Familia", "Tarifa congelada al cerrar"],
    },
  },
  {
    id: "extra-0903",
    concept: "Libranza trabajada 09/03",
    detail: "1 jornada × 70,00 €",
    quantity: 1,
    unit: "jornada",
    unitPrice: 70,
    amount: 70,
    section: "salary",
    tone: "positive",
    origin: {
      eyebrow: "Evento de trabajo extra · EW-104",
      title: "Domingo 9 de marzo",
      body: "Ana registró la jornada y la familia confirmó resolverla como pago. La tarifa quedó congelada al aprobarse.",
      meta: ["Solicitada por Familia", "Aprobada por Alberto", "Resolución: pago · tarifa v1"],
    },
  },
  {
    id: "comp-2303",
    concept: "Libranza trabajada 23/03",
    detail: "Compensada con día libre",
    quantity: 1,
    unit: "jornada",
    unitPrice: 0,
    amount: 0,
    section: "salary",
    tone: "info",
    origin: {
      eyebrow: "Evento de trabajo extra · EW-109",
      title: "Domingo 23 de marzo",
      body: "Resuelta como compensación. No genera importe y suma un día al saldo de días a devolver.",
      meta: ["Registrada por Ana", "Aprobada por Alberto", "Saldo permanente hasta su consumo"],
    },
  },
  {
    id: "hours-march",
    concept: "Horas extra",
    detail: "3 h × 12,00 €",
    quantity: 3,
    unit: "hora",
    unitPrice: 12,
    amount: 36,
    section: "salary",
    tone: "positive",
    origin: {
      eyebrow: "Registro semanal · semanas 10 y 11",
      title: "3 horas extraordinarias",
      body: "Excepciones confirmadas por Ana y validadas por la familia en dos registros semanales.",
      meta: ["2 h · 12/03", "1 h · 18/03", "Tarifa: 12,00 €/h"],
    },
  },
  {
    id: "advance-march",
    concept: "Descuento anticipo",
    detail: "Plan de 100,00 €/mes",
    quantity: 1,
    unit: "cuota",
    unitPrice: -100,
    amount: -100,
    section: "salary",
    tone: "negative",
    origin: {
      eyebrow: "Anticipo · AD-12",
      title: "Cuota de marzo",
      body: "Descuento conforme al plan aceptado de 100,00 € al mes. Tras esta cuota quedan 200,00 € pendientes.",
      meta: ["Importe inicial: 400,00 €", "Pagado: 200,00 €", "Pendiente tras marzo: 200,00 €"],
    },
  },
  {
    id: "expenses-march",
    concept: "Reembolso de gastos",
    detail: "2 tickets aprobados",
    quantity: 2,
    unit: "tickets",
    unitPrice: 23.65,
    amount: 47.3,
    section: "reimbursement",
    tone: "positive",
    origin: {
      eyebrow: "Gastos · 2 justificantes",
      title: "Compra para la casa",
      body: "Reembolso no salarial de dos gastos registrados por Ana y aprobados por la familia.",
      meta: ["Farmacia · 18,50 €", "Supermercado · 28,80 €", "Aprobado el 26/03"],
    },
  },
];

export const agreementVersions = [
  {
    version: 3,
    status: "Vigente",
    from: "1 ene 2026",
    author: "Alberto",
    changes: ["Día de pago: día 31 → último laborable", "Aviso de pago: 2 → 3 días antes"],
  },
  {
    version: 2,
    status: "Anterior",
    from: "1 sep 2025",
    to: "31 dic 2025",
    author: "Marta",
    changes: ["Nuevo patrón de libranzas: sábado 14:00 → lunes 08:00"],
  },
  {
    version: 1,
    status: "Inicial",
    from: "3 feb 2025",
    to: "31 ago 2025",
    author: "Alberto",
    changes: ["Creación del acuerdo laboral"],
  },
];

export const weekMenu = [
  {
    day: "Lunes", date: "3", short: "L",
    slots: [
      { time: "08:00", label: "Desayuno", dish: "Tostadas, fruta y bebida de avena", group: "Todos", note: "Usar el envase marcado para Marta; revisar trazas" },
      { time: "11:00", label: "Almuerzo", dish: "Mandarina y crackers", group: "Niños" },
      { time: "14:00", label: "Comida", dish: "Lentejas con verduras", group: "Todos", recipe: "lentejas", note: "Sin sal; triturar una ración para Leo" },
      { time: "17:30", label: "Merienda", dish: "Yogur vegetal y plátano", group: "Niños", note: "Comprobar sello sin leche" },
      { time: "20:30", label: "Cena", dish: "Tortilla francesa y tomate", group: "Todos", note: "Para Leo: huevo completamente cuajado. Adultos: añadir ensalada" },
    ],
  },
  {
    day: "Martes", date: "4", short: "M",
    slots: [
      { time: "08:00", label: "Desayuno", dish: "Porridge de avena y manzana", group: "Todos" },
      { time: "11:00", label: "Almuerzo", dish: "Fruta de temporada", group: "Niños" },
      { time: "14:00", label: "Comida", dish: "Arroz con pollo", group: "Todos", recipe: "arroz-pollo" },
      { time: "17:30", label: "Merienda", dish: "Bocadillo de pavo", group: "Niños" },
      { time: "20:30", label: "Cena", dish: "Merluza al horno", group: "Adultos", recipe: "merluza", note: "Niños: crema de calabaza. Evitar contaminación cruzada" },
    ],
  },
  {
    day: "Miércoles", date: "5", short: "X",
    slots: [
      { time: "08:00", label: "Desayuno", dish: "Yogur vegetal, granola y pera", group: "Todos", note: "Granola sin trazas de leche" },
      { time: "11:00", label: "Almuerzo", dish: "Uvas cortadas", group: "Niños" },
      { time: "14:00", label: "Comida", dish: "Pasta con tomate casero", group: "Niños", note: "Adultos: ensalada de garbanzos" },
      { time: "17:30", label: "Merienda", dish: "Fruta y hummus con pan", group: "Niños" },
      { time: "20:30", label: "Cena", dish: "Crema de calabaza", group: "Todos", recipe: "crema-calabaza" },
    ],
  },
  {
    day: "Jueves", date: "6", short: "J",
    slots: [
      { time: "08:00", label: "Desayuno", dish: "Tostadas con aguacate", group: "Todos" },
      { time: "11:00", label: "Almuerzo", dish: "Plátano", group: "Niños" },
      { time: "14:00", label: "Comida", dish: "Garbanzos con espinacas", group: "Todos" },
      { time: "17:30", label: "Merienda", dish: "Yogur vegetal", group: "Niños" },
      { time: "20:30", label: "Cena", dish: "Pollo y verduras al horno", group: "Todos" },
    ],
  },
  {
    day: "Viernes", date: "7", short: "V",
    slots: [
      { time: "08:00", label: "Desayuno", dish: "Tortitas de plátano", group: "Todos" },
      { time: "11:00", label: "Almuerzo", dish: "Manzana y nueces", group: "Adultos" },
      { time: "14:00", label: "Comida", dish: "Salmón con patata cocida", group: "Adultos", note: "Niños: pollo con patata. Preparar por separado" },
      { time: "17:30", label: "Merienda", dish: "Bizcocho casero sin lácteos", group: "Niños", note: "Huevo completamente cocinado" },
      { time: "20:30", label: "Cena", dish: "Pizza casera sin lácteos", group: "Todos" },
    ],
  },
  {
    day: "Sábado", date: "8", short: "S",
    slots: [
      { time: "09:00", label: "Desayuno", dish: "Huevos, tostadas y fruta", group: "Todos", note: "Para Leo: huevo completamente cuajado" },
      { time: "11:30", label: "Almuerzo", dish: "—", group: "Todos" },
      { time: "14:30", label: "Comida", dish: "Comida fuera", group: "Todos" },
      { time: "18:00", label: "Merienda", dish: "Fruta", group: "Niños" },
      { time: "21:00", label: "Cena", dish: "Sopa y sándwiches", group: "Todos" },
    ],
  },
  {
    day: "Domingo", date: "9", short: "D",
    slots: [
      { time: "09:00", label: "Desayuno", dish: "Churros y fruta", group: "Todos" },
      { time: "11:30", label: "Almuerzo", dish: "—", group: "Todos" },
      { time: "14:30", label: "Comida", dish: "Cocido de la abuela", group: "Todos" },
      { time: "18:00", label: "Merienda", dish: "Yogur vegetal", group: "Niños", note: "Comprobar sello sin leche" },
      { time: "20:30", label: "Cena", dish: "Restos y fruta", group: "Todos" },
    ],
  },
];

export const recipes = [
  {
    id: "crema-calabaza", type: "recipe", title: "Crema de calabaza", description: "Suave, rápida y apta para toda la familia.",
    aliases: ["pure de calabaza"], tags: ["rápida", "sin gluten", "favorita niños"], popularity: 14,
    baseServings: 4, prep: 10, cook: 25, allergens: [], imageClass: "pumpkin",
    ingredients: [
      { food: "Calabaza", amount: 800, unit: "g", section: "Fruta y verdura" },
      { food: "Patata", amount: 200, unit: "g", section: "Fruta y verdura" },
      { food: "Puerro", amount: 1, unit: "ud", section: "Fruta y verdura" },
      { food: "Aceite de oliva", amount: 2, unit: "cda", section: "Despensa" },
    ],
    steps: ["Lavar, pelar y cortar las verduras.", "Cubrir justo con agua y cocer 25 minutos.", "Triturar con el aceite hasta que quede fina."],
  },
  {
    id: "lentejas", type: "recipe", title: "Lentejas con verduras", description: "La receta de diario, preparada para congelar.",
    aliases: ["lentejas de casa"], tags: ["batch cooking", "sin lactosa"], popularity: 18,
    baseServings: 6, prep: 15, cook: 45, allergens: [], imageClass: "lentils",
    ingredients: [
      { food: "Lenteja pardina", amount: 500, unit: "g", section: "Despensa" },
      { food: "Zanahoria", amount: 3, unit: "ud", section: "Fruta y verdura" },
      { food: "Puerro", amount: 1, unit: "ud", section: "Fruta y verdura" },
      { food: "Tomate triturado", amount: 250, unit: "ml", section: "Conservas" },
    ],
    steps: ["Lavar las lentejas y cortar las verduras.", "Cubrir con agua y cocer a fuego suave.", "Separar una ración antes de salar."],
  },
  {
    id: "arroz-pollo", type: "recipe", title: "Arroz con pollo", description: "Arroz suave con verduras, sin lácteos ni pescado.",
    aliases: ["arroz amarillo", "pollo con arroz"], tags: ["comida", "sin lácteos"], popularity: 13,
    baseServings: 4, prep: 15, cook: 35, allergens: [], imageClass: "lentils",
    ingredients: [
      { food: "Arroz", amount: 320, unit: "g", section: "Despensa" },
      { food: "Pollo", amount: 600, unit: "g", section: "Carnicería" },
      { food: "Zanahoria", amount: 2, unit: "ud", section: "Fruta y verdura" },
      { food: "Guisantes", amount: 150, unit: "g", section: "Congelados" },
    ],
    steps: ["Cortar el pollo y dorarlo con un poco de aceite.", "Añadir las verduras y el arroz.", "Cubrir con caldo seguro y cocer hasta que el arroz esté tierno."],
  },
  {
    id: "merluza", type: "recipe", title: "Merluza al horno", description: "Con patata, limón y perejil.",
    aliases: ["pescado al horno"], tags: ["rápida", "cena"], popularity: 10,
    baseServings: 4, prep: 10, cook: 20, allergens: ["Pescado"], imageClass: "fish",
    ingredients: [
      { food: "Lomos de merluza", amount: 4, unit: "ud", section: "Pescadería" },
      { food: "Patata", amount: 600, unit: "g", section: "Fruta y verdura" },
      { food: "Limón", amount: 1, unit: "ud", section: "Fruta y verdura" },
      { food: "Perejil", amount: 1, unit: "manojo", section: "Fruta y verdura", linear: false },
    ],
    steps: ["Cortar la patata fina y hornear 15 minutos.", "Añadir la merluza, limón y perejil.", "Hornear 12–15 minutos más."],
  },
];

export const wikiPages = [
  {
    id: "wiki-lavadora", type: "wiki", slug: "lavadora-programa-corto", title: "Lavadora · programa corto", space: "Equipamiento",
    description: "Qué programa usar para una colada pequeña y dónde poner cada producto.", aliases: ["lavadra", "el cacharro de la ropa", "lavadora rápida"],
    tags: ["lavandería", "electrodomésticos", "ropa"], popularity: 20, updated: "Ayer", icon: "washer", pinned: true,
    body: "## Para una colada pequeña\nUsa el programa **Mixto 40°**. Dura 59 minutos y admite hasta media carga.\n\n1. Detergente: compartimento **II**.\n2. Suavizante: compartimento con la flor, sin pasar la marca MAX.\n3. Pulsa el botón de temperatura una vez para dejarlo en 40°.\n\n> No uses el programa rápido para toallas ni ropa de cama.\n\n## Si aparece un error\nConsulta [[lavadora-error-e18]] o llama al servicio técnico desde Contactos.",
  },
  {
    id: "wiki-vitro", type: "wiki", slug: "placa-induccion", title: "Placa de inducción", space: "Equipamiento",
    description: "Encendido, bloqueo y limpieza de la placa de la cocina.", aliases: ["vitro", "vitrocerámica", "fuegos"],
    tags: ["cocina", "electrodomésticos"], popularity: 12, updated: "Hace 3 días", icon: "stove", pinned: true,
    body: "## Encender\nMantén pulsado el círculo durante dos segundos y elige la zona.\n\n## Bloqueo infantil\nPulsa la llave durante cuatro segundos.\n\n> No uses estropajo verde. Para restos pegados, usa la rasqueta guardada en el segundo cajón.",
  },
  {
    id: "wiki-power", type: "wiki", slug: "se-ha-ido-la-luz", title: "Se ha ido la luz", space: "Incidencias",
    description: "Pasos seguros para comprobar el cuadro eléctrico y a quién llamar.", aliases: ["apagón", "no hay electricidad", "plomos"],
    tags: ["urgente", "electricidad", "incidencia"], popularity: 17, updated: "12 jul", icon: "bolt", pinned: true,
    body: "## Primero\nComprueba si hay luz en la escalera. El cuadro está detrás de la puerta de entrada.\n\n1. Baja todos los interruptores pequeños.\n2. Sube el interruptor general.\n3. Sube los pequeños uno a uno para identificar el circuito.\n\n> Si huele a quemado o ves humo, no toques el cuadro. Sal de casa y llama al 112.",
  },
  {
    id: "wiki-boiler", type: "wiki", slug: "caldera", title: "Caldera y agua caliente", space: "Equipamiento",
    description: "Presión correcta, reinicio y contacto del servicio técnico.", aliases: ["agua fría", "calefacción", "bombona"],
    tags: ["caldera", "mantenimiento", "baño"], popularity: 16, updated: "18 jun", icon: "flame",
    body: "## Presión\nLa aguja debe estar entre 1 y 1,5 bar cuando la caldera está fría.\n\n## Reiniciar\nMantén pulsado Reset dos segundos. No lo intentes más de una vez.\n\nSi vuelve a fallar, llama a **Clima Norte** desde Contactos.",
  },
  {
    id: "wiki-sleep", type: "wiki", slug: "rutina-sueno-leo", title: "Rutina de sueño de Leo", space: "Crianza",
    description: "Orden de baño, cuento y hora de dormir.", aliases: ["dormir leo", "noche leo"],
    tags: ["Leo", "sueño", "niños"], popularity: 19, updated: "Hoy", icon: "moon", visibility: "family",
    body: "## Antes de dormir\nA las 20:00: baño rápido, pijama y dientes. Puede elegir un cuento.\n\nDeja la puerta entreabierta y la luz del pasillo encendida. Si llama, entra con calma y recuérdale que estamos cerca.",
  },
  {
    id: "wiki-bathroom", type: "wiki", slug: "bano-principal", title: "Baño principal", space: "Estancias",
    description: "Dónde están las toallas, los repuestos y los productos de limpieza.", aliases: ["baño padres"],
    tags: ["estancia", "limpieza"], popularity: 8, updated: "4 may", icon: "room",
    body: "## Repuestos\nEl papel y las toallas limpias están en el armario alto del pasillo.\n\n## Limpieza\nConsulta la rutina semanal enlazada. No mezcles lejía con ningún otro producto.",
  },
];

export const contacts = [
  { id: "contact-112", type: "contact", title: "Emergencias 112", role: "Emergencias", phone: "112", description: "Emergencias generales", aliases: ["ambulancia", "policía", "bomberos"], tags: ["urgente", "emergencia"], popularity: 20, emergency: true },
  { id: "contact-pediatrician", type: "contact", title: "Dra. Elena Núñez", role: "Pediatra", phone: "+34910000111", displayPhone: "910 000 111", description: "Centro Médico del Parque · Póliza SAL-28491", aliases: ["pediatra", "médico niños"], tags: ["salud", "niños"], popularity: 17, emergency: true },
  { id: "contact-plumber", type: "contact", title: "Javier · Fontanero", role: "Fontanería", phone: "+34600000122", displayPhone: "600 000 122", description: "Averías de agua y calefacción", aliases: ["fontanero", "tubería", "fuga"], tags: ["servicio", "agua"], popularity: 12 },
  { id: "contact-boiler", type: "contact", title: "Clima Norte", role: "Técnico de caldera", phone: "+34910000233", displayPhone: "910 000 233", description: "Contrato CN-4412 · asistencia 24 h", aliases: ["caldera", "técnico calefacción"], tags: ["servicio", "caldera"], popularity: 15 },
  { id: "contact-neighbor", type: "contact", title: "Carmen · 2º B", role: "Vecina de confianza", phone: "+34600000344", displayPhone: "600 000 344", description: "Tiene una copia de las llaves", aliases: ["vecina", "Carmen"], tags: ["familia", "llaves"], popularity: 10, emergency: true },
  { id: "contact-school", type: "contact", title: "Colegio Las Encinas", role: "Colegio", phone: "+34910000455", displayPhone: "910 000 455", description: "Secretaría · 08:30–17:00", aliases: ["cole", "colegio niños"], tags: ["colegio", "niños"], popularity: 11 },
];

export const calendarEvents = [
  { id: "event-school", time: "08:35", title: "Dejar a Marta y Leo en el colegio", detail: "Entrada por la puerta azul", icon: "school", audience: "Ana" },
  { id: "event-pickup", time: "16:30", title: "Recoger a Marta en natación", detail: "C/ Ejemplo 12 · llevar mochila azul", icon: "swim", audience: "Ana" },
  { id: "event-tech", time: "18:00", title: "Viene el técnico de la caldera", detail: "Clima Norte · contrato CN-4412", icon: "tools", audience: "Familia" },
  { id: "event-pay", time: "Todo el día", title: "Pago estimado de agosto · 1.400,00 €", detail: "Vence el 31 de agosto", icon: "wallet", audience: "Familia", future: true },
];

export const routines = [
  { id: "routine-bathrooms", title: "Baños", detail: "Semanal · unos 35 min", room: "Baños", wiki: "bano-principal", done: false },
  { id: "routine-sheets", title: "Cambiar sábanas de los niños", detail: "Cada 7 días · unos 20 min", room: "Dormitorios", wiki: "rutina-ropa-cama", done: true },
  { id: "routine-plants", title: "Regar plantas del salón", detail: "Cada 4 días · unos 10 min", room: "Salón", wiki: "plantas-salon", done: false },
];

export const docGaps = [
  { id: "gap-1", query: "modo corto lavavajillas", count: 4, variants: ["programa rápido lavaplatos", "lavavajillas corto"], status: "Pendiente" },
  { id: "gap-2", query: "dónde están las pilas", count: 2, variants: ["pilas mando"], status: "Pendiente" },
];

export function getSearchCorpus() {
  const menuItems = weekMenu.flatMap((day, dayIndex) => day.slots.map((slot, slotIndex) => ({
    id: `menu-${dayIndex}-${slotIndex}`,
    type: "menu",
    title: slot.dish,
    description: `${slot.label} del ${day.day.toLocaleLowerCase("es")} · ${slot.time}`,
    aliases: [],
    tags: [slot.label, slot.group, day.day],
    popularity: 4,
    dayIndex,
  })));
  return [...wikiPages, ...recipes, ...contacts, ...menuItems];
}
